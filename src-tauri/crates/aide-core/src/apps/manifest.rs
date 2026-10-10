//! 应用清单（`app.json`）：解析 + 校验。纯函数，不碰磁盘。

use serde::{Deserialize, Serialize};

pub const MANIFEST_FILE: &str = "app.json";

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    /// 右栏 rail 上的一个 tab（窄）。
    #[default]
    Right,
    /// 左侧栏导航组里的一行，点开占主区。
    Main,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub entry: String,
    #[serde(default)]
    pub placement: Placement,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub entry: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub panel: Panel,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub server: Option<Server>,
}

/// 不带参数的权限名。`net` 另可写成 `net:<主机>` 限定到一台主机。
const PERMISSIONS: &[&str] = &[
    "storage",
    "secrets",
    "net",
    "workspace:read",
    "workspace:write",
    "session:read",
    "composer",
];

const MAX_ID: usize = 40;
const MAX_NAME: usize = 40;

/// 解析并校验清单。`dir_name` 是应用所在目录名：`id` 必须与它一致，
/// 否则「目录叫 a、清单自称 b」会让同意记录、数据目录各说各话。
pub fn parse(text: &str, dir_name: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| format!("app.json 解析失败：{e}"))?;
    if !valid_id(&m.id) {
        return Err(format!("id「{}」不合法：只能用小写字母、数字、连字符，字母或数字开头，最长 {MAX_ID}", m.id));
    }
    if m.id != dir_name {
        return Err(format!("id「{}」必须与目录名「{dir_name}」一致", m.id));
    }
    let name = m.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(format!("name 不能为空、不能含控制字符，最长 {MAX_NAME} 个字符"));
    }
    safe_rel(&m.panel.entry).map_err(|e| format!("panel.entry {e}"))?;
    if let Some(icon) = &m.icon {
        safe_rel(icon).map_err(|e| format!("icon {e}"))?;
    }
    if let Some(server) = &m.server {
        safe_rel(&server.entry).map_err(|e| format!("server.entry {e}"))?;
    }
    for p in &m.permissions {
        if !valid_permission(p) {
            return Err(format!("未知权限「{p}」"));
        }
    }
    Ok(m)
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= MAX_ID
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_permission(p: &str) -> bool {
    if PERMISSIONS.contains(&p) {
        return true;
    }
    // net:<主机>：只认主机名字符，不认通配、端口、路径（要更细再加，不能先放开）
    p.strip_prefix("net:").is_some_and(|host| {
        !host.is_empty()
            && host.len() <= 253
            && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    })
}

/// 应用目录内的相对路径：正斜杠分隔，只许普通路径段。
/// `..`、绝对路径、盘符、反斜杠一律拒绝（清单是不可信输入）。
pub fn safe_rel(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 512 {
        return Err("路径为空或过长".into());
    }
    if path.contains('\\') || path.contains(':') || path.starts_with('/') {
        return Err(format!("「{path}」必须是应用目录内的相对路径（正斜杠）"));
    }
    if path.split('/').any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.chars().any(char::is_control)) {
        return Err(format!("「{path}」含非法路径段"));
    }
    Ok(())
}

impl Manifest {
    /// 用户同意的对象：权限集合 + 后端入口。这两样变了就得重新问；
    /// 界面文件怎么改都不用（沙箱管着），否则 agent 每改一行就弹一次。
    pub fn grant(&self) -> String {
        let mut perms = self.permissions.clone();
        perms.sort();
        perms.dedup();
        let server = self.server.as_ref().map(|s| s.entry.as_str()).unwrap_or("");
        format!("permissions={};server={server}", perms.join(","))
    }

    pub fn has_permission(&self, wanted: &str) -> bool {
        self.permissions.iter().any(|p| p == wanted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = r#"{
        "id": "api-tester", "name": "接口调试", "version": "0.1.0",
        "icon": "ui/icon.svg",
        "panel": { "entry": "ui/index.html", "placement": "main" },
        "permissions": ["storage", "net:api.example.com"],
        "server": { "entry": "server/main.mjs" }
    }"#;

    #[test]
    fn parses_a_full_manifest() {
        let m = parse(OK, "api-tester").unwrap();
        assert_eq!(m.panel.placement, Placement::Main);
        assert!(m.has_permission("storage"));
        assert!(!m.has_permission("net"));
    }

    #[test]
    fn placement_and_permissions_default() {
        let m = parse(r#"{"id":"a","name":"A","version":"1","panel":{"entry":"index.html"}}"#, "a").unwrap();
        assert_eq!(m.panel.placement, Placement::Right);
        assert!(m.permissions.is_empty());
        assert!(m.server.is_none());
    }

    #[test]
    fn id_must_match_the_directory() {
        assert!(parse(OK, "other").unwrap_err().contains("目录名"));
    }

    #[test]
    fn rejects_bad_ids() {
        for id in ["", "A", "-a", "a_b", "a/b", "..", "a b", &"a".repeat(41)] {
            let text = format!(r#"{{"id":"{id}","name":"A","version":"1","panel":{{"entry":"i.html"}}}}"#);
            assert!(parse(&text, id).is_err(), "id {id:?} should be rejected");
        }
    }

    #[test]
    fn rejects_paths_that_leave_the_app_directory() {
        for entry in ["../x.html", "/etc/passwd", "C:/x.html", "ui\\\\x.html", "ui//x.html", "ui/./x.html", "ui/../../x", ""] {
            let text = format!(r#"{{"id":"a","name":"A","version":"1","panel":{{"entry":"{entry}"}}}}"#);
            assert!(parse(&text, "a").is_err(), "entry {entry:?} should be rejected");
        }
    }

    #[test]
    fn rejects_unknown_permissions() {
        for p in ["fs", "net:", "net:*.example.com", "net:a.com/path", "net:a.com:443", "workspace"] {
            let text = format!(r#"{{"id":"a","name":"A","version":"1","panel":{{"entry":"i.html"}},"permissions":["{p}"]}}"#);
            assert!(parse(&text, "a").is_err(), "permission {p:?} should be rejected");
        }
    }

    #[test]
    fn grant_tracks_permissions_and_server_only() {
        let base = parse(OK, "api-tester").unwrap();
        let mut reordered = base.clone();
        reordered.permissions.reverse();
        reordered.name = "改了名".into();
        reordered.panel.entry = "ui/other.html".into();
        assert_eq!(base.grant(), reordered.grant());

        let mut more = base.clone();
        more.permissions.push("secrets".into());
        assert_ne!(base.grant(), more.grant());

        let mut no_server = base.clone();
        no_server.server = None;
        assert_ne!(base.grant(), no_server.grant());
    }
}
