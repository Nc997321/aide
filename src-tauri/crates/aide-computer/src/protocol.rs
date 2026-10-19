//! sidecar ↔ 执行器协议：`computer_query` 事件 → [`Request`]；回包 `computer_result`。
//!
//! 形制同内嵌浏览器桥（`src-tauri/src/browser/agent_bridge.rs`）：request_id 配对，
//! 本机 Host 经 runtime stdin 回写，远程 Host 经 `agent_tool_result`。
//! **工具面不出现任何应用名词**——换一个应用，这里一行不动。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::model::{Direction, WindowAction};

pub const QUERY_EVENT: &str = "computer_query";
pub const RESULT_CMD: &str = "computer_result";

/// 每次 `computer_act` 最多几步：一小串、做完回报，不是一整套脚本。
pub const MAX_STEPS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub request_id: String,
    /// 发起的会话（输入锁的属主）。sidecar 的 emit 会给每个事件带上。
    pub session_id: String,
    pub query: Query,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Query {
    Windows,
    Window {
        action: WindowAction,
        window_id: Option<String>,
        app: Option<String>,
    },
    Read {
        window_id: Option<String>,
        screenshot: bool,
        text_tail: Option<u32>,
        /// 只读这个元素（ref）下面的部分；之后对该窗口的内部读取（动作回报、按名字找、等待）沿用，
        /// 直到一次不带 scope 的读取。
        scope: Option<String>,
    },
    Act {
        window_id: String,
        intent: String,
        steps: Vec<Step>,
    },
    Wait {
        window_id: Option<String>,
        condition: Condition,
        timeout_ms: Option<u64>,
    },
    /// 是本桥事件但载荷不对：回错误，不静默（协议不匹配越早越响越好）。
    Malformed(String),
}

