//! 一致性向量的执行器。向量 = `tests/fixtures/*.json` 里语言无关的对话脚本：
//!
//! ```json
//! { "name": "…", "channel": "resume", "steps": [
//!   { "send":   { …Link 帧… } },                 // 经加密通道发给 Host
//!   { "expect": { …期望的 Link 帧（子集匹配）… } },
//!   { "expect_set": [ {…}, {…} ] },              // 这几帧都要到，顺序不限
//!   { "emit":   { "name": "chat-event", "payload": {…} } },   // 让 Host 产生一个事件
//!   { "tick_secs": 80 },                         // 假装过了这么久，跑一次周期维护
//!   { "expect_closed": true },                   // 连接此刻应已被 Host 终止
//!   { "expect_none": true },                     // 此刻不应有多余的帧
//!
//!   // 握手层（外层明文帧）：
//!   { "connect": { "mode": "resume"|"pair", "as": "a"|"b"|"stranger",
//!                  "psk": "offer"|"wrong", "versions": [1] } },
//!   { "wire_send": { …外层帧… } },               // 原样发（字符串 = 原样文本，造乱码）
//!   { "wire_expect": { …外层帧模式… } },
//!   { "connection": "b" }                        // 切到另一条并行连接（首次出现即新建）
//! ] }
//! ```
//!
//! `offer`（可选，`"none"`）：开始前撤掉 Host 的配对二维码。
//!
//! `channel`（默认 `"resume"`）：向量开始前由执行器替你完成的握手——`resume`（以手机 A 恢复）、
//! `pair`（以手机 B 用有效二维码配对）、`none`（不握手，全靠 `connect` / `wire_*` 步骤）。
//!
//! 期望帧按**子集**匹配（只校验写出的键，多出的键忽略——协议允许加字段）；值可以是占位符
//! `"<any>"` / `"<string>"` / `"<number>"` / `"<bool>"`。角色（手机 A / B）、固定的 Host 身份与
//! 一次性密钥见 [`crate::testkit`]。
//!
//! 手机端实现可以把同一批向量当作自测脚本；aide-host 的真实后端用同一个执行器验证（实现
//! [`Harness`] 即可）。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::backend::Backend;
use crate::client::RefClient;
use crate::connection::Connection;
use crate::frame::SUPPORTED_VERSIONS;
use crate::identity::Identity;
use crate::secure::{Keypair, Mode, WireFrame};

/// 被测的 Host：给出后端、身份，并能按需产生事件；角色手机的密钥对与有效二维码的一次性密钥
/// 由装置按向量约定提供。
pub trait Harness {
    fn backend(&self) -> Arc<dyn Backend>;
    fn identity(&self) -> Arc<Identity>;
    fn emit(&self, name: &str, payload: Value);
    /// `"a"`（已配对）/ `"b"`（另一台）/ 其他（陌生人）。
    fn phone(&self, role: &str) -> Keypair;
    /// 当前有效二维码里的一次性密钥。
    fn offer_psk(&self) -> [u8; 32];
}

const STEP_TIMEOUT: Duration = Duration::from_secs(2);

/// 占位符 / 子集匹配。
pub fn matches(expected: &Value, actual: &Value) -> Result<(), String> {
    match expected {
        Value::String(s) if s == "<any>" => Ok(()),
        Value::String(s) if s == "<string>" => actual.is_string().then_some(()).ok_or_else(|| format!("expected a string, got {actual}")),
        Value::String(s) if s == "<number>" => actual.is_number().then_some(()).ok_or_else(|| format!("expected a number, got {actual}")),
        Value::String(s) if s == "<bool>" => actual.is_boolean().then_some(()).ok_or_else(|| format!("expected a bool, got {actual}")),
        Value::Object(want) => {
            let Value::Object(have) = actual else {
                return Err(format!("expected an object, got {actual}"));
            };
            for (k, v) in want {
                let got = have.get(k).ok_or_else(|| format!("missing key `{k}` in {actual}"))?;
                matches(v, got).map_err(|e| format!("{k}: {e}"))?;
            }
            Ok(())
        }
        Value::Array(want) => {
            let Value::Array(have) = actual else {
                return Err(format!("expected an array, got {actual}"));
            };
            if want.len() != have.len() {
                return Err(format!("expected {} items, got {}: {actual}", want.len(), have.len()));
            }
            want.iter().zip(have).enumerate().try_for_each(|(i, (w, h))| matches(w, h).map_err(|e| format!("[{i}]: {e}")))
        }
        other => (other == actual).then_some(()).ok_or_else(|| format!("expected {other}, got {actual}")),
    }
}

