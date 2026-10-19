//! 策略层：输入锁、观察版本、元素引用、逐步校验执行、动作后回报、接管与急停。
//!
//! 只认 [`Backend`] / [`Guard`] 两个端口，任何平台都能用假适配器单测。
//! 跑在执行器自己的线程上，一次处理一个请求。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::keys::parse_combo;
use crate::model::{ClickVia, MouseButton, RawElement, RawTree, ViewElement, WindowAction, WindowInfo};
use crate::port::{Backend, Guard, HostHooks, Res, SharedSignals};
use crate::protocol::{err_payload, ok_payload, Condition, Query, Request, Step, Target};
use crate::prune::prune;
use crate::refs::{diff, Diff, RefTable};

/// 持锁会话多久没有动作就自动放锁。
pub const IDLE_RELEASE: Duration = Duration::from_secs(30);
/// 动作做完后等界面静下来。
const SETTLE: Duration = Duration::from_millis(250);
const SCREENSHOT_MAX_SIDE: u32 = 1280;
const WAIT_DEFAULT: Duration = Duration::from_secs(10);
const WAIT_MAX: Duration = Duration::from_secs(60);
const WAIT_POLL: Duration = Duration::from_millis(250);
const LAUNCH_WAIT: Duration = Duration::from_secs(10);
const STOP_HOTKEY: &str = "Ctrl+Alt+Shift+S";
const MODAL_WAIT: Duration = Duration::from_millis(1500);

/// 每个窗口的观察状态。
#[derive(Default)]
struct WinState {
    obs: u64,
    refs: RefTable,
    view: Vec<ViewElement>,
    /// 上次读取之后做过动作：坐标作废，按名字找元素前要重读。
    dirty: bool,
    shot: Option<ShotMeta>,
    /// 分区读取：只看这个元素（RuntimeId, ref）下面的部分。
    scope: Option<(Vec<i32>, String)>,
}

#[derive(Clone, Copy)]
struct ShotMeta {
    obs: u64,
    scale: f64,
    origin: (i32, i32),
    size: (i32, i32),
}

struct Lock {
    session: String,
    last_used: Instant,
}

/// 会话这一轮的信号（来自事件流）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSignal {
    /// 用户发了新消息：解除「用户接管」的暂停。
    UserMessage,
    /// 这一轮结束（完成 / 失败 / 被停止）。
    TurnEnd,
}

pub struct Engine<B: Backend> {
    backend: B,
    guard: Arc<dyn Guard>,
    host: Arc<dyn HostHooks>,
    signals: SharedSignals,
    lock: Option<Lock>,
    /// 用户接管后暂停的会话：等用户发新消息才解除。
    paused: HashSet<String>,
    windows: HashMap<String, WinState>,
}

/// 动作中途被打断的原因。
enum Halt {
    Failed(String),
    Interrupted(String),
}

impl<B: Backend> Engine<B> {
    pub fn new(backend: B, guard: Arc<dyn Guard>, host: Arc<dyn HostHooks>, signals: SharedSignals) -> Self {
        Self { backend, guard, host, signals, lock: None, paused: HashSet::new(), windows: HashMap::new() }
    }

    /// 处理一个请求，返回回包载荷（`{ok, data|error}`）。
    pub fn handle(&mut self, req: &Request) -> Value {
        let sid = req.session_id.as_str();
        let result = match &req.query {
            Query::Malformed(m) => Err(format!("malformed computer_query: {m}")),
            Query::Windows => {
                self.flash_viewing(sid);
                self.list_windows()
            }
            Query::Read { window_id, screenshot, text_tail, scope } => {
                self.flash_viewing(sid);
                self.read(window_id.as_deref(), *screenshot, *text_tail, scope.as_deref())
            }
            Query::Wait { window_id, condition, timeout_ms } => {
                self.flash_viewing(sid);
                self.wait(sid, window_id.as_deref(), condition, *timeout_ms)
            }
            Query::Window { action, window_id, app } => {
                self.window_op(sid, *action, window_id.as_deref(), app.as_deref())
            }
            Query::Act { window_id, intent, steps } => self.act(sid, window_id, intent, steps),
        };
        match result {
            Ok(v) => ok_payload(v),
            Err(e) => err_payload(e),
        }
    }

