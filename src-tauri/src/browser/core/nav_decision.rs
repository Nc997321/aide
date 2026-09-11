//! 导航历史/游标的纯决策。把 off-by-one 与下溢关进可单测的纯核心（rust 技能 §七：纯核心+薄外壳）。
//! 无 IO、无时钟、无全局状态——同输入必同输出，脱离 webview 即可单测。

/// 后退后的新游标；已在最前（`cursor == 0`）则 `None`。`checked_sub` 防下溢。
///
/// 调用方（`BrowserView`）据 `is_some()` 推导 `can_go_back`，据返回值移动游标——
/// 历史/游标的唯一主人是 `BrowserView`，本函数只做纯算术决策。
pub fn back_cursor(cursor: usize) -> Option<usize> {
    cursor.checked_sub(1)
}

/// 前进后的新游标；已在末尾则 `None`。`checked_add` 防溢出，`history_len` 界定上界。
pub fn forward_cursor(cursor: usize, history_len: usize) -> Option<usize> {
    let next = cursor.checked_add(1)?;
    (next < history_len).then_some(next)
}