/// 一条并行连接在执行器里的状态。
struct Conn {
    conn: Connection,
    rx: UnboundedReceiver<WireFrame>,
    /// 已从通道取出、还没被步骤消费的外层帧（`connect` 窥视 Host 的回应时留下的）。
    peeked: VecDeque<WireFrame>,
    client: Option<RefClient>,
    /// 握手里客户端一侧失败了（如一次性密钥不对）：之后发不出有效帧。
    client_failed: Option<String>,
    started: Instant,
}

impl Conn {
    fn new(h: &dyn Harness) -> Self {
        let (tx, rx) = unbounded_channel();
        Self {
            conn: Connection::new(h.backend(), h.identity(), tx),
            rx,
            peeked: VecDeque::new(),
            client: None,
            client_failed: None,
            started: Instant::now(),
        }
    }

    async fn next_wire(&mut self) -> Result<WireFrame, String> {
        if let Some(f) = self.peeked.pop_front() {
            return Ok(f);
        }
        tokio::time::timeout(STEP_TIMEOUT, self.rx.recv())
            .await
            .map_err(|_| "timed out waiting for a Host frame".to_string())?
            .ok_or_else(|| "connection output closed".to_string())
    }

    /// 下一个 Link 帧（逐块收齐、解密）。
    async fn next_link(&mut self) -> Result<Value, String> {
        loop {
            let w = self.next_wire().await?;
            if let WireFrame::ScErr { code, message } = &w {
                return Err(format!("Host rejected the channel: {code:?} ({message})"));
            }
            let client = self.client.as_mut().ok_or("no encrypted channel yet (use `connect` or `channel`)")?;
            if let Some(v) = client.open(&w)? {
                return Ok(v);
            }
        }
    }

