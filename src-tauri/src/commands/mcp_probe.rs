//! MCP server 探活：拉起 agent runtime 的 `test-mcp` 子命令。依赖 agent runtime 的可执行
//! 路径解析（`AgentRuntimeManager`），随 runtime 在 Host 模型 P0-4 迁入 aide-core；其余
//! MCP 配置命令已在 `aide_core::commands::customizations::mcp`。

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
