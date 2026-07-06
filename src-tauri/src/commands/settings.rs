use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::sync::Mutex;

use super::config_path;
use once_cell::sync::Lazy;

/// Global state to store the most recent notification's session ID.
/// When the app window is activated (e.g., by clicking the toast),
/// the frontend can retrieve this to navigate to the session.
static PENDING_NOTIFICATION: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Keybindings {
    #[serde(default = "default_search_open")]
    pub search_open: String,
    /// 聊天区：当前 tab 向右拆分
    #[serde(default = "default_pane_split_right")]
    pub pane_split_right: String,
    /// 聊天区：当前 tab 向下拆分
    #[serde(default = "default_pane_split_down")]
    pub pane_split_down: String,
    /// 聊天区：关闭当前 tab
    #[serde(default = "default_pane_close_tab")]
    pub pane_close_tab: String,
}

impl Default for Keybindings {
    fn default() -> Self {
        Self {
            search_open: default_search_open(),
            pane_split_right: default_pane_split_right(),
            pane_split_down: default_pane_split_down(),
            pane_close_tab: default_pane_close_tab(),
        }
    }
}

fn default_search_open() -> String { "Ctrl+P".to_string() }
fn default_pane_split_right() -> String { "Ctrl+\\".to_string() }
fn default_pane_split_down() -> String { "Ctrl+Shift+\\".to_string() }
fn default_pane_close_tab() -> String { "Ctrl+W".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_notifications_enabled")]
    pub notifications_enabled: bool,
    #[serde(default)]
    pub proxy: String,
    #[serde(default)]
    pub shell_path: String,
    #[serde(default)]
    pub workbench_height: u32,
    #[serde(default)]
    pub keybindings: Keybindings,
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 已注册到 Windows「打开方式」的扩展名（小写、无前导点）。
    /// 持久化于此，`set_open_with_extensions` 负责同步注册表。
    /// `alias` 兼容落盘为 snake_case 的旧 config.json。
    #[serde(default, alias = "open_with_extensions")]
    pub open_with_extensions: Vec<String>,
    /// 「最近访问」每类列表保留条数（会话与文件共用），默认 10。
    #[serde(default = "default_recent_limit")]
    pub recent_limit: u32,
    /// 聊天区分屏布局快照——前端不透明数据（按工作区键控），Rust 只负责存取。
    #[serde(default)]
    pub pane_layouts: Value,
}

fn default_font_size() -> u32 { 14 }
fn default_font_family() -> String {
    "'Cascadia Code', 'Fira Code', 'Consolas', monospace".to_string()
}
fn default_notifications_enabled() -> bool { true }
fn default_theme() -> String { "warm-dark".to_string() }
fn default_recent_limit() -> u32 { 10 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: default_font_size(),
            font_family: default_font_family(),
            notifications_enabled: default_notifications_enabled(),
            proxy: String::new(),
            shell_path: String::new(),
            workbench_height: 0,
            keybindings: Keybindings::default(),
            theme: default_theme(),
            open_with_extensions: Vec::new(),
            recent_limit: default_recent_limit(),
            pane_layouts: Value::Null,
        }
    }
}

/// Read the full config JSON. Returns Value::Null if the file doesn't exist.
pub fn load_config() -> Value {
    let path = config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                return v;
            }
        }
    }
    Value::Null
}

/// Write the full config JSON back to disk.
pub fn save_config(v: &Value) -> Result<(), String> {
    let path = config_path();
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    fs::write(&path, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write config: {}", e))
}

#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    let config = load_config();
    if let Some(settings) = config.get("settings") {
        serde_json::from_value::<AppSettings>(settings.clone())
            .map_err(|e| format!("Failed to deserialize settings: {}", e))
    } else {
        Ok(AppSettings::default())
    }
}

#[tauri::command]
pub fn set_settings(settings: Value) -> Result<(), String> {
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    // Merge incoming settings fields into the existing "settings" sub-object
    let existing = config
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let mut merged = existing;
    if let Some(obj) = settings.as_object() {
        for (k, v) in obj {
            merged[k] = v.clone();
        }
    }
    config["settings"] = merged;
    save_config(&config)
}

/// Send a desktop notification with the correct AppUserModelID,
/// bypassing the notification plugin's dev-mode skip.
/// Optionally stores session_id for click-to-navigate support.
#[tauri::command]
pub fn notify_send(title: String, body: String, session_id: Option<String>) {
    // Store session_id for later retrieval when window is activated
    if let Some(ref sid) = session_id {
        if let Ok(mut guard) = PENDING_NOTIFICATION.lock() {
            *guard = Some(sid.clone());
        }
    }

    let mut n = notify_rust::Notification::new();
    n.app_id("com.aide.app");
    n.auto_icon();
    n.summary(&title);
    n.body(&body);
    tauri::async_runtime::spawn(async move {
        let _ = n.show();
    });
}

/// Retrieve and clear the pending notification's session ID.
/// Called by frontend when window gains focus to check if user clicked a notification.
#[tauri::command]
pub fn get_pending_notification() -> Option<String> {
    if let Ok(mut guard) = PENDING_NOTIFICATION.lock() {
        guard.take()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set_settings` 收的是 `serde_json::Value`，Tauri 不转换 Value 内部 key，
    /// 前端发 camelCase 就以 camelCase 落盘。`AppSettings` 用 `rename_all = "camelCase"`
    /// 后，`get_settings` 必须能按 camelCase 反序列化多词字段，且再序列化仍出 camelCase。
    #[test]
    fn app_settings_round_trips_camel_case() {
        let json = r#"{
            "fontSize": 16,
            "fontFamily": "mono",
            "notificationsEnabled": false,
            "proxy": "p",
            "shellPath": "s",
            "workbenchHeight": 100,
            "keybindings": { "searchOpen": "Ctrl+P" },
            "theme": "warm-dark",
            "openWithExtensions": [".rs"],
            "recentLimit": 3
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.font_size, 16);
        assert_eq!(s.workbench_height, 100);
        assert_eq!(s.recent_limit, 3);
        assert_eq!(s.open_with_extensions, vec![".rs".to_string()]);
        assert_eq!(s.keybindings.search_open, "Ctrl+P");

        // 再序列化必须仍是 camelCase（前端按 camelCase 读）
        let out = serde_json::to_string(&s).unwrap();
        assert!(out.contains("\"fontSize\":16"), "fontSize key must be camelCase: {out}");
        assert!(out.contains("\"workbenchHeight\":100"), "{out}");
        assert!(out.contains("\"recentLimit\":3"), "{out}");
        assert!(out.contains("\"openWithExtensions\""), "{out}");
        assert!(out.contains("\"searchOpen\":\"Ctrl+P\""), "{out}");
        // 不应出现 snake_case 多词键
        assert!(!out.contains("font_size"));
        assert!(!out.contains("workbench_height"));
        assert!(!out.contains("recent_limit"));
    }

    /// 旧 config.json 把 `open_with_extensions` 落盘为 snake_case；`alias` 让新代码
    /// 仍能读旧数据，避免迁移丢失「打开方式」扩展名。
    #[test]
    fn app_settings_reads_legacy_snake_case_open_with_extensions() {
        let json = r#"{"open_with_extensions": [".py"]}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.open_with_extensions, vec![".py".to_string()]);
    }
}
