//! 假 Host：给协议一致性测试用（会话逻辑不依赖真实 Host）。真实的 Host 实现（aide-host）用同一批
//! 一致性向量验证自己（见 [`crate::conformance::Harness`]）。

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::auth::{Credentials, MemoryVault, TokenVault};
use crate::backend::{Backend, BoxFuture, Subscription};
use crate::catalog::{Catalog, LinkPolicy};
use crate::conformance::Harness;
use crate::frame::{HostFrame, HostInfo, Since, Subscribed};

pub const EPOCH: &str = "epoch-1";
/// 一致性向量里约定的固定值（向量文件里直接写这些字面量）。
pub const FIXTURE_CODE: &str = "123456";
pub const FIXTURE_TOKEN: &str = "test-token";

struct Entry {
    seq: u64,
    name: String,
    payload: Value,
}

struct Consumer {
    sink: UnboundedSender<HostFrame>,
    sessions: Option<Vec<String>>,
    id: u64,
}

#[derive(Default)]
struct BusState {
    ring: Vec<Entry>,
    consumers: Vec<Consumer>,
    next_id: u64,
}

/// 假事件总线：全量留底（不限长）、按订阅过滤、先 `subscribed` 后回放再实时。
#[derive(Default)]
pub struct FakeBus {
    state: Arc<Mutex<BusState>>,
}

fn session_of(name: &str, payload: &Value) -> Option<String> {
    (name == "chat-event").then(|| payload.get("session_id").and_then(Value::as_str).map(str::to_string)).flatten()
}

fn wanted(sessions: &Option<Vec<String>>, name: &str, payload: &Value) -> bool {
    match (sessions, session_of(name, payload)) {
        (Some(list), Some(sid)) => list.contains(&sid),
        _ => true,
    }
}

impl FakeBus {
    pub fn emit(&self, name: &str, payload: Value) {
        let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let seq = st.ring.len() as u64 + 1;
        st.ring.push(Entry { seq, name: name.to_string(), payload: payload.clone() });
        if !Catalog::is_event_exposed(name) {
            return;
        }
        for c in &st.consumers {
            if wanted(&c.sessions, name, &payload) {
                let _ = c.sink.send(HostFrame::Event { seq, name: name.to_string(), payload: payload.clone() });
            }
        }
    }

    fn attach(&self, sink: UnboundedSender<HostFrame>, sessions: Option<Vec<String>>, since: Option<Since>) -> FakeSub {
        let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let head = st.ring.len() as u64;
        let resumed = since.as_ref().is_some_and(|s| s.epoch == EPOCH);
        let from = since.filter(|s| s.epoch == EPOCH).map(|s| s.seq).unwrap_or(head);
        let replay: Vec<HostFrame> = st
            .ring
            .iter()
            .filter(|e| e.seq > from && Catalog::is_event_exposed(&e.name) && wanted(&sessions, &e.name, &e.payload))
            .map(|e| HostFrame::Event { seq: e.seq, name: e.name.clone(), payload: e.payload.clone() })
            .collect();
        let _ = sink.send(HostFrame::Subscribed(Subscribed {
            epoch: EPOCH.into(),
            seq: head,
            resumed,
            gap: false,
            replayed: replay.len() as u64,
        }));
        for f in replay {
            let _ = sink.send(f);
        }
        let id = st.next_id;
        st.next_id += 1;
        st.consumers.push(Consumer { sink, sessions, id });
        FakeSub { state: Arc::clone(&self.state), id }
    }
}

struct FakeSub {
    state: Arc<Mutex<BusState>>,
    id: u64,
}

impl Subscription for FakeSub {}

impl Drop for FakeSub {
    fn drop(&mut self) {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).consumers.retain(|c| c.id != self.id);
    }
}

/// 假 Host 后端：命令脚本化，事件走 [`FakeBus`]。
pub struct FakeBackend {
    pub bus: FakeBus,
    pub policy: LinkPolicy,
}

impl Default for FakeBackend {
    fn default() -> Self {
        Self { bus: FakeBus::default(), policy: LinkPolicy { permission_mode: "acceptEdits".into() } }
    }
}

impl Backend for FakeBackend {
    fn host(&self) -> HostInfo {
        HostInfo {
            id: "dev-1".into(),
            name: "fake-host".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            version: "0.0.0-test".into(),
        }
    }

    fn policy(&self) -> LinkPolicy {
        self.policy.clone()
    }

    fn call(&self, method: &str, params: Value) -> BoxFuture<Result<Value, String>> {
        let method = method.to_string();
        Box::pin(async move {
            match method.as_str() {
                "list_sessions" => Ok(json!(["s1", "s2"])),
                // 回显参数：让向量看得到链路预处理（默认权限模式等）
                "send_message" | "get_settings" => Ok(params),
                "set_model" => Err("model not found".into()),
                "load_messages" => {
                    // 慢命令：证明慢调用不堵后面的帧（应答无序到达）
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    Ok(json!(["slow"]))
                }
                _ => Ok(Value::Null),
            }
        })
    }

    fn attach_events(
        &self,
        sink: UnboundedSender<HostFrame>,
        sessions: Option<Vec<String>>,
        since: Option<Since>,
    ) -> Box<dyn Subscription> {
        Box::new(self.bus.attach(sink, sessions, since))
    }
}

/// 假 Host 的一致性测试装置。
pub struct FakeHarness {
    pub backend: Arc<FakeBackend>,
    pub creds: Arc<Credentials>,
}

impl FakeHarness {
    pub fn new() -> Self {
        let vault = Arc::new(MemoryVault::default());
        vault.store(FIXTURE_TOKEN).expect("memory vault");
        let creds = Arc::new(Credentials::new(vault, "dev-1".into()));
        creds.force_pairing_code(FIXTURE_CODE);
        Self { backend: Arc::new(FakeBackend::default()), creds }
    }
}

impl Default for FakeHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness for FakeHarness {
    fn backend(&self) -> Arc<dyn Backend> {
        self.backend.clone()
    }
    fn credentials(&self) -> Arc<Credentials> {
        Arc::clone(&self.creds)
    }
    fn emit(&self, name: &str, payload: Value) {
        self.backend.bus.emit(name, payload);
    }
}