    /// 会话事件（来自事件流）。
    pub fn session_signal(&mut self, sid: &str, signal: SessionSignal) {
        if signal == SessionSignal::UserMessage {
            self.paused.remove(sid);
        }
        self.signals.uncancel(sid);
        if self.lock.as_ref().is_some_and(|l| l.session == sid) {
            self.release();
        }
    }

    /// 定时调用：空闲放锁、处理急停。
    pub fn tick(&mut self) {
        if self.signals.take_stop() {
            if let Some(owner) = self.lock.as_ref().map(|l| l.session.clone()) {
                self.release();
                self.host.emergency_stop(&owner);
            }
        }
        if self.lock.as_ref().is_some_and(|l| l.last_used.elapsed() > IDLE_RELEASE) {
            self.release();
        }
    }

    // ---------------------------------------------------------------- 锁

    fn acquire(&mut self, sid: &str) -> Res<()> {
        if self.paused.contains(sid) {
            return Err("The user took over the mouse/keyboard, so you stopped. Do not act again until the user sends a new message telling you to continue.".into());
        }
        if self.signals.is_cancelled(sid) {
            return Err("This turn was stopped; do not continue operating the computer.".into());
        }
        match &mut self.lock {
            Some(l) if l.session == sid => {
                l.last_used = Instant::now();
                Ok(())
            }
            Some(l) => Err(format!(
                "Another Aide session ({}) is operating the computer right now. Wait for it to finish, or tell the user.",
                self.host.session_label(&l.session).unwrap_or_else(|| l.session.clone())
            )),
            None => {
                self.signals.takeover.store(false, Ordering::SeqCst);
                self.signals.stop.store(false, Ordering::SeqCst);
                self.signals.set_owner(Some(sid.to_string()));
                self.lock = Some(Lock { session: sid.to_string(), last_used: Instant::now() });
                self.guard.watch_input(true);
                self.guard.show(Some(Self::operating_text()), None);
                Ok(())
            }
        }
    }

    fn release(&mut self) {
        if self.lock.take().is_some() {
            self.signals.set_owner(None);
            self.guard.watch_input(false);
            self.guard.show(None, None);
        }
    }

    /// 提示条告诉用户：在 Aide 里操作（批准、打字、停止）不会打断它，别处点击 / 按键才会。
    fn operating_text() -> String {
        format!("Aide 正在操作 · Aide 内操作不影响 · 按 {STOP_HOTKEY} 停止")
    }

    fn flash_viewing(&self, sid: &str) {
        // 持锁期间常驻「正在操作」，不被「正在查看」覆盖。
        if self.lock.is_some() {
            return;
        }
        let text = match self.host.session_label(sid) {
            Some(l) if !l.trim().is_empty() => format!("Aide 正在查看 · {l}"),
            _ => "Aide 正在查看".to_string(),
        };
        self.guard.show(Some(text), Some(Duration::from_secs(2)));
    }

    /// 动作执行中检查：急停 / 用户接管 / 本轮已结束。
    fn interruption(&self, sid: &str) -> Option<String> {
        if self.signals.stop.load(Ordering::SeqCst) {
            return Some(format!("The user pressed the emergency stop ({STOP_HOTKEY}). Stop operating the computer."));
        }
        if self.signals.takeover.load(Ordering::SeqCst) {
            return Some("The user started using the mouse/keyboard, so you stopped. Do not act again until the user sends a new message telling you to continue.".into());
        }
        if self.signals.is_cancelled(sid) {
            return Some("This turn was stopped.".into());
        }
        None
    }

    /// 被打断后的收尾：接管 → 暂停该会话；急停交给 tick 去中断会话。
    fn on_interrupted(&mut self, sid: &str) {
        if self.signals.takeover.load(Ordering::SeqCst) {
            self.paused.insert(sid.to_string());
            self.release();
            self.guard.show(Some("Aide 已停手：你接管了鼠标键盘".into()), Some(Duration::from_secs(3)));
        }
    }

    // ---------------------------------------------------------------- 读

    fn list_windows(&mut self) -> Res<Value> {
        let windows = self.backend.list_windows()?;
        Ok(json!({ "windows": windows }))
    }

    fn resolve_window(&mut self, window_id: Option<&str>) -> Res<String> {
        match window_id {
            Some(id) => Ok(id.to_string()),
            None => self
                .backend
                .foreground()
                .ok_or_else(|| "There is no foreground window. Call computer_windows and pass a window_id.".into()),
        }
    }

