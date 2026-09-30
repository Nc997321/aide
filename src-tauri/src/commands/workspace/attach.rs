//! @目录 授权（单会话跨目录工作）的**裁定**：哪些目录真的能进本会话的附加根账本。
//!
//! 为什么裁定在 Rust：PWA/鸿蒙与桌面共用同一个 sidecar 会话，授权请求可能来自任何
//! 客户端，前端校验只能算 UX；Rust 是唯一能读 `registeredWorkspaces` 的层。
//! （设计见 docs/superpowers/plans/2026-09-17-cross-directory-session.md 的 F9/D4。）
//!
//! 判据（D4）：只认**已注册工作区**本身或其子目录。fail-closed——任何一条不过就丢弃
//! 并计入 `rejected`（不静默：前端要能显示"未注册，已忽略"），合法条目照常下发；
//! 全部非法也不阻塞发送。
//!
//! 包含性复用 `policy::matchers::path_within_folder`：它**双边** canonicalize（注册表
//! 里存的是用户登记的原样路径，只 trim 了尾分隔符）、解析符号链接、出错即 false。
//! 自己手搓 `strip_prefix(canonicalize(输入), 注册表原样)` 是单边 canonicalize，
//! 大小写 / 8.3 短名 / UNC 形态不一致就会变成静默误拒。

use std::path::Path;

use crate::policy::matchers::path_within_folder;

use super::registry::{self, RegisteredWorkspace};

/// 裁定结果：过闸的目录 + 被拒的目录。两者都要回给前端（拒绝不能静默）。
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct AttachResolution {
    /// 已 canonicalize 的原生绝对路径（`\\?\` 已剥），去重后按出现顺序。
    pub accepted: Vec<String>,
    /// 被丢弃的条目（原样回显，便于前端显示是哪一条没通过）。
    pub rejected: Vec<String>,
}

/// 裁定入口：读注册表（轻量 IO，同 `is_path_trusted` 的口径）后走纯核心。
pub fn resolve_attach_dirs(raw: &[String], session_cwd: &str) -> AttachResolution {
    let config = crate::commands::settings::load_state();
    resolve_with_registry(raw, session_cwd, &registry::registered(&config))
}

/// 纯核心：注册表由调用方给——单测直喂，不碰 state.json。
pub fn resolve_with_registry(
    raw: &[String],
    session_cwd: &str,
    registry: &[RegisteredWorkspace],
) -> AttachResolution {
    let mut out = AttachResolution::default();
    for entry in raw {
        match adjudicate_one(entry, session_cwd, registry) {
            Verdict::Accept(path) => {
                if !out.accepted.contains(&path) {
                    out.accepted.push(path);
                }
            }
            Verdict::Reject => out.rejected.push(entry.clone()),
            // 主根子树：本来就能访问，静默跳过（不是拒绝，不该在界面上报警）
            Verdict::Skip => {}
        }
    }
    out
}

enum Verdict {
    Accept(String),
    Reject,
    Skip,
}

/// 单条裁定：归一 → 绝对性 → 存在性/目录性 → 注册表包含性 → 剔主根子树。
fn adjudicate_one(entry: &str, session_cwd: &str, registry: &[RegisteredWorkspace]) -> Verdict {
    let normalized = registry::normalize_registration_path(entry);
    if normalized.is_empty() {
        return Verdict::Reject;
    }
    let path = Path::new(&normalized);
    // 相对路径与 drive-relative（`C:repo`）在这里挡掉：canonicalize 会拿**进程 cwd**
    // 去解析它们，方向不可控（前端给的应该是工作区根拼出来的绝对路径）。
    if !path.is_absolute() {
        return Verdict::Reject;
    }
    // 存在性 + 目录性顺带拿到真实路径；canonicalize 出错（不存在/无权限）即拒。
    let Ok(real) = std::fs::canonicalize(path) else {
        return Verdict::Reject;
    };
    // Windows 上 canonicalize 产 `\\?\` verbatim——剥掉再进账本/下发（仓库两次踩坑）
    let real = dunce::simplified(&real).to_path_buf();
    if !real.is_dir() || !within_registered_workspace(&real, registry) {
        return Verdict::Reject;
    }
    let real_str = real.to_string_lossy().into_owned();
    if !session_cwd.is_empty() && path_within_folder(&real_str, session_cwd, None) {
        return Verdict::Skip;
    }
    Verdict::Accept(real_str)
}

