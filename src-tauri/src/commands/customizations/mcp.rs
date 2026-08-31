// mcp 子域：settings.json mcpServers 清单增删改启停 + 探活（test_mcp_connection）。
// 内置项的 UI 展示另有 useCustomizations.ts 静态镜像（sidecar 侧登记，两处同步）。
use super::{load_settings, save_settings, settings_path, CustomizationItem};
// ── MCP Server Commands ──

#[tauri::command]
pub fn list_mcp_servers() -> Result<Vec<CustomizationItem>, String> {
    let _trace = crate::diagnostics::trace_command("list_mcp_servers");
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

#[tauri::command]
pub async fn create_mcp_server(data: serde_json::Value) -> Result<CustomizationItem, String> {
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

#[tauri::command]
pub async fn update_mcp_server(id: String, data: serde_json::Value) -> Result<(), String> {
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

#[tauri::command]
pub fn delete_mcp_server(id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("delete_mcp_server");
    let mut settings = load_settings();
    if let Some(mcp_servers) = settings.get_mut("mcpServers") {
        if let Some(obj) = mcp_servers.as_object_mut() {
            obj.remove(&id);
        }
    }
    save_settings(&settings)
}

#[tauri::command]
pub fn toggle_mcp_server(id: String, enabled: bool) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("toggle_mcp_server");
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
}

// ── MCP 探活 ──

#[derive(Debug, serde::Serialize)]
pub struct TestResult {
    pub status: String,
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// 探活一个 MCP server：spawn agent-runtime 跑 test-mcp 子命令，收集 stdout JSON。
/// config = { transport, command?, args?, env?, url?, headers? }。
/// Windows 加 CREATE_NO_WINDOW；路径经 resolve_runtime_command 走 dev/release 分支。
#[tauri::command]
pub async fn test_mcp_connection(
    app: tauri::AppHandle,
    config: serde_json::Value,
) -> Result<TestResult, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let (bin, runtime_arg) = crate::runtime::AgentRuntimeManager::resolve_runtime_command(&app)?;
    let config_str = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();

    let mut cmd = Command::new(&bin);
    if !runtime_arg.as_os_str().is_empty() {
        cmd.arg(&runtime_arg);
    }
    cmd.arg("test-mcp").arg(&config_str);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = tokio::task::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let duration_ms = start.elapsed().as_millis() as u64;

    if !out.status.success() {
        return Ok(TestResult {
            status: "spawn_error".into(),
            tools: vec![],
            error: Some(String::from_utf8_lossy(&out.stderr).to_string()),
            duration_ms,
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    // stdout 最后一行非空是 test-mcp 的 JSON（前面无 server stderr 转发——server stderr 进本进程 stderr pipe）。
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    match serde_json::from_str::<serde_json::Value>(json_line) {
        Ok(v) => Ok(TestResult {
            status: v["status"]
                .as_str()
                .unwrap_or("handshake_error")
                .to_string(),
            tools: v["tools"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            error: v["error"].as_str().map(String::from),
            duration_ms,
        }),
        Err(e) => Ok(TestResult {
            status: "handshake_error".into(),
            tools: vec![],
            error: Some(format!("{}: {}", e, stdout)),
            duration_ms,
        }),
    }
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

#[cfg(test)]
mod result_tests {
    use super::*;

    #[test]
    fn testresult_serializes() {
        let r = TestResult {
            status: "ok".into(),
            tools: vec!["a".into(), "b".into()],
            error: None,
            duration_ms: 42,
        };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["status"], "ok");
        assert_eq!(j["tools"][0], "a");
        assert_eq!(j["duration_ms"], 42);
        assert!(j.as_object().unwrap().get("error").is_none()); // skip_serializing_if
    }
}