    /// 读一次并更新该窗口的观察状态（有分区就只看分区）。返回 (窗口信息, 截断数, 原始截断)。
    fn observe(&mut self, id: &str, text_tail: Option<u32>) -> Res<(WindowInfo, usize, bool)> {
        let RawTree { window, elements, truncated } = self.backend.snapshot(id, text_tail)?;
        let state = self.windows.entry(id.to_string()).or_default();
        let slice: &[RawElement] = match &state.scope {
            Some((rid, _)) => match subtree(&elements, rid) {
                Some(s) => s,
                None => {
                    // 分区的根元素不在了：退回整个窗口。
                    state.scope = None;
                    &elements
                }
            },
            None => &elements,
        };
        let pruned = prune(slice, |rid| state.refs.assign(rid));
        state.obs += 1;
        state.view = pruned.elements;
        state.dirty = false;
        Ok((window, pruned.omitted, truncated))
    }

    fn read(&mut self, window_id: Option<&str>, screenshot: bool, text_tail: Option<u32>, scope: Option<&str>) -> Res<Value> {
        let id = self.resolve_window(window_id)?;
        let state = self.windows.entry(id.clone()).or_default();
        state.scope = match scope {
            None => None,
            Some(r) => {
                let el = state.view.iter().find(|e| e.ref_id == r).ok_or_else(|| {
                    format!("scope {r} is not in the latest read of this window — read the whole window first and pick a ref from it.")
                })?;
                if el.runtime_id.is_empty() {
                    return Err(format!("{r} cannot be used as a scope; pick a container that has a name or a role like List, Pane, Group."));
                }
                Some((el.runtime_id.clone(), r.to_string()))
            }
        };
        let (window, omitted, raw_truncated) = self.observe(&id, text_tail)?;
        let focused = self.focused_ref(&id);
        let state = self.windows.get_mut(&id).expect("observed");
        let mut out = json!({
            "obs": state.obs,
            "window": window,
            "elements": state.view,
        });
        if let Some(f) = focused {
            out["focused"] = json!(f);
        }
        match (&state.scope, scope) {
            (Some((_, r)), _) => out["scope"] = json!(r),
            (None, Some(r)) => out["note_scope"] = json!(format!("{r} is gone; showing the whole window.")),
            _ => {}
        }
        if omitted > 0 || raw_truncated {
            out["truncated"] = json!(format!(
                "{omitted} more elements not listed{}. Narrow down: read again with scope=<ref of the list/panel you need>.",
                if raw_truncated { " (the window's tree is very large)" } else { "" }
            ));
        }
        if !window.accessible {
            out["note"] = json!("This window runs with higher privileges (administrator). Windows blocks Aide's input to it; you can only look.");
        }
        if screenshot {
            let obs = state.obs;
            match self.backend.screenshot(&id, SCREENSHOT_MAX_SIDE) {
                Ok(shot) => {
                    let state = self.windows.get_mut(&id).expect("observed");
                    state.shot = Some(ShotMeta {
                        obs,
                        scale: shot.scale,
                        origin: shot.origin,
                        size: (window.bounds.w, window.bounds.h),
                    });
                    out["screenshot"] = json!({
                        "png_base64": base64::engine::general_purpose::STANDARD.encode(&shot.png),
                        "width": shot.width,
                        "height": shot.height,
                    });
                }
                Err(e) => out["screenshot_error"] = json!(e),
            }
        }
        Ok(out)
    }

    fn focused_ref(&mut self, id: &str) -> Option<String> {
        if self.backend.foreground().as_deref() != Some(id) {
            return None;
        }
        let (rid, _) = self.backend.focused_element()?;
        let state = self.windows.get(id)?;
        state.view.iter().find(|e| !rid.is_empty() && e.runtime_id == rid).map(|e| e.ref_id.clone())
    }

    // ---------------------------------------------------------------- 窗口动作