impl Query {
    pub fn op_name(&self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Window { .. } => "window",
            Self::Read { .. } => "read",
            Self::Act { .. } => "act",
            Self::Wait { .. } => "wait",
            Self::Malformed(_) => "malformed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Target {
    Ref {
        #[serde(rename = "ref")]
        ref_id: String,
    },
    Point {
        x: f64,
        y: f64,
        obs: u64,
    },
    Name {
        name: String,
        #[serde(default)]
        role: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Step {
    Click { target: Target },
    DoubleClick { target: Target },
    RightClick { target: Target },
    Type {
        text: String,
        #[serde(default)]
        target: Option<Target>,
    },
    Press { keys: String },
    Scroll {
        #[serde(default)]
        target: Option<Target>,
        direction: Direction,
        #[serde(default)]
        amount: Option<u32>,
    },
    SetValue { target: Target, value: String },
}

impl Step {
    pub fn target(&self) -> Option<&Target> {
        match self {
            Self::Click { target }
            | Self::DoubleClick { target }
            | Self::RightClick { target }
            | Self::SetValue { target, .. } => Some(target),
            Self::Type { target, .. } | Self::Scroll { target, .. } => target.as_ref(),
            Self::Press { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Condition {
    WindowAppears {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        process: Option<String>,
    },
    WindowGone,
    ElementAppears {
        name: String,
        #[serde(default)]
        role: Option<String>,
    },
    ElementGone {
        name: String,
        #[serde(default)]
        role: Option<String>,
    },
    TextContains { text: String },
    TextStable {
        #[serde(default)]
        quiet_ms: Option<u64>,
    },
    FocusChanges,
}

/// 解析事件。`None` = 不是本桥事件；`Some(Malformed)` = 是本桥事件但载荷不对。
pub fn parse_request(event: &Value) -> Option<Request> {
    if event.get("type").and_then(Value::as_str) != Some(QUERY_EVENT) {
        return None;
    }
    let request_id = event.get("request_id")?.as_str()?.to_string();
    let session_id = event
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(Request {
        request_id,
        session_id,
        query: parse_query(event),
    })
}

fn parse_query(event: &Value) -> Query {
    match parse_query_inner(event) {
        Ok(q) => q,
        Err(e) => Query::Malformed(e),
    }
}

fn parse_query_inner(event: &Value) -> Result<Query, String> {
    let op = event
        .get("op")
        .and_then(Value::as_str)
        .ok_or("missing `op`")?;
    let opt_str = |k: &str| event.get(k).and_then(Value::as_str).map(str::to_string);
    match op {
        "windows" => Ok(Query::Windows),
        "window" => {
            let action: WindowAction = field(event, "action")?;
            let window_id = opt_str("window_id");
            let app = opt_str("app");
            if action == WindowAction::Launch && app.as_deref().map_or(true, |a| a.trim().is_empty()) {
                return Err("action=launch requires `app` (the application's name)".into());
            }
            if action != WindowAction::Launch && window_id.is_none() {
                return Err("this action requires `window_id` (from computer_windows)".into());
            }
            Ok(Query::Window { action, window_id, app })
        }
        "read" => Ok(Query::Read {
            window_id: opt_str("window_id"),
            screenshot: event.get("screenshot").and_then(Value::as_bool).unwrap_or(false),
            text_tail: event.get("text_tail").and_then(Value::as_u64).map(|n| n.min(2000) as u32),
            scope: opt_str("scope"),
        }),
        "act" => {
            let window_id = opt_str("window_id").ok_or("act requires `window_id`")?;
            let intent = opt_str("intent").unwrap_or_default();
            if intent.trim().is_empty() {
                return Err("act requires `intent`: one sentence on what these steps are meant to achieve".into());
            }
            let steps: Vec<Step> = field(event, "steps")?;
            if steps.is_empty() {
                return Err("act requires at least one step".into());
            }
            if steps.len() > MAX_STEPS {
                return Err(format!(
                    "act takes at most {MAX_STEPS} steps — split the work and look at the result in between"
                ));
            }
            Ok(Query::Act { window_id, intent, steps })
        }
        "wait" => Ok(Query::Wait {
            window_id: opt_str("window_id"),
            condition: field(event, "condition")?,
            timeout_ms: event.get("timeout_ms").and_then(Value::as_u64),
        }),
        other => Err(format!("unknown op: {other}")),
    }
}

fn field<T: for<'de> Deserialize<'de>>(event: &Value, key: &str) -> Result<T, String> {
    let v = event.get(key).ok_or_else(|| format!("missing `{key}`"))?;
    serde_json::from_value(v.clone()).map_err(|e| format!("invalid `{key}`: {e}"))
}

pub fn ok_payload(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

/// 失败回包。`message` 面向 agent：要能直接指导下一步。
pub fn err_payload(message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": message.into() })
}

/// 打上 `cmd` / `request_id` 的回包命令。
pub fn result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String(RESULT_CMD.into());
    v["request_id"] = Value::String(request_id.into());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(v: Value) -> Query {
        parse_request(&v).unwrap().query
    }

    #[test]
    fn ignores_other_events() {
        assert!(parse_request(&json!({"type": "browser_query", "request_id": "r"})).is_none());
        assert!(parse_request(&json!({"type": "computer_query", "op": "windows"})).is_none());
    }

    #[test]
    fn parses_act_with_mixed_targets() {
        let r = parse_request(&json!({
            "type": "computer_query", "request_id": "r1", "session_id": "s1", "op": "act",
            "window_id": "0x10", "intent": "save the file",
            "steps": [
                {"do": "click", "target": {"ref": "e3"}},
                {"do": "type", "text": "你好\n"},
                {"do": "click", "target": {"x": 10, "y": 20.5, "obs": 4}},
                {"do": "click", "target": {"name": "保存", "role": "Button"}},
                {"do": "press", "keys": "ctrl+s"},
                {"do": "scroll", "direction": "down", "amount": 3}
            ]
        }))
        .unwrap();
        assert_eq!(r.session_id, "s1");
        let Query::Act { steps, .. } = r.query else { panic!() };
        assert_eq!(steps.len(), 6);
        assert_eq!(steps[0], Step::Click { target: Target::Ref { ref_id: "e3".into() } });
        assert_eq!(steps[2], Step::Click { target: Target::Point { x: 10.0, y: 20.5, obs: 4 } });
        assert_eq!(
            steps[3],
            Step::Click { target: Target::Name { name: "保存".into(), role: Some("Button".into()) } }
        );
    }

    #[test]
    fn act_requires_intent_and_bounded_steps() {
        let base = json!({"type": "computer_query", "request_id": "r", "op": "act", "window_id": "0x1",
            "steps": [{"do": "press", "keys": "enter"}]});
        assert!(matches!(q(base.clone()), Query::Malformed(m) if m.contains("intent")));
        let mut many = base.clone();
        many["intent"] = json!("x");
        many["steps"] = json!(vec![json!({"do": "press", "keys": "a"}); MAX_STEPS + 1]);
        assert!(matches!(q(many), Query::Malformed(m) if m.contains("at most")));
    }

    #[test]
    fn window_launch_needs_app() {
        let v = json!({"type": "computer_query", "request_id": "r", "op": "window", "action": "launch"});
        assert!(matches!(q(v), Query::Malformed(_)));
        let v = json!({"type": "computer_query", "request_id": "r", "op": "window", "action": "launch", "app": "Notepad"});
        assert!(matches!(q(v), Query::Window { action: WindowAction::Launch, .. }));
        let v = json!({"type": "computer_query", "request_id": "r", "op": "window", "action": "close"});
        assert!(matches!(q(v), Query::Malformed(_)));
    }

    #[test]
    fn parses_wait_conditions() {
        let v = json!({"type": "computer_query", "request_id": "r", "op": "wait", "window_id": "0x1",
            "condition": {"kind": "text_stable", "quiet_ms": 1200}});
        assert!(matches!(q(v), Query::Wait { condition: Condition::TextStable { quiet_ms: Some(1200) }, .. }));
        let v = json!({"type": "computer_query", "request_id": "r", "op": "wait",
            "condition": {"kind": "nope"}});
        assert!(matches!(q(v), Query::Malformed(_)));
    }

    #[test]
    fn result_command_is_tagged() {
        let c = result_command("r9", ok_payload(json!({"a": 1})));
        assert_eq!(c["cmd"], "computer_result");
        assert_eq!(c["request_id"], "r9");
        assert_eq!(c["ok"], true);
    }
}
