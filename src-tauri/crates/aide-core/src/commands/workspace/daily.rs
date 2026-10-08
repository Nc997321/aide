//! 「日常」模式的底层工作区：一个真实目录，存在且已注册，但对所有工作区列表隐身。
//!
//! 为什么必须真目录：会话子进程必须有 cwd，且 key = path_to_key(path) 是信任 /
//! 记忆目录 / run configs / 会话归属的共同锚。
//! 为什么必须隐身：它是实现细节，不是用户要管理的项目。
//! 设计取舍见 docs/superpowers/specs/2026-09-20-daily-mode-design.md。
//!
//! 纯路径逻辑（daily_path_in / is_daily_path）与 IO 外壳（ensure_daily_workspace）
//! 分开：前两个脱离 AppHandle 与文件系统也能测。

use std::path::{Path, PathBuf};

/// 日常目录 = `<配置目录>/workspace`。纯函数（配置目录由调用方给），便于测试。
pub fn daily_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join("workspace")
}

/// 是不是日常目录：按注册表同源的规范化口径比较（trim + 去尾部斜杠）。
///
/// 不做分隔符归一（`\` 与 `/` 互转）—— 日常目录这一条路径全程只由本模块生成：
/// 注册时写进去的是 `daily_path_in(..).to_string_lossy()`，这里比较的也是同一份，
/// 两侧同源。手写进 state.json 的异体路径属于用户改配置，不在判定范围内。
pub fn is_daily_path(daily_dir: &Path, path: &str) -> bool {
    super::normalize_registration_path(&daily_dir.to_string_lossy())
        == super::normalize_registration_path(path)
}

/// 启动引导：确保日常目录存在 + 已注册。**不激活**（活动工作区仍由用户 / 恢复链决定）。
///
/// 目录必须存在，不只是为了能当 cwd：`resolve_path_from_key` 的反解逐段校验存在性
/// （workspace/mod.rs 的 try_decode），目录不在则侧栏「日常」分区会整段列不出会话。
pub fn ensure_daily_workspace() -> Result<(), String> {
    let dir = daily_path_in(&crate::paths::our_config_dir());
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    super::ensure_workspace_registered(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── daily_path_in：日常目录 = <配置目录>/workspace ──

    /// 用 parent/file_name 断言而不是比对整串：Windows 的 Path::join 插入的是
    /// `\`，写死分隔符的断言跨平台会假红。
    #[test]
    fn daily_path_is_workspace_under_config_dir() {
        let p = daily_path_in(Path::new("C:/cfg"));
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "workspace");
        assert_eq!(p.parent().unwrap().to_string_lossy(), "C:/cfg");
    }

    // ── is_daily_path：判定用注册表同源的规范化口径（trim + 去尾部斜杠）──

    #[test]
    fn is_daily_path_matches_trailing_separator() {
        let daily = PathBuf::from(r"C:\cfg\workspace");
        assert!(is_daily_path(&daily, r"C:\cfg\workspace"));
        assert!(is_daily_path(&daily, r"C:\cfg\workspace\"));
    }

    #[test]
    fn is_daily_path_rejects_other_dirs() {
        let daily = PathBuf::from(r"C:\cfg\workspace");
        assert!(!is_daily_path(&daily, r"C:\cfg\other"));
        // 子目录不是日常目录本身（保留给将来可能的子路径场景）
        assert!(!is_daily_path(&daily, r"C:\cfg\workspace\sub"));
        assert!(!is_daily_path(&daily, ""));
    }

    /// 一次性自检（`#[ignore]`：它会真的建目录、写用户的 state.json）。跑：
    /// `cargo test --lib -- --ignored smoke`。验的是「启动引导真的干了它该干的」。
    #[test]
    #[ignore]
    fn smoke_bootstrap_creates_registers_and_does_not_activate() {
        let active_before = crate::app_settings::load_state()
            .get("workspace")
            .cloned();

        ensure_daily_workspace().expect("bootstrap 应成功");

        let dir = daily_path_in(&crate::paths::our_config_dir());
        assert!(dir.exists(), "日常目录应被创建: {}", dir.display());

        let key = crate::commands::workspace::path_to_key(&dir.to_string_lossy());
        let after = crate::app_settings::load_state();
        assert!(
            crate::commands::workspace::registered_path_for_key(&after, &key).is_some(),
            "日常目录应已注册（key={key}）"
        );
        assert_eq!(
            after.get("workspace").cloned(),
            active_before,
            "活动工作区**不该**被动过（刻意不激活）"
        );

        let n1 = registered_len(&after);
        ensure_daily_workspace().expect("第二次应幂等成功");
        let n2 = registered_len(&crate::app_settings::load_state());
        assert_eq!(n1, n2, "幂等：重复引导不新增条目");
    }

    fn registered_len(config: &serde_json::Value) -> usize {
        config
            .get("registeredWorkspaces")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    }
}
