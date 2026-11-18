use portable_pty::CommandBuilder;
use std::io;
use std::path::Path;
use tempfile::TempDir;

/// Installs the shell's line-editor hook and returns any startup files it needs.
/// Every hook emits the same OSC frame for the terminal's shared suggestion flow.
trait ShellInput {
    fn configure(&self, command: &mut CommandBuilder, token: &str) -> io::Result<Option<TempDir>>;
}

fn nested_shell_bootstrap(token: &str) -> String {
    use base64::Engine;
    let common = include_str!("terminal_input/common.sh");
    let execute = include_str!("terminal_input/ssh_execute.sh");
    let script = include_str!("terminal_input/ssh.sh")
        .replace("__AIDE_BASH_RC__", &format!(
            "[ ! -r \"$HOME/.bashrc\" ] || . \"$HOME/.bashrc\"\n{common}\n{execute}\n{}",
            include_str!("terminal_input/bash.sh")
        ))
        .replace("__AIDE_ZSH_ENV__", include_str!("terminal_input/zshenv"))
        .replace("__AIDE_ZSH_RC__", &format!(
            "{}\n{common}\n{execute}\n{}",
            include_str!("terminal_input/zshrc"), include_str!("terminal_input/zsh.sh")
        ))
        .replace("__AIDE_INPUT_TOKEN__", token);
    let encoded = base64::engine::general_purpose::STANDARD.encode(script.replace("\r\n", "\n"));
    format!("if command -v base64 >/dev/null 2>&1; then sh -c \"$(printf %s {encoded} | base64 -d)\"; else exec \"$SHELL\" -i; fi")
}

#[cfg(unix)]
fn ssh_hook(token: &str) -> String {
    include_str!("terminal_input/ssh_local.sh")
        .replace("__AIDE_SSH_BOOTSTRAP__", &format!("'{}'", nested_shell_bootstrap(token)))
        .replace("__AIDE_INPUT_TOKEN__", token)
}

struct PowerShell;

impl ShellInput for PowerShell {
    fn configure(&self, command: &mut CommandBuilder, token: &str) -> io::Result<Option<TempDir>> {
        use base64::Engine;
        let bootstrap = nested_shell_bootstrap(token);
        let script = include_str!("commands/terminal_input.ps1")
            .replace("__AIDE_INPUT_TOKEN__", token)
            .replace("__AIDE_SSH_BOOTSTRAP__", &bootstrap);
        #[cfg(windows)]
        let script = format!(
            "chcp 65001 >$null\n{script}\n{}",
            include_str!("terminal_input/wsl.ps1")
                .replace("__AIDE_INPUT_TOKEN__", token)
                .replace("__AIDE_WSL_BOOTSTRAP__", &bootstrap)
        );
        let directory = tempfile::Builder::new().prefix("aide-terminal-").tempdir()?;
        let startup = directory.path().join("startup.ps1");
        std::fs::write(&startup, script)?;

        // Keep the SSH/WSL payload off the Windows command line. Load it as
        // interactive startup code and dot-source it so the hooks stay in scope.
        command.env("AIDE_TERMINAL_STARTUP", dunce::simplified(&startup));
        let loader = ". ([scriptblock]::Create([IO.File]::ReadAllText($env:AIDE_TERMINAL_STARTUP)))";
        let bytes: Vec<u8> = loader.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        command.args(["-NoExit", "-EncodedCommand", &encoded]);
        Ok(Some(directory))
    }
}

#[cfg(unix)]
struct Bash;

#[cfg(unix)]
impl ShellInput for Bash {
    fn configure(&self, command: &mut CommandBuilder, token: &str) -> io::Result<Option<TempDir>> {
        let directory = tempfile::Builder::new().prefix("aide-terminal-").tempdir()?;
        let rc = directory.path().join("bashrc");
        let common = include_str!("terminal_input/common.sh").replace("__AIDE_INPUT_TOKEN__", token);
        std::fs::write(&rc, format!(
            "if [ -r \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\"; fi\n{common}\n{}\n{}",
            include_str!("terminal_input/bash.sh"), ssh_hook(token)
        ))?;
        command.arg("--rcfile");
        command.arg(rc);
        Ok(Some(directory))
    }
}

