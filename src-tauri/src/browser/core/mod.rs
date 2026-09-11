//! 纯核心：无 IO、无时钟、无全局状态，脱离 webview 即可单测（rust 技能 §七）。

pub mod nav_decision;
pub mod url_guard;

#[cfg(test)]
mod core_test;