/// 是否落在任一已注册工作区内（含工作区根本身）。
fn within_registered_workspace(path: &Path, registry: &[RegisteredWorkspace]) -> bool {
    let candidate = path.to_string_lossy();
    registry.iter().any(|ws| {
        let root = registry::normalize_registration_path(&ws.path);
        !root.is_empty() && path_within_folder(&candidate, &root, None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时目录里的固定夹具：`<tmp>/aide-attach-test-<pid>-<seq>/{repoA/{sub/deep,file.txt}, outside}`
    ///
    /// **每个用例一个独立目录**（seq 递增）：测试是同进程并行跑的，共用目录时各自的
    /// `remove_dir_all` 会把别人正在用的路径删掉——症状是"随机几个用例失败"。
    struct Fixture {
        root: std::path::PathBuf,
    }

    static FIXTURE_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    impl Fixture {
        fn new() -> Self {
            let seq = FIXTURE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("aide-attach-test-{}-{}", std::process::id(), seq));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("repoA").join("sub").join("deep")).unwrap();
            std::fs::create_dir_all(root.join("outside")).unwrap();
            std::fs::write(root.join("repoA").join("file.txt"), "x").unwrap();
            Self { root }
        }

        fn path(&self, rel: &str) -> String {
            self.root.join(rel).to_string_lossy().into_owned()
        }

        fn registry_of(&self, entries: &[&str]) -> Vec<RegisteredWorkspace> {
            entries
                .iter()
                .map(|rel| RegisteredWorkspace {
                    key: rel.replace([':', '\\', '/'], "-"),
                    path: self.path(rel),
                    added_at: 0,
                })
                .collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn accepts_registered_root_and_subdir() {
        let f = Fixture::new();
        let reg = f.registry_of(&["repoA"]);
        let out = resolve_with_registry(
            &[f.path("repoA"), f.path("repoA/sub/deep")],
            &f.path("outside"),
            &reg,
        );
        assert_eq!(out.accepted.len(), 2, "工作区根与其子目录都应过闸");
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn rejects_unregistered_nonexistent_and_file() {
        let f = Fixture::new();
        let reg = f.registry_of(&["repoA"]);
        let file = f.path("repoA/file.txt");
        let out = resolve_with_registry(
            &[
                f.path("outside"),
                f.path("repoA/nope"),
                file.clone(),
                String::new(),
            ],
            &f.path("outside"),
            &reg,
        );
        assert!(out.accepted.is_empty());
        assert_eq!(out.rejected.len(), 4, "未注册/不存在/文件/空串全部计入回声");
        assert!(out.rejected.contains(&file));
    }

    #[test]
    fn rejects_relative_and_drive_relative() {
        let f = Fixture::new();
        let reg = f.registry_of(&["repoA"]);
        let out = resolve_with_registry(
            &["sub/dir".into(), "C:repoA".into()],
            &f.path("outside"),
            &reg,
        );
        assert!(out.accepted.is_empty());
        assert_eq!(out.rejected.len(), 2, "相对路径与 drive-relative 都不能按进程 cwd 解析");
    }

    #[test]
    fn normalized_trailing_separator_still_hits() {
        let f = Fixture::new();
        // 注册表里带尾分隔符、输入也带——两头都归一后仍应命中
        let reg = f.registry_of(&["repoA/"]);
        let out = resolve_with_registry(&[format!("{}\\", f.path("repoA"))], &f.path("outside"), &reg);
        assert_eq!(out.accepted.len(), 1);
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn session_root_subtree_is_skipped_silently() {
        let f = Fixture::new();
        let reg = f.registry_of(&["repoA"]);
        let out = resolve_with_registry(
            &[f.path("repoA"), f.path("repoA/sub")],
            &f.path("repoA"),
            &reg,
        );
        assert!(out.accepted.is_empty(), "会话主根及其子树不进账本");
        assert!(out.rejected.is_empty(), "但也不算拒绝——不该在界面上报警");
    }

    #[test]
    fn dedupes_same_dir_written_differently() {
        let f = Fixture::new();
        let reg = f.registry_of(&["repoA"]);
        let out = resolve_with_registry(
            &[
                f.path("repoA"),
                format!("{}/", f.path("repoA")),
                f.path("repoA/sub/.."),
            ],
            &f.path("outside"),
            &reg,
        );
        assert_eq!(out.accepted.len(), 1, "canonicalize 后同一目录只入账一次");
        assert!(out.rejected.is_empty());
    }

    /// 大小写不敏感只在 Windows 成立（Linux/macOS 大小写敏感，同一断言会误判）
    #[cfg(windows)]
    #[test]
    fn case_mismatch_still_hits() {
        let f = Fixture::new();
        let reg = f.registry_of(&["repoA"]);
        let upper = f.path("repoA").to_uppercase();
        let out = resolve_with_registry(&[upper], &f.path("outside"), &reg);
        assert_eq!(out.accepted.len(), 1, "注册表原样路径与输入大小写不一致也应命中");
        assert!(out.rejected.is_empty());
    }
}
