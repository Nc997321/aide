use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::settings::{SettingsScope, SettingsService};
use super::config_path;
use once_cell::sync::Lazy;

/// 串行化所有 config「读→改→写」临界区的全局锁。单纯的原子写只能防崩溃半截
/// 文件，防不了两个写入方在杀软拖慢 `fs::write` 时互相覆盖——曾导致用户新增的
/// provider 被异步 `refresh_system_default_models` 的陈旧快照覆盖丢失。所有要改
/// config 并写回的命令必须走 `with_config_mut`；纯读用 `load_config`（原子写
/// 保证读到的是完整旧值或新值，不会读到半截）。
static CONFIG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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

/// Embedding backend selector for CodeGraph. `fastembed` = local ONNX (zero
/// config, downloads a model on first use); `http` = any HTTP embedding service
/// (Ollama local/remote, OpenAI/Jina cloud — selected by `format`).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraphEmbedderConfig {
    #[serde(default = "default_cg_backend")]
    pub backend: String,
    /// backend == "http" fields (ignored when backend == "fastembed"):
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key_configured: bool,
    #[serde(default = "default_cg_model")]
    pub model: String,
    #[serde(default = "default_cg_format")]
    pub format: String,
    /// 0 = auto-probe from the first successful embedding response.
    #[serde(default)]
    pub dim: u32,
}

fn default_cg_backend() -> String { "fastembed".to_string() }
fn default_cg_model() -> String { "nomic-embed-text".to_string() }
fn default_cg_format() -> String { "ollama".to_string() }

impl Default for CodeGraphEmbedderConfig {
    fn default() -> Self {
        Self {
            backend: default_cg_backend(),
            base_url: String::new(),
            api_key_configured: false,
            model: default_cg_model(),
            format: default_cg_format(),
            dim: 0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_notifications_enabled")]
    pub notifications_enabled: bool,
    /// 会话自动命名：首轮对话后由 sidecar 用小模型生成会话标题（默认开）。
    /// 关闭后 send 命令带 auto_title:false，sidecar 不再发起标题生成。
    #[serde(default = "default_auto_naming")]
    pub auto_naming: bool,
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
    /// CodeGraph embedding 后端配置（fastembed / http）。默认 fastembed
    /// 零配置开箱即用；切 http 走 Ollama / OpenAI 兼容云端。
    #[serde(default)]
    pub codegraph_embedder: CodeGraphEmbedderConfig,
    /// 已启用的固定市场源 source_id 列表（默认空；前端首次进入可写默认两条）。
    #[serde(default)]
    pub enabled_marketplaces: Vec<String>,
    /// 已装插件的启用开关：key = "<plugin>@<market>"。
    #[serde(default)]
    pub enabled_plugins: std::collections::BTreeMap<String, bool>,
    /// JDK 注册表：本机已登记的 JDK（扫描 + 手动添加），供运行配置按项目选
    /// JDK 版本。机器级资源（非按工作区）。前端 settings 管理；Rust 只存取。
    #[serde(default)]
    pub jdk_registry: Vec<super::jdk::JdkEntry>,
    /// 「检测到 Java 项目但运行配置未选 JDK」提示的「稍后」关闭记录——按工作区
    /// 路径键控。落盘到 config.json（非 localStorage），重启不丢。Rust 只存取，
    /// 语义/判定全在前端。一旦该工作区任一 Java 运行配置选了 JDK，前端即不再提示。
    #[serde(default)]
    pub jdk_prompt_dismissed: Vec<String>,
}

fn default_font_size() -> u32 { 14 }
fn default_font_family() -> String {
    // 与前端 utils/fonts.ts MONO_FONT_STACK 保持一致——尾部垫 CJK 回退，
    // 否则西文 mono 无中文字形，Windows 中文落宋体
    "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace".to_string()
}
fn default_notifications_enabled() -> bool { true }
fn default_auto_naming() -> bool { true }
fn default_theme() -> String { "warm-dark".to_string() }
fn default_recent_limit() -> u32 { 10 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: default_font_size(),
            font_family: default_font_family(),
            notifications_enabled: default_notifications_enabled(),
            auto_naming: default_auto_naming(),
            proxy: String::new(),
            shell_path: String::new(),
            workbench_height: 0,
            keybindings: Keybindings::default(),
            theme: default_theme(),
            open_with_extensions: Vec::new(),
            recent_limit: default_recent_limit(),
            pane_layouts: Value::Null,
            codegraph_embedder: CodeGraphEmbedderConfig::default(),
            enabled_marketplaces: Vec::new(),
            enabled_plugins: std::collections::BTreeMap::new(),
            jdk_registry: Vec::new(),
            jdk_prompt_dismissed: Vec::new(),
        }
    }
}

/// Read the full config JSON. Returns Value::Null if the file doesn't exist.
///
/// 纯读不取锁——`save_config` 走 temp+rename 原子替换，读到的要么是完整的旧值
/// 要么是完整的新值，绝不会读到半截。要改并写回必须用 `with_config_mut`。
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

