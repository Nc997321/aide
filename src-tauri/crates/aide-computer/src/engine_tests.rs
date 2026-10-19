//! 策略层单测：假适配器，任何平台可跑。

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::keys::Combo;
use crate::model::{ClickVia, Direction, Patterns, RawElement, Rect, Shot};
use crate::port::Signals;
use crate::protocol::parse_request;

#[derive(Default)]
struct Desk {
    elements: Vec<RawElement>,
    alive: bool,
    calls: Vec<String>,
    /// 打字时模拟用户动了鼠标。
    takeover_on_type: Option<SharedSignals>,
    windows: Vec<WindowInfo>,
    /// 每次 snapshot 后对元素做的改动（模拟持续输出）。
    on_snapshot: Option<Box<dyn FnMut(&mut Vec<RawElement>)>>,
    /// 根元素报告为禁用（模态框将要弹出）。
    disable_root: bool,
    /// 第 N 次列窗口时冒出一个对话框。
    dialog_after_lists: Option<u32>,
    lists: u32,
}

struct Fake(Rc<RefCell<Desk>>);

fn win(id: &str, title: &str) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: title.into(),
        process: "notepad.exe".into(),
        pid: 1,
        foreground: true,
        minimized: false,
        accessible: true,
        bounds: Rect { x: 0, y: 0, w: 800, h: 600 },
    }
}

fn el(rid: i32, role: &str, name: &str) -> RawElement {
    RawElement {
        runtime_id: vec![rid],
        role: role.into(),
        name: name.into(),
        depth: 1,
        bounds: Rect { x: 10, y: 10, w: 20, h: 20 },
        enabled: true,
        ..Default::default()
    }
}

impl Backend for Fake {
    fn list_windows(&mut self) -> Res<Vec<WindowInfo>> {
        let mut d = self.0.borrow_mut();
        d.lists += 1;
        if d.dialog_after_lists.is_some_and(|n| d.lists >= n) && !d.windows.iter().any(|w| w.id == "0x9") {
            let mut dialog = win("0x9", "另存为");
            dialog.foreground = false;
            d.windows.push(dialog);
        }
        Ok(d.windows.clone())
    }
    fn window(&mut self, id: &str) -> Res<WindowInfo> {
        self.0.borrow().windows.iter().find(|w| w.id == id).cloned().ok_or_else(|| "no such window".into())
    }
    fn foreground(&mut self) -> Option<String> {
        self.0.borrow().windows.iter().find(|w| w.foreground).map(|w| w.id.clone())
    }
    fn focused_element(&mut self) -> Option<(Vec<i32>, String)> {
        None
    }
    fn window_action(&mut self, id: &str, action: WindowAction) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("window {id} {action:?}"));
        Ok(())
    }
    fn launch(&mut self, app: &str) -> Res<String> {
        let mut d = self.0.borrow_mut();
        d.calls.push(format!("launch {app}"));
        for w in &mut d.windows {
            w.foreground = false;
        }
        d.windows.push(win("0x2", "无标题 - 记事本"));
        Ok("记事本".into())
    }
    fn snapshot(&mut self, id: &str, _text_tail: Option<u32>) -> Res<RawTree> {
        let mut d = self.0.borrow_mut();
        let window = d.windows.iter().find(|w| w.id == id).cloned().ok_or("no such window")?;
        let mut elements = vec![RawElement { depth: 0, enabled: !d.disable_root, ..el(1, "Window", &window.title) }];
        elements.extend(d.elements.clone());
        if let Some(mut f) = d.on_snapshot.take() {
            f(&mut d.elements);
            d.on_snapshot = Some(f);
        }
        Ok(RawTree { window, elements, truncated: false })
    }
    fn screenshot(&mut self, _id: &str, _max: u32) -> Res<Shot> {
        Ok(Shot { png: vec![1, 2, 3], width: 400, height: 300, scale: 0.5, origin: (100, 50) })
    }
    fn element_alive(&mut self, _w: &str, _rid: &[i32], _role: &str) -> Res<bool> {
        Ok(self.0.borrow().alive)
    }
    fn pattern_click(&mut self, _w: &str, rid: &[i32], via: ClickVia) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("{} {rid:?}", via.verb()));
        Ok(())
    }
    fn element_center(&mut self, _w: &str, _rid: &[i32]) -> Res<(i32, i32)> {
        Ok((20, 20))
    }
    fn focus_element(&mut self, _w: &str, rid: &[i32]) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("focus {rid:?}"));
        Ok(())
    }
    fn set_value(&mut self, _w: &str, _rid: &[i32], v: &str) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("set {v}"));
        Ok(())
    }
    fn bring_to_front(&mut self, _id: &str) -> Res<()> {
        Ok(())
    }
    fn check_point(&mut self, _id: &str, _x: i32, _y: i32) -> Res<()> {
        Ok(())
    }
    fn mouse_click(&mut self, x: i32, y: i32, _b: MouseButton, clicks: u32) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("mouse {x},{y} x{clicks}"));
        Ok(())
    }
    fn scroll(&mut self, x: i32, y: i32, _d: Direction, n: u32) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("scroll {x},{y} {n}"));
        Ok(())
    }
    fn type_text(&mut self, _id: &str, text: &str, interrupted: &dyn Fn() -> Option<String>) -> Res<usize> {
        let sig = self.0.borrow().takeover_on_type.clone();
        if let Some(s) = sig {
            s.takeover.store(true, Ordering::SeqCst);
        }
        if let Some(why) = interrupted() {
            return Err(why);
        }
        self.0.borrow_mut().calls.push(format!("type {text}"));
        let mut d = self.0.borrow_mut();
        d.elements.push(el(99, "Text", text));
        Ok(text.chars().count())
    }
    fn press(&mut self, _id: &str, combo: &Combo) -> Res<()> {
        self.0.borrow_mut().calls.push(format!("press {combo:?}"));
        Ok(())
    }
}

