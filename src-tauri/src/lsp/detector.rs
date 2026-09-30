//! 语言探测已迁入 `aide_workspace::detect::languages`（桌面与目标机上的 aide-host 共用一份，
//! 远程工作区 LSP 需要在目标机上探测）。此处只留 re-export 壳，保持 `crate::lsp::detector` 路径。

pub use aide_workspace::detect::languages::*;
