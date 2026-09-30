// mcp 子域：settings.json mcpServers 清单增删改启停 + 探活（test_mcp_connection）。
// 内置项的 UI 展示另有 useCustomizations.ts 静态镜像（sidecar 侧登记，两处同步）。
#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("list_mcp_servers", list_mcp_servers),
    command!("create_mcp_server", create_mcp_server),
    command!("update_mcp_server", update_mcp_server),
    command!("delete_mcp_server", delete_mcp_server),
    command!("toggle_mcp_server", toggle_mcp_server),
];

use super::{load_settings, save_settings, settings_path, CustomizationItem};
// ── MCP Server Commands ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMcpServersArgs {
}

async fn list_mcp_servers(_core: Arc<Core>, a: ListMcpServersArgs) -> Result<Vec<CustomizationItem>, String> {
    let _ = a;
    blocking(move || -> Result<Vec<CustomizationItem>, String> {
    let settings = load_settings();
    let mcp_servers = settings
        .get("mcpServers")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let mut items = Vec::new();
    if let Some(obj) = mcp_servers.as_object() {
        for (name, config) in obj {
            let command = config["command"].as_str().unwrap_or("");
            let args = config["args"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let enabled = !config
                .get("disabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            items.push(CustomizationItem {
                id: name.clone(),
                name: name.clone(),
                r#type: "mcp_server".to_string(),
                enabled,
                path: settings_path().to_string_lossy().to_string(),
                description: Some(format!("{} {}", command, args)),
                metadata: Some(config.clone()),
            });
        }
    }
    Ok(items)
}).await
}

/// 从前端 data 构造写入 settings.json 的 mcpServer config。
/// 剥离前端 UI 字段（transport/disabled/name），保留 SDK 认的传输字段
/// （stdio: command/args/env；sse/http: url/headers）。跳过 null 与空 env/args。
fn build_mcp_config(data: &serde_json::Value) -> serde_json::Value {
    let mut cfg = serde_json::Map::new();
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            if k == "name" || k == "transport" || k == "disabled" {
                continue;
            }
            if v.is_null() {
                continue;
            }
            if k == "env" {
                if let Some(e) = v.as_object() {
                    if e.is_empty() {
                        continue;
                    }
                }
            }
            if k == "args" {
                if let Some(a) = v.as_array() {
                    if a.is_empty() {
                        continue;
                    }
                }
            }
            cfg.insert(k.clone(), v.clone());
        }
    }
    serde_json::Value::Object(cfg)
}