    /// 发 `sc_init`，并看 Host 怎么回：`sc_resp` → 完成客户端握手；`sc_err` → 留给 `wire_expect`。
    async fn connect(&mut self, h: &dyn Harness, spec: &Value) -> Result<(), String> {
        let mode = match spec["mode"].as_str().unwrap_or("resume") {
            "pair" => Mode::Pair,
            _ => Mode::Resume,
        };
        let phone = h.phone(spec["as"].as_str().unwrap_or(if mode == Mode::Pair { "b" } else { "a" }));
        let psk = (mode == Mode::Pair).then(|| match spec["psk"].as_str().unwrap_or("offer") {
            "wrong" => [0xEE; 32],
            _ => h.offer_psk(),
        });
        let versions: Vec<u32> = spec["versions"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
            .unwrap_or_else(|| SUPPORTED_VERSIONS.to_vec());
        let id = h.identity();
        let (init, pending) = RefClient::begin(mode, &phone, &id.host_public(), id.device_id(), psk.as_ref(), &versions)?;
        self.conn.on_wire_text(&serde_json::to_string(&init).map_err(|e| e.to_string())?).await;
        let reply = self.next_wire().await?;
        match &reply {
            WireFrame::ScResp { .. } => match pending.complete(&reply) {
                Ok(c) => self.client = Some(c),
                Err(e) => self.client_failed = Some(e),
            },
            _ => self.peeked.push_back(reply),
        }
        Ok(())
    }

    async fn send_link(&mut self, frame: &Value) -> Result<(), String> {
        if let Some(e) = &self.client_failed {
            return Err(format!("the client side of the handshake failed ({e}); nothing can be sent"));
        }
        let client = self.client.as_mut().ok_or("no encrypted channel yet")?;
        for w in client.seal_frame(frame) {
            self.conn.on_wire_text(&serde_json::to_string(&w).map_err(|e| e.to_string())?).await;
        }
        Ok(())
    }
}

/// 跑一个向量；失败返回带步骤号的原因。
pub async fn run_fixture(h: &dyn Harness, fixture: &Value) -> Result<(), String> {
    let name = fixture["name"].as_str().unwrap_or("?");
    let steps = fixture["steps"].as_array().ok_or("fixture has no steps")?;
    let mut conns: HashMap<String, Conn> = HashMap::new();
    let mut active = "default".to_string();
    conns.insert(active.clone(), Conn::new(h));

    if fixture["offer"].as_str() == Some("none") {
        h.identity().cancel_offer(); // 「Host 没有开着配对二维码」的前置
    }

    match fixture["channel"].as_str().unwrap_or("resume") {
        "none" => {}
        "pair" => conns.get_mut(&active).unwrap().connect(h, &serde_json::json!({"mode":"pair","as":"b"})).await.map_err(|e| format!("[{name}] channel: {e}"))?,
        _ => conns.get_mut(&active).unwrap().connect(h, &serde_json::json!({"mode":"resume","as":"a"})).await.map_err(|e| format!("[{name}] channel: {e}"))?,
    }

    for (i, step) in steps.iter().enumerate() {
        let at = |e: String| format!("[{name}] step {i}: {e}");
        if let Some(c) = step.get("connection").and_then(Value::as_str) {
            if !conns.contains_key(c) {
                conns.insert(c.to_string(), Conn::new(h));
            }
            active = c.to_string();
            continue;
        }
        let c = conns.get_mut(&active).expect("active connection");
        if let Some(frame) = step.get("send") {
            c.send_link(frame).await.map_err(&at)?;
        } else if let Some(want) = step.get("expect") {
            let got = c.next_link().await.map_err(&at)?;
            matches(want, &got).map_err(|e| at(format!("{e}\n  expected: {want}\n  actual:   {got}")))?;
        } else if let Some(wants) = step.get("expect_set").and_then(Value::as_array) {
            let mut pending: Vec<&Value> = wants.iter().collect();
            while !pending.is_empty() {
                let got = c.next_link().await.map_err(|e| at(format!("{e}; still waiting for {pending:?}")))?;
                match pending.iter().position(|w| matches(w, &got).is_ok()) {
                    Some(p) => {
                        pending.remove(p);
                    }
                    None => return Err(at(format!("unexpected frame {got}; still waiting for {pending:?}"))),
                }
            }
        } else if let Some(ev) = step.get("emit") {
            h.emit(ev["name"].as_str().unwrap_or(""), ev["payload"].clone());
        } else if let Some(secs) = step.get("tick_secs").and_then(Value::as_u64) {
            c.conn.on_tick(c.started + Duration::from_secs(secs));
        } else if step.get("expect_closed").is_some() {
            if !c.conn.is_closed() {
                return Err(at("the Host should have terminated the connection".into()));
            }
        } else if step.get("expect_none").is_some() {
            // 给在途任务一点时间，确认确实没有多余的帧
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(f) = c.peeked.pop_front().or_else(|| c.rx.try_recv().ok()) {
                return Err(at(format!("unexpected extra frame {}", serde_json::to_string(&f).unwrap_or_default())));
            }
        } else if let Some(spec) = step.get("connect") {
            c.connect(h, spec).await.map_err(&at)?;
        } else if let Some(frame) = step.get("wire_send") {
            let text = frame.as_str().map(str::to_string).unwrap_or_else(|| frame.to_string());
            c.conn.on_wire_text(&text).await;
        } else if let Some(want) = step.get("wire_expect") {
            let got = c.next_wire().await.map_err(&at)?;
            let got = serde_json::to_value(&got).map_err(|e| e.to_string())?;
            matches(want, &got).map_err(|e| at(format!("{e}\n  expected: {want}\n  actual:   {got}")))?;
        } else {
            return Err(at(format!("unknown step {step}")));
        }
    }
    Ok(())
}
