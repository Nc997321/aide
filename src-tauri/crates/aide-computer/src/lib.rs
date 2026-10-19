//! aide-computer：让 agent 像人一样操作电脑——经 UI Automation 读窗口、用真实输入做动作、做完核对。
//!
//! 设计：docs/superpowers/specs/2026-10-19-computer-use-design.md
//!
//! 分层（可替换技术藏在端口后面）：
//! - [`protocol`]：sidecar 的 `computer_query` ↔ `computer_result`；
//! - [`engine`]：策略（输入锁、观察版本、元素引用、校验、回报、接管、急停），纯 Rust；
//! - [`port`]：`Backend` / `Guard` 两个端口；
//! - `adapter/`：平台实现（Windows = UIA + SendInput + 截屏；其他平台如实回「暂不支持」）。
//!
//! 桌面壳只需：`Computer::start(hooks)`，把 `computer_query` 交给 [`Computer::answer_blocking`]，
//! 把每条 chat-event 交给 [`Computer::observe_event`]。

pub mod adapter;
pub mod apps;
pub mod engine;
pub mod keys;
pub mod model;
pub mod port;
pub mod protocol;
pub mod prune;
pub mod refs;

use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

pub use engine::SessionSignal;
pub use port::HostHooks;
pub use protocol::{parse_request, Request};

use port::{SharedSignals, Signals};

enum Job {
    Query(Request, mpsc::Sender<Value>),
    Signal(String, SessionSignal),
}

/// 执行器句柄。内部一条专用线程（UIA 的 COM 对象不跨线程），请求按到达顺序处理。
#[derive(Clone)]
pub struct Computer {
    tx: mpsc::Sender<Job>,
    signals: SharedSignals,
}

/// 等执行器回包的上限：最长的等待是 60 s，再留余量。
const ANSWER_TIMEOUT: Duration = Duration::from_secs(90);
const TICK: Duration = Duration::from_millis(200);

impl Computer {
    pub fn start(host: Arc<dyn HostHooks>) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let signals: SharedSignals = Arc::new(Signals::default());
        let thread_signals = Arc::clone(&signals);
        let spawned = std::thread::Builder::new().name("aide-computer".into()).spawn(move || {
            #[cfg(windows)]
            let (backend, guard) = adapter::windows::create(Arc::clone(&thread_signals));
            #[cfg(not(windows))]
            let (backend, guard): (adapter::unsupported::Unsupported, Arc<dyn port::Guard>) =
                (adapter::unsupported::Unsupported, Arc::new(adapter::unsupported::NoGuard));
            let mut engine = engine::Engine::new(backend, guard, host, thread_signals);
            loop {
                match rx.recv_timeout(TICK) {
                    Ok(Job::Query(req, reply)) => {
                        let started = Instant::now();
                        let payload = engine.handle(&req);
                        let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        tracing::info!(
                            op = req.query.op_name(),
                            request_id = %req.request_id,
                            ok,
                            ms = started.elapsed().as_millis() as u64,
                            "computer query"
                        );
                        if !ok {
                            let error = payload.get("error").and_then(Value::as_str).unwrap_or("");
                            tracing::warn!(op = req.query.op_name(), error, "computer query failed");
                        }
                        let _ = reply.send(protocol::result_command(&req.request_id, payload));
                    }
                    Ok(Job::Signal(sid, signal)) => engine.session_signal(&sid, signal),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                engine.tick();
            }
        });
        if let Err(e) = spawned {
            tracing::error!("aide-computer: cannot start executor thread: {e}");
        }
        Self { tx, signals }
    }

    /// 执行一个请求，返回打好 `computer_result` 标的回包命令（阻塞；调用方放进 `spawn_blocking`）。
    pub fn answer_blocking(&self, req: Request) -> Value {
        let request_id = req.request_id.clone();
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.tx.send(Job::Query(req, reply_tx)).is_err() {
            return protocol::result_command(
                &request_id,
                protocol::err_payload("The computer-use executor is not running in this Aide instance."),
            );
        }
        reply_rx.recv_timeout(ANSWER_TIMEOUT).unwrap_or_else(|_| {
            protocol::result_command(&request_id, protocol::err_payload("The computer-use executor did not answer in time."))
        })
    }

    /// 喂一条 chat-event：用户新消息解除接管暂停；一轮结束放锁、让进行中的等待收手。
    pub fn observe_event(&self, event: &Value) {
        let Some(kind) = event.get("type").and_then(Value::as_str) else { return };
        let signal = match kind {
            "user_message" => SessionSignal::UserMessage,
            "completed" | "failed" | "stopped" => SessionSignal::TurnEnd,
            _ => return,
        };
        let Some(sid) = event.get("session_id").and_then(Value::as_str) else { return };
        if signal == SessionSignal::TurnEnd {
            // 带外：执行线程可能正卡在一个等待里，先让它看到。
            self.signals.cancel(sid);
        }
        let _ = self.tx.send(Job::Signal(sid.to_string(), signal));
    }
}
