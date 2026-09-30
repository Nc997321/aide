//! 进到目标机的那一跳：构造 `wsl.exe` / `ssh` 子进程命令。纯构造，不 spawn。
//!
//! 两种传输对上层完全同构——「起一个子进程，它的 stdin/stdout 就是目标机上某条
//! 命令的 stdin/stdout」。上层（安装、serve、agent、终端）只拿 `Command`，不关心是哪种。
//!
//! 远程命令一律以 `sh -c '<script>'` 执行：ssh 会把命令串交给用户的登录 shell
//! （可能是 fish / zsh），套一层 `sh -c` 让脚本语义与用户 shell 无关。

use std::process::Stdio;

use super::path::HostId;

/// 单引号转义：把任意字符串安全嵌进 `sh -c '<…>'`。
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 在目标机上执行 `script`（POSIX sh 语法），stdio 全部 piped。
pub fn command(host: &HostId, script: &str) -> Result<tokio::process::Command, String> {
    let mut cmd = match host {
        HostId::Wsl(distro) => {
            if !cfg!(windows) {
                return Err("WSL 工作区只在 Windows 上可用".to_string());
            }
            let mut c = tokio::process::Command::new("wsl.exe");
            // --exec：不经 wsl 的默认 shell 再解释一遍（少一层转义）
            c.args(["-d", distro, "--exec", "sh", "-c", script]);
            c
        }
        HostId::Ssh(alias) => {
            let mut c = tokio::process::Command::new("ssh");
            c.args([
                "-T",
                // 桌面进程没有终端可供输入密码：必须走密钥 / ssh-agent。密码交互会
                // 永远挂起，BatchMode 让它立即失败并给出可读错误。
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=15",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "--",
                alias,
                &format!("sh -c {}", sh_quote(script)),
            ]);
            c
        }
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CLAUDE.md 红线：任何外部 CLI 必须 CREATE_NO_WINDOW，否则每次连接弹控制台
        cmd.creation_flags(0x08000000);
    }
    Ok(cmd)
}

/// aide-core 终端的远程钩子（`terminal::set_remote_shell`）：远程工作区路径 → 目标机登录
/// shell 的 argv + 本机 PTY 的 cwd（家目录）。本机路径返回 None，照常起本机 shell。
pub fn remote_shell(cwd: &str) -> Option<Result<(Vec<String>, std::path::PathBuf), String>> {
    let (host, posix_cwd) = super::path::parse(cwd)?;
    let local_cwd = aide_core::paths::user_home().unwrap_or_else(|| std::path::PathBuf::from("."));
    Some(terminal_argv(&host, &posix_cwd).map(|argv| (argv, local_cwd)))
}

/// 交互式终端的启动参数（交给 PTY 跑，不是 piped）：在目标机 `cwd` 下开用户的登录 shell。
pub fn terminal_argv(host: &HostId, cwd: &str) -> Result<Vec<String>, String> {
    // cd 失败（目录已删）不致命：落到家目录照样给一个 shell
    let script = format!(
        "cd {} 2>/dev/null || cd; exec \"${{SHELL:-/bin/sh}}\" -l",
        sh_quote(cwd)
    );
    match host {
        HostId::Wsl(distro) => {
            if !cfg!(windows) {
                return Err("WSL 工作区只在 Windows 上可用".to_string());
            }
            Ok(vec![
                "wsl.exe".into(),
                "-d".into(),
                distro.clone(),
                "--exec".into(),
                "sh".into(),
                "-c".into(),
                script,
            ])
        }
        HostId::Ssh(alias) => Ok(vec![
            "ssh".into(),
            "-t".into(),
            "--".into(),
            alias.clone(),
            format!("sh -c {}", sh_quote(&script)),
        ]),
    }
}

/// 列出本机已安装的 WSL 发行版（`wsl.exe -l -q`）。非 Windows → 空。
pub async fn list_wsl_distros() -> Result<Vec<String>, String> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-l", "-q"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "wsl.exe -l 超时".to_string())?
        .map_err(|e| format!("无法运行 wsl.exe（未安装 WSL？）：{e}"))?;
    Ok(parse_wsl_list(&out.stdout))
}

/// `wsl.exe -l -q` 输出 UTF-16LE（无 BOM 或带 BOM），每行一个发行版名。
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    // UTF-16LE：带 BOM（FF FE）或无 BOM 但 ASCII 字符的高字节全为 0
    let (utf16, body) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (true, rest),
        _ => (
            bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(8).all(|b| *b == 0),
            bytes,
        ),
    };
    let text = if utf16 {
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(body).into_owned()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        .filter(|l| super::path::valid_name(l))
        .map(String::from)
        .collect()
}

/// `~/.ssh/config` 里的具体 Host 别名（跳过带通配符的模式）。
pub fn list_ssh_config_hosts() -> Vec<String> {
    let Some(home) = crate::commands::user_home() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Vec::new();
    };
    parse_ssh_config_hosts(&text)
}

pub fn parse_ssh_config_hosts(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let mut it = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let Some(key) = it.next() else { continue };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for name in it.next().unwrap_or("").split_whitespace() {
            if super::path::valid_name(name) && !out.iter().any(|h| h == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_survives_single_quotes() {
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn wsl_list_utf16() {
        let s = "Debian\r\nUbuntu-24.04\r\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(parse_wsl_list(&bytes), vec!["Debian", "Ubuntu-24.04"]);
    }

    #[test]
    fn wsl_list_utf8_fallback() {
        assert_eq!(parse_wsl_list(b"Debian\n\n"), vec!["Debian"]);
    }

    #[test]
    fn ssh_config_hosts_skip_patterns() {
        let cfg = "Host devbox gpu-1\n  HostName 10.0.0.2\nHost *\n  ForwardAgent no\nhost=box2\nHost *.corp\n";
        assert_eq!(parse_ssh_config_hosts(cfg), vec!["devbox", "gpu-1", "box2"]);
    }
}
