//! 什么算「用户接管了」（纯函数；钩子在 adapter/windows/guard.rs）。
//!
//! 只有**在别的窗口里点击、滚动或按键**才算：
//! - 在 Aide 自己的窗口里操作是在指挥 Aide（点审批、打字、点停止），不是抢桌面——
//!   否则手动权限模式下点「允许」本身就会触发接管，手动模式没法用；
//! - 只移动鼠标不算：挪到 Aide 的审批按钮途中必然划过别的窗口。
//! 代价：agent 操作的正是 Aide 自己的界面时，在 Aide 里点击不会让它停手，那时用急停热键。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserInput {
    MouseMove,
    MouseButtonDown,
    MouseButtonUp,
    Wheel,
    KeyDown,
    KeyUp,
}

/// `injected` = 系统标记的程序注入（我们自己的 SendInput）；`on_aide` = 落在 Aide 自己的窗口上。
pub fn is_takeover(input: UserInput, injected: bool, on_aide: bool) -> bool {
    !injected
        && !on_aide
        && matches!(input, UserInput::MouseButtonDown | UserInput::Wheel | UserInput::KeyDown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_and_keys_elsewhere_take_over() {
        assert!(is_takeover(UserInput::MouseButtonDown, false, false));
        assert!(is_takeover(UserInput::KeyDown, false, false));
        assert!(is_takeover(UserInput::Wheel, false, false));
    }

    #[test]
    fn approving_in_aide_or_moving_the_mouse_does_not() {
        assert!(!is_takeover(UserInput::MouseButtonDown, false, true));
        assert!(!is_takeover(UserInput::KeyDown, false, true));
        assert!(!is_takeover(UserInput::MouseMove, false, false));
        assert!(!is_takeover(UserInput::KeyUp, false, false));
        assert!(!is_takeover(UserInput::MouseButtonUp, false, false));
    }

    #[test]
    fn our_own_injected_input_never_counts() {
        assert!(!is_takeover(UserInput::MouseButtonDown, true, false));
        assert!(!is_takeover(UserInput::KeyDown, true, false));
    }
}
