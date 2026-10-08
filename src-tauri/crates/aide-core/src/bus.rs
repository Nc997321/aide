//! Host 的事件总线：Host 核心发出的**全部**事件在这里编号、留底、按订阅投给连着的消费者。
//!
//! 为什么要它（docs/host-model.md §3 P2d / P3）：
//! - **断线重连保住会话**：Host 常驻，客户端（桌面的桥、手机）来来去去；每个事件带全局序号 `seq`，
//!   环形缓冲留最近一段，重连时客户端报上「最后收到的序号」就能把错过的补回来——UI 看到的是一条没断过
//!   的事件流。缓冲覆盖不到（错过太久）就如实报 `gap`，由客户端决定重新同步。
//! - **按会话订阅投递**（早先 headless 验收过、删除时留下的契约）：多个客户端连同一个 Host 时，
//!   `chat-event` 只送给订阅了该会话的消费者；不带会话号的事件（文件变更 / LSP / 系统通知…）照常全送。
//!
//! 总线是 **Host 自己的**（`Core::bus`），不属于任何前门：本机 Host 与远程 Host 都有；前门 / 网关
//! （aide-host 的桥、Aide Link）各自实现 [`Consumer`] 挂上来，用自己的线上格式序列化事件。
//! `Core::new` 把前门给的 `EventSink` 包一层，所有 `emit` 都先经过总线再到前门（本机桌面的
//! `TauriSink` 照旧直接 `emit_to` 窗口，零额外跳数）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::EventSink;

/// 环形缓冲上限：条数与字节数，先到先止。字节上限是主约束（chat 流的帧大小差别很大）。
const RING_MAX_EVENTS: usize = 50_000;
const RING_MAX_BYTES: usize = 16 << 20;

pub type ClientId = u64;

/// 一个带序号的 Host 事件。
#[derive(Debug)]
pub struct Event {
    /// 在同一 epoch 内单调递增，从 1 起。
    pub seq: u64,
    pub name: String,
    pub payload: Value,
    /// `chat-event` 所属的会话；其余事件 None（对所有消费者可见）。
    pub session: Option<String>,
    size: usize,
}

/// 事件消费者：前门 / 网关把事件按自己的线上格式送出去。
pub trait Consumer: Send + Sync + 'static {
    /// 投递一个事件。返回 `false` = 消费者已死（总线随即摘掉它）。**不得阻塞**（持总线锁调用）。
    fn deliver(&self, ev: &Arc<Event>) -> bool;
}

/// 续传凭据：上次连的是哪一代总线（epoch）、收到第几号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resume {
    pub epoch: String,
    pub seq: u64,
}

/// 接入请求。
#[derive(Default)]
pub struct Attach {
    pub resume: Option<Resume>,
    /// `None` = 全收；`Some` = 只收这些会话的 `chat-event`（回放也按它过滤）。
    pub sessions: Option<Vec<String>>,
    /// 事件名白名单（网关用它只暴露目录里的事件）；`None` = 全部。
    pub allow: Option<fn(&str) -> bool>,
}

/// 接入结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachInfo {
    pub epoch: String,
    /// 带了 `resume` 且 epoch 对得上。
    pub resumed: bool,
    /// 想回放但环形缓冲已覆盖不到：错过的事件有丢失。
    pub gap: bool,
    /// 接入时的最新序号。
    pub seq: u64,
    /// 本次回放了多少条。
    pub replayed: u64,
}

struct Client {
    consumer: Arc<dyn Consumer>,
    sessions: Option<HashSet<String>>,
    allow: Option<fn(&str) -> bool>,
}

impl Client {
    fn wants(&self, name: &str, session: Option<&str>) -> bool {
        if self.allow.is_some_and(|f| !f(name)) {
            return false;
        }
        match (&self.sessions, session) {
            (Some(set), Some(sid)) => set.contains(sid),
            _ => true,
        }
    }
}

