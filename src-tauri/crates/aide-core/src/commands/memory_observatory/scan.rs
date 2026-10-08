//! scan 聚合：memory 目录 + MEMORY.md 索引 + 用户 CLAUDE.md → 一个 DTO。
//! 多目录合并规则：同名 topic 后命中目录优先（spec §3.1），来源目录标注在
//! `source_dir`。演化 tab 的生长曲线/最近变化由前端从 topics 时间戳推导，
//! 后端只出原始事实。

use std::collections::HashMap;
use std::fs;

use serde::Serialize;

use super::parse::{self, IndexEntry};
use super::resolve;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub lines: usize,
    pub bytes: usize,
    pub entries: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicInfo {
    pub name: String,
    /// 完整磁盘路径：观测台点击该条直接调 FileViewer.open(path) 复用 markdown
    /// 文件预览/编辑器；多 memory 目录后命中目录覆盖前命中同名条目，path 始终
    /// 是当前活跃实体的完整路径。前端只看 FileViewer 处理（写盘由 FileViewer.save
    /// 走通用 write_file_content，confinement 在 FileViewer 上层 vs. 观测台删除
    /// 命令各自的路径解析层把关）。
    pub path: String,
    pub size: u64,
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
    /// 被 MEMORY.md 链接（在索引里出现）。
    pub indexed: bool,
    /// 链接条目在截断窗口内（前 200 行 / 25KB）；孤儿为 false。
    pub within_window: bool,
    /// 来源 memory 目录（多目录合并时的冲突标注）。
    pub source_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdInfo {
    pub path: String,
    pub bytes: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_lines: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    /// 无 memory 目录或目录里没有 MEMORY.md 时为 None。
    pub index: Option<IndexInfo>,
    pub topics: Vec<TopicInfo>,
    /// 文件在、索引无链接 → 永远不会被回忆起。
    pub orphans: Vec<String>,
    /// 索引链接指向不存在的文件。
    pub deadlinks: Vec<String>,
    pub claude_md: Option<ClaudeMdInfo>,
    pub limits: Limits,
}

/// 跨项目聚合（P2）：一个项目的 key + 它的扫描结果。
/// per-project 扫描不含 claude_md（全局指令全用户唯一，在 scan_all 顶层带一次）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScan {
    pub key: String,
    pub scan: ScanResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanAllResult {
    pub projects: Vec<ProjectScan>,
    pub claude_md: Option<ClaudeMdInfo>,
}

pub fn scan(workspace_key: &str) -> Result<ScanResult, String> {
    let dirs = resolve::memory_dirs(workspace_key);
    scan_dirs(
        &dirs,
        &resolve::claude_md_path(),
        super::MEMORY_INDEX_MAX_LINES,
        super::MEMORY_INDEX_MAX_BYTES,
    )
}

/// 跨项目全量扫描（P2 只读聚合）：遍历 projects 下所有含 memory/ 的项目目录。
pub fn scan_all() -> Result<ScanAllResult, String> {
    let projects = scan_projects_dir(&crate::paths::claude_projects_dir());
    let claude_md = fs::metadata(resolve::claude_md_path())
        .ok()
        .map(|m| ClaudeMdInfo {
            path: resolve::claude_md_path().to_string_lossy().to_string(),
            bytes: m.len(),
            modified_ms: resolve::to_ms(m.modified()),
        });
    Ok(ScanAllResult {
        projects,
        claude_md,
    })
}

/// 与 projects 根目录解耦的扫描本体（fixture 测试直接喂目录）。
fn scan_projects_dir(projects_dir: &std::path::Path) -> Vec<ProjectScan> {
    let mut out: Vec<ProjectScan> = Vec::new();
    let Ok(rd) = fs::read_dir(projects_dir) else {
        return out;
    };
    // 全局指令不进 per-project 扫描（避免 N 份重复），喂一个必不存在的路径。
    let no_claude = std::path::PathBuf::new();
    for entry in rd.flatten() {
        let mem = entry.path().join("memory");
        if !mem.is_dir() {
            continue;
        }
        let Ok(scan) = scan_dirs(
            &[mem],
            &no_claude,
            super::MEMORY_INDEX_MAX_LINES,
            super::MEMORY_INDEX_MAX_BYTES,
        ) else {
            continue;
        };
        if scan.topics.is_empty() && scan.index.is_none() {
            continue; // 空项目不进聚合视图
        }
        out.push(ProjectScan {
            key: entry.file_name().to_string_lossy().to_string(),
            scan,
        });
    }
    // 最近有动静的项目排前面
    out.sort_by_key(|p| {
        std::cmp::Reverse(
            p.scan
                .topics
                .iter()
                .filter_map(|t| t.modified_ms)
                .max()
                .unwrap_or(0),
        )
    });
    out
}

/// 与目录来源解耦的扫描本体（fixture 测试直接喂目录）。
fn scan_dirs(
    dirs: &[std::path::PathBuf],
    claude_md_path: &std::path::Path,
    max_lines: usize,
    max_bytes: usize,
) -> Result<ScanResult, String> {
    // ── 索引：多目录按顺序拼接条目（冲突 topic 归属后命中目录，与 topics 合并一致）──
    let mut entries: Vec<IndexEntry> = Vec::new();
    let mut index_lines = 0usize;
    let mut index_bytes = 0usize;
    let mut have_index = false;
    for dir in dirs {
        let idx_path = dir.join("MEMORY.md");
        let Ok(content) = fs::read_to_string(&idx_path) else {
            continue;
        };
        have_index = true;
        index_lines += content.lines().count();
        index_bytes += content.len();
        entries.extend(parse::parse_index(&content));
    }

    // ── topics：按目录扫描 *.md（MEMORY.md 除外），同名后命中目录覆盖 ──
    let mut topics: HashMap<String, TopicInfo> = HashMap::new();
    for dir in dirs {
        let Ok(rd) = fs::read_dir(dir) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") || name == "MEMORY.md" {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            topics.insert(
                name.clone(),
                TopicInfo {
                    name,
                    path: entry.path().to_string_lossy().to_string(),
                    size: meta.len(),
                    created_ms: resolve::to_ms(meta.created()),
                    modified_ms: resolve::to_ms(meta.modified()),
                    indexed: false,
                    within_window: false,
                    source_dir: dir.to_string_lossy().to_string(),
                },
            );
        }
    }

    // ── 链接回填 + 死链 ──
    let mut deadlinks = Vec::new();
    for e in &entries {
        match topics.get_mut(&e.file) {
            Some(t) => {
                t.indexed = true;
                if parse::within_window(e, max_lines, max_bytes) {
                    t.within_window = true;
                }
            }
            None => {
                if !deadlinks.contains(&e.file) {
                    deadlinks.push(e.file.clone());
                }
            }
        }
    }

    let mut topics: Vec<TopicInfo> = topics.into_values().collect();
    topics.sort_by_key(|t| std::cmp::Reverse(t.modified_ms));
    let orphans: Vec<String> = topics
        .iter()
        .filter(|t| !t.indexed)
        .map(|t| t.name.clone())
        .collect();

    let claude_md = fs::metadata(claude_md_path).ok().map(|m| ClaudeMdInfo {
        path: claude_md_path.to_string_lossy().to_string(),
        bytes: m.len(),
        modified_ms: resolve::to_ms(m.modified()),
    });

    Ok(ScanResult {
        index: have_index.then_some(IndexInfo {
            lines: index_lines,
            bytes: index_bytes,
            entries,
        }),
        topics,
        orphans,
        deadlinks,
        claude_md,
        limits: Limits {
            max_lines,
            max_bytes,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aide_mo_scan_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_flags_orphans_and_deadlinks() {
        let dir = fixture_dir("orphan");
        fs::write(
            dir.join("MEMORY.md"),
            "# Project Memory\n\n- [甲](a.md) — 有文件\n- [乙](gone.md) — 没文件\n",
        )
        .unwrap();
        fs::write(dir.join("a.md"), "A").unwrap();
        fs::write(dir.join("b.md"), "B（索引没引用）").unwrap();
        let missing_claude = dir.join("no-such-CLAUDE.md");

        let r = scan_dirs(&[dir.clone()], &missing_claude, 200, 25 * 1024).unwrap();
        let idx = r.index.unwrap();
        assert_eq!(idx.lines, 4);
        assert_eq!(idx.entries.len(), 2);
        assert_eq!(r.topics.len(), 2);
        assert_eq!(r.orphans, vec!["b.md"]);
        assert_eq!(r.deadlinks, vec!["gone.md"]);
        assert!(r.claude_md.is_none());
        let a = r.topics.iter().find(|t| t.name == "a.md").unwrap();
        assert!(a.indexed && a.within_window);
        let b = r.topics.iter().find(|t| t.name == "b.md").unwrap();
        assert!(!b.indexed && !b.within_window);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_marks_entries_beyond_window() {
        let dir = fixture_dir("window");
        // 索引 3 行上限：第 4 行的链接在窗口外
        fs::write(
            dir.join("MEMORY.md"),
            "# H\n- [一](a.md) — x\n- [二](b.md) — y\n- [三](c.md) — z\n",
        )
        .unwrap();
        for n in ["a.md", "b.md", "c.md"] {
            fs::write(dir.join(n), "x").unwrap();
        }
        let missing = dir.join("none.md");
        let r = scan_dirs(&[dir.clone()], &missing, 3, 25 * 1024).unwrap();
        let c = r.topics.iter().find(|t| t.name == "c.md").unwrap();
        assert!(c.indexed && !c.within_window, "截断线外：indexed 但不可达");
        let a = r.topics.iter().find(|t| t.name == "a.md").unwrap();
        assert!(a.within_window);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn later_dir_wins_on_name_collision() {
        let d1 = fixture_dir("dup1");
        let d2 = fixture_dir("dup2");
        fs::write(d1.join("MEMORY.md"), "- [甲](a.md) — d1\n").unwrap();
        fs::write(d2.join("MEMORY.md"), "- [甲](a.md) — d2\n").unwrap();
        fs::write(d1.join("a.md"), "1234").unwrap();
        fs::write(d2.join("a.md"), "12345678").unwrap();
        let missing = d1.join("none.md");

        let r = scan_dirs(&[d1.clone(), d2.clone()], &missing, 200, 25 * 1024).unwrap();
        let a = r.topics.iter().find(|t| t.name == "a.md").unwrap();
        assert_eq!(a.size, 8, "后命中目录优先");
        assert_eq!(a.source_dir, d2.to_string_lossy());
        assert!(a.indexed);

        let _ = fs::remove_dir_all(&d1);
        let _ = fs::remove_dir_all(&d2);
    }

    #[test]
    fn no_memory_dir_yields_none_index() {
        let missing = std::path::PathBuf::from("Z:/definitely/not/exist");
        let r = scan_dirs(&[], &missing, 200, 25 * 1024).unwrap();
        assert!(r.index.is_none());
        assert!(r.topics.is_empty());
    }

    #[test]
    fn scan_projects_dir_aggregates_and_skips_empty() {
        let root = fixture_dir("all");
        let pa = root.join("C--proj-a");
        let pb = root.join("C--proj-b");
        let pe = root.join("C--proj-empty");
        fs::create_dir_all(pa.join("memory")).unwrap();
        fs::create_dir_all(pb.join("memory")).unwrap();
        fs::create_dir_all(&pe).unwrap(); // 无 memory/ 目录
        let pc = root.join("C--proj-c");
        fs::create_dir_all(pc.join("memory")).unwrap(); // 有目录但空
        fs::write(pa.join("memory/MEMORY.md"), "- [甲](a.md) — x\n").unwrap();
        fs::write(pa.join("memory/a.md"), "A").unwrap();
        fs::write(pb.join("memory/b.md"), "B").unwrap();

        let out = scan_projects_dir(&root);
        assert_eq!(out.len(), 2, "空项目与无 memory 目录的项目不进聚合");
        let keys: Vec<&str> = out.iter().map(|p| p.key.as_str()).collect();
        assert!(keys.contains(&"C--proj-a") && keys.contains(&"C--proj-b"));
        let a = out.iter().find(|p| p.key == "C--proj-a").unwrap();
        assert_eq!(a.scan.topics.len(), 1);
        assert!(a.scan.claude_md.is_none(), "per-project 扫描不带全局指令");

        let _ = fs::remove_dir_all(&root);
    }
}
