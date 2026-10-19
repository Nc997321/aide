//! 真机调试台：从 stdin 逐行读 JSON 查询（只写 `op` 及其参数），打印回包。截图存成 PNG 文件。
//!
//! ```text
//! echo {"op":"windows"} | cargo run -p aide-computer --example drive
//! cargo run -p aide-computer --example drive < scenario.jsonl
//! ```
//! 每行可加 `"sleep_ms"` 在执行前等一会；`"session_id"` 缺省为 `drive`。
//! `"save": {"w": "/data/window/id"}` 把回包里某处存成变量，后续行里的 `${w}` 会被替换；
//! `"expect": {"/data/window/title": "记事本"}` 回包那处不含该文字就中止整个脚本（安全闸）。

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::Arc;
use std::time::Instant;

use aide_computer::{parse_request, Computer, HostHooks};
use base64::Engine as _;
use serde_json::{json, Value};

struct Hooks;
impl HostHooks for Hooks {
    fn emergency_stop(&self, session_id: &str) {
        println!("<< emergency stop: interrupt session {session_id} >>");
    }
    fn session_label(&self, _: &str) -> Option<String> {
        Some("调试台".into())
    }
}

fn main() {
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_target(false).init();
    let computer = Computer::start(Arc::new(Hooks));
    let stdin = std::io::stdin();
    let mut vars: HashMap<String, String> = HashMap::new();
    for (n, line) in stdin.lock().lines().enumerate() {
        let Ok(mut line) = line else { break };
        for (k, v) in &vars {
            line = line.replace(&format!("${{{k}}}"), v);
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut q: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                println!("line {}: bad JSON: {e}", n + 1);
                continue;
            }
        };
        if let Some(ms) = q.get("sleep_ms").and_then(Value::as_u64) {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        q["type"] = json!("computer_query");
        q["request_id"] = json!(format!("r{}", n + 1));
        if q.get("session_id").is_none() {
            q["session_id"] = json!("drive");
        }
        if q.get("signal").is_some() {
            // {"signal":"user_message"} / {"signal":"completed"}：模拟会话事件
            let ev = json!({"type": q["signal"], "session_id": q["session_id"]});
            computer.observe_event(&ev);
            println!("== signal {}", q["signal"]);
            continue;
        }
        let save = q.get("save").cloned();
        let expect = q.get("expect").cloned();
        let Some(req) = parse_request(&q) else { continue };
        let op = req.query.op_name();
        let started = Instant::now();
        let mut out = computer.answer_blocking(req);
        let ms = started.elapsed().as_millis();
        if let Some(b64) = out.pointer("/data/screenshot/png_base64").and_then(Value::as_str) {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
            let path = format!("shot-{}.png", n + 1);
            let _ = std::fs::write(&path, bytes);
            out["data"]["screenshot"]["png_base64"] = json!(format!("<saved to {path}>"));
        }
        println!("== line {} op={op} {ms}ms\n{}", n + 1, serde_json::to_string_pretty(&out).unwrap_or_default());
        if let Some(Value::Object(m)) = save {
            for (k, ptr) in m {
                let v = ptr.as_str().and_then(|p| out.pointer(p)).map(|v| v.as_str().map(str::to_string).unwrap_or(v.to_string()));
                if let Some(v) = v {
                    vars.insert(k, v);
                }
            }
        }
        if let Some(Value::Object(m)) = expect {
            for (ptr, want) in m {
                let got = out.pointer(&ptr).map(|v| v.as_str().map(str::to_string).unwrap_or(v.to_string())).unwrap_or_default();
                let want = want.as_str().unwrap_or_default();
                if !got.contains(want) {
                    println!("== ABORT: {ptr} = {got:?} does not contain {want:?}");
                    return;
                }
            }
        }
    }
}
