//! 事件中心：Host 核心（aide-core）发出的**全部**事件在这里编号、留底、按订阅投给连着的客户端。
//!
//! 为什么要它（docs/host-model.md §3 P2d / P3）：
//! - **断线重连保住会话**：守护进程常驻，客户端（桌面的桥）来来去去；每个事件带全局序号 `seq`，
//!   环形缓冲留最近一段，重连时客户端报上「最后收到的序号」就能把错过的补回来——UI 看到的是
//!   一条没断过的事件流。缓冲覆盖不到（错过太久）就如实报 `gap`，由客户端决定重新同步。
//! - **按会话订阅投递**（早先 headless 验收过、删除时留下的契约）：多个客户端（桌面窗口、将来的
//!   手机）连同一个 Host 时，`chat-event` 只送给订阅了该会话的客户端；不带会话号的事件
//!   （文件变更 / LSP / 系统通知…）照常全送。默认订阅全部（桌面的行为不变）。
//!
//! 帧在这里只序列化一次（带 `seq`），回放与实时投递共用同一份文本。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use aide_core::EventSink;
use aide_host::protocol::{AttachInfo, Notification, Resume};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

/// 一条出站帧（已序列化、不含换行）。`Arc` 让一条事件投给多个客户端时只存一份。
pub type Frame = Arc<str>;

/// 环形缓冲上限：条数与字节数，先到先止。字节上限是主约束（chat 流的帧大小差别很大）。
const RING_MAX_EVENTS: usize = 50_000;
const RING_MAX_BYTES: usize = 16 << 20;

pub type ClientId = u64;

struct Entry {
    seq: u64,
    /// `chat-event` 所属的会话；其余事件 None（对所有客户端可见）。
    session: Option<String>,
    frame: Frame,
}

struct Client {
    tx: UnboundedSender<Frame>,
    /// None = 全收；Some = 只收这些会话的 `chat-event`。
    sessions: Option<HashSet<String>>,
}

impl Client {
    fn wants(&self, session: Option<&str>) -> bool {
        match (&self.sessions, session) {
            (Some(set), Some(sid)) => set.contains(sid),
            _ => true,
        }
    }
}

struct State {
    /// 下一个要发的序号（从 1 起；0 = 还没发过任何事件）。
    next_seq: u64,
    ring: VecDeque<Entry>,
    ring_bytes: usize,
    clients: HashMap<ClientId, Client>,
    next_client: ClientId,
    /// 最近一次「有动静」（客户端来去 / chat 事件）——空闲退出的计时起点。
    last_activity: Instant,
}

pub struct Hub {
    daemon_id: String,
    max_events: usize,
    max_bytes: usize,
    state: Mutex<State>,
}

impl Hub {
    pub fn new(daemon_id: String) -> Self {
        Self::with_limits(daemon_id, RING_MAX_EVENTS, RING_MAX_BYTES)
    }