    fn window_op(&mut self, sid: &str, action: WindowAction, window_id: Option<&str>, app: Option<&str>) -> Res<Value> {
        self.acquire(sid)?;
        if action == WindowAction::Launch {
            let app = app.unwrap_or_default();
            let before: HashSet<String> = self.backend.list_windows()?.into_iter().map(|w| w.id).collect();
            let matched = self.backend.launch(app)?;
            let deadline = Instant::now() + LAUNCH_WAIT;
            while Instant::now() < deadline {
                if let Some(msg) = self.interruption(sid) {
                    self.on_interrupted(sid);
                    return Err(msg);
                }
                std::thread::sleep(WAIT_POLL);
                let now = self.backend.list_windows()?;
                let fresh: Vec<&WindowInfo> = now.iter().filter(|w| !before.contains(&w.id)).collect();
                if let Some(w) = fresh.iter().find(|w| w.foreground).or(fresh.first()) {
                    return Ok(json!({ "launched": matched, "window": w }));
                }
            }
            return Ok(json!({
                "launched": matched,
                "note": "No new window appeared within 10s. The app may already have been running (check computer_windows), or it is still starting (computer_wait window_appears)."
            }));
        }
        let id = window_id.unwrap_or_default();
        let info = self.backend.window(id)?;
        if !info.accessible && action != WindowAction::Close {
            return Err(inaccessible(&info));
        }
        self.backend.window_action(id, action)?;
        std::thread::sleep(SETTLE);
        if let Some(s) = self.windows.get_mut(id) {
            s.dirty = true;
        }
        let after = if action == WindowAction::Close { self.backend.window(id).ok() } else { Some(self.backend.window(id)?) };
        Ok(json!({ "window": after, "closed": action == WindowAction::Close && after.is_none() }))
    }

    // ---------------------------------------------------------------- 动作

    fn act(&mut self, sid: &str, window_id: &str, intent: &str, steps: &[Step]) -> Res<Value> {
        self.acquire(sid)?;
        let info = self.backend.window(window_id)?;
        if !info.accessible {
            return Err(inaccessible(&info));
        }
        tracing::info!(window = window_id, intent, steps = steps.len(), "computer act");
        let windows_before: Vec<WindowInfo> = self.backend.list_windows().unwrap_or_default();
        // 回报以「上次读取」为基线；从没读过就先读一次（不然没有基线可比）。
        if !self.windows.contains_key(window_id) {
            self.observe(window_id, None)?;
        }
        let baseline = self.windows.get(window_id).map(|s| s.view.clone()).unwrap_or_default();

        let mut done = Vec::new();
        let mut halt = None;
        for (i, step) in steps.iter().enumerate() {
            if let Some(msg) = self.interruption(sid) {
                halt = Some(Halt::Interrupted(msg));
                break;
            }
            match self.run_step(sid, window_id, step) {
                Ok(how) => {
                    done.push(json!({ "step": i + 1, "done": how }));
                    if let Some(s) = self.windows.get_mut(window_id) {
                        s.dirty = true;
                    }
                }
                Err(Halt::Failed(e)) => {
                    halt = Some(Halt::Failed(format!("Step {} was not executed: {e}", i + 1)));
                    break;
                }
                Err(Halt::Interrupted(e)) => {
                    halt = Some(Halt::Interrupted(format!("Stopped during step {}: {e}", i + 1)));
                    break;
                }
            }
        }
        if let Some(l) = &mut self.lock {
            l.last_used = Instant::now();
        }
        let interrupted = matches!(halt, Some(Halt::Interrupted(_)));
        if interrupted {
            self.on_interrupted(sid);
        }
        if !done.is_empty() {
            std::thread::sleep(SETTLE);
        }
        let report = self.after_report(window_id, &baseline, &windows_before);
        let mut out = json!({
            "executed": done.len(),
            "of": steps.len(),
            "steps": done,
            "after": report,
        });
        if let Some(h) = halt {
            out["stopped"] = json!(match h {
                Halt::Failed(m) | Halt::Interrupted(m) => m,
            });
        }
        Ok(out)
    }

