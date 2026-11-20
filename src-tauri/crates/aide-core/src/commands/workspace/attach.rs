//! @目录 授权（单会话跨目录工作）的**裁定**：哪些目录真的能进本会话的附加根账本。
//!
//! 工程协作与普通目录都由用户引用表达访问意图，不依赖项目登记或工作区信任。
//! 这里只校验绝对路径、存在性、目录类型并归一去重；执行权限交给 SDK。
//! 无效条目回显 rejected，其余合法目录不受影响。主工作目录子树无需重复扩根。

use std::path::Path;

use crate::policy::matchers::path_within_folder;

use super::registry;

/// 裁定结果：过闸的目录 + 被拒的目录。两者都要回给前端（拒绝不能静默）。
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct AttachResolution {
    /// 已 canonicalize 的原生绝对路径（`\\?\` 已剥），去重后按出现顺序。
    pub accepted: Vec<String>,
    /// 被丢弃的条目（原样回显，便于前端显示是哪一条没通过）。
    pub rejected: Vec<String>,
}

/// 访问根的统一校验入口，不读取或修改项目注册表。
pub fn resolve_attach_dirs(raw: &[String], session_cwd: &str) -> AttachResolution {
    let mut out = AttachResolution::default();
    for entry in raw {
        match adjudicate_one(entry, session_cwd) {
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

/// 单条校验：归一 → 绝对性 → 存在性/目录性 → 剔主根子树。
fn adjudicate_one(entry: &str, session_cwd: &str) -> Verdict {
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
    if !real.is_dir() {
        return Verdict::Reject;
    }
    let real_str = real.to_string_lossy().into_owned();
    if !session_cwd.is_empty() && path_within_folder(&real_str, session_cwd, None) {
        return Verdict::Skip;
    }
    Verdict::Accept(real_str)
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


    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn accepts_directory_root_and_subdir() {
        let f = Fixture::new();
        let out = resolve_attach_dirs(
            &[f.path("repoA"), f.path("repoA/sub/deep")],
            &f.path("outside"),
        );
        assert_eq!(out.accepted.len(), 2, "工作区根与其子目录都应过闸");
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn accepts_unregistered_directory_but_rejects_nonexistent_and_file() {
        let f = Fixture::new();
        let file = f.path("repoA/file.txt");
        let out = resolve_attach_dirs(
            &[
                f.path("outside"),
                f.path("repoA/nope"),
                file.clone(),
                String::new(),
            ],
            &f.path("repoA"),
        );
        assert_eq!(out.accepted, vec![f.path("outside")]);
        assert_eq!(out.rejected.len(), 3, "不存在/文件/空串计入回声");
        assert!(out.rejected.contains(&file));
    }

    #[test]
    fn rejects_relative_and_drive_relative() {
        let f = Fixture::new();
        let out = resolve_attach_dirs(
            &["sub/dir".into(), "C:repoA".into()],
            &f.path("outside"),
        );
        assert!(out.accepted.is_empty());
        assert_eq!(out.rejected.len(), 2, "相对路径与 drive-relative 都不能按进程 cwd 解析");
    }

    #[test]
    fn normalized_trailing_separator_still_hits() {
        let f = Fixture::new();
        // 尾分隔符归一后仍是同一个目录
        let out = resolve_attach_dirs(&[format!("{}\\", f.path("repoA"))], &f.path("outside"));
        assert_eq!(out.accepted.len(), 1);
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn session_root_subtree_is_skipped_silently() {
        let f = Fixture::new();
        let out = resolve_attach_dirs(
            &[f.path("repoA"), f.path("repoA/sub")],
            &f.path("repoA"),
        );
        assert!(out.accepted.is_empty(), "会话主根及其子树不进账本");
        assert!(out.rejected.is_empty(), "但也不算拒绝——不该在界面上报警");
    }

    #[test]
    fn dedupes_same_dir_written_differently() {
        let f = Fixture::new();
        let out = resolve_attach_dirs(
            &[
                f.path("repoA"),
                format!("{}/", f.path("repoA")),
                f.path("repoA/sub/.."),
            ],
            &f.path("outside"),
        );
        assert_eq!(out.accepted.len(), 1, "canonicalize 后同一目录只入账一次");
        assert!(out.rejected.is_empty());
    }

    /// 大小写不敏感只在 Windows 成立（Linux/macOS 大小写敏感，同一断言会误判）
    #[cfg(windows)]
    #[test]
    fn case_mismatch_still_hits() {
        let f = Fixture::new();
        let upper = f.path("repoA").to_uppercase();
        let out = resolve_attach_dirs(&[upper], &f.path("outside"));
        assert_eq!(out.accepted.len(), 1, "输入大小写不一致仍应命中真实目录");
        assert!(out.rejected.is_empty());
    }
}
