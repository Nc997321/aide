//! Host 的数据目录布局：Aide 自管理根 `~/.aide/`、内置 Claude 的 home、state / 设置文件。
//! 「~」= **Host 所在机器**的用户家目录——本机 Host 是桌面用户，远程 Host 是目标机用户。

use std::fs;
use std::path::PathBuf;

pub fn user_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .ok()
}

/// claude.exe 的「家目录」——所有 Claude 自有数据（settings.json / CLAUDE.md /
/// agents/ / skills/ / projects/ / sessions/ / plugins/）的根。
///
/// 指向 Aide 自管理目录下的 `claude/` 子目录，而非用户系统的 `~/.claude/`：
/// runtime/mod.rs 会把 `CLAUDE_CONFIG_DIR` 注入 sidecar 指向同一处，使内置
/// claude.exe 把所有自有数据写到 Aide 自己的目录树里，彻底切断对系统 Claude CLI
/// 的依赖。用子目录而非顶层是为了与 Aide 自己的 `our_sessions_dir()`
/// （`~/.aide/sessions/`，schema 不同）按所有权天然分离，零碰撞。
pub fn claude_home() -> PathBuf {
    our_config_dir().join("claude")
}

pub fn claude_projects_dir() -> PathBuf {
    claude_home().join("projects")
}

pub fn claude_sessions_dir() -> PathBuf {
    claude_home().join("sessions")
}

/// **作用域化的 Claude 配置根**（对应子进程 `CLAUDE_CONFIG_DIR`）。
///
/// 这是「指定目录」能力的基础设施：**任何**需要把产物/配置隔离到自己目录的
/// 调用方（automation 任务、后台支线…）都走这里，不要各自拼路径。
///
/// - 不隔离 → 用 [`claude_home()`]（`~/.aide/claude`）
/// - 隔离 → `~/.aide/scopes/<kind>/<id>/claude`
///
/// 为什么需要它：`~/.aide/claude/projects/` 被 `list_workspaces()` 全量扫描当作
/// 用户工作区，任何往那里写转录的内部流程都会污染侧栏（2026-09-07 bug）。
/// 隔离后子进程的 `projects/` 落在自己的 scope 下，与用户工作区天然分离，
/// 无需在读取侧做任何过滤/硬编码名单。
pub fn scoped_claude_home(kind: &str, id: &str) -> PathBuf {
    our_config_dir()
        .join("scopes")
        .join(kind)
        .join(id)
        .join("claude")
}

/// Aide 自管理配置根目录：`~/.aide/`。
///
/// 历史路径是 `~/.claude-code-desktop/`；启动时 `migration::ensure_aide_data_dir_migrated()`
/// 会把老目录原子 rename 到此处（同文件系统、瞬时、无需用户确认）。所有 Aide 自有数据
/// （state.json / sessions / recent / notifications / diagnostics / log /
/// 以及 claude/ 子目录）都在这棵树下。
pub fn our_config_dir() -> PathBuf {
    user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aide")
}

pub fn our_sessions_dir() -> PathBuf {
    our_config_dir().join("sessions")
}

/// legacy `config.json`——**纯遗留导入源**：老版本的设置+状态都写在这个文件里，
/// 设置体系迁移（`settings::migration`）读它一次、导入 `settings.json` 后即可整体
/// 删除。没有任何活代码应该再读写它；运行时状态的家是 `state_path()`。
pub fn config_path() -> PathBuf {
    our_config_dir().join("config.json")
}

/// `state.json`——应用自记账的运行时状态（当前工作区、隐藏工作区黑名单、
/// Claude 数据迁移标记、文件关联注册基线等「不是用户偏好」的状态）。用户设置
/// 走 `settings.json` 的 descriptor 体系，不进这里。
pub fn state_path() -> PathBuf {
    our_config_dir().join("state.json")
}


/// 会话转录可能存在的所有配置根（claude home）：全局 + 每个作用域的
/// `scopes/<kind>/<id>/claude`（见 [`scoped_claude_home`]）。
///
/// 读侧必须与写侧对称：内部流程（automation 等）的转录被写到作用域隔离
/// 目录，只扫全局的话，点开运行记录就是空白（2026-09-07 实锤）。一切按
/// session id 找转录的路径统一走这里，不要各自决定「去哪找会话」。
///
/// 参数化核心（参照 [`find_session_jsonl_in`] 的可测设计）：`aide_base`
/// = Aide 配置根（生产传 [`our_config_dir`]，测试传 temp dir）。
pub fn session_config_roots_in(aide_base: &std::path::Path) -> Vec<PathBuf> {
    let mut roots = vec![aide_base.join("claude")];
    let scopes = aide_base.join("scopes");
    if let Ok(kinds) = fs::read_dir(&scopes) {
        for kind in kinds.flatten() {
            if let Ok(ids) = fs::read_dir(kind.path()) {
                for id in ids.flatten() {
                    if id.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        roots.push(id.path().join("claude"));
                    }
                }
            }
        }
    }
    roots
}

/// [`session_config_roots_in`] 的生产入口（真实配置根）。
pub fn session_config_roots() -> Vec<PathBuf> {
    session_config_roots_in(&our_config_dir())
}

