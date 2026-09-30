//! aide-host：远程 Host 的目标机端（WSL 发行版 / SSH 服务器，无需图形界面）——`serve` 模式
//! 就是一个完整的 Aide 后端（aide-core），经 stdio 连到一扇 GUI 窗口。
//!
//! 库部分只导出 [`protocol`]（帧类型）——桌面依赖它，保证两端编译期同形；其余模块只属于
//! 二进制。

pub mod protocol;