    fn run_step(&mut self, sid: &str, window: &str, step: &Step) -> Result<String, Halt> {
        let fail = Halt::Failed;
        match step {
            Step::Click { target } | Step::DoubleClick { target } | Step::RightClick { target } => {
                let (button, clicks) = match step {
                    Step::DoubleClick { .. } => (MouseButton::Left, 2),
                    Step::RightClick { .. } => (MouseButton::Right, 1),
                    _ => (MouseButton::Left, 1),
                };
                let resolved = self.resolve_target(window, target).map_err(fail)?;
                if let Resolved::Element { runtime_id, via: Some(via), label, .. } = &resolved {
                    if clicks == 1 && button == MouseButton::Left {
                        self.backend.pattern_click(window, runtime_id, *via).map_err(fail)?;
                        return Ok(format!("{} {label}", via.verb()));
                    }
                }
                let (x, y) = self.point_of(window, &resolved).map_err(fail)?;
                self.backend.bring_to_front(window).map_err(fail)?;
                self.backend.check_point(window, x, y).map_err(fail)?;
                self.backend.mouse_click(x, y, button, clicks).map_err(fail)?;
                Ok(format!("mouse {} {}", click_word(button, clicks), resolved.label()))
            }
            Step::Type { text, target } => {
                if let Some(t) = target {
                    let resolved = self.resolve_target(window, t).map_err(fail)?;
                    match &resolved {
                        Resolved::Element { takes_text: false, label, .. } => {
                            return Err(fail(format!(
                                "{label} does not take typed text. To press it use click; to type into whatever has the focus, omit target."
                            )));
                        }
                        Resolved::Element { runtime_id, .. } => {
                            self.backend.focus_element(window, runtime_id).map_err(fail)?;
                            self.backend.bring_to_front(window).map_err(fail)?;
                        }
                        Resolved::Point { .. } => {
                            let (x, y) = self.point_of(window, &resolved).map_err(fail)?;
                            self.backend.bring_to_front(window).map_err(fail)?;
                            self.backend.check_point(window, x, y).map_err(fail)?;
                            self.backend.mouse_click(x, y, MouseButton::Left, 1).map_err(fail)?;
                        }
                    }
                } else {
                    self.backend.bring_to_front(window).map_err(fail)?;
                }
                let signals = Arc::clone(&self.signals);
                let sid_owned = sid.to_string();
                let check = move || interruption_of(&signals, &sid_owned);
                let total = text.chars().count();
                match self.backend.type_text(window, text, &check) {
                    Ok(n) => Ok(format!("typed {n} characters")),
                    Err(e) => {
                        if let Some(m) = self.interruption(sid) {
                            Err(Halt::Interrupted(format!("{m} (typing was cut off; {total} characters were requested)")))
                        } else {
                            Err(Halt::Failed(e))
                        }
                    }
                }
            }
            Step::Press { keys } => {
                let combo = parse_combo(keys).map_err(fail)?;
                self.backend.bring_to_front(window).map_err(fail)?;
                self.backend.press(window, &combo).map_err(fail)?;
                Ok(format!("pressed {keys}"))
            }
            Step::Scroll { target, direction, amount } => {
                let (x, y) = match target {
                    Some(t) => {
                        let r = self.resolve_target(window, t).map_err(fail)?;
                        self.point_of(window, &r).map_err(fail)?
                    }
                    None => self.backend.window(window).map_err(fail)?.bounds.center(),
                };
                self.backend.check_point(window, x, y).map_err(fail)?;
                let n = amount.unwrap_or(3).clamp(1, 30);
                self.backend.scroll(x, y, *direction, n).map_err(fail)?;
                Ok(format!("scrolled {direction:?} {n}").to_lowercase())
            }
            Step::SetValue { target, value } => {
                let resolved = self.resolve_target(window, target).map_err(fail)?;
                let Resolved::Element { runtime_id, label, .. } = &resolved else {
                    return Err(fail("set_value needs an element target (ref or name), not a point".into()));
                };
                self.backend.set_value(window, runtime_id, value).map_err(fail)?;
                Ok(format!("set value of {label}"))
            }
        }
    }