/// 生成列表展示用的描述文本：stdio 显 command+args，sse/http 显 type+url。
fn describe_mcp(cfg: &serde_json::Value) -> String {
    if let Some(c) = cfg.get("command").and_then(|v| v.as_str()) {
        let args = cfg
            .get("args")
            .and_then(|a| a.as_array())
            .map(|v| {
                v.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        format!("{} {}", c, args)
    } else if let Some(u) = cfg.get("url").and_then(|v| v.as_str()) {
        let t = if cfg.get("headers").is_some() {
            "http"
        } else {
            "sse"
        };
        format!("{} {}", t, u)
    } else {
        String::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMcpServerArgs {
    data: serde_json::Value,
}

async fn create_mcp_server(_core: Arc<Core>, a: CreateMcpServerArgs) -> Result<CustomizationItem, String> {
    let CreateMcpServerArgs { data } = a;
    {
    let name = data["name"].as_str().unwrap_or("unnamed").to_string();
    let cfg = build_mcp_config(&data);
    let mut settings = load_settings();
    settings
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    settings["mcpServers"][name.as_str()] = cfg.clone();
    save_settings(&settings)?;

    Ok(CustomizationItem {
        id: name.clone(),
        name,
        r#type: "mcp_server".to_string(),
        enabled: true,
        path: settings_path().to_string_lossy().to_string(),
        description: Some(describe_mcp(&cfg)),
        metadata: Some(cfg),
    })
}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpServerArgs {
    id: String,
    data: serde_json::Value,
}

async fn update_mcp_server(_core: Arc<Core>, a: UpdateMcpServerArgs) -> Result<(), String> {
    let UpdateMcpServerArgs { id, data } = a;
    {
    let cfg = build_mcp_config(&data);
    let mut settings = load_settings();
    if let Some(servers) = settings
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
    {
        // 保留原 disabled 状态（toggle 单独管），其余整体替换为前端透传的 config。
        let disabled = servers.get(&id).and_then(|c| c.get("disabled")).cloned();
        let mut new_cfg = cfg;
        if let Some(d) = disabled {
            if let Some(obj) = new_cfg.as_object_mut() {
                obj.insert("disabled".into(), d);
            }
        }
        servers.insert(id, new_cfg);
    }
    save_settings(&settings)
}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMcpServerArgs {
    id: String,
}

async fn delete_mcp_server(_core: Arc<Core>, a: DeleteMcpServerArgs) -> Result<(), String> {
    let DeleteMcpServerArgs { id } = a;
    blocking(move || -> Result<(), String> {
    let mut settings = load_settings();
    if let Some(mcp_servers) = settings.get_mut("mcpServers") {
        if let Some(obj) = mcp_servers.as_object_mut() {
            obj.remove(&id);
        }
    }
    save_settings(&settings)
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleMcpServerArgs {
    id: String,
    enabled: bool,
}

async fn toggle_mcp_server(_core: Arc<Core>, a: ToggleMcpServerArgs) -> Result<(), String> {
    let ToggleMcpServerArgs { id, enabled } = a;
    blocking(move || -> Result<(), String> {
    let mut settings = load_settings();
    if let Some(mcp_servers) = settings.get_mut("mcpServers") {
        if let Some(config) = mcp_servers.get_mut(&id) {
            if let Some(obj) = config.as_object_mut() {
                if enabled {
                    obj.remove("disabled");
                } else {
                    obj.insert("disabled".to_string(), serde_json::json!(true));
                }
            }
        } else {
            return Err(format!("MCP server '{}' not found", id));
        }
    } else {
        return Err(format!("MCP server '{}' not found", id));
    }

    save_settings(&settings)
}).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_mcp_config_stdio() {
        let data = serde_json::json!({ "transport": "stdio", "command": "npx", "args": ["-y", "srv"], "env": {} });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["command"], "npx");
        assert!(cfg["args"].is_array());
        assert!(!cfg.as_object().unwrap().contains_key("disabled"));
        assert!(!cfg.as_object().unwrap().contains_key("transport"));
        assert!(!cfg.as_object().unwrap().contains_key("env")); // 空 env 跳过
    }

    #[test]
    fn build_mcp_config_sse_strips_transport() {
        let data = serde_json::json!({ "transport": "sse", "url": "http://x/sse" });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["url"], "http://x/sse");
        assert!(!cfg.as_object().unwrap().contains_key("transport"));
    }

    #[test]
    fn build_mcp_config_http() {
        let data = serde_json::json!({ "transport": "http", "url": "http://x/mcp", "headers": { "Authorization": "Bearer k" } });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["url"], "http://x/mcp");
        assert_eq!(cfg["headers"]["Authorization"], "Bearer k");
    }

    #[test]
    fn build_mcp_config_strips_name_and_disabled() {
        let data =
            serde_json::json!({ "name": "x", "disabled": true, "command": "npx", "args": ["a"] });
        let cfg = build_mcp_config(&data);
        assert!(!cfg.as_object().unwrap().contains_key("name"));
        assert!(!cfg.as_object().unwrap().contains_key("disabled"));
        assert_eq!(cfg["command"], "npx");
    }

    #[test]
    fn describe_mcp_stdio_and_url() {
        let stdio = serde_json::json!({ "command": "npx", "args": ["-y", "srv"] });
        assert_eq!(describe_mcp(&stdio), "npx -y srv");
        let sse = serde_json::json!({ "type": "sse", "url": "http://x/sse" });
        assert_eq!(describe_mcp(&sse), "sse http://x/sse");
        let http =
            serde_json::json!({ "url": "http://x/mcp", "headers": { "Authorization": "k" } });
        assert_eq!(describe_mcp(&http), "http http://x/mcp");
        assert_eq!(describe_mcp(&serde_json::json!({})), "");
    }
}
