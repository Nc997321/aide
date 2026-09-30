//! sidecar stdout 泵：心跳看门狗 + 事件分发 + codegraph / LSP / 浏览器桥拦截。
//!
//! 从 `spawn_runtime` 抽出，按**车道**（lane）参数化：本机车道 = 原有行为逐字不变；
//! 远程车道（WSL / SSH 上的 sidecar，经 `aide-host agent` 管道）复用同一条泵，只在
//! 三处分叉——桥查询就地回错、事件路径译回桌面形态、进程死亡只波及本车道的会话。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

use super::{emit_runtime_dead, AgentRuntimeManager};
use crate::remote_workspace::path::HostId;

/// sidecar 进程跑在哪。
#[derive(Clone, Debug, PartialEq)]
pub enum Lane {
    Local,
    Remote(HostId),
}

impl Lane {
    fn tag(&self) -> String {
        match self {
            Lane::Local => String::new(),
            Lane::Remote(h) => format!(" {h}"),
        }
    }
}

pub(super) struct Pump {
    pub app: AppHandle,
    pub lane: Lane,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    /// 桥查询的回写通道（与命令写入同一个 stdin）。
    pub stdin: Arc<TokioMutex<ChildStdin>>,
    pub child: Arc<TokioMutex<Child>>,
    pub killed: Arc<AtomicBool>,
    pub chat_events: tokio::sync::broadcast::Sender<Value>,
}

