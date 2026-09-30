//! sidecar stdout 泵：心跳看门狗 + 事件分发 + codegraph / LSP / 浏览器桥拦截。
//!
//! 从 `spawn_runtime` 抽出。一个 Host 一个 sidecar 进程，一条泵（WSL / SSH 工作区的会话跑在
//! 那台 Host 自己的泵里，见 docs/host-model.md）。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

use super::emit_runtime_dead;
use crate::Core;

pub struct Pump {
    pub core: Arc<Core>,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    /// 桥查询的回写通道（与命令写入同一个 stdin）。
    pub stdin: Arc<TokioMutex<ChildStdin>>,
    pub child: Arc<TokioMutex<Child>>,
    pub killed: Arc<AtomicBool>,
    pub chat_events: tokio::sync::broadcast::Sender<Value>,
}

pub fn start(p: Pump) {
    let Pump {
        core,
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
                    // codegraph agent 工具查询：Rust ↔ Runtime 内部 request/response，不转发 Vue。
                    // 查询在独立任务里跑，不阻塞 reader 主循环——慢查询
                    // （大 shard 搜索 / HTTP embed）不能卡住心跳与其他事件的读取。
                    // 进程隔离后：查询经 CodeGraphService RPC 转给 runner 执行，
                    // sidecar 协议解析/组装（codegraph_query → codegraph_result）留主进程。
                    if let Some(req) =
                        crate::codegraph::agent_bridge::parse_codegraph_query(&event)
                    {
                        let core = core.clone();
                        let stdin2 = stdin_for_agent.clone();
                        tokio::spawn(async move {
                            let payload = crate::codegraph::agent_bridge::answer(&core, &req).await;
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
                        let core2 = core.clone();
                        let stdin2 = stdin_for_agent.clone();
                        tokio::spawn(async move {
                            super::lsp_agent::handle(core2, stdin2, req).await;
                        });
                        continue;
                    }
                    // 宿主认领的工具查询（内嵌浏览器——GUI 能力，见 ports::AgentHooks）：
                    // Rust ↔ Runtime 的内部 request/response，**不转发 Vue**。
                    if let Some(hooks) = core.runtime.hooks() {
                        if hooks.intercept(&event, &stdin_for_agent) {
                            continue;
                        }
                    }
                    // 心跳只喂看门狗，不转发前端
                    if event.get("type").and_then(|t| t.as_str()) == Some("heartbeat") {
                        continue;
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
                    // 旁路观察（诊断黑匣子计量与留痕）：GUI 宿主的事，经钩子。
                    if let Some(hooks) = core.runtime.hooks() {
                        hooks.observe(&event, line.len());
                    }
                    // 自动化运行终态观测：非活跃会话/非终态事件立即返回，
                    // 终态落盘在内部 spawn 出去做，不堵事件泵。
                    core.automation.observe_chat_event(&event);
                    // 后台任务注册表：远程快照源（list_bg_tasks RPC）。桌面常驻
                    // 在线、是唯一看全 bg_task_* 流的一端；手机打开会话/重连时
                    // 对账离线期间错过的任务。进程级死亡兜底见 emit_runtime_dead。
                    core.runtime.bg_tasks.feed(&event);
                    // 会话存活表：session_init 登记 / session_dead 移除。远程端
                    // 判断「跟随全局还是锁定会话供应商」的唯一权威来源（前端的
                    // useSessionState 在 Rust 侧拿不到）。
                    {
                        let mgr = &core.runtime;
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
                    let _ = chat_events_tx.send(event.clone());
                    core.emit("chat-event", event);
                }
                Ok(Ok(None)) | Ok(Err(_)) => break "exit",
                Err(_) => break "heartbeat_timeout",
            }
        };

        let report = |core: &Core| emit_runtime_dead(core, &stderr_tail, reason);
        if reason == "heartbeat_timeout" {
            report(&core);
            killed_clone.store(true, Ordering::Relaxed);
            let mut c = child_for_kill.lock().await;
            let _ = c.start_kill();
        } else if !killed_clone.load(Ordering::Relaxed) {
            report(&core);
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
            eprintln!("[runtime stderr] {}", line);
            let mut buf = tail_writer.lock().unwrap();
            if buf.len() >= 8 {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    });
}
