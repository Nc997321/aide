//! 远程工作区的**桌面侧路径形态**与目标机路径（POSIX）的互译。纯函数，无 IO。
//!
//! 桌面里（前端、注册表、会话档案、IPC 参数）远程路径统一写成 UNC 形态：
//!
//! | 目标 | 桌面形态 | 目标机路径 |
//! |---|---|---|
//! | WSL 发行版 `Debian` | `\\wsl.localhost\Debian\home\u\proj` | `/home/u/proj` |
//! | SSH 主机 `devbox` | `\\aide-ssh.invalid\devbox\home\u\proj` | `/home/u/proj` |
//!
//! 为什么是 UNC：
//! - WSL 用的就是 Windows 原生路径——资源管理器「在文件夹中显示」、系统默认程序
//!   打开等**桌面本机能力对它天然可用**，前端 `joinPath` / `isSameOrInside` 等按分隔符
//!   工作的工具零改动。
//! - SSH 借同一形态统一处理；服务器名用保留顶级域 `.invalid`（RFC 2606），万一有
//!   未路由的命令在本机碰到它，DNS 立即失败，不会卡在 SMB 名称解析上。
//!
//! 这是路径形态的**唯一真相源**：别处需要判断「是不是远程路径」「属于哪台主机」
//! 一律调这里，不要手搓前缀比较。

use std::fmt;

const WSL_SERVERS: &[&str] = &["wsl.localhost", "wsl$"];
const WSL_CANONICAL: &str = "wsl.localhost";
pub const SSH_SERVER: &str = "aide-ssh.invalid";

/// 目标机：一个 WSL 发行版或一个 SSH 主机（`~/.ssh/config` 里的 Host 别名或 `user@host`）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum HostId {
    Wsl(String),
    Ssh(String),
}

impl HostId {
    /// 稳定字符串键：`wsl:Debian` / `ssh:devbox`（持久化与前端传参用）。
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

