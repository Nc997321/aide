//! 活动工作区状态与命令的根解析。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 工作区目录是否还在。**凡「工作区还在吗」一律走这里**（判定为不在 = 回落活动工作区 /
/// 家目录，误判就是 2026-09-18 的「跑错项目」）。Host 模型下工作区与 Host 在同一台机器上，
/// 本机 stat 即权威。
pub fn present(p: &Path) -> bool {
    p.exists()
}

pub struct WorkspaceState {
    pub key: Mutex<Option<String>>,
    pub path: Mutex<Option<PathBuf>>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceState {
    pub fn new() -> Self {
        Self {
            key: Mutex::new(None),
            path: Mutex::new(None),
        }
    }

    /// 活动工作区根（目录须存在）。无 = 没打开项目——展示/索引类消费者必须能区分这一点，
    /// 绝不回退家目录（2026-08-01：FileTree 渲染整个家目录）。
    pub fn active_root(&self) -> Option<PathBuf> {
        self.path
            .lock()
            .ok()
            .and_then(|p| p.as_ref().filter(|p| present(p)).cloned())
    }

    /// 进程 cwd 类消费者（git 等）的根：显式 `cwd`（会话所属工作区）→ 活动工作区 → 家目录。
    /// 家目录是这类命令合理的兜底 cwd；展示类命令用 [`Self::active_root`]。
    pub fn root_for(&self, cwd: Option<&str>) -> PathBuf {
        match cwd {
            Some(c) if !c.trim().is_empty() => PathBuf::from(c),
            _ => self
                .active_root()
                .or_else(crate::paths::user_home)
                .unwrap_or_else(|| PathBuf::from(".")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_cwd_wins_over_active_workspace() {
        let ws = WorkspaceState::new();
        *ws.path.lock().unwrap() = Some(std::env::temp_dir());
        assert_eq!(ws.root_for(Some("/some/where")), PathBuf::from("/some/where"));
        assert_eq!(ws.root_for(Some("  ")), std::env::temp_dir());
        assert_eq!(ws.root_for(None), std::env::temp_dir());
    }

    #[test]
    fn missing_active_workspace_is_not_a_root() {
        let ws = WorkspaceState::new();
        *ws.path.lock().unwrap() = Some(PathBuf::from("/definitely/not/here/aide"));
        assert_eq!(ws.active_root(), None);
    }
}
