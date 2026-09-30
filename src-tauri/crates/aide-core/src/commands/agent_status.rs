//! agent runtime 的状态查询与探活：会话存活、通知上下文、后台任务快照、MCP server 探活。

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::registry::Command as HostCommand;
use crate::runtime::bg_registry::BgTaskSnapshot;
use crate::{command, Core};

pub static COMMANDS: &[HostCommand] = &[
    command!("session_alive", session_alive),
    command!("session_notification_info", session_notification_info),
    command!("list_bg_tasks", list_bg_tasks),
    command!("test_mcp_connection", test_mcp_connection),
    command!("agent_tool_result", agent_tool_result),
];

/// GUI 侧工具的应答能回写给 agent 的命令（sidecar 协议里的结果命令名）。只放行这些——
/// 本命令不是通往 sidecar stdin 的通用后门。
const GUI_TOOL_RESULTS: &[&str] = &["browser_result"];

#[derive(Deserialize)]
pub struct AgentToolResultArgs {
    payload: serde_json::Value,
}

/// GUI 侧工具（内嵌浏览器…）答完 agent 的查询，把结果写回这台 Host 的 agent runtime。
///
/// 一个窗口 = 一个 Host：Host 的 sidecar 发出的 `browser_query` 经事件到了 GUI，GUI 执行后
/// 由它回到 Host——本机窗口走进程内钩子（`runtime::ports::AgentHooks`），不经这里。
async fn agent_tool_result(core: Arc<Core>, a: AgentToolResultArgs) -> Result<(), String> {
    let cmd = a.payload.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    if !GUI_TOOL_RESULTS.contains(&cmd) {
        return Err(format!("agent_tool_result: `{cmd}` is not a GUI tool result"));
    }
    core.runtime.send_to_runtime(&a.payload).await
}

#[derive(Deserialize)]
pub struct SessionAliveArgs {
    id: String,
}

/// 会话进程是否存活（唯一权威来源：Rust 侧存活表，见 `AgentRuntimeManager::session_alive`）。
///
/// 远程端用它决定模型下拉的口径：
///  - **存活** → 锁定会话自己的供应商。此时切到别的供应商的模型，请求会带着新模型名
///    打到旧供应商的 baseUrl 上，直接 400（手机端报的 `glm` 送到 deepseek 就是这么来的）。
///  - **未存活** → 跟随全局激活供应商，与桌面「有活进程才锁定」同一语义。
///
/// 此前远程端无从判断，只能无条件按全局算下拉，于是存活会话也被换成了别的供应商的模型。
async fn session_alive(core: Arc<Core>, a: SessionAliveArgs) -> Result<bool, String> {
    Ok(core.runtime.is_session_alive(&a.id))
}

/// 桌面通知的会话上下文：按 session_id 查它**真实所属的工作区**（send_message
/// 注册的进程内路由表）+ 会话显示名。会话是内存形态——进程死了 claude cli 也
/// 随之关闭，不存在重启后还要通知的会话，因此路由表即权威、无需落盘兜底。
/// 查不到路由（如新会话 finalize 换 key 后尚未再 send）返回 None，前端回退
/// 当前工作区名。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotificationInfo {
    /// 会话所属工作区根路径
    pub workspace: String,
    /// 会话显示名（our_session_name 权威源，缺失回退 session id）
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdArgs {
    session_id: String,
}

async fn session_notification_info(
    core: Arc<Core>,
    a: SessionIdArgs,
) -> Result<Option<SessionNotificationInfo>, String> {
    let Some(workspace) = core.runtime.session_workspace_root(&a.session_id) else {
        return Ok(None);
    };
    let session_id = a.session_id;
    crate::registry::blocking(move || {
        let name = crate::session_store::our_session_name(&session_id).unwrap_or(session_id);
        Ok(Some(SessionNotificationInfo {
            workspace: workspace.to_string_lossy().to_string(),
            name,
        }))
    })
    .await
}

/// 后台任务快照：远程客户端打开会话/重连后对账 bgTasks（bg_task_* 事件流
/// 只做实时转发无重放，离线期间错过的任务靠这里回填）。
async fn list_bg_tasks(core: Arc<Core>, a: SessionIdArgs) -> Result<Vec<BgTaskSnapshot>, String> {
    Ok(core.runtime.bg_tasks.list(&a.session_id))
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

#[derive(Deserialize)]
pub struct TestMcpConnectionArgs {
    config: serde_json::Value,
}

/// 探活一个 MCP server：spawn agent-runtime 跑 test-mcp 子命令，收集 stdout JSON。
/// config = { transport, command?, args?, env?, url?, headers? }。
/// Windows 加 CREATE_NO_WINDOW；启动命令由资源端口给（dev/release 分支在前门）。
async fn test_mcp_connection(core: Arc<Core>, a: TestMcpConnectionArgs) -> Result<TestResult, String> {
    let config = a.config;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let (bin, runtime_arg) = core.resources.agent_runtime()?;
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