    /// 桌面形态的根前缀（不带尾分隔符）：`\\wsl.localhost\Debian`。
    pub fn desktop_prefix(&self) -> String {
        match self {
            HostId::Wsl(d) => format!("\\\\{WSL_CANONICAL}\\{d}"),
            HostId::Ssh(a) => format!("\\\\{SSH_SERVER}\\{a}"),
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
/// ——名字会进 `wsl.exe -d` / `ssh` 的参数，也会进 UNC 路径。
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'))
        && !name.starts_with('-')
}

/// 解析桌面形态路径 → (主机, 目标机 POSIX 路径)。非远程路径 → None。
///
/// 接受 `\` 与 `/` 两种分隔符（前端有时会把分隔符归一成 `/`），WSL 另接受 `wsl$`。
pub fn parse(desktop: &str) -> Option<(HostId, String)> {
    let rest = desktop
        .strip_prefix("\\\\")
        .or_else(|| desktop.strip_prefix("//"))?;
    let mut parts = rest.splitn(3, ['\\', '/']);
    let server = parts.next()?;
    let name = parts.next()?;
    if !valid_name(name) {
        return None;
    }
    let host = if WSL_SERVERS.iter().any(|s| s.eq_ignore_ascii_case(server)) {
        HostId::Wsl(name.to_string())
    } else if server.eq_ignore_ascii_case(SSH_SERVER) {
        HostId::Ssh(name.to_string())
    } else {
        return None;
    };
    let tail = parts.next().unwrap_or("");
    let posix = format!("/{}", tail.replace('\\', "/").trim_matches('/'));
    // 折叠重复分隔符（`\\wsl.localhost\D\\home` 这类拼接产物）
    let mut out = String::with_capacity(posix.len());
    for ch in posix.chars() {
        if ch == '/' && out.ends_with('/') {
            continue;
        }
        out.push(ch);
    }
    Some((host, out))
}

pub fn is_remote(desktop: &str) -> bool {
    parse(desktop).is_some()
}

/// 桌面侧「这个工作区目录还在吗」的判定：本机路径照常 stat；远程路径**按存在处理**
/// ——同步 stat 远程要先连目标机（可能要装套件、要几秒），不能卡在注册表 / cwd 解析这类
/// 同步小函数里。真实存在性由转发到目标机的操作如实报错。
///
/// 这条必须用在所有「目录不在就回落 / 判 missing」的地方：若对远程路径返回 false，
/// 会话 cwd 解析会静默回落到活动工作区——即「跑错项目」（CLAUDE.md 2026-09-18 事故）。
pub fn present(p: &std::path::Path) -> bool {
    match p.to_str() {
        Some(s) if is_remote(s) => true,
        _ => p.exists(),
    }
}

/// 目标机 POSIX 路径 → 桌面形态。非绝对路径原样返回（相对路径不属于任何主机）。
pub fn to_desktop(host: &HostId, posix: &str) -> String {
    if !posix.starts_with('/') {
        return posix.to_string();
    }
    let tail = posix.trim_matches('/');
    if tail.is_empty() {
        return format!("{}\\", host.desktop_prefix());
    }
    format!("{}\\{}", host.desktop_prefix(), tail.replace('/', "\\"))
}

/// 自由文本里的桌面形态路径（属于 `host` 的）→ 目标机路径。用于发往远程 agent 的
/// prompt：@引用展开后的正文里带的是桌面路径，模型在目标机上要看到它能用的路径。
/// 其它主机 / 本机路径原样保留。
pub fn translate_text_to_posix(host: &HostId, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with("\\\\") || rest.starts_with("//") {
            // 候选路径到下一个空白 / 引号 / 尖括号为止
            let end = rest
                .char_indices()
                .find(|(_, c)| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '<' | '>' | '|' | ')' | ']'))
                .map(|(j, _)| j)
                .unwrap_or(rest.len());
            let candidate = &rest[..end];
            if let Some((h, posix)) = parse(candidate) {
                if &h == host {
                    out.push_str(&posix);
                    i += end;
                    continue;
                }
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl() -> HostId {
        HostId::Wsl("Debian".into())
    }

    #[test]
    fn parses_wsl_forms() {
        for p in [
            "\\\\wsl.localhost\\Debian\\home\\u\\proj",
            "//wsl.localhost/Debian/home/u/proj",
            "\\\\wsl$\\Debian\\home\\u\\proj",
            "\\\\WSL.LOCALHOST\\Debian\\home\\u\\proj\\",
        ] {
            assert_eq!(parse(p), Some((wsl(), "/home/u/proj".into())), "{p}");
        }
    }

    #[test]
    fn distro_root_maps_to_slash() {
        assert_eq!(parse("\\\\wsl.localhost\\Debian"), Some((wsl(), "/".into())));
        assert_eq!(parse("\\\\wsl.localhost\\Debian\\"), Some((wsl(), "/".into())));
        assert_eq!(to_desktop(&wsl(), "/"), "\\\\wsl.localhost\\Debian\\");
    }

    #[test]
    fn parses_ssh_form() {
        assert_eq!(
            parse("\\\\aide-ssh.invalid\\me@box\\srv\\app"),
            Some((HostId::Ssh("me@box".into()), "/srv/app".into()))
        );
    }

    #[test]
    fn local_and_foreign_unc_are_not_remote() {
        for p in [
            "C:\\Users\\u\\proj",
            "/home/u/proj",
            "\\\\fileserver\\share\\x",
            "\\\\wsl.localhost\\bad;name\\x",
            "",
        ] {
            assert_eq!(parse(p), None, "{p}");
        }
    }

    #[test]
    fn roundtrip() {
        let d = to_desktop(&wsl(), "/home/u/proj/src/main.rs");
        assert_eq!(d, "\\\\wsl.localhost\\Debian\\home\\u\\proj\\src\\main.rs");
        assert_eq!(parse(&d), Some((wsl(), "/home/u/proj/src/main.rs".into())));
    }

    #[test]
    fn relative_paths_untouched() {
        assert_eq!(to_desktop(&wsl(), "src/main.rs"), "src/main.rs");
    }

    #[test]
    fn host_key_roundtrip_and_validation() {
        assert_eq!(HostId::parse_key("wsl:Ubuntu-24.04"), Some(HostId::Wsl("Ubuntu-24.04".into())));
        assert_eq!(HostId::parse_key("ssh:me@box"), Some(HostId::Ssh("me@box".into())));
        assert_eq!(HostId::parse_key("ssh:-oProxyCommand=x"), None);
        assert_eq!(HostId::parse_key("ssh:a b"), None);
        assert_eq!(HostId::parse_key("ftp:x"), None);
    }

    #[test]
    fn text_translation_only_touches_own_host() {
        let t = "看 @\\\\wsl.localhost\\Debian\\home\\u\\p\\a.rs 和 C:\\x\\b.rs 以及 \\\\wsl.localhost\\Other\\c";
        assert_eq!(
            translate_text_to_posix(&wsl(), t),
            "看 @/home/u/p/a.rs 和 C:\\x\\b.rs 以及 \\\\wsl.localhost\\Other\\c"
        );
    }

    #[test]
    fn text_translation_handles_quotes_and_multibyte() {
        let t = "路径\"//wsl.localhost/Debian/home/u/文件.md\"结束";
        assert_eq!(translate_text_to_posix(&wsl(), t), "路径\"/home/u/文件.md\"结束");
    }
}
