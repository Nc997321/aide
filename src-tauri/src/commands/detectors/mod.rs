//! 项目 marker 探测器链已迁入 `aide_workspace::detect::markers`（与语言探测同理：远程工作区
//! 要在目标机上跑）。此处只留 re-export 壳，保持 `crate::commands::detectors` 路径。

pub use aide_workspace::detect::markers::*;