#[derive(Default)]
struct Screen {
    shown: Mutex<Vec<Option<String>>>,
    watching: Mutex<Vec<bool>>,
}
impl Guard for Screen {
    fn watch_input(&self, on: bool) {
        self.watching.lock().unwrap().push(on);
    }
    fn show(&self, text: Option<String>, _linger: Option<Duration>) {
        self.shown.lock().unwrap().push(text);
    }
}

#[derive(Default)]
struct Host {
    stopped: Mutex<Vec<String>>,
}
impl HostHooks for Host {
    fn emergency_stop(&self, sid: &str) {
        self.stopped.lock().unwrap().push(sid.into());
    }
    fn session_label(&self, _sid: &str) -> Option<String> {
        Some("测试会话".into())
    }
}

struct Rig {
    engine: Engine<Fake>,
    desk: Rc<RefCell<Desk>>,
    screen: Arc<Screen>,
    host: Arc<Host>,
    signals: SharedSignals,
}

fn rig() -> Rig {
    let desk = Rc::new(RefCell::new(Desk { alive: true, windows: vec![win("0x1", "文档 - 记事本")], ..Default::default() }));
    desk.borrow_mut().elements = vec![
        RawElement { patterns: Patterns { invoke: true, ..Default::default() }, ..el(10, "Button", "保存") },
        RawElement { patterns: Patterns { value_editable: true, ..Default::default() }, ..el(11, "Edit", "文件名") },
    ];
    let screen = Arc::new(Screen::default());
    let host = Arc::new(Host::default());
    let signals: SharedSignals = Arc::new(Signals::default());
    let engine = Engine::new(Fake(desk.clone()), screen.clone(), host.clone(), signals.clone());
    Rig { engine, desk, screen, host, signals }
}

fn call(r: &mut Rig, sid: &str, mut q: Value) -> Value {
    q["type"] = json!("computer_query");
    q["request_id"] = json!("r");
    q["session_id"] = json!(sid);
    r.engine.handle(&parse_request(&q).unwrap())
}

fn ref_of(read: &Value, name: &str) -> String {
    read["data"]["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap()["ref"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn read_then_act_by_ref_uses_pattern_and_reports_changes() {
    let mut r = rig();
    let read = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    assert_eq!(read["ok"], true);
    let save = ref_of(&read, "保存");
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "save",
        "steps": [{"do": "click", "target": {"ref": save}}, {"do": "type", "text": "hello"}]}));
    assert_eq!(act["ok"], true, "{act}");
    assert_eq!(act["data"]["executed"], 2);
    assert!(r.desk.borrow().calls.iter().any(|c| c.starts_with("invoked")));
    let added = &act["data"]["after"]["changes"]["added"];
    assert_eq!(added[0]["name"], "hello");
    // 持锁：装了钩子、提示条显示「正在操作」
    assert_eq!(r.screen.watching.lock().unwrap().last(), Some(&true));
    assert!(r.screen.shown.lock().unwrap().last().unwrap().as_ref().unwrap().contains("正在操作"));
}