    /// 动作后的回报：前台、焦点、新开 / 关掉的窗口、目标窗口相对基线的变化。
    fn after_report(&mut self, window: &str, baseline: &[ViewElement], windows_before: &[WindowInfo]) -> Value {
        let mut windows_now = self.backend.list_windows().unwrap_or_default();
        // 目标窗口被禁用 = 有模态对话框正在弹出（它会禁用属主窗口）；新窗口还没出现就再等一会，
        // 让这次回报直接带上它，省 agent 一轮等待。
        if windows_now.iter().any(|w| w.id == window)
            && !windows_now.iter().any(|w| !windows_before.iter().any(|b| b.id == w.id))
            && self.root_disabled(window)
        {
            let deadline = Instant::now() + MODAL_WAIT;
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
                windows_now = self.backend.list_windows().unwrap_or_default();
                if windows_now.iter().any(|w| !windows_before.iter().any(|b| b.id == w.id)) {
                    break;
                }
            }
        }
        let opened: Vec<&WindowInfo> =
            windows_now.iter().filter(|w| !windows_before.iter().any(|b| b.id == w.id)).collect();
        let closed: Vec<Value> = windows_before
            .iter()
            .filter(|b| !windows_now.iter().any(|w| w.id == b.id))
            .map(|b| json!({ "id": b.id, "title": b.title }))
            .collect();
        let foreground = self.backend.foreground().and_then(|f| windows_now.iter().find(|w| w.id == f).cloned());
        let mut out = json!({ "foreground": foreground });
        if !opened.is_empty() {
            out["opened_windows"] = json!(opened);
        }
        if !closed.is_empty() {
            out["closed_windows"] = json!(closed);
        }
        if windows_now.iter().any(|w| w.id == window) {
            match self.observe(window, None) {
                Ok(_) => {
                    let state = self.windows.get(window).expect("observed");
                    let d: Diff = diff(baseline, &state.view);
                    out["obs"] = json!(state.obs);
                    out["changes"] = if d.is_empty() { json!("none visible in this window") } else { json!(d) };
                    if let Some(f) = self.focused_ref(window) {
                        out["focused"] = json!(f);
                    }
                }
                Err(e) => out["read_error"] = json!(e),
            }
        } else {
            out["window_gone"] = json!(true);
            self.windows.remove(window);
        }
        out
    }

    // ---------------------------------------------------------------- 目标解析

    fn resolve_target(&mut self, window: &str, target: &Target) -> Res<Resolved> {
        match target {
            Target::Ref { ref_id } => {
                let state = self
                    .windows
                    .get(window)
                    .ok_or("This window has not been read yet — call computer_read first.")?;
                let el = state.view.iter().find(|e| &e.ref_id == ref_id).ok_or_else(|| {
                    format!("{ref_id} is not in the latest read of this window — the UI changed. Call computer_read again.")
                })?;
                let (rid, role, via, takes_text, label) =
                    (el.runtime_id.clone(), el.role.clone(), el.click_via, el.takes_text, describe(el));
                if rid.is_empty() || !self.backend.element_alive(window, &rid, &role)? {
                    return Err(format!("{label} is no longer there — the UI changed. Call computer_read again."));
                }
                Ok(Resolved::Element { runtime_id: rid, via, takes_text, label })
            }
            Target::Name { name, role } => {
                if self.windows.get(window).is_none_or(|s| s.dirty) {
                    self.observe(window, None)?;
                }
                let state = self.windows.get(window).expect("observed");
                let el = find_by_name(&state.view, name, role.as_deref())?;
                Ok(Resolved::Element {
                    runtime_id: el.runtime_id.clone(),
                    via: el.click_via,
                    takes_text: el.takes_text,
                    label: describe(el),
                })
            }
            Target::Point { x, y, obs } => {
                let state = self.windows.get(window).ok_or("No screenshot of this window yet — call computer_read with screenshot=true.")?;
                let shot = state.shot.ok_or("No screenshot of this window yet — call computer_read with screenshot=true.")?;
                if shot.obs != *obs || state.obs != *obs {
                    return Err(format!(
                        "Coordinates are from obs {obs}, but the latest view of this window is obs {}. Take a new screenshot (computer_read screenshot=true) and use its coordinates.",
                        state.obs
                    ));
                }
                if state.dirty {
                    return Err("Something was done in this window after that screenshot, so its coordinates may be stale. Take a new screenshot first.".into());
                }
                let now = self.backend.window(window)?.bounds;
                if (now.w, now.h) != shot.size {
                    return Err("The window was resized after that screenshot. Take a new screenshot first.".into());
                }
                let sx = shot.origin.0 + (*x / shot.scale).round() as i32;
                let sy = shot.origin.1 + (*y / shot.scale).round() as i32;
                Ok(Resolved::Point { x: sx, y: sy, label: format!("at ({x}, {y})") })
            }
        }
    }

    /// 窗口根元素是否处于禁用（读一次；只在判断「是否有模态框要弹」时用）。
    fn root_disabled(&mut self, window: &str) -> bool {
        match self.backend.snapshot(window, None) {
            Ok(t) => t.elements.first().is_some_and(|e| !e.enabled),
            Err(_) => false,
        }
    }

    fn point_of(&mut self, window: &str, r: &Resolved) -> Res<(i32, i32)> {
        match r {
            Resolved::Element { runtime_id, .. } => self.backend.element_center(window, runtime_id),
            Resolved::Point { x, y, .. } => Ok((*x, *y)),
        }
    }

    // ---------------------------------------------------------------- 等待

    fn wait(&mut self, sid: &str, window_id: Option<&str>, cond: &Condition, timeout_ms: Option<u64>) -> Res<Value> {
        let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(WAIT_DEFAULT).min(WAIT_MAX);
        let start = Instant::now();
        let needs_window = !matches!(cond, Condition::WindowAppears { .. } | Condition::FocusChanges);
        let window = if needs_window { Some(self.resolve_window(window_id)?) } else { window_id.map(str::to_string) };

        let fg_start = self.backend.foreground();
        let focus_start = self.backend.focused_element().map(|(r, _)| r);
        let baseline = match (&window, cond) {
            (Some(w), Condition::TextStable { .. }) => {
                self.observe(w, None)?;
                self.windows.get(w).map(|s| s.view.clone()).unwrap_or_default()
            }
            _ => Vec::new(),
        };
        let quiet = match cond {
            Condition::TextStable { quiet_ms } => Duration::from_millis(quiet_ms.unwrap_or(1500).clamp(300, 20_000)),
            _ => Duration::ZERO,
        };
        let mut last_sig = signature(&baseline);
        let mut last_change = Instant::now();

        loop {
            if let Some(msg) = self.interruption(sid) {
                self.on_interrupted(sid);
                return Err(msg);
            }
            let met: Option<Value> = match cond {
                Condition::WindowAppears { title, process } => {
                    let ws = self.backend.list_windows()?;
                    ws.into_iter()
                        .find(|w| {
                            title.as_deref().is_none_or(|t| contains_ci(&w.title, t))
                                && process.as_deref().is_none_or(|p| contains_ci(&w.process, p))
                        })
                        .map(|w| json!({ "window": w }))
                }
                Condition::WindowGone => {
                    let w = window.as_deref().unwrap_or_default();
                    match self.backend.window(w) {
                        Ok(_) => None,
                        Err(_) => Some(json!({ "window_gone": w })),
                    }
                }
                Condition::FocusChanges => {
                    let fg = self.backend.foreground();
                    let focus = self.backend.focused_element().map(|(r, _)| r);
                    (fg != fg_start || focus != focus_start).then(|| json!({ "foreground": fg }))
                }
                Condition::ElementAppears { name, role } | Condition::ElementGone { name, role } => {
                    let w = window.clone().unwrap_or_default();
                    self.observe(&w, None)?;
                    let state = self.windows.get(&w).expect("observed");
                    let found = find_by_name(&state.view, name, role.as_deref()).ok().cloned();
                    match (cond, found) {
                        (Condition::ElementAppears { .. }, Some(e)) => Some(json!({ "obs": state.obs, "element": e })),
                        (Condition::ElementGone { .. }, None) => Some(json!({ "obs": state.obs })),
                        _ => None,
                    }
                }
                Condition::TextContains { text } => {
                    let w = window.clone().unwrap_or_default();
                    self.observe(&w, None)?;
                    let state = self.windows.get(&w).expect("observed");
                    state
                        .view
                        .iter()
                        .find(|e| element_text(e).contains(text.as_str()))
                        .map(|e| json!({ "obs": state.obs, "element": e }))
                }
                Condition::TextStable { .. } => {
                    let w = window.clone().unwrap_or_default();
                    self.observe(&w, None)?;
                    let state = self.windows.get(&w).expect("observed");
                    let sig = signature(&state.view);
                    if sig != last_sig {
                        last_sig = sig;
                        last_change = Instant::now();
                        None
                    } else if last_change.elapsed() >= quiet {
                        let d = diff(&baseline, &state.view);
                        Some(json!({ "obs": state.obs, "changes": if d.is_empty() { json!("nothing changed") } else { json!(d) } }))
                    } else {
                        None
                    }
                }
            };
            if let Some(mut v) = met {
                v["waited_ms"] = json!(start.elapsed().as_millis() as u64);
                v["met"] = json!(true);
                return Ok(v);
            }
            if start.elapsed() >= timeout {
                let mut v = json!({ "met": false, "waited_ms": start.elapsed().as_millis() as u64,
                    "note": "Timed out — the condition was not met. Look at the window (computer_read) before deciding what to do." });
                if let (Some(w), Condition::TextStable { .. }) = (&window, cond) {
                    if let Some(s) = self.windows.get(w) {
                        let d = diff(&baseline, &s.view);
                        v["obs"] = json!(s.obs);
                        v["changes"] = json!(d);
                    }
                }
                return Ok(v);
            }
            std::thread::sleep(WAIT_POLL);
        }
    }
}

