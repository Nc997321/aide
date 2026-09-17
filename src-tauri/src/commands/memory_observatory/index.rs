//! 按**目录**取该工作区的 auto memory 索引原文——供桌面在 `@目录` 的当轮注入里带上
//! 对方仓的记忆（单会话跨目录工作，方案 D 段：中途 @ 的目录靠消息级目录段当轮送达）。
//!
//! 为什么落在这里：memory 目录解析（`resolve::memory_dirs`）与截断窗口常量都是本模块
//! 的，key 规则（`workspace::path_to_key`）也是 `resolve.rs` 已经在用的那条边。与
//! `scan` 的差别只在产出：scan 给结构化条目（观测台面板用），这里给**原文**（喂模型）。
//!
//! 已知边界：索引里的 topic 链接是相对文件名，模型拿不到对方仓的 memory 目录路径，
//! 因此这一轮它只能"知道有这条记忆"，要读细节得等下次 spawn 的 systemPrompt 通路
//! （那条由 sidecar `engine/instructions.ts` 注入，同一套截断规则）。

use std::path::PathBuf;

use super::{resolve, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES};
use crate::commands::workspace::path_to_key;

/// 目录 → 索引原文（已截断）。目录不存在 / 该仓没有记忆 → None（不是错误：
/// 多数仓就是没有记忆，调用方据此静默跳过）。
pub fn for_dir(dir: &str) -> Option<String> {
    let real = canonical(dir)?;
    read_index_in(&resolve::memory_dirs(&path_to_key(&real)))
}

/// 归一成盘上真实形态。projects 下的 key 是 CLI 按**它看到的 cwd** 编码的，大小写 /
/// 8.3 短名 / 符号链接形态不一致就会静默查不到（同 `attach.rs` 的 canonicalize 理由）；
/// `canonicalize` 失败 = 目录不存在，直接判无（本来也读不到）。
fn canonical(dir: &str) -> Option<String> {
    let real = std::fs::canonicalize(dir).ok()?;
    Some(dunce::simplified(&real).to_string_lossy().into_owned())
}

/// 多目录取第一个读到的非空 MEMORY.md——dot 归一可能命中多个 projects 目录
/// （见 `workspace::resolve_project_dirs`），与 sidecar 侧同序取首个。
fn read_index_in(dirs: &[PathBuf]) -> Option<String> {
    dirs.iter()
        .filter_map(|d| std::fs::read_to_string(d.join("MEMORY.md")).ok())
        .find(|text| !text.trim().is_empty())
        .map(|text| truncate_index(&text))
}

/// 前 200 行 / 25 KiB 先到先截，尾部留一行说明——与 sidecar `engine/instructions.ts`
/// 的 `truncateMemoryIndex` 同规则（那条走 systemPrompt，这条走消息段），改一处要改两处。
fn truncate_index(text: &str) -> String {
    let lines: Vec<&str> = text.lines().take(MEMORY_INDEX_MAX_LINES).collect();
    let by_lines = lines.join("\n");
    let cut = truncate_bytes(&by_lines, MEMORY_INDEX_MAX_BYTES);
    if cut == text {
        text.to_string()
    } else {
        format!("{cut}\n…（记忆索引过长，已截断）")
    }
}

/// 按字节切到最近的 UTF-8 边界（索引多为中文，按 char 数切会松 3 倍）。
fn truncate_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立临时目录（同进程并行跑，共用目录会互相删——attach.rs 的教训）。
    struct Fixture {
        root: PathBuf,
    }

    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    impl Fixture {
        fn new() -> Self {
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("aide-memidx-{}-{}", std::process::id(), seq));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn dir(&self, name: &str) -> PathBuf {
            let d = self.root.join(name);
            std::fs::create_dir_all(&d).unwrap();
            d
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn short_index_passes_through_untouched() {
        assert_eq!(truncate_index("# Memory\n- [一](a.md)"), "# Memory\n- [一](a.md)");
    }

    #[test]
    fn keeps_first_200_lines_only() {
        let text = (0..260).map(|i| format!("- line-{i}")).collect::<Vec<_>>().join("\n");
        let out = truncate_index(&text);
        assert!(out.contains("- line-199"));
        assert!(!out.contains("- line-200"));
        assert!(out.contains("已截断"));
    }

    #[test]
    fn cuts_by_bytes_on_utf8_boundary() {
        // 单行超 25 KiB 的中文：必须按字节切在字符边界上，否则 panic / 出乱码
        let text = "记".repeat(20_000); // 60 KB > 25 KiB
        let out = truncate_index(&text);
        assert!(out.len() < 26 * 1024);
        assert!(out.contains("已截断"));
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn reads_first_dir_that_has_content() {
        let f = Fixture::new();
        let empty = f.dir("empty"); // 没有 MEMORY.md
        let blank = f.dir("blank"); // 有但是空的 → 跳过
        std::fs::write(blank.join("MEMORY.md"), "\n").unwrap();
        let hit = f.dir("hit");
        std::fs::write(hit.join("MEMORY.md"), "- [一](a.md)").unwrap();

        assert_eq!(read_index_in(&[empty, blank, hit]).as_deref(), Some("- [一](a.md)"));
        assert_eq!(read_index_in(&[]), None);
    }

    #[test]
    fn missing_dir_is_none_not_error() {
        assert_eq!(for_dir("Z:\\aide-nonexistent-dir"), None);
    }
}
