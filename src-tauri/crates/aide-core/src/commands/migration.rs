//! 两类一次性迁移：
//!
//! 1. **Aide 数据目录改名**（`ensure_aide_data_dir_migrated`，启动时自动）：把老根
//!    `~/.claude-code-desktop/` 原子 rename 到 `~/.aide/`。Aide 自有数据，无需用户确认。
//! 2. **Claude CLI 数据迁移**（`migrate_claude_data`，用户弹窗触发）：把用户系统
//!    `~/.claude/` 下的 Claude 数据拷到 `~/.aide/claude/`（即 `claude_home()`），让现有
//!    用户升级后无缝保留 MCP / skills / agents / 全局指令 / 历史会话，且 Aide 不再依赖
//!    系统 Claude CLI。
//!
//! 设计要点：
//! - **拷贝不是移动**：原 `~/.claude/` 保留不动，让同时使用 Claude CLI 的用户不受
//!   影响（Aide 用副本，CLI 继续用原件，二者此后各自演化）。
//! - **只补缺失项、不覆盖已有**（`copy_entry_missing_only`）：一举解决两个问题——
//!   ①幂等：重复迁移不会破坏已迁数据；②边界：用户迁移前先开了会话，claude.exe 已
//!   在 `claude/` 下写了新 settings.json / 新 transcript，迁移时跳过已存在项，新会话
//!   数据不被旧数据冲掉，旧数据只补到还没产生的位置。
//! - **迁移状态记在 state.json 顶层**（`claudeMigrationDone` / `claudeMigrationDismissed`），
//!   不在 `AppSettings` 内——这是迁移状态，不是用户偏好。
//! - **重 IO 走 `spawn_blocking`**：拷 `projects/` 可能数百 MB，不能阻塞 Tauri 主线程。
//!   检测由前端 `App.vue onMounted` 调 `check_claude_migration` 触发，不在 `lib.rs`
//!   setup 自动跑（避免卡首帧）。

#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("check_claude_migration", check_claude_migration),
    command!("migrate_claude_data", migrate_claude_data),
    command!("dismiss_claude_migration", dismiss_claude_migration),
];

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::app_settings::{load_state, with_state_mut};
use crate::paths::{claude_home, our_config_dir, user_home};