/// 先序列表里以 `rid` 为根的子树（含根）。
fn subtree<'a>(elements: &'a [RawElement], rid: &[i32]) -> Option<&'a [RawElement]> {
    let start = elements.iter().position(|e| !e.runtime_id.is_empty() && e.runtime_id == rid)?;
    let depth = elements[start].depth;
    let end = elements[start + 1..]
        .iter()
        .position(|e| e.depth <= depth)
        .map_or(elements.len(), |i| start + 1 + i);
    Some(&elements[start..end])
}

enum Resolved {
    Element { runtime_id: Vec<i32>, via: Option<ClickVia>, takes_text: bool, label: String },
    Point { x: i32, y: i32, label: String },
}

impl Resolved {
    fn label(&self) -> &str {
        match self {
            Self::Element { label, .. } | Self::Point { label, .. } => label,
        }
    }
}

fn interruption_of(signals: &SharedSignals, sid: &str) -> Option<String> {
    if signals.stop.load(Ordering::SeqCst) {
        return Some("emergency stop".into());
    }
    if signals.takeover.load(Ordering::SeqCst) {
        return Some("the user took over".into());
    }
    if signals.is_cancelled(sid) {
        return Some("turn stopped".into());
    }
    None
}

fn describe(e: &ViewElement) -> String {
    if e.name.is_empty() {
        format!("[{}] {}", e.ref_id, e.role)
    } else {
        format!("[{}] {} \"{}\"", e.ref_id, e.role, e.name)
    }
}

