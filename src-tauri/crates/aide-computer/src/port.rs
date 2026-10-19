//! 端口：策略层只认这两个 trait，平台技术全部在 `adapter/` 里实现。
//!
//! 所有方法的 `Err(String)` 都面向 agent：要能直接说明发生了什么、下一步怎么办。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::keys::Combo;
use crate::model::{ClickVia, Direction, MouseButton, RawTree, Shot, WindowAction, WindowInfo};

pub type Res<T> = Result<T, String>;

/// 读、写桌面的能力。只在执行器自己的线程上调用（UIA 的 COM 对象不跨线程）。
pub trait Backend {
    fn list_windows(&mut self) -> Res<Vec<WindowInfo>>;
    fn window(&mut self, id: &str) -> Res<WindowInfo>;
    fn foreground(&mut self) -> Option<String>;
    /// 前台窗口里的焦点元素：(RuntimeId, 名字)。
    fn focused_element(&mut self) -> Option<(Vec<i32>, String)>;

    fn window_action(&mut self, id: &str, action: WindowAction) -> Res<()>;
    /// 按名字匹配开始菜单里的应用并启动。成功返回匹配到的应用名。
    fn launch(&mut self, app: &str) -> Res<String>;

    /// 读窗口的控件树。`text_tail` = 文字控件取末尾多少行（`None` = 取可见部分）。
    fn snapshot(&mut self, id: &str, text_tail: Option<u32>) -> Res<RawTree>;
    fn screenshot(&mut self, id: &str, max_side: u32) -> Res<Shot>;

    /// 元素是否还在、控件类型是否仍是 `role`（身份按 RuntimeId，取自该窗口最近一次读取）。
    fn element_alive(&mut self, window: &str, runtime_id: &[i32], role: &str) -> Res<bool>;
    /// 不动鼠标地「单击」：用 `via` 指定的模式，然后把键盘焦点交给它（真人点一下也会拿到焦点）。
    fn pattern_click(&mut self, window: &str, runtime_id: &[i32], via: ClickVia) -> Res<()>;
    /// 元素当前中心点（屏幕物理像素）。
    fn element_center(&mut self, window: &str, runtime_id: &[i32]) -> Res<(i32, i32)>;
    fn focus_element(&mut self, window: &str, runtime_id: &[i32]) -> Res<()>;
    fn set_value(&mut self, window: &str, runtime_id: &[i32], value: &str) -> Res<()>;

    /// 把窗口带到前台（最小化的先还原）。
    fn bring_to_front(&mut self, id: &str) -> Res<()>;
    /// 屏幕上这一点是否落在 `id` 窗口（或它的弹出层）上，被别的窗口挡住则报错。
    fn check_point(&mut self, id: &str, x: i32, y: i32) -> Res<()>;
    fn mouse_click(&mut self, x: i32, y: i32, button: MouseButton, clicks: u32) -> Res<()>;
    fn scroll(&mut self, x: i32, y: i32, direction: Direction, notches: u32) -> Res<()>;
    /// 向前台窗口打字；每批之前确认前台仍是 `id`（或它的弹出层），并检查 `interrupted`。
    /// 返回实际打出的字符数。
    fn type_text(&mut self, id: &str, text: &str, interrupted: &dyn Fn() -> Option<String>) -> Res<usize>;
    fn press(&mut self, id: &str, combo: &Combo) -> Res<()>;
}

/// 「agent 在碰电脑」的守护：接管检测、急停热键、屏幕提示。跑在它自己的线程上。
pub trait Guard: Send + Sync {
    /// 装 / 卸底层输入钩子（只在持锁期间装）。
    fn watch_input(&self, on: bool);
    /// 显示提示；`linger` = 显示多久后自动消失（`None` = 常驻直到下次调用）。`text = None` = 收起。
    fn show(&self, text: Option<String>, linger: Option<Duration>);
}

/// 守护线程与执行器线程之间共享的信号。
#[derive(Default)]
pub struct Signals {
    /// 持锁期间检测到用户真实输入。
    pub takeover: AtomicBool,
    /// 急停热键被按下。
    pub stop: AtomicBool,
    /// 持锁的会话（急停时要中断它）。
    pub owner: Mutex<Option<String>>,
    /// 已经结束这一轮的会话（停止 / 新的用户消息）：进行中的等待与动作看到就收手。
    pub cancelled: Mutex<Vec<String>>,
}

impl Signals {
    pub fn owner(&self) -> Option<String> {
        self.owner.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn set_owner(&self, sid: Option<String>) {
        *self.owner.lock().unwrap_or_else(|e| e.into_inner()) = sid;
    }
    pub fn is_cancelled(&self, sid: &str) -> bool {
        self.cancelled.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|s| s == sid)
    }
    pub fn cancel(&self, sid: &str) {
        let mut v = self.cancelled.lock().unwrap_or_else(|e| e.into_inner());
        if !v.iter().any(|s| s == sid) {
            v.push(sid.to_string());
        }
    }
    pub fn uncancel(&self, sid: &str) {
        self.cancelled.lock().unwrap_or_else(|e| e.into_inner()).retain(|s| s != sid);
    }
    pub fn take_stop(&self) -> bool {
        self.stop.swap(false, Ordering::SeqCst)
    }
}

/// 宿主（桌面壳）提供的回调。
pub trait HostHooks: Send + Sync {
    /// 急停：中断这个会话的当前轮（走现有 interrupt 命令，所有客户端都看得到）。
    fn emergency_stop(&self, session_id: &str);
    /// 提示条上显示的会话名。
    fn session_label(&self, session_id: &str) -> Option<String>;
}

pub type SharedSignals = Arc<Signals>;
