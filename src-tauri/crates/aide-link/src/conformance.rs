//! 一致性向量的执行器。向量 = `tests/fixtures/*.json` 里语言无关的对话脚本：
//!
//! ```json
//! { "name": "…", "steps": [
//!   { "send":   { …客户端帧… } },
//!   { "expect": { …期望的 Host 帧（子集匹配）… } },
//!   { "expect_set": [ {…}, {…} ] },     // 这几帧都要到，顺序不限
//!   { "emit":   { "name": "chat-event", "payload": {…} } },   // 让 Host 产生一个事件
//!   { "tick_secs": 80 },                // 假装过了这么久，跑一次周期维护
//!   { "expect_closed": true }           // 连接此刻应已被 Host 终止
//! ] }
//! ```
//!
//! 期望帧按**子集**匹配（只校验写出的键，多出的键忽略——协议允许加字段）；值可以是占位符
//! `"<any>"` / `"<string>"` / `"<number>"` / `"<bool>"`。向量约定的固定值（配对码 `123456`、
//! 已配对 token `test-token`、Host 画像、`list_sessions` 的结果…）见 [`crate::testkit`]。
//!
//! 手机端实现可以把同一批向量当作自测脚本（对着真实 Host 或自己的 mock Host 跑）；
//! aide-host 的真实后端用同一个执行器验证（实现 [`Harness`] 即可）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::auth::Credentials;
use crate::backend::Backend;
use crate::frame::HostFrame;
use crate::session::Session;

/// 被测的 Host：给出后端、凭据，并能按需产生事件。
pub trait Harness {
    fn backend(&self) -> Arc<dyn Backend>;
    /// 须满足向量约定：配对码 `123456`，已配对的 token 为 `test-token`。
    fn credentials(&self) -> Arc<Credentials>;
    fn emit(&self, name: &str, payload: Value);
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

async fn next_frame(rx: &mut UnboundedReceiver<HostFrame>) -> Result<Value, String> {
    let f = tokio::time::timeout(STEP_TIMEOUT, rx.recv())
        .await
        .map_err(|_| "timed out waiting for a Host frame".to_string())?
        .ok_or("session output closed")?;
    serde_json::to_value(f).map_err(|e| e.to_string())
}

/// 跑一个向量；失败返回带步骤号的原因。
pub async fn run_fixture(h: &dyn Harness, fixture: &Value) -> Result<(), String> {
    let name = fixture["name"].as_str().unwrap_or("?");
    let steps = fixture["steps"].as_array().ok_or("fixture has no steps")?;
    let (tx, mut rx) = unbounded_channel();
    let mut session = Session::new(h.backend(), h.credentials(), tx);
    let started = Instant::now();
    for (i, step) in steps.iter().enumerate() {
        let at = |e: String| format!("[{name}] step {i}: {e}");
        if let Some(frame) = step.get("send") {
            session.on_text(&frame.to_string()).await;
        } else if let Some(want) = step.get("expect") {
            let got = next_frame(&mut rx).await.map_err(&at)?;
            matches(want, &got).map_err(|e| at(format!("{e}\n  expected: {want}\n  actual:   {got}")))?;
        } else if let Some(wants) = step.get("expect_set").and_then(Value::as_array) {
            let mut pending: Vec<&Value> = wants.iter().collect();
            let mut seen = Vec::new();
            while !pending.is_empty() {
                let got = next_frame(&mut rx).await.map_err(|e| at(format!("{e}; still waiting for {pending:?}; seen {seen:?}")))?;
                match pending.iter().position(|w| matches(w, &got).is_ok()) {
                    Some(p) => {
                        pending.remove(p);
                    }
                    None => return Err(at(format!("unexpected frame {got}; still waiting for {pending:?}"))),
                }
                seen.push(got);
            }
        } else if let Some(ev) = step.get("emit") {
            h.emit(ev["name"].as_str().unwrap_or(""), ev["payload"].clone());
        } else if let Some(secs) = step.get("tick_secs").and_then(Value::as_u64) {
            session.on_tick(started + Duration::from_secs(secs));
        } else if step.get("expect_closed").is_some() {
            if !session.is_closed() {
                return Err(at("the Host should have terminated the connection".into()));
            }
        } else if step.get("expect_none").is_some() {
            // 给在途任务一点时间，确认确实没有多余的帧
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Ok(f) = rx.try_recv() {
                return Err(at(format!("unexpected extra frame {}", serde_json::to_string(&f).unwrap_or_default())));
            }
        } else {
            return Err(at(format!("unknown step {step}")));
        }
    }
    Ok(())
}
