//! MEMORY.md 索引解析：提取 markdown 链接条目（标题 / 目标文件 / 描述 / 行号 /
//! 行字节偏移），截断窗口判定在行号与字节偏移两个维度上做（先到先截，
//! 与 Claude Code 的 200 行 / 25KB 加载语义一致）。

/// 索引里的一条链接条目。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub title: String,
    /// 链接目标文件名（如 `foo.md`）。非 markdown 链接 / 外链条目不入列。
    pub file: String,
    /// ` — ` 之后的描述（可空串）。
    pub desc: String,
    /// 1-based 行号。
    pub line: usize,
    /// 该行起始字节偏移（0-based，用于 25KB 截断窗口判定）。
    pub byte_offset: usize,
}

/// 解析单行里的所有 `[title](target)` 链接；target 只收裸 `.md` 文件名
/// （跳过 http(s) 外链与带路径分隔符的目标——它们不是记忆文件）。
pub fn parse_links(line: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let Some(close) = find_byte(bytes, i + 1, b']') else {
            break;
        };
        // 必须紧跟 `(`
        if close + 1 >= bytes.len() || bytes[close + 1] != b'(' {
            i = close + 1;
            continue;
        }
        let Some(end) = find_byte(bytes, close + 2, b')') else {
            break;
        };
        let title = &line[i + 1..close];
        let target = &line[close + 2..end];
        if target.ends_with(".md")
            && !target.contains('/')
            && !target.contains('\\')
            && !target.contains(':')
        {
            out.push((title.to_string(), target.to_string()));
        }
        i = end + 1;
    }
    out
}

fn find_byte(bytes: &[u8], from: usize, b: u8) -> Option<usize> {
    bytes[from..].iter().position(|&x| x == b).map(|p| from + p)
}

/// 整份 MEMORY.md → 链接条目列表（一行多链接出多条，行号相同）。
pub fn parse_index(content: &str) -> Vec<IndexEntry> {
    let mut entries = Vec::new();
    let mut offset = 0usize;
    for (idx, line) in content.lines().enumerate() {
        for (title, file) in parse_links(line) {
            // 描述 = 最后一个链接 `)` 之后的 ` — ` 文本
            let desc = line
                .rsplit(')')
                .next()
                .map(|s| {
                    s.trim()
                        .trim_start_matches('—')
                        .trim()
                        .trim_start_matches('-')
                        .trim()
                })
                .unwrap_or("")
                .to_string();
            entries.push(IndexEntry {
                title,
                file,
                desc,
                line: idx + 1,
                byte_offset: offset,
            });
        }
        offset += line.len() + 1; // +1 换行符（\n；\r\n 场景差一字节，对 25KB 窗口无影响）
    }
    entries
}

/// 截断窗口判定：行号 ≤ max_lines 且行起始字节偏移 < max_bytes。
pub fn within_window(entry: &IndexEntry, max_lines: usize, max_bytes: usize) -> bool {
    entry.line <= max_lines && entry.byte_offset < max_bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_bullet() {
        let (t, f) = &parse_links("- [标题](foo.md) — 描述文字")[0];
        assert_eq!(t, "标题");
        assert_eq!(f, "foo.md");
    }

    #[test]
    fn skips_external_and_path_targets() {
        assert!(parse_links("[a](https://x.com/y.md)").is_empty());
        assert!(parse_links("[a](../b.md)").is_empty());
        assert!(parse_links("[a](sub/b.md)").is_empty());
    }

    #[test]
    fn multiple_links_one_line() {
        let links = parse_links("- [a](a.md) 与 [b](b.md)");
        assert_eq!(links.len(), 2);
    }

    #[test]
    fn index_entries_carry_line_and_offset() {
        let content = "# Project Memory\n\n- [一](a.md) — d1\n- [二](b.md) — d2\n";
        let entries = parse_index(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].line, 3);
        assert_eq!(entries[1].line, 4);
        assert_eq!(entries[0].desc, "d1");
        assert!(entries[1].byte_offset > entries[0].byte_offset);
    }

    #[test]
    fn window_uses_lines_and_bytes() {
        let e = IndexEntry {
            title: "t".into(),
            file: "f.md".into(),
            desc: "".into(),
            line: 201,
            byte_offset: 0,
        };
        assert!(!within_window(&e, 200, 25 * 1024));
        let e2 = IndexEntry {
            line: 1,
            byte_offset: 26 * 1024,
            ..e
        };
        assert!(!within_window(&e2, 200, 25 * 1024));
        let e3 = IndexEntry {
            line: 1,
            byte_offset: 100,
            ..e2
        };
        assert!(within_window(&e3, 200, 25 * 1024));
    }
}