/// Write the full config JSON back to disk atomically（temp + rename）。
///
/// 崩溃/强杀不会留下半截损坏的 config.json——原文件只在 rename 成功的一刻被
/// 替换。杀软锁定目标文件时 rename 重试几次（锁通常瞬态）；仍失败则保留原文件
/// 并报错，最坏是本次改动没保存，而不是把整个 config 写坏。**不取锁**——并发
/// 安全由 `with_config_mut` 在外层临界区保证；直接成对调用 `load_config` +
/// `save_config` 是不安全的，应改用 `with_config_mut`。
pub fn save_config(v: &Value) -> Result<(), String> {
    let path = config_path();
    let dir = path.parent().ok_or_else(|| "config path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let json = serde_json::to_string_pretty(v).map_err(|e| format!("Serialize config: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    // 先写临时文件——失败说明磁盘/权限问题，不碰原文件。
    fs::write(&tmp, &json).map_err(|e| format!("Failed to write config temp: {}", e))?;
    if let Err(e) = persist_file(&tmp, &path) {
        // rename 始终失败：清理临时文件，原文件未动。
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 原子替换：同文件系统 rename 是原子的。Windows 上杀软锁目标文件时 rename
/// 失败，重试几次（锁通常瞬态）；都失败则保留原文件。
fn persist_file(tmp: &Path, dest: &Path) -> Result<(), String> {
    if let Err(e) = fs::rename(tmp, dest) {
        #[cfg(windows)]
        {
            for _ in 0..4 {
                std::thread::sleep(std::time::Duration::from_millis(30));
                if fs::rename(tmp, dest).is_ok() {
                    return Ok(());
                }
            }
        }
        return Err(format!(
            "Failed to atomically replace config (file may be locked by antivirus): {}",
            e
        ));
    }
    Ok(())
}

/// 在一把全局锁内完成 load → modify → save，把「读旧值→改→写回」做成临界区。
/// 防止两个 config 写入方在杀软拖慢写盘时互相覆盖（曾导致新增的 provider 被异步
/// refresh 的陈旧快照覆盖丢失）。闭包返回的值原样透传。`config` 为空时初始化为
/// `{}`，闭包可直接 `config["key"] = ...`。
pub fn with_config_mut<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut Value) -> Result<R, String>,
{
    let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    let r = f(&mut config)?;
    save_config(&config)?;
    Ok(r)
}

pub(crate) fn public_settings(service: &SettingsService) -> Result<AppSettings, String> {
    let effective = service.effective_document_blocking(None).map_err(|error| error.to_string())?;
    let value = effective.values.get("settings").cloned().unwrap_or_else(|| serde_json::json!({}));
    let mut settings: AppSettings = serde_json::from_value(value)
        .map_err(|error| format!("Failed to deserialize settings: {error}"))?;
    settings.codegraph_embedder.api_key_configured = service.secrets()
        .get("codegraph/default/apiKey").map_err(|error| error.to_string())?.is_some();
    Ok(settings)
}

pub(crate) fn resolve_codegraph_embedder(service: &SettingsService) -> Result<RuntimeCodeGraphEmbedderConfig, String> {
    let settings = public_settings(service)?;
    Ok(RuntimeCodeGraphEmbedderConfig {
        backend: settings.codegraph_embedder.backend,
        base_url: settings.codegraph_embedder.base_url,
        api_key: service.secrets().get("codegraph/default/apiKey").map_err(|error| error.to_string())?.unwrap_or_default(),
        model: settings.codegraph_embedder.model,
        format: settings.codegraph_embedder.format,
        dim: settings.codegraph_embedder.dim,
    })
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeCodeGraphEmbedderConfig {
    pub backend: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub format: String,
    pub dim: u32,
}

#[tauri::command]
pub async fn get_settings(service: State<'_, Arc<SettingsService>>) -> Result<AppSettings, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || public_settings(&service))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_settings(settings: Value, service: State<'_, Arc<SettingsService>>) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut incoming = settings;
        let api_key = incoming.get_mut("codegraphEmbedder")
            .and_then(Value::as_object_mut)
            .and_then(|embedder| embedder.remove("apiKey"))
            .map(serde_json::from_value::<crate::settings::SecretMutation>)
            .transpose().map_err(|error| format!("Invalid API key mutation: {error}"))?
            .unwrap_or_default();
        if let Some(embedder) = incoming.get_mut("codegraphEmbedder").and_then(Value::as_object_mut) {
            embedder.remove("apiKeyConfigured");
        }
        service.mutate_scope_blocking(SettingsScope::User, None, |document| {
            let target = document.values.entry("settings".to_string()).or_insert_with(|| serde_json::json!({}));
            let target = target.as_object_mut().ok_or_else(|| crate::settings::SettingsError::Validation("settings must be an object".to_string()))?;
            for (key, value) in incoming.as_object().ok_or_else(|| crate::settings::SettingsError::Validation("settings must be an object".to_string()))? {
                target.insert(key.clone(), value.clone());
            }
            Ok(())
        }).map_err(|error| error.to_string())?;
        match api_key {
            crate::settings::SecretMutation::Unchanged => Ok(()),
            crate::settings::SecretMutation::Set(value) if value.is_empty() => Ok(()),
            crate::settings::SecretMutation::Set(value) => service.secrets().set("codegraph/default/apiKey", &value).map_err(|error| error.to_string()),
            crate::settings::SecretMutation::Clear => service.secrets().delete("codegraph/default/apiKey").map_err(|error| error.to_string()),
        }
    }).await.map_err(|error| error.to_string())?
}

