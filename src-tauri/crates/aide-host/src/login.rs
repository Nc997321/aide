//! 目标机用户的**登录环境**（PATH 里的 nvm / cargo / pyenv…）。agent 与语言服务器都要看到
//! 与用户自己终端一致的工具链：wsl/ssh 起的是非登录环境，PATH 往往缺一大截。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

const ENV_MARKER: &str = "__AIDE_LOGIN_ENV__";

/// 以交互式登录 shell 取环境（`-lic`：Debian/Ubuntu 的 .bashrc 对非交互 shell 直接
/// return，nvm 之类只装在那里）。rc 文件往 stdout 打的任何东西都在标记之前，被丢弃。
pub async fn login_env() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    for flags in ["-lic", "-lc"] {
        let script = format!("printf '\\n{ENV_MARKER}\\n'; env -0");
        let fut = tokio::process::Command::new(&shell)
            .arg(flags)
            .arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output();
        let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(15), fut).await else {
            continue;
        };
        if let Some(env) = parse_env_dump(&out.stdout) {
            return Some(env);
        }
    }
    None
}

fn parse_env_dump(bytes: &[u8]) -> Option<HashMap<String, String>> {
    let text = String::from_utf8_lossy(bytes);
    let marker = format!("\n{ENV_MARKER}\n");
    let (_, dump) = text.split_once(&marker)?;
    let env: HashMap<String, String> = dump
        .split('\0')
        .filter_map(|kv| kv.split_once('='))
        .filter(|(k, _)| !k.is_empty() && !k.contains('\n'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    env.contains_key("PATH").then_some(env)
}

/// 裸名按登录环境的 PATH 解析成绝对路径（spawn 用的是本进程的 PATH，不是子进程 env）。
/// 带 `/` 的按原样认（存在才算）；找不到 → None。
pub fn which(name: &str, env: Option<&HashMap<String, String>>) -> Option<String> {
    if name.contains('/') {
        return PathBuf::from(name).is_file().then(|| name.to_string());
    }
    let path = env
        .and_then(|e| e.get("PATH").cloned())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|cand| cand.is_file())
        .map(|cand| cand.to_string_lossy().into_owned())
}

/// 登录环境只取一次（一次 shell 启动可达数秒；serve 进程里的每次探测都要用）。
pub async fn cached_login_env() -> Option<&'static HashMap<String, String>> {
    static CELL: tokio::sync::OnceCell<Option<HashMap<String, String>>> =
        tokio::sync::OnceCell::const_new();
    CELL.get_or_init(login_env).await.as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_dump_skips_rc_noise() {
        let mut dump = b"Welcome to box!\nfortune cookie\n\n__AIDE_LOGIN_ENV__\n".to_vec();
        dump.extend_from_slice(b"PATH=/home/u/.nvm/bin:/usr/bin\0HOME=/home/u\0MULTI=a\nb\0");
        let env = parse_env_dump(&dump).unwrap();
        assert_eq!(env["PATH"], "/home/u/.nvm/bin:/usr/bin");
        assert_eq!(env["MULTI"], "a\nb");
    }

    #[test]
    fn which_finds_executables_on_the_given_path_only() {
        let dir = std::env::temp_dir().join(format!("aide-host-which-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake-ls"), "#!/bin/sh\n").unwrap();
        let env: HashMap<String, String> =
            [("PATH".to_string(), format!("/nonexistent:{}", dir.display()))].into();
        let found = which("fake-ls", Some(&env));
        assert_eq!(found.as_deref(), Some(dir.join("fake-ls").to_str().unwrap()));
        assert!(which("definitely-not-here-xyz", Some(&env)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_dump_without_marker_is_rejected() {
        assert!(parse_env_dump(b"PATH=/x\0").is_none());
    }
}