struct State {
    /// 下一个要发的序号（从 1 起；0 = 还没发过任何事件）。
    next_seq: u64,
    ring: VecDeque<Arc<Event>>,
    ring_bytes: usize,
    clients: HashMap<ClientId, Client>,
    next_client: ClientId,
    /// 最近一次「有动静」（消费者来去 / chat 事件）——空闲退出的计时起点。
    last_activity: Instant,
}

pub struct Bus {
    epoch: String,
    max_events: usize,
    max_bytes: usize,
    state: Mutex<State>,
}

/// 每次启动随机的身份：客户端据此分辨「还是原来那个 Host」还是「重启过」。
pub fn new_epoch() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    format!("{:016x}", h.finish())
}

impl Bus {
    pub fn new(epoch: String) -> Self {
        Self::with_limits(epoch, RING_MAX_EVENTS, RING_MAX_BYTES)
    }

    pub fn with_limits(epoch: String, max_events: usize, max_bytes: usize) -> Self {
        Self {
            epoch,
            max_events,
            max_bytes,
            state: Mutex::new(State {
                next_seq: 1,
                ring: VecDeque::new(),
                ring_bytes: 0,
                clients: HashMap::new(),
                next_client: 1,
                last_activity: Instant::now(),
            }),
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 登记一个消费者。**先**调 `ack(&info)`（调用方在里面把对 attach 的应答送出去），**再**回放
    /// 错过的事件，最后才加入实时投递——全程在同一把锁里，所以回放与实时之间不丢不重不乱序。
    pub fn attach(
        &self,
        consumer: Arc<dyn Consumer>,
        req: Attach,
        ack: impl FnOnce(&AttachInfo),
    ) -> (ClientId, AttachInfo) {
        let client = Client {
            consumer,
            sessions: req.sessions.map(|v| v.into_iter().collect()),
            allow: req.allow,
        };
        let mut st = self.lock();
        let head = st.next_seq - 1;
        let mut info = AttachInfo { epoch: self.epoch.clone(), resumed: false, gap: false, seq: head, replayed: 0 };
        let mut replay: Vec<Arc<Event>> = Vec::new();
        if let Some(r) = req.resume.filter(|r| r.epoch == self.epoch) {
            info.resumed = true;
            if r.seq > head {
                info.gap = true; // 客户端比我还新：不可能的状态，当作对不上
            } else if r.seq < head {
                if st.ring.front().is_some_and(|e| e.seq <= r.seq + 1) {
                    // 回放也按订阅过滤：受限订阅者重连不能借回放看到别的会话
                    replay = st
                        .ring
                        .iter()
                        .filter(|e| e.seq > r.seq && client.wants(&e.name, e.session.as_deref()))
                        .cloned()
                        .collect();
                } else {
                    info.gap = true;
                }
            }
            info.replayed = replay.len() as u64;
        }
        ack(&info);
        for ev in &replay {
            let _ = client.consumer.deliver(ev);
        }
        let id = st.next_client;
        st.next_client += 1;
        st.clients.insert(id, client);
        st.last_activity = Instant::now();
        (id, info)
    }

    pub fn detach(&self, id: ClientId) {
        let mut st = self.lock();
        st.clients.remove(&id);
        st.last_activity = Instant::now();
    }

    /// 改某消费者的订阅。`None` = 全收。
    pub fn subscribe(&self, id: ClientId, sessions: Option<Vec<String>>) {
        if let Some(c) = self.lock().clients.get_mut(&id) {
            c.sessions = sessions.map(|v| v.into_iter().collect());
        }
    }

    pub fn client_count(&self) -> usize {
        self.lock().clients.len()
    }

    /// 自上次动静起的静默时长。
    pub fn idle_for(&self) -> Duration {
        self.lock().last_activity.elapsed()
    }

    /// 当前最新事件序号（0 = 还没有）。
    pub fn head_seq(&self) -> u64 {
        self.lock().next_seq - 1
    }
}

/// `chat-event` 属于哪个会话（路由键）。其余事件没有会话维度。
fn session_of(event: &str, payload: &Value) -> Option<String> {
    if event != "chat-event" {
        return None;
    }
    payload.get("session_id").and_then(Value::as_str).map(str::to_string)
}

impl EventSink for Bus {
    fn emit(&self, event: &str, payload: Value) {
        let session = session_of(event, &payload);
        let size = payload.to_string().len() + event.len() + 32;
        let mut st = self.lock();
        let seq = st.next_seq;
        st.next_seq += 1;
        if event == "chat-event" {
            st.last_activity = Instant::now();
        }
        let ev = Arc::new(Event { seq, name: event.to_string(), payload, session, size });

        st.ring_bytes += ev.size;
        st.ring.push_back(Arc::clone(&ev));
        while st.ring.len() > self.max_events || (st.ring_bytes > self.max_bytes && st.ring.len() > 1) {
            if let Some(old) = st.ring.pop_front() {
                st.ring_bytes -= old.size;
            }
        }

        // 投递；消费者已死就顺手摘掉
        let mut dead: Vec<ClientId> = Vec::new();
        for (id, c) in &st.clients {
            if c.wants(&ev.name, ev.session.as_deref()) && !c.consumer.deliver(&ev) {
                dead.push(*id);
            }
        }
        for id in dead {
            st.clients.remove(&id);
        }
    }
}

/// 总线 + 前门的出口：`Core::new` 用它包住前门给的 `EventSink`——所有事件先进总线（编号 / 留底 /
/// 投给网关），再原样交给前门（本机桌面 = 直接 `emit_to` 窗口）。
pub(crate) struct Tee {
    pub bus: Arc<Bus>,
    pub inner: Arc<dyn EventSink>,
}

impl EventSink for Tee {
    fn emit(&self, event: &str, payload: Value) {
        self.bus.emit(event, payload.clone());
        self.inner.emit(event, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

    /// 测试消费者：把投递的事件和 ack 都转成 JSON 塞进通道。
    struct Chan(UnboundedSender<Value>);
    impl Consumer for Chan {
        fn deliver(&self, ev: &Arc<Event>) -> bool {
            self.0.send(json!({ "event": ev.name, "payload": ev.payload, "seq": ev.seq })).is_ok()
        }
    }

    fn bus() -> Bus {
        Bus::new("d1".into())
    }

    fn chat(sid: &str, n: u32) -> Value {
        json!({ "type": "text_delta", "session_id": sid, "n": n })
    }

    fn drain(rx: &mut UnboundedReceiver<Value>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(f) = rx.try_recv() {
            out.push(f);
        }
        out
    }

    fn attach_with(b: &Bus, req: Attach) -> (ClientId, AttachInfo, UnboundedReceiver<Value>) {
        let (tx, rx) = unbounded_channel();
        let ack_tx = tx.clone();
        let (id, info) = b.attach(Arc::new(Chan(tx)), req, |i| {
            let _ = ack_tx.send(json!({ "ack": i.resumed }));
        });
        (id, info, rx)
    }

    fn attach(b: &Bus, resume: Option<Resume>) -> (ClientId, AttachInfo, UnboundedReceiver<Value>) {
        attach_with(b, Attach { resume, ..Default::default() })
    }

    /// 事件带单调序号，实时投给已连的消费者。
    #[test]
    fn events_are_numbered_and_delivered_live() {
        let b = bus();
        let (_, _, mut rx) = attach(&b, None);
        b.emit("file-tree-changed", json!(["/a"]));
        b.emit("chat-event", chat("s1", 1));
        let got = drain(&mut rx);
        assert_eq!(got[0], json!({ "ack": false }));
        assert_eq!(got[1]["seq"], 1);
        assert_eq!(got[1]["event"], "file-tree-changed");
        assert_eq!(got[2]["seq"], 2);
        assert_eq!(b.head_seq(), 2);
    }

    /// 重连带上次的序号：认得这一代 → 错过的按序补回，应答在最前面、回放在实时之前。
    #[test]
    fn resume_replays_exactly_the_missed_events() {
        let b = bus();
        let (id, _, mut rx) = attach(&b, None);
        b.emit("a", json!(1));
        b.emit("b", json!(2));
        assert_eq!(drain(&mut rx).len(), 3); // ack + 2
        b.detach(id);
        b.emit("c", json!(3)); // 无人连着时发生
        b.emit("d", json!(4));

        let (_, info, mut rx2) = attach(&b, Some(Resume { epoch: "d1".into(), seq: 2 }));
        assert!(info.resumed && !info.gap);
        assert_eq!((info.replayed, info.seq), (2, 4));
        b.emit("e", json!(5)); // attach 之后的实时事件排在回放之后
        let got = drain(&mut rx2);
        let seqs: Vec<u64> = got.iter().skip(1).map(|f| f["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, [3, 4, 5]);
        assert_eq!(got[0], json!({ "ack": true }));
    }

    /// 总线换了一代（epoch 不符）= 会话都没了：不回放、不谎称 resumed。
    #[test]
    fn resume_against_a_different_epoch_is_not_resumed() {
        let b = bus();
        b.emit("a", json!(1));
        let (_, info, mut rx) = attach(&b, Some(Resume { epoch: "other".into(), seq: 1 }));
        assert!(!info.resumed && !info.gap);
        assert_eq!(drain(&mut rx).len(), 1, "只有应答");
    }

    /// 缓冲已覆盖不到客户端缺的部分：如实报 gap（不回放残缺的一半假装完整）。
    #[test]
    fn resume_beyond_the_ring_reports_a_gap() {
        let b = Bus::with_limits("d1".into(), 3, usize::MAX);
        for i in 0..10 {
            b.emit("x", json!(i));
        }
        let (_, info, mut rx) = attach(&b, Some(Resume { epoch: "d1".into(), seq: 2 }));
        assert!(info.resumed && info.gap);
        assert_eq!(info.replayed, 0);
        assert_eq!(drain(&mut rx).len(), 1);

        // 刚好接得上（缺 8、9、10，环里正好是 8、9、10）就不算 gap
        let (_, info, _rx) = attach(&b, Some(Resume { epoch: "d1".into(), seq: 7 }));
        assert!(info.resumed && !info.gap);
        assert_eq!(info.replayed, 3);
    }

    /// 什么都没错过：resumed、无回放、无 gap。
    #[test]
    fn resume_when_up_to_date_replays_nothing() {
        let b = bus();
        b.emit("a", json!(1));
        let (_, info, _rx) = attach(&b, Some(Resume { epoch: "d1".into(), seq: 1 }));
        assert!(info.resumed && !info.gap && info.replayed == 0);
    }

    /// 字节上限：大事件把旧的挤出去（但至少留最新一条）。
    #[test]
    fn ring_is_bounded_by_bytes() {
        let b = Bus::with_limits("d1".into(), usize::MAX, 300);
        for _ in 0..20 {
            b.emit("big", json!("x".repeat(80)));
        }
        let st = b.lock();
        assert!(st.ring.len() < 20 && !st.ring.is_empty());
        assert!(st.ring_bytes <= 300 || st.ring.len() == 1);
    }

    /// 按会话订阅：`chat-event` 只送订阅了该会话的消费者，其余事件照常全送。
    #[test]
    fn chat_events_follow_session_subscriptions() {
        let b = bus();
        let (a, _, mut ra) = attach(&b, None);
        let (c, _, mut rc) = attach(&b, None);
        drain(&mut ra);
        drain(&mut rc);
        b.subscribe(a, Some(vec!["s1".into()]));
        b.subscribe(c, Some(vec!["s2".into()]));

        b.emit("chat-event", chat("s1", 1));
        b.emit("chat-event", chat("s2", 2));
        b.emit("file-tree-changed", json!([]));
        b.emit("chat-event", json!({ "type": "runtime_dead" })); // 没有会话号 → 全送

        let events = |rx: &mut UnboundedReceiver<Value>| -> Vec<String> {
            drain(rx).iter().map(|f| f["payload"]["n"].to_string() + f["event"].as_str().unwrap()).collect()
        };
        assert_eq!(events(&mut ra), ["1chat-event", "nullfile-tree-changed", "nullchat-event"]);
        assert_eq!(events(&mut rc), ["2chat-event", "nullfile-tree-changed", "nullchat-event"]);

        b.subscribe(a, None); // 改回全收
        b.emit("chat-event", chat("s2", 3));
        assert_eq!(events(&mut ra), ["3chat-event"]);
    }

    /// 受限订阅者重连：回放只含它订阅的会话（不能借回放看到别的会话）。
    #[test]
    fn resume_replay_respects_the_initial_subscription() {
        let b = bus();
        b.emit("chat-event", chat("s1", 1));
        b.emit("chat-event", chat("s2", 2));
        b.emit("file-tree-changed", json!([]));
        let (_, info, mut rx) = attach_with(
            &b,
            Attach { resume: Some(Resume { epoch: "d1".into(), seq: 0 }), sessions: Some(vec!["s2".into()]), allow: None },
        );
        assert_eq!(info.replayed, 2);
        let got = drain(&mut rx);
        assert_eq!(got[1]["payload"]["n"], 2);
        assert_eq!(got[2]["event"], "file-tree-changed");
    }

    /// 白名单：网关只暴露目录里的事件名，回放与实时都按它过滤。
    #[test]
    fn the_allow_list_filters_live_and_replayed_events() {
        fn only_chat(name: &str) -> bool {
            name == "chat-event"
        }
        let b = bus();
        b.emit("file-tree-changed", json!([]));
        b.emit("chat-event", chat("s1", 1));
        let (_, info, mut rx) = attach_with(
            &b,
            Attach { resume: Some(Resume { epoch: "d1".into(), seq: 0 }), sessions: None, allow: Some(only_chat) },
        );
        assert_eq!(info.replayed, 1);
        b.emit("lsp-diagnostics", json!({}));
        b.emit("chat-event", chat("s1", 2));
        let got = drain(&mut rx);
        let names: Vec<&str> = got.iter().skip(1).map(|f| f["event"].as_str().unwrap()).collect();
        assert_eq!(names, ["chat-event", "chat-event"]);
    }

    /// 已死的消费者在下一次投递时被摘掉，不拖累别人。
    #[test]
    fn dead_consumers_are_dropped_on_delivery() {
        let b = bus();
        let (_, _, rx) = attach(&b, None);
        let (_, _, mut live) = attach(&b, None);
        drain(&mut live);
        drop(rx);
        assert_eq!(b.client_count(), 2);
        b.emit("a", json!(1));
        assert_eq!(b.client_count(), 1);
        assert_eq!(drain(&mut live).len(), 1);
    }

    /// 空闲计时：消费者来去与 chat 事件刷新它，别的事件（文件变更噪声）不算。
    #[test]
    fn activity_clock_ignores_background_noise() {
        let b = bus();
        std::thread::sleep(Duration::from_millis(30));
        b.emit("file-tree-changed", json!([]));
        assert!(b.idle_for() >= Duration::from_millis(30));
        b.emit("chat-event", chat("s", 1));
        assert!(b.idle_for() < Duration::from_millis(30));
    }

    /// `Tee`：事件先进总线（编号），再交给前门。
    #[test]
    fn tee_records_then_forwards() {
        #[derive(Default)]
        struct Rec(Mutex<Vec<String>>);
        impl EventSink for Rec {
            fn emit(&self, event: &str, _p: Value) {
                self.0.lock().unwrap().push(event.to_string());
            }
        }
        let bus = Arc::new(Bus::new("e".into()));
        let rec = Arc::new(Rec::default());
        let tee = Tee { bus: Arc::clone(&bus), inner: rec.clone() };
        tee.emit("a", json!(1));
        assert_eq!(bus.head_seq(), 1);
        assert_eq!(rec.0.lock().unwrap().as_slice(), ["a"]);
    }
}
