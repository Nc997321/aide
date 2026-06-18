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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Keybindings {
    #[serde(default = "default_search_open")]
    pub search_open: String,
}

fn default_search_open() -> String { "Ctrl+P".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
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
}

fn default_font_size() -> u32 { 14 }
fn default_font_family() -> String {
    "'Cascadia Code', 'Fira Code', 'Consolas', monospace".to_string()
}
fn default_notifications_enabled() -> bool { true }

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