/// Send a desktop notification with the correct AppUserModelID,
/// bypassing the notification plugin's dev-mode skip.
/// Optionally stores session_id for click-to-navigate support.
#[tauri::command]
pub fn notify_send(title: String, body: String, session_id: Option<String>) {
    let _trace = crate::diagnostics::trace_command("notify_send");
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

    /// 自动命名开关随 AppSettings 落盘/读取，camelCase 一致；旧 config 缺字段时
    /// 回填默认 true（功能默认开启）。
    #[test]
    fn auto_naming_round_trip_and_default() {
        let s: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
        assert!(s.auto_naming, "旧 config 缺 autoNaming 字段应回填 true");

        let s2: AppSettings = serde_json::from_str(r#"{"autoNaming":false}"#).unwrap();
        assert!(!s2.auto_naming);
        let out = serde_json::to_string(&s2).unwrap();
        assert!(out.contains("\"autoNaming\":false"), "{out}");
    }

    /// 市场源启用字段 round-trip + 缺省回填。
    #[test]
    fn marketplace_enabled_fields_round_trip() {
        let json = r#"{"fontSize":14,"enabledMarketplaces":["claude-plugins-official"],"enabledPlugins":{"github@claude-plugins-official":true}}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.enabled_marketplaces, vec!["claude-plugins-official"]);
        assert_eq!(s.enabled_plugins.get("github@claude-plugins-official"), Some(&true));
        let out = serde_json::to_string(&s).unwrap();
        assert!(out.contains("\"enabledMarketplaces\""), "{out}");
        assert!(out.contains("\"enabledPlugins\""), "{out}");
        // 缺字段回填默认
        let s2: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
        assert!(s2.enabled_marketplaces.is_empty());
        assert!(s2.enabled_plugins.is_empty());
    }

    /// CodeGraph embedder 配置随 AppSettings 落盘/读取，camelCase 一致；缺省
    /// 块回填默认 fastembed 后端（旧 config.json 没有这一字段时）。
    #[test]
    fn codegraph_embedder_config_round_trip_and_default() {
        // 缺 codegraphEmbedder 块 → 默认 fastembed
        let s: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
        assert_eq!(s.codegraph_embedder.backend, "fastembed");
        assert_eq!(s.codegraph_embedder.format, "ollama");

        // 完整 http 配置 round-trip
        let json = r#"{
            "fontSize": 14,
            "codegraphEmbedder": {
                "backend": "http",
                "baseUrl": "http://localhost:11434",
                "apiKey": "sk-x",
                "model": "nomic-embed-text",
                "format": "ollama",
                "dim": 768
            }
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.codegraph_embedder.backend, "http");
        assert_eq!(s.codegraph_embedder.base_url, "http://localhost:11434");
        assert_eq!(s.codegraph_embedder.model, "nomic-embed-text");
        assert_eq!(s.codegraph_embedder.format, "ollama");
        assert_eq!(s.codegraph_embedder.dim, 768);

        let out = serde_json::to_string(&s).unwrap();
        assert!(out.contains("\"codegraphEmbedder\""), "{out}");
        assert!(out.contains("\"baseUrl\":\"http://localhost:11434\""), "{out}");
    }

    /// JDK 注册表随 AppSettings 落盘/读取，camelCase 一致；缺字段回填空。
    #[test]
    fn jdk_registry_round_trip_and_default() {
        // 缺 jdkRegistry → 默认空
        let s: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
        assert!(s.jdk_registry.is_empty());

        let json = r#"{
            "fontSize": 14,
            "jdkRegistry": [
                {"name":"jdk-21","version":"21","path":"C:\\Program Files\\Java\\jdk-21"},
                {"name":"jdk-8","version":"8","path":"C:\\Program Files\\Java\\jdk-8"}
            ]
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.jdk_registry.len(), 2);
        assert_eq!(s.jdk_registry[0].version, "21");
        assert_eq!(s.jdk_registry[1].name, "jdk-8");

        let out = serde_json::to_string(&s).unwrap();
        assert!(out.contains("\"jdkRegistry\""), "{out}");
        assert!(out.contains("\"path\":\"C:\\\\Program Files\\\\Java\\\\jdk-21\""), "{out}");
    }
}
