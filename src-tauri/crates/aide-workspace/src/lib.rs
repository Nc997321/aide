//! 工作区操作（文件系统 / 搜索 / git）的**唯一实现**。
//!
//! 两个宿主共用：桌面（src-tauri 的 `#[tauri::command]` 薄包装）与 aide-host
//! （远程工作区：跑在 WSL / SSH 目标机上，经 stdio JSON-RPC 被桌面调用）。
//! 因此本 crate **禁止依赖 Tauri**，也不认识「活动工作区」——需要工作区根的
//! 函数一律显式收 `root`，由宿主解析后传入。
//!
//! 序列化形状即 IPC 契约：桌面把 aide-host 的 JSON 结果原样转给前端，所以这里的
//! serde 属性就是前端看到的字段名，改动等同于改前端协议。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub mod detect;
pub mod fs_ops;
pub mod git;
pub mod search;
pub mod transcripts;
pub mod watch;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffEntry {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line: u32,
    pub content: String,
    pub match_type: String,
}

/// 读 `.git/HEAD` 取当前分支名；分离 HEAD / 非仓库 → 空串。
pub fn detect_git_branch(root: &Path) -> String {
    let head = root.join(".git").join("HEAD");
    if let Ok(content) = fs::read_to_string(&head) {
        if let Some(line) = content.lines().next() {
            if let Some(branch) = line.strip_prefix("ref: refs/heads/") {
                return branch.to_string();
            }
        }
    }
    String::new()
}