#[cfg(unix)]
struct Zsh;

#[cfg(unix)]
impl ShellInput for Zsh {
    fn configure(&self, command: &mut CommandBuilder, token: &str) -> io::Result<Option<TempDir>> {
        let directory = tempfile::Builder::new().prefix("aide-terminal-").tempdir()?;
        let common = include_str!("terminal_input/common.sh").replace("__AIDE_INPUT_TOKEN__", token);
        std::fs::write(directory.path().join(".zshenv"), include_str!("terminal_input/zshenv"))?;
        std::fs::write(directory.path().join(".zshrc"), format!(
            "{}\n{common}\n{}\n{}",
            include_str!("terminal_input/zshrc"),
            include_str!("terminal_input/zsh.sh"),
            ssh_hook(token),
        ))?;
        command.env_remove("AIDE_TERMINAL_ZDOTDIR");
        if let Some(zdotdir) = std::env::var_os("ZDOTDIR") {
            command.env("AIDE_TERMINAL_ZDOTDIR", zdotdir);
        }
        command.env("ZDOTDIR", directory.path());
        Ok(Some(directory))
    }
}

pub(crate) fn configure(
    command: &mut CommandBuilder,
    program: &str,
    input_token: Option<&str>,
) -> Option<TempDir> {
    let name = Path::new(program).file_name()?.to_str()?.to_ascii_lowercase();
    let adapter: Option<&dyn ShellInput> = match name.as_str() {
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => Some(&PowerShell),
        #[cfg(unix)]
        "bash" => Some(&Bash),
        #[cfg(unix)]
        "zsh" => Some(&Zsh),
        _ => None,
    };
    if let (Some(adapter), Some(token)) = (adapter, input_token.filter(|token| {
        token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
    })) {
        match adapter.configure(command, token) {
            Ok(directory) => return directory,
            Err(error) => tracing::warn!(shell = name, %error, "terminal input integration unavailable"),
        }
    }
    // Keep ConPTY on UTF-8 even when inline input integration is unavailable.
    #[cfg(windows)]
    match name.as_str() {
        "powershell.exe" | "pwsh.exe" => command.args(["-NoExit", "-Command", "chcp 65001 >$null"]),
        "cmd.exe" => command.args(["/k", "chcp 65001 >nul"]),
        _ => {}
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_shell_bootstrap_keeps_the_pty_as_the_shell_input() {
        let command = nested_shell_bootstrap("0123456789abcdef0123456789abcdef");
        assert!(command.contains("sh -c \"$(printf"));
        assert!(!command.contains("| sh"));
        assert!(!command.contains('\''));
    }

    #[test]
    fn configures_powershell_only_with_a_valid_token() {
        let program = "pwsh";
        let mut command = CommandBuilder::new(program);
        let token = "0123456789abcdef0123456789abcdef";
        let startup = configure(&mut command, program, Some(token)).expect("startup directory");
        assert_eq!(command.get_argv()[1], "-NoExit");
        assert_eq!(command.get_argv()[2], "-EncodedCommand");
        assert!(command.get_argv()[3].len() < 1024);
        let script = std::fs::read_to_string(startup.path().join("startup.ps1")).unwrap();
        assert!(script.contains(token));
        assert!(script.contains("function ssh"));
        #[cfg(windows)]
        assert!(script.contains("function wsl"));

        let mut command = CommandBuilder::new(program);
        configure(&mut command, program, Some("invalid"));
        assert_eq!(command.get_argv().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn preserves_windows_code_page_setup_for_plain_shells() {
        for (program, args) in [
            ("powershell.exe", &["-NoExit", "-Command", "chcp 65001 >$null"][..]),
            ("cmd.exe", &["/k", "chcp 65001 >nul"][..]),
            ("sh.exe", &[][..]),
        ] {
            let mut command = CommandBuilder::new(program);
            configure(&mut command, program, None);
            let actual: Vec<_> = command.get_argv().iter().skip(1).map(|arg| arg.to_str().unwrap()).collect();
            assert_eq!(actual.as_slice(), args);
        }
    }
}
