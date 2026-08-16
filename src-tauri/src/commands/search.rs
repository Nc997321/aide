use std::path::Path;

use ignore::WalkBuilder;
use regex::Regex;
use regex::RegexBuilder;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub file_mask: Option<String>,
    pub limit: Option<usize>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            use_regex: false,
            case_sensitive: false,
            whole_word: false,
            file_mask: None,
            limit: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub line_text: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileGroup {
    pub file: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub files: Vec<SearchFileGroup>,
    pub total: usize,
    pub truncated: bool,
}

/// 编译搜索模式：非正则先转义；全词按 IDEA 语义只在首/尾是词字符时加 \b。
fn compile_pattern(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let mut pattern = if options.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if options.whole_word {
        let starts_word = pattern
            .chars()
            .next()
            .map_or(false, |c| c.is_alphanumeric() || c == '_');
        let ends_word = pattern
            .chars()
            .last()
            .map_or(false, |c| c.is_alphanumeric() || c == '_');
        if starts_word && ends_word {
            pattern = format!(r"\b(?:{})\b", pattern);
        } else if starts_word {
            pattern = format!(r"\b(?:{})", pattern);
        } else if ends_word {
            pattern = format!(r"(?:{})\b", pattern);
        }
    }
    let mut builder = RegexBuilder::new(&pattern);
    builder.case_insensitive(!options.case_sensitive);
    builder.build().map_err(|e| format!("正则无效: {}", e))
}

/// 与 grep_symbol 同款遍历：尊重 .gitignore / git global / git exclude，限深 20。
/// 文件掩码用 OverrideBuilder（rg 同款 glob 语义），逗号分隔多个 pattern。
fn build_walker(cwd: &str, options: &SearchOptions) -> Result<ignore::Walk, String> {
    let mut builder = WalkBuilder::new(cwd);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // ignore 0.4 默认 require_git=true：非 git 仓库目录（无 .git/.jj）里
        // .gitignore 完全不生效。搜索是纯文件遍历，不要求目标在 git 仓库内
        // （rg --no-require-git 同款语义），否则临时目录/普通文件夹的
        // .gitignore 会被无视（gitignored_files_skipped 测试坐实）。
        .require_git(false)
        .max_depth(Some(20));
    if let Some(mask) = options.file_mask.as_deref() {
        let mut ob = ignore::overrides::OverrideBuilder::new(cwd);
        for pat in mask.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            ob.add(pat).map_err(|e| format!("文件掩码无效: {}", e))?;
        }
        builder.overrides(ob.build().map_err(|e| format!("文件掩码无效: {}", e))?);
    }
    Ok(builder.build())
}

/// 读文本文件；二进制（含 null byte）或非 UTF-8 返回 None。
fn read_text_skip_binary(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// 行内 byte 偏移 → char 计数（CJK 友好，供显示/跳转）。
fn char_count(s: &str, byte_idx: usize) -> usize {
    s.get(..byte_idx).map_or(0, |prefix| prefix.chars().count())
}

fn search_in_files_blocking(
    query: &str,
    cwd: &str,
    options: &SearchOptions,
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        return Ok(SearchResponse { files: Vec::new(), total: 0, truncated: false });
    }
    let re = compile_pattern(query, options)?;
    let limit = options.limit.unwrap_or(500);

    let mut groups: Vec<SearchFileGroup> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for entry in build_walker(cwd, options)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 1_000_000 {
                continue;
            }
        }
        let Some(content) = read_text_skip_binary(path) else { continue };
        let rel_path = path
            .strip_prefix(cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        let mut matches: Vec<SearchMatch> = Vec::new();
        for (line_num, line) in content.lines().enumerate() {
            for m in re.find_iter(line) {
                matches.push(SearchMatch {
                    file: rel_path.clone(),
                    line: (line_num + 1) as u32,
                    column: char_count(line, m.start()) as u32 + 1,
                    line_text: line.to_string(),
                    match_start: m.start() as u32,
                    match_end: m.end() as u32,
                });
                total += 1;
                if total >= limit {
                    truncated = true;
                    break;
                }
            }
            if truncated {
                break;
            }
        }
        if !matches.is_empty() {
            groups.push(SearchFileGroup { file: rel_path, matches });
        }
        if truncated {
            break;
        }
    }

    Ok(SearchResponse { files: groups, total, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static DIR_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn make_workspace() -> std::path::PathBuf {
        let n = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("aide_search_test_{}_{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &std::path::Path, name: &str, content: &str) {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    #[test]
    fn literal_search_finds_matches() {
        let dir = make_workspace();
        write(&dir, "a.ts", "const foo = 1;\nlet bar = 2;\n");
        write(&dir, "b.ts", "no match here\n");
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].file, "a.ts");
        assert_eq!(res.files[0].matches[0].line, 1);
        assert_eq!(res.files[0].matches[0].column, 7);
        assert!(!res.truncated);
    }

    #[test]
    fn literal_search_case_insensitive_by_default() {
        let dir = make_workspace();
        write(&dir, "a.ts", "const FOO = 1;\n");
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.total, 1);
    }

    #[test]
    fn case_sensitive_option() {
        let dir = make_workspace();
        write(&dir, "a.ts", "const Foo = 1;\n");
        let opts = SearchOptions { case_sensitive: true, ..Default::default() };
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.total, 0);
    }

    #[test]
    fn whole_word_option() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo\nfoobar\n");
        let opts = SearchOptions { whole_word: true, ..Default::default() };
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.files[0].matches[0].line, 1);
    }

    #[test]
    fn whole_word_with_non_word_edges() {
        // 首尾非词字符（如 "foo("）不加 \b，否则 \b 在非词字符处永不匹配
        let dir = make_workspace();
        write(&dir, "a.ts", "foo(1)\n");
        let opts = SearchOptions { whole_word: true, ..Default::default() };
        let res = search_in_files_blocking("foo(", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.total, 1);
    }

    #[test]
    fn regex_search() {
        let dir = make_workspace();
        write(&dir, "a.ts", "f.o\n");
        let opts = SearchOptions { use_regex: true, ..Default::default() };
        let res = search_in_files_blocking("f.o", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.total, 1);
    }

    #[test]
    fn invalid_regex_returns_error() {
        let dir = make_workspace();
        write(&dir, "a.ts", "x\n");
        let opts = SearchOptions { use_regex: true, ..Default::default() };
        let res = search_in_files_blocking("(", dir.to_str().unwrap(), &opts);
        assert!(res.is_err());
    }

    #[test]
    fn file_mask_filters() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo\n");
        write(&dir, "b.vue", "foo\n");
        let opts = SearchOptions { file_mask: Some("*.ts".to_string()), ..Default::default() };
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.files[0].file, "a.ts");
    }

    #[test]
    fn binary_file_skipped() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo\n");
        fs::write(dir.join("b.bin"), b"foo\x00bar").unwrap();
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.files[0].file, "a.ts");
    }

    #[test]
    fn limit_truncates() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo\nfoo\nfoo\n");
        let opts = SearchOptions { limit: Some(2), ..Default::default() };
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.total, 2);
        assert!(res.truncated);
    }

    #[test]
    fn empty_query_returns_empty() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo\n");
        let res = search_in_files_blocking("  ", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.total, 0);
        assert!(res.files.is_empty());
    }

    #[test]
    fn gitignored_files_skipped() {
        let dir = make_workspace();
        write(&dir, ".gitignore", "target/\n");
        write(&dir, "target/gen.ts", "foo\n");
        write(&dir, "src/a.ts", "foo\n");
        let res = search_in_files_blocking("foo", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.files[0].file, "src/a.ts");
    }
}
