//! 活动工作区状态与命令的根解析。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 「这个工作区目录还在吗」的判定。默认 `exists()`；前门在启动时可注入更懂路径形态的判定
/// ——桌面在远程工作区过渡期注入 `remote_workspace::path::present`（远程路径同步 stat 不了，
/// 按存在处理）。判定为不在 = 回落，对远程路径误判就是 2026-09-18 的「跑错项目」。
/// 进程级：一个进程只有一个 Host。
static PRESENCE: OnceLock<fn(&Path) -> bool> = OnceLock::new();

/// 启动时调一次（第二次调用被忽略）。
pub fn set_presence_check(check: fn(&Path) -> bool) {
    let _ = PRESENCE.set(check);
}

/// 工作区目录是否（按当前 Host 的口径）存在。**凡「工作区还在吗」一律走这里**。
pub fn present(p: &Path) -> bool {
    PRESENCE.get().map_or_else(|| p.exists(), |check| check(p))
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
    /// 绝不回退家目录（2026-08-01：FileTree 渲染整个家目录、CodeGraph 索引 405 万符号）。
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