#[test]
fn clicking_a_list_item_selects_it_instead_of_opening_it() {
    let mut r = rig();
    r.desk.borrow_mut().elements.push(RawElement {
        patterns: Patterns { invoke: true, select: true, ..Default::default() },
        ..el(30, "ListItem", "a.txt")
    });
    let read = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    let item = ref_of(&read, "a.txt");
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "select",
        "steps": [{"do": "click", "target": {"ref": item}}]}));
    assert_eq!(act["data"]["steps"][0]["done"], format!("selected [{item}] ListItem \"a.txt\""));
    assert!(!r.desk.borrow().calls.iter().any(|c| c.starts_with("invoked")));
}

#[test]
fn refs_are_stable_across_reads() {
    let mut r = rig();
    let a = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    let b = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    assert_eq!(ref_of(&a, "保存"), ref_of(&b, "保存"));
    assert_eq!(b["data"]["obs"].as_u64().unwrap(), a["data"]["obs"].as_u64().unwrap() + 1);
}

#[test]
fn stale_element_stops_before_acting() {
    let mut r = rig();
    let read = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    let save = ref_of(&read, "保存");
    r.desk.borrow_mut().alive = false;
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "save",
        "steps": [{"do": "click", "target": {"ref": save}}]}));
    assert_eq!(act["data"]["executed"], 0);
    assert!(act["data"]["stopped"].as_str().unwrap().contains("no longer there"));
    assert!(!r.desk.borrow().calls.iter().any(|c| c.starts_with("invoked")));
}

#[test]
fn coordinates_need_the_latest_screenshot() {
    let mut r = rig();
    let read = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1", "screenshot": true}));
    let obs = read["data"]["obs"].as_u64().unwrap();
    // 正确的观察版本：图像坐标按比例换回屏幕坐标（origin 100,50；scale 0.5）
    let ok = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "click",
        "steps": [{"do": "double_click", "target": {"x": 20, "y": 40, "obs": obs}}]}));
    assert_eq!(ok["data"]["executed"], 1, "{ok}");
    assert!(r.desk.borrow().calls.contains(&"mouse 140,130 x2".to_string()));
    // 做过动作后旧坐标作废
    let stale = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "click",
        "steps": [{"do": "click", "target": {"x": 20, "y": 40, "obs": obs}}]}));
    assert!(stale["data"]["stopped"].as_str().unwrap().contains("obs"));
}

#[test]
fn name_target_must_be_unambiguous() {
    let mut r = rig();
    r.desk.borrow_mut().elements.push(el(12, "Button", "保存副本"));
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x",
        "steps": [{"do": "click", "target": {"name": "保存"}}]}));
    // 精确命中优先：只有一个叫「保存」的
    assert_eq!(act["data"]["executed"], 1, "{act}");
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x",
        "steps": [{"do": "click", "target": {"name": "保"}}]}));
    assert!(act["data"]["stopped"].as_str().unwrap().contains("matches 2"));
}

#[test]
fn second_session_is_locked_out_until_release() {
    let mut r = rig();
    let a = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert_eq!(a["ok"], true);
    let b = call(&mut r, "s2", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert_eq!(b["ok"], false);
    assert!(b["error"].as_str().unwrap().contains("测试会话"));
    // 只读不需要锁
    assert_eq!(call(&mut r, "s2", json!({"op": "windows"}))["ok"], true);
    r.engine.session_signal("s1", SessionSignal::TurnEnd);
    let c = call(&mut r, "s2", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert_eq!(c["ok"], true);
}

#[test]
fn user_takeover_pauses_until_next_user_message() {
    let mut r = rig();
    r.desk.borrow_mut().takeover_on_type = Some(r.signals.clone());
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "type",
        "steps": [{"do": "type", "text": "abc"}, {"do": "press", "keys": "enter"}]}));
    assert_eq!(act["data"]["executed"], 0);
    assert!(act["data"]["stopped"].as_str().unwrap().contains("user"));
    assert!(!r.desk.borrow().calls.iter().any(|c| c.starts_with("press")));
    // 锁已放、钩子已卸
    assert_eq!(r.screen.watching.lock().unwrap().last(), Some(&false));
    r.desk.borrow_mut().takeover_on_type = None;
    let again = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert_eq!(again["ok"], false);
    assert!(again["error"].as_str().unwrap().contains("took over"));
    r.engine.session_signal("s1", SessionSignal::UserMessage);
    let resumed = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert_eq!(resumed["ok"], true, "{resumed}");
}

