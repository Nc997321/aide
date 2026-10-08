//! 远程 Host 的标识，以及 WSL 路径在桌面上的形态。纯函数，无 IO。
//!
//! Host 模型下前端与 Host 之间传的一律是 **Host 原生路径**（WSL / SSH 上就是 POSIX 路径），
//! 不做翻译。唯一例外是显式跨界的 GUI 动作（「用本机程序打开」「在资源管理器中显示」）：
//! WSL 的文件在 Windows 上可经 `\\wsl.localhost\<distro>\…` 访问，由 [`wsl_desktop_path`] 给出；
//! SSH Host 的文件本机摸不到，调用方如实拒绝。

use std::fmt;

/// 目标机：一个 WSL 发行版或一个 SSH 主机（`~/.ssh/config` 里的 Host 别名或 `user@host`）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum HostId {
    Wsl(String),
    Ssh(String),
}

impl HostId {
    /// 稳定字符串键：`wsl:Debian` / `ssh:devbox`（窗口绑定与前端传参用）。
    pub fn key(&self) -> String {
        match self {
            HostId::Wsl(d) => format!("wsl:{d}"),
            HostId::Ssh(a) => format!("ssh:{a}"),
        }
    }

    pub fn parse_key(key: &str) -> Option<HostId> {
        let (kind, name) = key.split_once(':')?;
        if !valid_name(name) {
            return None;
        }
        match kind {
            "wsl" => Some(HostId::Wsl(name.to_string())),
            "ssh" => Some(HostId::Ssh(name.to_string())),
            _ => None,
        }
    }

    /// 界面显示名：`WSL: Debian` / `SSH: devbox`。
    pub fn label(&self) -> String {
        match self {
            HostId::Wsl(d) => format!("WSL: {d}"),
            HostId::Ssh(a) => format!("SSH: {a}"),
        }
    }
}

impl fmt::Display for HostId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.key())
    }
}

/// 主机名合法字符：发行版名 / ssh 别名 / `user@host`。拒绝分隔符与 shell 元字符
/// ——名字会进 `wsl.exe -d` / `ssh` 的参数。
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'))
        && !name.starts_with('-')
}

/// WSL 发行版里的 POSIX 绝对路径 → Windows 上能打开的 `\\wsl.localhost\<distro>\…`。
/// 非绝对路径原样返回（相对路径不属于任何主机）。
pub fn wsl_desktop_path(distro: &str, posix: &str) -> String {
    if !posix.starts_with('/') {
        return posix.to_string();
    }
    let tail = posix.trim_matches('/');
    if tail.is_empty() {
        return format!("\\\\wsl.localhost\\{distro}\\");
    }
    format!("\\\\wsl.localhost\\{distro}\\{}", tail.replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_paths_open_through_the_unc_share() {
        assert_eq!(
            wsl_desktop_path("Debian", "/home/u/proj/src/main.rs"),
            "\\\\wsl.localhost\\Debian\\home\\u\\proj\\src\\main.rs"
        );
        assert_eq!(wsl_desktop_path("Debian", "/"), "\\\\wsl.localhost\\Debian\\");
    }

    #[test]
    fn relative_paths_untouched() {
        assert_eq!(wsl_desktop_path("Debian", "src/main.rs"), "src/main.rs");
    }

    #[test]
    fn host_key_roundtrip_and_validation() {
        assert_eq!(HostId::parse_key("wsl:Ubuntu-24.04"), Some(HostId::Wsl("Ubuntu-24.04".into())));
        assert_eq!(HostId::parse_key("ssh:me@box"), Some(HostId::Ssh("me@box".into())));
        assert_eq!(HostId::parse_key("ssh:-oProxyCommand=x"), None);
        assert_eq!(HostId::parse_key("ssh:a b"), None);
        assert_eq!(HostId::parse_key("ftp:x"), None);
    }
}