fn click_word(button: MouseButton, clicks: u32) -> &'static str {
    match (button, clicks) {
        (MouseButton::Right, _) => "right-clicked",
        (_, 2) => "double-clicked",
        _ => "clicked",
    }
}

fn inaccessible(w: &WindowInfo) -> String {
    format!(
        "\"{}\" runs with higher privileges (administrator). Windows blocks input from Aide to it — tell the user you cannot operate this window.",
        w.title
    )
}

fn contains_ci(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(&needle.to_lowercase())
}

fn element_text(e: &ViewElement) -> String {
    let mut s = e.name.clone();
    if let Some(v) = &e.value {
        s.push('\n');
        s.push_str(v);
    }
    if let Some(t) = &e.text {
        s.push('\n');
        s.push_str(t);
    }
    s
}

fn signature(view: &[ViewElement]) -> String {
    view.iter().map(element_text).collect::<Vec<_>>().join("\u{1}")
}

/// 按可见名字找元素：精确（忽略大小写与首尾空白）优先，其次包含；多个命中报错并列出候选。
fn find_by_name<'a>(view: &'a [ViewElement], name: &str, role: Option<&str>) -> Res<&'a ViewElement> {
    let want = name.trim().to_lowercase();
    let role_ok = |e: &ViewElement| role.is_none_or(|r| e.role.eq_ignore_ascii_case(r));
    let exact: Vec<&ViewElement> =
        view.iter().filter(|e| role_ok(e) && e.name.trim().to_lowercase() == want).collect();
    let pool = if exact.is_empty() {
        view.iter().filter(|e| role_ok(e) && e.name.to_lowercase().contains(&want)).collect()
    } else {
        exact
    };
    match pool.len() {
        1 => Ok(pool[0]),
        0 => Err(format!(
            "No element named \"{name}\"{} in this window. Call computer_read to see what is there.",
            role.map(|r| format!(" with role {r}")).unwrap_or_default()
        )),
        _ => {
            let list: Vec<String> = pool.iter().take(8).map(|e| describe(e)).collect();
            Err(format!(
                "\"{name}\" matches {} elements: {}. Use the ref of the one you mean.",
                pool.len(),
                list.join(", ")
            ))
        }
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