/// 迁移源：用户系统老 `~/.claude/`（Claude CLI 数据）
fn legacy_claude_dir() -> PathBuf {
    user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// 迁移目标：`<claude_home>` == `~/.aide/claude/`
fn target_dir() -> PathBuf {
    claude_home()
}

/// Aide 老数据目录：`~/.claude-code-desktop/`（改名前的自管理根）。
fn legacy_aide_data_dir() -> PathBuf {
    user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude-code-desktop")
}

/// 启动时自动把老数据目录 `~/.claude-code-desktop/` 原子 rename 到 `~/.aide/`。
///
/// 这是 Aide **自有数据目录**的升级（区别于 `~/.claude/` 的 Claude CLI 数据迁移——
/// 那个走用户弹窗，因为涉及外部 CLI 的数据）。本函数无需用户确认：同文件系统 rename
/// 瞬时完成，把 config.json（legacy）/ state.json / sessions / recent / notifications /
/// diagnostics / log / claude/ 等整棵树搬到新根。
///
/// **必须在任何读 state.json 之前调用**（lib.rs setup 第一步），否则 `our_config_dir()`
/// 已指向 `~/.aide/` 而 state 还在老目录，provider 设置会读空。
///
/// 幂等：`~/.aide/` 已存在（已迁移或新用户首次写入后）→ 直接 Ok；老目录不存在（新用户）
/// → Ok。rename 失败（杀软锁等）→ 返回 Err，下次启动重试，不标记任何状态。
pub fn ensure_aide_data_dir_migrated() -> Result<(), String> {
    migrate_aide_data_dir(&legacy_aide_data_dir(), &our_config_dir())
}

/// 参数化版本，便于单测（参照 `find_session_jsonl_in` 的可测设计）。
fn migrate_aide_data_dir(old_dir: &Path, new_dir: &Path) -> Result<(), String> {
    if new_dir.exists() {
        return Ok(()); // 已迁移或新用户已建
    }
    if !old_dir.exists() {
        return Ok(()); // 新用户，无老数据可迁
    }
    // 同文件系统（都在 $HOME 下）原子 rename。new_dir 已确认不存在，dir rename 安全。
    std::fs::rename(old_dir, new_dir).map_err(|e| {
        format!(
            "rename {} -> {} failed: {e}（下次启动会重试）",
            old_dir.display(),
            new_dir.display()
        )
    })
}

const DONE_KEY: &str = "claudeMigrationDone";
const DISMISSED_KEY: &str = "claudeMigrationDismissed";

/// 可迁移条目（相对 legacy/target 根的子路径）。单文件或目录皆可。
const MIGRATABLE_ENTRIES: &[&str] = &[
    "settings.json",
    "CLAUDE.md",
    "agents",
    "skills",
    "projects",
    "sessions",
    "plugins/cache",
    ".credentials.json",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    /// `~/.claude/` 是否存在
    pub legacy_exists: bool,
    /// 是否有任一可迁移条目存在（决定要不要弹窗）
    pub has_migratable: bool,
    /// state.json `claudeMigrationDone`——已迁移过，不再弹
    pub done: bool,
    /// state.json `claudeMigrationDismissed`——用户选过「不再提示」
    pub dismissed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSummary {
    pub copied_count: u32,
    pub skipped_count: u32,
}

/// 纯读：探测 `~/.claude/` 是否存在 + 读 state.json 两个标记。轻量，同步即可。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckClaudeMigrationArgs {
}

async fn check_claude_migration(_core: Arc<Core>, a: CheckClaudeMigrationArgs) -> Result<MigrationStatus, String> {
    let _ = a;
    blocking(move || -> Result<MigrationStatus, String> {
    let legacy = legacy_claude_dir();
    let legacy_exists = legacy.is_dir();
    let has_migratable =
        legacy_exists && MIGRATABLE_ENTRIES.iter().any(|e| legacy.join(e).exists());
    let state = load_state();
    let done = state
        .get(DONE_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dismissed = state
        .get(DISMISSED_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(MigrationStatus {
        legacy_exists,
        has_migratable,
        done,
        dismissed,
    })
}).await
}

/// 执行迁移。重 IO（拷 projects/ 可能数百 MB）→ `spawn_blocking` 不阻塞主线程。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateClaudeDataArgs {
}

async fn migrate_claude_data(_core: Arc<Core>, a: MigrateClaudeDataArgs) -> Result<MigrationSummary, String> {
    let _ = a;
    tokio::task::spawn_blocking(migrate_blocking)
        .await
        .map_err(|e| format!("migration task panicked: {e}"))?
}

/// 用户选「不再提示」——只压住自动弹窗，不影响 SettingsPanel 后备按钮主动触发。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissClaudeMigrationArgs {
}

async fn dismiss_claude_migration(_core: Arc<Core>, a: DismissClaudeMigrationArgs) -> Result<(), String> {
    let _ = a;
    blocking(move || -> Result<(), String> {
    with_state_mut(|state| {
        state[DISMISSED_KEY] = serde_json::Value::Bool(true);
        Ok(())
    })
}).await
}

fn migrate_blocking() -> Result<MigrationSummary, String> {
    let src = legacy_claude_dir();
    let dst = target_dir();
    if !src.is_dir() {
        // 无可迁移源（前端只在 has_migratable=true 时才会调到，这里是竞态兜底）：
        // 仍标记 done，避免反复触发。
        mark_done()?;
        return Ok(MigrationSummary {
            copied_count: 0,
            skipped_count: 0,
        });
    }
    std::fs::create_dir_all(&dst).map_err(|e| format!("create target dir: {e}"))?;

    let mut copied = 0u32;
    let mut skipped = 0u32;
    for entry in MIGRATABLE_ENTRIES {
        let s = src.join(entry);
        if !s.exists() {
            continue;
        }
        let d = dst.join(entry);
        match copy_entry_missing_only(&s, &d) {
            Ok(true) => copied += 1,
            Ok(false) => skipped += 1,
            Err(e) => {
                tracing::warn!("migration: copy {} failed: {} (skipped)", entry, e);
                skipped += 1;
            }
        }
    }
    mark_done()?;
    Ok(MigrationSummary {
        copied_count: copied,
        skipped_count: skipped,
    })
}

fn mark_done() -> Result<(), String> {
    with_state_mut(|state| {
        state[DONE_KEY] = serde_json::Value::Bool(true);
        Ok(())
    })
}

/// 拷贝 `src` → `dst`，**只补 dst 中尚不存在的条目**。
/// - 文件：dst 已存在 → 跳过（返回 false）；否则拷贝（返回 true）。
/// - 目录：递归，对每个子条目同样「dst 不存在才拷」；返回「是否有任何新文件被拷」。
///
/// 返回 `true` = 有新文件被拷贝，`false` = 无（全部已存在）。
fn copy_entry_missing_only(src: &Path, dst: &Path) -> Result<bool, String> {
    if src.is_dir() {
        copy_dir_missing_only(src, dst)
    } else {
        if dst.exists() {
            return Ok(false);
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
        }
        std::fs::copy(src, dst).map_err(|e| format!("copy file: {e}"))?;
        Ok(true)
    }
}

/// 递归拷目录，只补 dst 中尚不存在的文件/子目录。返回是否有任何新文件被拷。
fn copy_dir_missing_only(src: &Path, dst: &Path) -> Result<bool, String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("create dir: {e}"))?;
    let mut any_copied = false;
    let entries = std::fs::read_dir(src).map_err(|e| format!("read dir: {e}"))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if to.exists() {
            continue;
        }
        let ft = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
        if ft.is_dir() {
            if copy_dir_missing_only(&from, &to)? {
                any_copied = true;
            }
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("copy file: {e}"))?;
            any_copied = true;
        }
    }
    Ok(any_copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aide_migration_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn credentials_json_is_migratable() {
        // 老系统 ~/.claude/.credentials.json 的 OAuth 登录随迁移提示一并迁入 ~/.aide/claude/
        assert!(MIGRATABLE_ENTRIES.iter().any(|e| *e == ".credentials.json"));
    }

    #[test]
    fn copy_file_missing_copies_when_absent() {
        let tmp = unique_tmp("file_copy_absent");
        let src = tmp.join("src").join("settings.json");
        let dst = tmp.join("dst").join("settings.json");
        write(&src, r#"{"mcpServers":{}}"#);
        assert_eq!(copy_entry_missing_only(&src, &dst).unwrap(), true);
        assert_eq!(fs::read_to_string(&dst).unwrap(), r#"{"mcpServers":{}}"#);
    }

    #[test]
    fn copy_file_missing_skips_when_present() {
        let tmp = unique_tmp("file_skip_present");
        let src = tmp.join("src").join("settings.json");
        let dst = tmp.join("dst").join("settings.json");
        write(&src, r#"{"legacy":true}"#);
        write(&dst, r#"{"new":true}"#);
        assert_eq!(copy_entry_missing_only(&src, &dst).unwrap(), false);
        // dst 内容未被覆盖
        assert_eq!(fs::read_to_string(&dst).unwrap(), r#"{"new":true}"#);
    }

    #[test]
    fn copy_dir_missing_only_copies_absent_files_preserves_existing() {
        let tmp = unique_tmp("dir_partial");
        // 源：agents/a.md, agents/b.md
        write(&tmp.join("src/agents/a.md"), "A");
        write(&tmp.join("src/agents/b.md"), "B");
        // 目标已存在 agents/a.md（claude.exe 先写的），不应被覆盖
        write(&tmp.join("dst/agents/a.md"), "A-NEW");
        let copied =
            copy_dir_missing_only(&tmp.join("src/agents"), &tmp.join("dst/agents")).unwrap();
        assert!(copied, "b.md 是新文件，应报告有拷贝");
        assert_eq!(
            fs::read_to_string(&tmp.join("dst/agents/a.md")).unwrap(),
            "A-NEW"
        );
        assert_eq!(
            fs::read_to_string(&tmp.join("dst/agents/b.md")).unwrap(),
            "B"
        );
    }

    #[test]
    fn copy_dir_missing_only_all_present_reports_no_copy() {
        let tmp = unique_tmp("dir_all_present");
        write(&tmp.join("src/skills/foo/SKILL.md"), "foo");
        write(&tmp.join("dst/skills/foo/SKILL.md"), "foo-existing");
        let copied =
            copy_dir_missing_only(&tmp.join("src/skills"), &tmp.join("dst/skills")).unwrap();
        assert!(!copied);
        assert_eq!(
            fs::read_to_string(&tmp.join("dst/skills/foo/SKILL.md")).unwrap(),
            "foo-existing"
        );
    }

    /// 用临时目录模拟 migrate_blocking 的拷贝阶段（绕开真实 home/config）。
    #[test]
    fn migrate_phase_is_idempotent() {
        let tmp = unique_tmp("idempotent");
        let src = tmp.join("legacy/.claude");
        let dst = tmp.join("target/claude");
        // 预置一个文件 + 一个目录
        write(&src.join("settings.json"), r#"{"mcpServers":{"x":1}}"#);
        write(&src.join("agents/a.md"), "A");
        fs::create_dir_all(&dst).unwrap();

        // 第一轮：settings.json + agents 都应被拷
        let mut copied = 0u32;
        let mut skipped = 0u32;
        for e in ["settings.json", "agents", "missing-entry"] {
            let s = src.join(e);
            if !s.exists() {
                continue;
            }
            match copy_entry_missing_only(&s, &dst.join(e)) {
                Ok(true) => copied += 1,
                Ok(false) => skipped += 1,
                Err(_) => skipped += 1,
            }
        }
        assert_eq!(copied, 2);
        assert_eq!(skipped, 0);

        // 第二轮：全部已存在 → 全 skipped
        let mut copied2 = 0u32;
        let mut skipped2 = 0u32;
        for e in ["settings.json", "agents"] {
            let s = src.join(e);
            if !s.exists() {
                continue;
            }
            match copy_entry_missing_only(&s, &dst.join(e)) {
                Ok(true) => copied2 += 1,
                Ok(false) => skipped2 += 1,
                Err(_) => skipped2 += 1,
            }
        }
        assert_eq!(copied2, 0);
        assert_eq!(skipped2, 2);
        // 内容仍是第一轮的
        assert_eq!(fs::read_to_string(&dst.join("agents/a.md")).unwrap(), "A");
    }

    #[test]
    fn migrate_phase_partial_when_target_has_some() {
        let tmp = unique_tmp("partial");
        let src = tmp.join("legacy/.claude");
        let dst = tmp.join("target/claude");
        write(&src.join("settings.json"), r#"{"legacy":1}"#);
        write(&src.join("CLAUDE.md"), "rules");
        fs::create_dir_all(&dst).unwrap();
        // 目标已有 settings.json（claude.exe 先写的）→ 应跳过
        write(&dst.join("settings.json"), r#"{"new":1}"#);

        let mut copied = 0u32;
        let mut skipped = 0u32;
        for e in ["settings.json", "CLAUDE.md"] {
            let s = src.join(e);
            if !s.exists() {
                continue;
            }
            match copy_entry_missing_only(&s, &dst.join(e)) {
                Ok(true) => copied += 1,
                Ok(false) => skipped += 1,
                Err(_) => skipped += 1,
            }
        }
        assert_eq!(copied, 1, "CLAUDE.md 被拷");
        assert_eq!(skipped, 1, "settings.json 跳过");
        assert_eq!(
            fs::read_to_string(&dst.join("settings.json")).unwrap(),
            r#"{"new":1}"#
        );
        assert_eq!(fs::read_to_string(&dst.join("CLAUDE.md")).unwrap(), "rules");
    }

    #[test]
    fn aide_data_dir_rename_moves_tree_when_target_absent() {
        let tmp = unique_tmp("aide_rename");
        let old = tmp.join("old/.claude-code-desktop");
        let new = tmp.join("old/.aide");
        write(
            &old.join("config.json"),
            r#"{"settings":{"theme":"warm-dark"}}"#,
        );
        write(&old.join("sessions/abc.json"), "{}");
        write(&old.join("claude/settings.json"), r#"{"mcpServers":{}}"#);
        migrate_aide_data_dir(&old, &new).unwrap();
        assert!(new.is_dir(), "新目录应存在");
        assert!(!old.exists(), "老目录应被 rename 走");
        assert_eq!(
            fs::read_to_string(&new.join("config.json")).unwrap(),
            r#"{"settings":{"theme":"warm-dark"}}"#
        );
        assert!(new.join("sessions/abc.json").exists());
        assert!(
            new.join("claude/settings.json").exists(),
            "claude/ 子树一并搬走"
        );
    }

    #[test]
    fn aide_data_dir_rename_skips_when_target_present() {
        let tmp = unique_tmp("aide_skip");
        let old = tmp.join("old/.claude-code-desktop");
        let new = tmp.join("old/.aide");
        write(&old.join("config.json"), r#"{"old":1}"#);
        write(&new.join("config.json"), r#"{"new":1}"#);
        // 目标已存在 → Ok 且不动（已迁移 / 新用户）
        migrate_aide_data_dir(&old, &new).unwrap();
        assert!(old.exists(), "老目录保留（不强行覆盖目标）");
        assert_eq!(
            fs::read_to_string(&new.join("config.json")).unwrap(),
            r#"{"new":1}"#
        );
    }

    #[test]
    fn aide_data_dir_rename_ok_when_neither_present() {
        let tmp = unique_tmp("aide_neither");
        let old = tmp.join("nope/.claude-code-desktop");
        let new = tmp.join("nope/.aide");
        // 都不存在（新用户）→ Ok，不创建任何目录
        migrate_aide_data_dir(&old, &new).unwrap();
        assert!(!old.exists());
        assert!(!new.exists());
    }
}