    pub fn with_limits(daemon_id: String, max_events: usize, max_bytes: usize) -> Self {
        Self {
            daemon_id,
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

    pub fn daemon_id(&self) -> &str {
        &self.daemon_id
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 登记一个客户端。**先**经 `tx` 送出 `ack`（对 attach 请求的应答，由调用方按接入结果造），
    /// **再**回放错过的事件，最后才加入实时投递——全程在同一把锁里，所以回放与实时之间
    /// 不丢不重不乱序。
    pub fn attach(
        &self,
        tx: UnboundedSender<Frame>,
        resume: Option<&Resume>,
        sessions: Option<Vec<String>>,
        ack: impl FnOnce(&AttachInfo) -> String,
    ) -> (ClientId, AttachInfo) {
        let client = Client { tx, sessions: sessions.map(|v| v.into_iter().collect()) };
        let mut st = self.lock();
        let head = st.next_seq - 1;
        let mut info = AttachInfo {
            daemon_id: self.daemon_id.clone(),
            resumed: false,
            gap: false,
            seq: head,
            replayed: 0,
        };
        let mut replay: Vec<Frame> = Vec::new();
        if let Some(r) = resume.filter(|r| r.daemon_id == self.daemon_id) {
            info.resumed = true;
            if r.seq > head {
                info.gap = true; // 客户端比我还新：不可能的状态，当作对不上
            } else if r.seq < head {
                let covered = st.ring.front().is_some_and(|e| e.seq <= r.seq + 1);
                if covered {
                    // 回放也按订阅过滤：受限订阅者重连不能借回放看到别的会话
                    replay = st
                        .ring
                        .iter()
                        .filter(|e| e.seq > r.seq && client.wants(e.session.as_deref()))
                        .map(|e| Arc::clone(&e.frame))
                        .collect();
                } else {
                    info.gap = true;
                }
            }
            info.replayed = replay.len() as u64;
        }
        let ack: Frame = ack(&info).into();
        let _ = client.tx.send(ack);
        for f in replay {
            let _ = client.tx.send(f);
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

    /// 改某客户端的订阅。`None` = 全收。
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
    #[cfg(test)]
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

impl EventSink for Hub {
    fn emit(&self, event: &str, payload: Value) {
        let session = session_of(event, &payload);
        let mut st = self.lock();
        let seq = st.next_seq;
        let n = Notification { event: event.to_string(), payload, seq: Some(seq) };
        let frame: Frame = match serde_json::to_string(&n) {
            Ok(s) => s.into(),
            Err(e) => {
                eprintln!("[aide-host] event {event} not serialisable: {e}");
                return;
            }
        };
        st.next_seq += 1;
        if event == "chat-event" {
            st.last_activity = Instant::now();
        }

        st.ring_bytes += frame.len();
        st.ring.push_back(Entry { seq, session: session.clone(), frame: Arc::clone(&frame) });
        while st.ring.len() > self.max_events || (st.ring_bytes > self.max_bytes && st.ring.len() > 1) {
            if let Some(old) = st.ring.pop_front() {
                st.ring_bytes -= old.frame.len();
            }
        }

        // 投递；发送失败 = 客户端的写端已死，顺手摘掉
        let mut dead: Vec<ClientId> = Vec::new();
        for (id, c) in &st.clients {
            if c.wants(session.as_deref()) && c.tx.send(Arc::clone(&frame)).is_err() {
                dead.push(*id);
            }
        }
        for id in dead {
            st.clients.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    fn hub() -> Hub {
        Hub::new("d1".into())
    }

    fn chat(sid: &str, n: u32) -> Value {
        json!({ "type": "text_delta", "session_id": sid, "n": n })
    }

    fn drain(rx: &mut UnboundedReceiver<Frame>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(f) = rx.try_recv() {
            out.push(serde_json::from_str(&f).unwrap());
        }
        out
    }

    fn attach(h: &Hub, resume: Option<Resume>) -> (ClientId, AttachInfo, UnboundedReceiver<Frame>) {
        let (tx, rx) = unbounded_channel();
        let (id, info) = h.attach(tx, resume.as_ref(), None, |i| json!({ "ack": i.resumed }).to_string());
        (id, info, rx)
    }

    /// 事件带单调序号，实时投给已连的客户端。
    #[test]
    fn events_are_numbered_and_delivered_live() {
        let h = hub();
        let (_, _, mut rx) = attach(&h, None);
        h.emit("file-tree-changed", json!(["/a"]));
        h.emit("chat-event", chat("s1", 1));
        let got = drain(&mut rx);
        assert_eq!(got[0], json!({ "ack": false }));
        assert_eq!(got[1]["seq"], 1);
        assert_eq!(got[1]["event"], "file-tree-changed");
        assert_eq!(got[2]["seq"], 2);
        assert_eq!(h.head_seq(), 2);
    }

    /// 重连带上次的序号：认得这个守护进程 → 错过的按序补回，应答帧在最前面、回放在实时之前。
    #[test]
    fn resume_replays_exactly_the_missed_events() {
        let h = hub();
        let (id, _, mut rx) = attach(&h, None);
        h.emit("a", json!(1));
        h.emit("b", json!(2));
        assert_eq!(drain(&mut rx).len(), 3); // ack + 2
        h.detach(id);
        h.emit("c", json!(3)); // 无人连着时发生
        h.emit("d", json!(4));

        let (_, info, mut rx2) = attach(&h, Some(Resume { daemon_id: "d1".into(), seq: 2 }));
        assert!(info.resumed && !info.gap);
        assert_eq!((info.replayed, info.seq), (2, 4));
        h.emit("e", json!(5)); // attach 之后的实时事件排在回放之后
        let got = drain(&mut rx2);
        let seqs: Vec<u64> = got.iter().skip(1).map(|f| f["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, [3, 4, 5]);
        assert_eq!(got[0], json!({ "ack": true }));
    }

    /// 守护进程换了（身份不符）= 会话都没了：不回放、不谎称 resumed。
    #[test]
    fn resume_against_a_different_daemon_is_not_resumed() {
        let h = hub();
        h.emit("a", json!(1));
        let (_, info, mut rx) = attach(&h, Some(Resume { daemon_id: "other".into(), seq: 1 }));
        assert!(!info.resumed && !info.gap);
        assert_eq!(drain(&mut rx).len(), 1, "只有应答帧");
    }

    /// 缓冲已覆盖不到客户端缺的部分：如实报 gap（不回放残缺的一半假装完整）。
    #[test]
    fn resume_beyond_the_ring_reports_a_gap() {
        let h = Hub::with_limits("d1".into(), 3, usize::MAX);
        for i in 0..10 {
            h.emit("x", json!(i));
        }
        let (_, info, mut rx) = attach(&h, Some(Resume { daemon_id: "d1".into(), seq: 2 }));
        assert!(info.resumed && info.gap);
        assert_eq!(info.replayed, 0);
        assert_eq!(drain(&mut rx).len(), 1);

        // 刚好接得上（缺 8、9、10，环里正好是 8、9、10）就不算 gap
        let (_, info, _rx) = attach(&h, Some(Resume { daemon_id: "d1".into(), seq: 7 }));
        assert!(info.resumed && !info.gap);
        assert_eq!(info.replayed, 3);
    }

    /// 什么都没错过：resumed、无回放、无 gap。
    #[test]
    fn resume_when_up_to_date_replays_nothing() {
        let h = hub();
        h.emit("a", json!(1));
        let (_, info, _rx) = attach(&h, Some(Resume { daemon_id: "d1".into(), seq: 1 }));
        assert!(info.resumed && !info.gap && info.replayed == 0);
    }

    /// 字节上限：大帧把旧的挤出去（但至少留最新一条）。
    #[test]
    fn ring_is_bounded_by_bytes() {
        let h = Hub::with_limits("d1".into(), usize::MAX, 200);
        for _ in 0..20 {
            h.emit("big", json!("x".repeat(80)));
        }
        let st = h.lock();
        assert!(st.ring.len() < 20 && !st.ring.is_empty());
        assert!(st.ring_bytes <= 200 || st.ring.len() == 1);
    }

    /// 按会话订阅：`chat-event` 只送订阅了该会话的客户端，其余事件照常全送。
    #[test]
    fn chat_events_follow_session_subscriptions() {
        let h = hub();
        let (a, _, mut ra) = attach(&h, None);
        let (b, _, mut rb) = attach(&h, None);
        drain(&mut ra);
        drain(&mut rb);
        h.subscribe(a, Some(vec!["s1".into()]));
        h.subscribe(b, Some(vec!["s2".into()]));

        h.emit("chat-event", chat("s1", 1));
        h.emit("chat-event", chat("s2", 2));
        h.emit("file-tree-changed", json!([]));
        h.emit("chat-event", json!({ "type": "runtime_dead" })); // 没有会话号 → 全送

        let events = |rx: &mut UnboundedReceiver<Frame>| -> Vec<String> {
            drain(rx).iter().map(|f| f["payload"]["n"].to_string() + f["event"].as_str().unwrap()).collect()
        };
        assert_eq!(events(&mut ra), ["1chat-event", "nullfile-tree-changed", "nullchat-event"]);
        assert_eq!(events(&mut rb), ["2chat-event", "nullfile-tree-changed", "nullchat-event"]);

        h.subscribe(a, None); // 改回全收
        h.emit("chat-event", chat("s2", 3));
        assert_eq!(events(&mut ra), ["3chat-event"]);
    }

    /// 受限订阅者重连：回放只含它订阅的会话（不能借回放看到别的会话）。
    #[test]
    fn resume_replay_respects_the_initial_subscription() {
        let h = hub();
        h.emit("chat-event", chat("s1", 1));
        h.emit("chat-event", chat("s2", 2));
        h.emit("file-tree-changed", json!([]));
        let (tx, mut rx) = unbounded_channel();
        let (_, info) = h.attach(
            tx,
            Some(&Resume { daemon_id: "d1".into(), seq: 0 }),
            Some(vec!["s2".into()]),
            |_| "{}".to_string(),
        );
        assert_eq!(info.replayed, 2);
        let got = drain(&mut rx);
        assert_eq!(got[1]["payload"]["n"], 2);
        assert_eq!(got[2]["event"], "file-tree-changed");
    }

    /// 写端已死的客户端在下一次投递时被摘掉，不拖累别人。
    #[test]
    fn dead_clients_are_dropped_on_delivery() {
        let h = hub();
        let (_, _, rx) = attach(&h, None);
        let (_, _, mut live) = attach(&h, None);
        drain(&mut live);
        drop(rx);
        assert_eq!(h.client_count(), 2);
        h.emit("a", json!(1));
        assert_eq!(h.client_count(), 1);
        assert_eq!(drain(&mut live).len(), 1);
    }

    /// 空闲计时：客户端来去与 chat 事件刷新它，别的事件（文件变更噪声）不算。
    #[test]
    fn activity_clock_ignores_background_noise() {
        let h = hub();
        std::thread::sleep(Duration::from_millis(30));
        h.emit("file-tree-changed", json!([]));
        assert!(h.idle_for() >= Duration::from_millis(30));
        h.emit("chat-event", chat("s", 1));
        assert!(h.idle_for() < Duration::from_millis(30));
    }
}