#[test]
fn takeover_during_a_wait_also_pauses() {
    let mut r = rig();
    call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    r.signals.takeover.store(true, Ordering::SeqCst);
    let w = call(&mut r, "s1", json!({"op": "wait", "window_id": "0x1", "condition": {"kind": "text_contains", "text": "never"}, "timeout_ms": 2000}));
    assert!(w["error"].as_str().unwrap().contains("user"), "{w}");
    let a = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert!(a["error"].as_str().unwrap().contains("took over"));
}

#[test]
fn emergency_stop_interrupts_the_lock_owner() {
    let mut r = rig();
    call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    r.signals.stop.store(true, Ordering::SeqCst);
    r.engine.tick();
    assert_eq!(*r.host.stopped.lock().unwrap(), vec!["s1".to_string()]);
    assert_eq!(r.screen.shown.lock().unwrap().last(), Some(&None));
}

#[test]
fn launch_returns_the_new_window() {
    let mut r = rig();
    let v = call(&mut r, "s1", json!({"op": "window", "action": "launch", "app": "notepad"}));
    assert_eq!(v["data"]["window"]["id"], "0x2", "{v}");
    assert_eq!(v["data"]["launched"], "记事本");
}

#[test]
fn act_waits_briefly_for_a_modal_dialog_to_appear() {
    let mut r = rig();
    // 按下快捷键后属主窗口被禁用，对话框稍后才出现
    call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    r.desk.borrow_mut().disable_root = true;
    r.desk.borrow_mut().dialog_after_lists = Some(3);
    let v = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "save", "steps": [{"do": "press", "keys": "ctrl+s"}]}));
    assert_eq!(v["data"]["after"]["opened_windows"][0]["title"], "另存为", "{v}");
}

#[test]
fn scoped_read_lists_only_the_subtree_and_sticks() {
    let mut r = rig();
    {
        let mut d = r.desk.borrow_mut();
        d.elements = vec![
            RawElement { depth: 1, ..el(20, "List", "会话列表") },
            RawElement { depth: 2, ..el(21, "ListItem", "甲") },
            RawElement { depth: 2, ..el(22, "ListItem", "乙") },
            RawElement { depth: 1, ..el(23, "Button", "设置") },
        ];
    }
    let full = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    let list = ref_of(&full, "会话列表");
    let scoped = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1", "scope": list}));
    let names: Vec<&str> = scoped["data"]["elements"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["会话列表", "甲", "乙"]);
    assert_eq!(scoped["data"]["scope"], list.as_str());
    // 分区沿用到动作回报：新增在分区外的元素不出现在变化里
    r.desk.borrow_mut().elements.push(RawElement { depth: 1, ..el(24, "Button", "分区外") });
    let act = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "down"}]}));
    assert_eq!(act["data"]["after"]["changes"], "none visible in this window", "{act}");
    // 不带 scope 的读取回到整个窗口
    let back = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1"}));
    assert!(back["data"].get("scope").is_none());
    assert_eq!(back["data"]["elements"].as_array().unwrap().len(), 6);
    // 不在最近一次读取里的 ref 不能当分区
    let bad = call(&mut r, "s1", json!({"op": "read", "window_id": "0x1", "scope": "e999"}));
    assert_eq!(bad["ok"], false);
}

#[test]
fn inaccessible_window_is_refused() {
    let mut r = rig();
    r.desk.borrow_mut().windows[0].accessible = false;
    let v = call(&mut r, "s1", json!({"op": "act", "window_id": "0x1", "intent": "x", "steps": [{"do": "press", "keys": "enter"}]}));
    assert!(v["error"].as_str().unwrap().contains("administrator"));
}

#[test]
fn text_stable_waits_for_output_to_settle() {
    let mut r = rig();
    let mut n = 0;
    r.desk.borrow_mut().on_snapshot = Some(Box::new(move |els: &mut Vec<RawElement>| {
        n += 1;
        if n <= 3 {
            els.push(el(200 + n, "Text", &format!("line {n}")));
        }
    }));
    let v = call(&mut r, "s1", json!({"op": "wait", "window_id": "0x1",
        "condition": {"kind": "text_stable", "quiet_ms": 300}, "timeout_ms": 5000}));
    assert_eq!(v["data"]["met"], true, "{v}");
    let added = v["data"]["changes"]["added"].as_array().unwrap();
    assert!(added.len() >= 2);
}

#[test]
fn reading_flashes_viewing_hint_without_lock() {
    let mut r = rig();
    call(&mut r, "s1", json!({"op": "windows"}));
    assert!(r.screen.shown.lock().unwrap().last().unwrap().as_ref().unwrap().contains("正在查看"));
    assert!(r.screen.watching.lock().unwrap().is_empty());
}