pub(super) fn start(p: Pump) {
    let Pump {
        app,
        lane,
        stdout,
        stderr,
        stdin: stdin_for_agent,
        child: child_for_kill,
        killed: killed_clone,
        chat_events: chat_events_tx,
    } = p;
    // stderr 尾部缓冲
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let tail_for_reader = Arc::clone(&stderr_tail);
    let tail_for_stderr = Arc::clone(&stderr_tail);
    let lane_for_stderr = lane.clone();

    tokio::spawn(async move {
        let stderr_tail = tail_for_reader;
        const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
        let mut reader = BufReader::new(stdout).lines();
        let reason: &str = loop {
            match tokio::time::timeout(HEARTBEAT_TIMEOUT, reader.next_line()).await {
                Ok(Ok(Some(line))) => {
                    let Ok(mut event) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    // 远程车道：codegraph 桥查询由本机服务执行，而工作区在目标机上
                    // ——就地回错误结果（不回就是让 agent 白等 15s 超时）。LSP 桥照常走下面的
                    // 分派：语言服务器经 aide-host 跑在目标机上，查询在 lsp_agent 里做路径互译。浏览器桥照常
                    // 放行：内嵌浏览器就在桌面上，远程 agent 用它天经地义。
                    if let Lane::Remote(host) = &lane {
                        if super::remote_lane::answer_unsupported_bridge(&event, host, &stdin_for_agent).await {
                            continue;
                        }
                    }
                    // codegraph agent 工具查询：Rust ↔ Runtime 内部 request/response，不转发 Vue。
                    // 查询在独立任务里跑，不阻塞 reader 主循环——慢查询
                    // （大 shard 搜索 / HTTP embed）不能卡住心跳与其他事件的读取。
                    // 进程隔离后：查询经 CodeGraphService RPC 转给 runner 执行，
                    // sidecar 协议解析/组装（codegraph_query → codegraph_result）留主进程。
                    if let Some(req) =
                        crate::codegraph::agent_bridge::parse_codegraph_query(&event)
                    {
                        use tauri::Manager;
                        let app2 = app.clone();
                        let stdin2 = stdin_for_agent.clone();
                        tokio::spawn(async move {
                            // 政策层输入：阈值按当前 settings 现解析（query-time，
                            // 不缓存、不重建）；trusted 同理由主进程计算——
                            // 信任是政策，runner 是机制。两者都是阻塞读，收进
                            // spawn_blocking。
                            let trust_root = req.project_root.clone();
                            let app_for_policy = app2.clone();
                            let (score_threshold, trusted) =
                                tokio::task::spawn_blocking(move || {
                                    let score_threshold = app_for_policy
                                        .try_state::<Arc<crate::settings::SettingsService>>()
                                        .map(|s| {
                                            crate::codegraph::query_score_threshold(s.inner())
                                        })
                                        .unwrap_or(0.35);
                                    let trusted = crate::commands::workspace::is_path_trusted(
                                        &trust_root,
                                    );
                                    (score_threshold, trusted)
                                })
                                .await
                                .unwrap_or((0.35, false));
                            let body = match app2
                                .try_state::<Arc<crate::codegraph::CodeGraphService>>()
                            {
                                Some(svc) => {
                                    match svc
                                        .agent_query(
                                            &req.tool,
                                            &req.args,
                                            &req.project_root,
                                            trusted,
                                            score_threshold,
                                        )
                                        .await
                                    {
                                        Ok(v) => v,
                                        Err(e) => serde_json::json!({
                                            "ok": false, "status": "error",
                                            "error": e,
                                        }),
                                    }
                                }
                                None => serde_json::json!({
                                    "ok": false, "status": "error",
                                    "error": "codegraph service unavailable",
                                }),
                            };
                            let payload = crate::codegraph::agent_bridge::build_result_command(
                                &req.request_id,
                                body,
                            );
                            if let Ok(mut line) = serde_json::to_string(&payload) {
                                line.push('\n');
                                let mut g = stdin2.lock().await;
                                let _ = g.write_all(line.as_bytes()).await;
                            }
                        });
                        continue;
                    }
                    // agent LSP 查询：同 codegraph，是 Rust ↔ Runtime 的内部 request/response，
                    // **不转发 Vue**。与 codegraph 的区别：查询本体**不跳 runner**——LspManager
                    // 就在本进程，直接就地派发。执行体在 `runtime/lsp_agent.rs`——这里只做
                    // 「拦截 + 派发」，业务不内联（同 browser 的理由：本文件有 1000 行拆分线）。
                    if let Some(req) = crate::lsp::agent_bridge::parse_lsp_query(&event) {
                        let app2 = app.clone();
                        let stdin2 = stdin_for_agent.clone();
                        let host = match &lane {
                            Lane::Remote(h) => Some(h.clone()),
                            Lane::Local => None,
                        };
                        tokio::spawn(async move {
                            crate::runtime::lsp_agent::handle(app2, stdin2, req, host).await;
                        });
                        continue;
                    }
                    // 内嵌浏览器 agent 工具查询：同 codegraph，是 Rust ↔ Runtime 的内部
                    // request/response，**不转发 Vue**。执行体在 `runtime/browser_agent.rs`
                    // ——这里只做「拦截 + 派发」，业务不内联（也避免本文件撞 1000 行拆分线）。
                    if let Some(req) = crate::browser::agent_bridge::parse_browser_query(&event)
                    {
                        let app_browser = app.clone();
                        let stdin_browser = stdin_for_agent.clone();
                        tokio::spawn(async move {
                            crate::runtime::browser_agent::handle(
                                app_browser,
                                stdin_browser,
                                req,
                            )
                            .await;
                        });
                        continue;
                    }
                    // 心跳只喂看门狗，不转发前端
                    if event.get("type").and_then(|t| t.as_str()) == Some("heartbeat") {
                        continue;
                    }
                    // 诊断黑匣子：chat-event 出口按秒计量
                    {
                        use tauri::Manager;
                        if let Some(diag) =
                            app.try_state::<crate::diagnostics::DiagnosticsState>()
                        {
                            let event_type = event
                                .get("type")
                                .and_then(|t| t.as_str())
                                .unwrap_or("unknown");
                            // session_init 事件的 session_id 是 SDK 真实会话 ID，
                            // 路由键在 _routing_id；其他事件的 session_id 即路由键。
                            let sid = event
                                .get("_routing_id")
                                .or_else(|| event.get("session_id"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("unknown");
                            diag.record_chat_event(sid, event_type, line.len() as u64);
                        }
                    }
                    // session_init 事件：SDK 的 session_id 是真实会话 ID，
                    // _routing_id 是 SessionManager 的路由键（临时 key）。
                    // 还原旧行为：session_id = 路由键（前端路由），sdk_session_id = 真 ID。
                    if let Some(obj) = event.as_object_mut() {
                        if obj.get("type").and_then(|t| t.as_str()) == Some("session_init") {
                            if let Some(sdk_sid) = obj.get("session_id").cloned() {
                                obj.insert("sdk_session_id".to_string(), sdk_sid);
                            }
                            if let Some(routing_id) = obj.get("_routing_id").cloned() {
                                obj.insert("session_id".to_string(), routing_id);
                            }
                        }
                    }
                    crate::diagnostics::trace::record(
                        "emit",
                        event
                            .get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("unknown"),
                        "worker",
                    );
                    // 自动化运行终态观测：非活跃会话/非终态事件立即返回，
                    // 终态落盘在内部 spawn 出去做，不堵事件泵。
                    if let Some(svc) =
                        app.try_state::<std::sync::Arc<crate::automation::AutomationService>>()
                    {
                        svc.observe_chat_event(&event);
                    }
                    // 后台任务注册表：远程快照源（list_bg_tasks RPC）。桌面常驻
                    // 在线、是唯一看全 bg_task_* 流的一端；手机打开会话/重连时
                    // 对账离线期间错过的任务。进程级死亡兜底见 emit_runtime_dead。
                    if let Some(reg) =
                        app.try_state::<Arc<crate::runtime::bg_registry::BgTaskRegistry>>()
                    {
                        reg.feed(&event);
                    }
                    // 会话存活表：session_init 登记 / session_dead 移除。远程端
                    // 判断「跟随全局还是锁定会话供应商」的唯一权威来源（前端的
                    // useSessionState 在 Rust 侧拿不到）。
                    if let Some(mgr) = app.try_state::<AgentRuntimeManager>() {
                        let ety = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if ety == "session_init" || ety == "session_dead" {
                            if let Some(sid) = event.get("session_id").and_then(|s| s.as_str())
                            {
                                if ety == "session_init" {
                                    mgr.mark_session_alive(sid);
                                } else {
                                    mgr.mark_session_dead(sid);
                                }
                            }
                        }
                    }
                    // 远程车道：结构化字段里的目标机路径译回桌面形态（前端据此打开文件 /
                    // 算 diff，拿到的必须是能再交回 IPC 的路径）。
                    if let Lane::Remote(host) = &lane {
                        super::remote_lane::map_event_paths(host, &mut event);
                    }
                    let _ = chat_events_tx.send(event.clone());
                    let _ = app.emit("chat-event", event);
                }
                Ok(Ok(None)) | Ok(Err(_)) => break "exit",
                Err(_) => break "heartbeat_timeout",
            }
        };

        let report = |app: &AppHandle| match &lane {
            Lane::Local => emit_runtime_dead(app, &stderr_tail, reason),
            // 远程车道只波及绑在它上面的会话（WSL 关机 / 断网不该连累本机会话）
            Lane::Remote(host) => {
                super::remote_lane::on_lane_dead(app, host, &stderr_tail, reason)
            }
        };
        if reason == "heartbeat_timeout" {
            report(&app);
            killed_clone.store(true, Ordering::Relaxed);
            let mut c = child_for_kill.lock().await;
            let _ = c.start_kill();
        } else if !killed_clone.load(Ordering::Relaxed) {
            report(&app);
        }
    });

    // stderr 只进日志与尾部缓冲
    let tail_writer = tail_for_stderr;
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            eprintln!("[runtime stderr{}] {}", lane_for_stderr.tag(), line);
            let mut buf = tail_writer.lock().unwrap();
            if buf.len() >= 8 {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    });
}
