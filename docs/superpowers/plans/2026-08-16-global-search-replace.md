# 全局搜索 + 替换（Find in Files）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供 IDEA 式「在文件中查找/替换」——右侧面板新 tab，内容搜索（正则/大小写/全词/文件掩码）+ 逐文件 diff 预览替换。

**Architecture:** 后端新模块 `src-tauri/src/commands/search.rs`（3 个 async 命令：`search_in_files` / `replace_in_files_preview` / `apply_replacements`，复用 ignore crate WalkBuilder + regex crate，spawn_blocking 防卡主线程）；前端新组件 `SearchPanel.vue` 注册进右侧 ARailBar tab，复用 DiffViewer 渲染替换预览、useFileViewer 跳转、useToast 反馈；App.vue 加 Ctrl+Shift+F（只搜索）/ Ctrl+Shift+R（搜索+替换）两个快捷键。

**Tech Stack:** Rust（ignore 0.4 / regex 1，均已依赖）、Tauri v2、Vue 3 + TypeScript、vitest + @vue/test-utils + jsdom。

**Spec:** `docs/superpowers/specs/2026-08-16-global-search-replace-design.md`

## Global Constraints

- **async 命令禁重 IO 主线程**（CLAUDE.md 红线）：3 个命令全部 `async fn` + `tokio::task::spawn_blocking`。
- **serde 结构体统一 `#[serde(rename_all = "camelCase")]`**（项目约定，见 chat.rs:106、jdk.rs:21）。
- **搜索/预览返回相对路径**（与 `GrepMatch.file` 约定一致，filesystem.rs:597-601 同款 `strip_prefix(cwd)` + `replace('\\', "/")`），前端用 workspacePath 拼接绝对路径。
- **路径拼接不硬编码 `\\`**（跨平台红线）：Rust 用 `PathBuf`/`strip_prefix`，前端用 `/` 拼接。
- **颜色/背景/边框一律 `var(--aide-*)`**（主题红线）：SearchPanel 样式禁止硬编码 hex。
- **测试运行**：Rust 用 `cargo test --lib search`（仓库怪癖：`cargo test --lib` 绕杀软锁）；前端用 `pnpm vitest run <file>`。
- **组件测试需文件头 `// @vitest-environment jsdom`**（vitest 全局 `environment: "node"`，vitest.config.ts）。
- **大文件保护**：> 1MB 跳过（对齐 DiffViewer MAX_DIFF_SIZE 心智）；二进制（null byte）跳过。
- **搜索上限**：`limit` 默认 500 条命中；预览上限 50 个文件，超出置 `truncated`。

---

### Task 1: Rust 搜索核心（search.rs：类型 + compile_pattern + search_in_files_blocking + 单测）

**Files:**
- Create: `src-tauri/src/commands/search.rs`

**Interfaces:**
- Produces（Task 2/3 依赖）：
  - `pub struct SearchOptions { pub use_regex: bool, pub case_sensitive: bool, pub whole_word: bool, pub file_mask: Option<String>, pub limit: Option<usize> }`（`#[serde(rename_all = "camelCase", default)]` + 手动 `Default`）
  - `pub struct SearchMatch { pub file: String, pub line: u32, pub column: u32, pub line_text: String, pub match_start: u32, pub match_end: u32 }`
  - `pub struct SearchFileGroup { pub file: String, pub matches: Vec<SearchMatch> }`
  - `pub struct SearchResponse { pub files: Vec<SearchFileGroup>, pub total: usize, pub truncated: bool }`
  - `fn compile_pattern(query: &str, options: &SearchOptions) -> Result<Regex, String>`（Task 2 复用）
  - `fn build_walker(cwd: &str, options: &SearchOptions) -> Result<ignore::Walk, String>`（Task 2 复用）
  - `fn read_text_skip_binary(path: &Path) -> Option<String>`（Task 2 复用）
  - `fn search_in_files_blocking(query: &str, cwd: &str, options: &SearchOptions) -> Result<SearchResponse, String>`

- [ ] **Step 1: 写类型定义 + 失败测试**

创建 `src-tauri/src/commands/search.rs`，先写类型定义和测试模块（函数尚未实现，编译失败即红灯）：

```rust
use std::path::Path;

use ignore::WalkBuilder;
use regex::Regex;

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
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cargo test --lib search`
Expected: 编译失败（`search_in_files_blocking` 等函数未定义）——红灯。

- [ ] **Step 3: 实现搜索核心**

在 `search.rs` 的 `mod tests` 之前追加实现（`use regex::RegexBuilder;` 加到文件头 import）：

```rust
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
```

- [ ] **Step 4: 运行测试确认绿灯**

Run: `cargo test --lib search`
Expected: 13 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/search.rs
git commit -m "feat(search): 全局搜索核心——compile_pattern + search_in_files_blocking + 单测"
```

---

### Task 2: Rust 替换核心（replace_in_files_preview_blocking + apply_replacements_blocking + 单测）

**Files:**
- Modify: `src-tauri/src/commands/search.rs`（追加类型 + 函数 + 测试）

**Interfaces:**
- Consumes: Task 1 的 `compile_pattern` / `build_walker` / `read_text_skip_binary` / `SearchOptions`
- Produces（Task 3 依赖）：
  - `pub struct ReplacePreviewFile { pub file: String, pub original: String, pub replaced: String, pub match_count: usize }`
  - `pub struct ReplacePreviewResponse { pub files: Vec<ReplacePreviewFile>, pub total_matches: usize, pub truncated: bool }`
  - `pub struct ReplaceFileInput { pub path: String, pub content: String }`（`#[serde(rename_all = "camelCase")]`，Deserialize）
  - `pub struct ApplyResult { pub succeeded: Vec<String>, pub failed: Vec<(String, String)> }`
  - `fn replace_in_files_preview_blocking(query: &str, replacement: &str, cwd: &str, options: &SearchOptions) -> Result<ReplacePreviewResponse, String>`
  - `fn apply_replacements_blocking(files: Vec<ReplaceFileInput>) -> Result<ApplyResult, String>`

- [ ] **Step 1: 写失败测试**

在 `search.rs` 的 `mod tests` 内追加（`use super::*` 已覆盖新类型）：

```rust
    #[test]
    fn replace_literal_all_occurrences() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo foo bar\n");
        let res = replace_in_files_preview_blocking("foo", "baz", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].replaced, "baz baz bar\n");
        assert_eq!(res.files[0].match_count, 2);
        assert_eq!(res.total_matches, 2);
    }

    #[test]
    fn replace_capture_groups() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foobar\n");
        let opts = SearchOptions { use_regex: true, ..Default::default() };
        let res = replace_in_files_preview_blocking("(foo)(bar)", "$1-$2", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.files[0].replaced, "foo-bar\n");
    }

    #[test]
    fn replace_named_capture_group() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foobar\n");
        let opts = SearchOptions { use_regex: true, ..Default::default() };
        let res = replace_in_files_preview_blocking("(?P<name>foo)bar", "${name}!", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.files[0].replaced, "foo!\n");
    }

    #[test]
    fn no_match_file_excluded_from_preview() {
        let dir = make_workspace();
        write(&dir, "a.ts", "foo\n");
        write(&dir, "b.ts", "nothing\n");
        let res = replace_in_files_preview_blocking("foo", "bar", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].file, "a.ts");
    }

    #[test]
    fn preview_truncates_at_50_files() {
        let dir = make_workspace();
        for i in 0..60 {
            write(&dir, &format!("f{}.ts", i), "foo\n");
        }
        let res = replace_in_files_preview_blocking("foo", "bar", dir.to_str().unwrap(), &SearchOptions::default()).unwrap();
        assert_eq!(res.files.len(), 50);
        assert!(res.truncated);
    }

    #[test]
    fn apply_writes_files() {
        let dir = make_workspace();
        let p = dir.join("a.ts");
        fs::write(&p, "old").unwrap();
        let res = apply_replacements_blocking(vec![
            ReplaceFileInput { path: p.to_string_lossy().to_string(), content: "new".to_string() },
        ]).unwrap();
        assert_eq!(res.succeeded.len(), 1);
        assert!(res.failed.is_empty());
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
    }

    #[test]
    fn apply_partial_failure() {
        let dir = make_workspace();
        let p = dir.join("a.ts");
        fs::write(&p, "old").unwrap();
        let res = apply_replacements_blocking(vec![
            ReplaceFileInput { path: p.to_string_lossy().to_string(), content: "new".to_string() },
            ReplaceFileInput { path: dir.join("missing.ts").to_string_lossy().to_string(), content: "x".to_string() },
        ]).unwrap();
        assert_eq!(res.succeeded.len(), 1);
        assert_eq!(res.failed.len(), 1);
        assert!(res.failed[0].0.ends_with("missing.ts"));
    }

    #[test]
    fn replace_respects_case_sensitive() {
        let dir = make_workspace();
        write(&dir, "a.ts", "Foo foo\n");
        let opts = SearchOptions { case_sensitive: true, ..Default::default() };
        let res = replace_in_files_preview_blocking("foo", "bar", dir.to_str().unwrap(), &opts).unwrap();
        assert_eq!(res.files[0].replaced, "Foo bar\n");
        assert_eq!(res.files[0].match_count, 1);
    }
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cargo test --lib search`
Expected: 编译失败（新类型/函数未定义）——红灯。

- [ ] **Step 3: 实现替换核心**

在 `search.rs` 的 `mod tests` 之前追加：

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewFile {
    pub file: String,
    pub original: String,
    pub replaced: String,
    pub match_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewResponse {
    pub files: Vec<ReplacePreviewFile>,
    pub total_matches: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFileInput {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub succeeded: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// 服务端权威计算替换（regex crate 的 $1/$name/${name} 捕获组），
/// 预览与写盘永远一致。文件数上限 50，超出置 truncated。
fn replace_in_files_preview_blocking(
    query: &str,
    replacement: &str,
    cwd: &str,
    options: &SearchOptions,
) -> Result<ReplacePreviewResponse, String> {
    if query.trim().is_empty() {
        return Ok(ReplacePreviewResponse { files: Vec::new(), total_matches: 0, truncated: false });
    }
    let re = compile_pattern(query, options)?;
    let max_files = 50;

    let mut files: Vec<ReplacePreviewFile> = Vec::new();
    let mut total_matches = 0usize;
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
        let replaced = re.replace_all(&content, replacement).to_string();
        if replaced == content {
            continue;
        }
        let match_count = re.find_iter(&content).count();
        total_matches += match_count;
        let rel_path = path
            .strip_prefix(cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        files.push(ReplacePreviewFile {
            file: rel_path,
            original: content,
            replaced,
            match_count,
        });
        if files.len() >= max_files {
            truncated = true;
            break;
        }
    }

    Ok(ReplacePreviewResponse { files, total_matches, truncated })
}

/// 只接受预览返回的 content，逐文件写盘，返回成功/失败列表。
fn apply_replacements_blocking(files: Vec<ReplaceFileInput>) -> Result<ApplyResult, String> {
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    for f in files {
        match std::fs::write(&f.path, &f.content) {
            Ok(()) => succeeded.push(f.path),
            Err(e) => failed.push((f.path, format!("写入失败: {}", e))),
        }
    }
    Ok(ApplyResult { succeeded, failed })
}
```

- [ ] **Step 4: 运行测试确认绿灯**

Run: `cargo test --lib search`
Expected: 全部测试（Task 1 的 13 个 + Task 2 的 8 个）PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/search.rs
git commit -m "feat(search): 替换核心——replace_in_files_preview_blocking + apply_replacements_blocking + 单测"
```

---

### Task 3: Rust 命令包装 + 模块注册

**Files:**
- Modify: `src-tauri/src/commands/search.rs`（追加 3 个 `#[tauri::command]`）
- Modify: `src-tauri/src/commands/mod.rs`（加 `pub mod search;`）
- Modify: `src-tauri/src/lib.rs`（`generate_handler!` 注册 3 个命令）

**Interfaces:**
- Consumes: Task 1/2 的全部 blocking 函数
- Produces（Task 4 依赖，前端 invoke 名）：
  - `search_in_files(query: String, cwd: String, options: SearchOptions) -> Result<SearchResponse, String>`
  - `replace_in_files_preview(query: String, replacement: String, cwd: String, options: SearchOptions) -> Result<ReplacePreviewResponse, String>`
  - `apply_replacements(files: Vec<ReplaceFileInput>) -> Result<ApplyResult, String>`

- [ ] **Step 1: 写 3 个 async 命令包装**

在 `search.rs` 的 `mod tests` 之前追加（`use tokio::task::spawn_blocking` 不需要——用全路径）：

```rust
/// async + spawn_blocking：全工作区遍历是重 IO，禁止跑主线程（CLAUDE.md 红线）。
#[tauri::command]
pub async fn search_in_files(
    query: String,
    cwd: String,
    options: SearchOptions,
) -> Result<SearchResponse, String> {
    tokio::task::spawn_blocking(move || search_in_files_blocking(&query, &cwd, &options))
        .await
        .map_err(|e| format!("search_in_files task panicked: {}", e))?
}

#[tauri::command]
pub async fn replace_in_files_preview(
    query: String,
    replacement: String,
    cwd: String,
    options: SearchOptions,
) -> Result<ReplacePreviewResponse, String> {
    tokio::task::spawn_blocking(move || {
        replace_in_files_preview_blocking(&query, &replacement, &cwd, &options)
    })
    .await
    .map_err(|e| format!("replace_in_files_preview task panicked: {}", e))?
}

#[tauri::command]
pub async fn apply_replacements(files: Vec<ReplaceFileInput>) -> Result<ApplyResult, String> {
    tokio::task::spawn_blocking(move || apply_replacements_blocking(files))
        .await
        .map_err(|e| format!("apply_replacements task panicked: {}", e))?
}
```

- [ ] **Step 2: 注册模块 + 命令**

`src-tauri/src/commands/mod.rs`：在 `pub mod filesystem;` 附近加一行：

```rust
pub mod search;
```

`src-tauri/src/lib.rs` 的 `generate_handler!` 列表（`commands::filesystem::find_files_by_name,` 之后）加：

```rust
            commands::search::search_in_files,
            commands::search::replace_in_files_preview,
            commands::search::apply_replacements,
```

- [ ] **Step 3: 编译 + 全量测试**

Run: `cargo test --lib search`
Expected: 全部 PASS（编译通过即证明注册无误——lib.rs 在 lib target 内）。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/commands/search.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(search): 注册 search_in_files / replace_in_files_preview / apply_replacements 命令"
```

---

### Task 4: 前端类型 + api.ts 包装

**Files:**
- Modify: `src/types.ts`（追加 Search/Replace 类型，放在 `GrepMatch` 之后）
- Modify: `src/api.ts`（追加 3 个 invoke 包装，放在 `grepSymbol` 之后）

**Interfaces:**
- Consumes: Task 3 的命令名与参数形状
- Produces（Task 5/6 依赖）：
  - `api.searchInFiles(query: string, cwd: string, options: SearchOptions): Promise<SearchResponse>`
  - `api.replaceInFilesPreview(query: string, replacement: string, cwd: string, options: SearchOptions): Promise<ReplacePreviewResponse>`
  - `api.applyReplacements(files: ReplaceFileInput[]): Promise<ApplyResult>`

- [ ] **Step 1: types.ts 追加类型**

在 `src/types.ts` 的 `GrepMatch` 接口（约 340 行）之后追加：

```ts
// ── Global search & replace types（Find in Files）──

export interface SearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  fileMask: string | null;
  limit: number | null;
}

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileGroup {
  file: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  files: SearchFileGroup[];
  total: number;
  truncated: boolean;
}

export interface ReplacePreviewFile {
  file: string;
  original: string;
  replaced: string;
  matchCount: number;
}

export interface ReplacePreviewResponse {
  files: ReplacePreviewFile[];
  totalMatches: number;
  truncated: boolean;
}

export interface ReplaceFileInput {
  path: string;
  content: string;
}

export interface ApplyResult {
  succeeded: string[];
  failed: [string, string][];
}
```

- [ ] **Step 2: api.ts 追加包装**

在 `src/api.ts` 的 `grepSymbol`（约 195 行）之后追加：

```ts
  // 全局搜索 + 替换（Find in Files）
  searchInFiles(query: string, cwd: string, options: SearchOptions): Promise<SearchResponse> {
    return invoke("search_in_files", { query, cwd, options });
  },
  replaceInFilesPreview(
    query: string,
    replacement: string,
    cwd: string,
    options: SearchOptions,
  ): Promise<ReplacePreviewResponse> {
    return invoke("replace_in_files_preview", { query, replacement, cwd, options });
  },
  applyReplacements(files: ReplaceFileInput[]): Promise<ApplyResult> {
    return invoke("apply_replacements", { files });
  },
```

`src/api.ts` 顶部类型 import 处补 `SearchOptions, SearchResponse, ReplacePreviewResponse, ReplaceFileInput, ApplyResult`。

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(search): 前端类型 + api 包装（searchInFiles / replaceInFilesPreview / applyReplacements）"
```

---

### Task 5: SearchPanel.vue 搜索模式

**Files:**
- Create: `src/components/SearchPanel.vue`
- Test: `src/components/SearchPanel.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `api.searchInFiles` / 类型；`useFileViewer().openAndScrollTo(path, line)`（useFileViewer.ts:270）；`useToast()`（useToast.ts:16）
- Produces（Task 6/7 依赖）：
  - Props: `{ workspacePath: string }`
  - 组件内部状态：`query` / `useRegex` / `caseSensitive` / `wholeWord` / `fileMask` / `result` / `searching` / `error` / `expanded`
  - 点击匹配行 → `useFileViewer().openAndScrollTo(joinPath(workspacePath, m.file), m.line)`

- [ ] **Step 1: 写失败测试**

创建 `src/components/SearchPanel.test.ts`（**文件头必须有 jsdom pragma**）：

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// useFileViewer mock 必须是单例：组件内部调用与测试断言共享同一个 vi.fn()，
// 否则每次 useFileViewer() 都新建 mock，断言永远落空。
const { openAndScrollTo } = vi.hoisted(() => ({ openAndScrollTo: vi.fn() }));

vi.mock("../api", () => ({
  api: {
    searchInFiles: vi.fn(),
    replaceInFilesPreview: vi.fn(),
    applyReplacements: vi.fn(),
  },
}));

vi.mock("../composables/useFileViewer", () => ({
  useFileViewer: () => ({ openAndScrollTo }),
}));

import SearchPanel from "./SearchPanel.vue";
import { api } from "../api";
import { useFileViewer } from "../composables/useFileViewer";

const EMPTY = { files: [], total: 0, truncated: false };

function group(file: string, line = 1, lineText = "const foo = 1;") {
  return {
    file,
    matches: [{ file, line, column: 7, lineText, matchStart: 6, matchEnd: 9 }],
  };
}

describe("SearchPanel 搜索模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("渲染输入框与选项行", () => {
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    expect(wrapper.find("input.search-input").exists()).toBe(true);
    expect(wrapper.find("input.mask-input").exists()).toBe(true);
    expect(wrapper.text()).toContain("正则");
  });

  it("防抖 300ms 后调用 searchInFiles", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue(EMPTY);
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    expect(api.searchInFiles).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(api.searchInFiles).toHaveBeenCalledWith(
      "foo",
      "/ws",
      expect.objectContaining({ useRegex: false, caseSensitive: false, wholeWord: false, fileMask: null, limit: 500 }),
    );
  });

  it("竞态：旧请求返回时被丢弃", async () => {
    vi.useFakeTimers();
    let resolveFirst: (v: unknown) => void = () => {};
    const first = new Promise((r) => { resolveFirst = r; });
    (api.searchInFiles as any)
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ files: [group("new.ts")], total: 1, truncated: false });
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    await wrapper.find("input.search-input").setValue("foobar");
    vi.advanceTimersByTime(300);
    await flushPromises();
    // 旧请求（seq=1）现在才返回，应被丢弃——UI 只显示新请求（seq=2）的 new.ts
    resolveFirst({ files: [group("old.ts")], total: 1, truncated: false });
    await flushPromises();
    expect(wrapper.text()).toContain("new.ts");
    expect(wrapper.text()).not.toContain("old.ts");
  });

  it("渲染分组结果，点击匹配行跳转文件", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue({
      files: [group("src/a.ts"), group("src/b.vue", 3, "foo bar")],
      total: 2,
      truncated: false,
    });
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.text()).toContain("src/a.ts");
    expect(wrapper.text()).toContain("src/b.vue");
    await wrapper.findAll(".match-row")[0].trigger("click");
    const viewer = useFileViewer();
    expect(viewer.openAndScrollTo).toHaveBeenCalledWith("/ws/src/a.ts", 1);
  });

  it("api 报错（非法正则）显示错误行", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockRejectedValue("正则无效: ...");
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("(");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.find(".error-line").exists()).toBe(true);
  });

  it("空查询清空结果", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue({ files: [group("a.ts")], total: 1, truncated: false });
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.text()).toContain("a.ts");
    await wrapper.find("input.search-input").setValue("");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.text()).not.toContain("a.ts");
  });
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `pnpm vitest run src/components/SearchPanel.test.ts`
Expected: 失败（组件不存在 / 找不到模块）。

- [ ] **Step 3: 实现 SearchPanel.vue（搜索模式）**

创建 `src/components/SearchPanel.vue`：

```vue
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { api } from "../api";
import type { SearchMatch, SearchOptions, SearchResponse } from "../types";
import { useFileViewer } from "../composables/useFileViewer";

const props = defineProps<{
  workspacePath: string;
}>();

const query = ref("");
const useRegex = ref(false);
const caseSensitive = ref(false);
const wholeWord = ref(false);
const fileMask = ref("");
const searching = ref(false);
const error = ref("");
const result = ref<SearchResponse | null>(null);
const expanded = ref<Set<string>>(new Set());

let seq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const options = computed<SearchOptions>(() => ({
  useRegex: useRegex.value,
  caseSensitive: caseSensitive.value,
  wholeWord: wholeWord.value,
  fileMask: fileMask.value.trim() || null,
  limit: 500,
}));

watch([query, useRegex, caseSensitive, wholeWord, fileMask], () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 300);
});

async function runSearch() {
  const mySeq = ++seq;
  const q = query.value.trim();
  if (!q) {
    result.value = null;
    error.value = "";
    return;
  }
  searching.value = true;
  error.value = "";
  try {
    const res = await api.searchInFiles(q, props.workspacePath, options.value);
    if (mySeq !== seq) return; // 竞态：丢弃过期结果
    result.value = res;
    expanded.value = new Set(res.files.map((g) => g.file)); // 新结果默认全展开（IDEA 习惯）
  } catch (e) {
    if (mySeq !== seq) return;
    error.value = String(e);
    result.value = null;
  } finally {
    if (mySeq === seq) searching.value = false;
  }
}

/** 相对路径 + 工作区根 → 绝对路径（Windows 盘符路径用 / 拼接，Rust 侧可吃） */
function joinPath(base: string, rel: string): string {
  return base.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + rel.replace(/\\/g, "/");
}

/** byte 偏移 → UTF-16 索引（Rust 返回 byte 偏移，JS 字符串是 UTF-16，CJK 需转换） */
function byteToUtf16(s: string, byteOffset: number): number {
  const enc = new TextEncoder();
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    if (bytes >= byteOffset) return i;
    bytes += enc.encode(s[i]).length;
  }
  return s.length;
}

function highlight(m: SearchMatch): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const start = byteToUtf16(m.lineText, m.matchStart);
  const end = byteToUtf16(m.lineText, m.matchEnd);
  return (
    esc(m.lineText.slice(0, start)) +
    "<mark>" + esc(m.lineText.slice(start, end)) + "</mark>" +
    esc(m.lineText.slice(end))
  );
}

function onMatchClick(m: SearchMatch) {
  const viewer = useFileViewer();
  viewer.openAndScrollTo(joinPath(props.workspacePath, m.file), m.line);
}

function toggleGroup(file: string) {
  const s = new Set(expanded.value);
  if (s.has(file)) s.delete(file);
  else s.add(file);
  expanded.value = s;
}
</script>

<template>
  <div class="search-panel">
    <div class="search-input-row">
      <input v-model="query" class="search-input" placeholder="搜索工作区…" spellcheck="false" />
      <button v-if="query" class="clear-btn" @click="query = ''">×</button>
    </div>
    <div class="option-row">
      <label class="opt"><input type="checkbox" v-model="useRegex" /> 正则</label>
      <label class="opt"><input type="checkbox" v-model="caseSensitive" /> Aa</label>
      <label class="opt"><input type="checkbox" v-model="wholeWord" /> 全词</label>
      <input v-model="fileMask" class="mask-input" placeholder="掩码 *.ts,*.vue" spellcheck="false" />
    </div>
    <div v-if="error" class="error-line">{{ error }}</div>
    <div v-if="searching" class="status-line">搜索中…</div>
    <div v-else-if="result && result.total === 0" class="status-line">无结果</div>
    <div v-else-if="result" class="result-list">
      <div v-for="g in result.files" :key="g.file" class="file-group">
        <div class="file-head" @click="toggleGroup(g.file)">
          <span class="chevron">{{ expanded.has(g.file) ? "▾" : "▸" }}</span>
          <span class="file-name">{{ g.file }}</span>
          <span class="file-count">{{ g.matches.length }}</span>
        </div>
        <div v-if="expanded.has(g.file)" class="match-list">
          <div v-for="(m, i) in g.matches" :key="i" class="match-row" @click="onMatchClick(m)">
            <span class="line-no">{{ m.line }}</span>
            <span class="line-text" v-html="highlight(m)"></span>
          </div>
        </div>
      </div>
      <div v-if="result.truncated" class="status-line">结果已截断（仅显示前 {{ result.total }} 处）</div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  height: 100%;
  overflow: hidden;
  color: var(--aide-text);
  font-size: 13px;
}
.search-input-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.search-input,
.mask-input,
.replace-input {
  flex: 1;
  min-width: 0;
  background: var(--aide-surface);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius);
  color: var(--aide-text);
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
}
.search-input:focus,
.mask-input:focus,
.replace-input:focus {
  border-color: var(--aide-accent);
}
.clear-btn {
  background: none;
  border: none;
  color: var(--aide-text-dim);
  cursor: pointer;
  font-size: 14px;
}
.option-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--aide-text-dim);
}
.opt {
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  user-select: none;
}
.mask-input {
  flex: 1;
  min-width: 90px;
  padding: 2px 6px;
  font-size: 12px;
}
.error-line {
  color: var(--aide-danger);
  font-size: 12px;
  word-break: break-all;
}
.status-line {
  color: var(--aide-text-dim);
  font-size: 12px;
  padding: 2px 0;
}
.result-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.file-group {
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius);
  overflow: hidden;
}
.file-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  background: var(--aide-surface);
  user-select: none;
}
.file-head:hover {
  background: var(--aide-surface-hover);
}
.chevron {
  font-size: 14px;
  color: var(--aide-text-dim);
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aide-font-mono);
  font-size: 12px;
}
.file-count {
  color: var(--aide-text-dim);
  font-size: 11px;
}
.match-list {
  border-top: 1px solid var(--aide-border);
}
.match-row {
  display: flex;
  gap: 8px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.match-row:hover {
  background: var(--aide-surface-hover);
}
.line-no {
  color: var(--aide-text-dim);
  font-size: 11px;
  min-width: 28px;
  text-align: right;
  user-select: none;
}
.line-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--aide-font-mono);
  font-size: 12px;
}
.line-text :deep(mark) {
  background: var(--aide-accent);
  color: var(--aide-bg);
  border-radius: 2px;
  padding: 0 1px;
}
</style>
```

注意：`--aide-surface-hover` 是 `ThemeTokens.surfaceHover` 的映射（tokens.ts:14，4 个主题均已实现），可直接使用。

- [ ] **Step 4: 运行测试确认绿灯**

Run: `pnpm vitest run src/components/SearchPanel.test.ts`
Expected: 6 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/SearchPanel.vue src/components/SearchPanel.test.ts
git commit -m "feat(search): SearchPanel 搜索模式——防抖/竞态/分组结果/跳转/高亮"
```

---

### Task 6: SearchPanel.vue 替换模式

**Files:**
- Modify: `src/components/SearchPanel.vue`（模式 toggle + 替换输入 + 预览 + DiffViewer + 应用 + toast）
- Modify: `src/components/SearchPanel.test.ts`（追加替换模式测试）

**Interfaces:**
- Consumes: Task 5 的组件；Task 4 的 `api.replaceInFilesPreview` / `api.applyReplacements`；`DiffViewer`（`src/components/fileviewer/DiffViewer.vue`，props: `pair: DiffPair` / `filePath: string` / `initialMode`）；`useToast()` 的 `showToast(text, kind)` / `toastState`
- Produces（Task 7 依赖）：
  - Props 追加：`initialMode?: "search" | "replace"`（默认 `"search"`）
  - Emits：`"files-changed"`（替换写盘成功后触发，App.vue 刷新文件树）
  - Expose：`focusInput(mode: "search" | "replace")`（切模式 + 聚焦搜索输入框）

- [ ] **Step 1: 写失败测试**

在 `src/components/SearchPanel.test.ts` 追加（`DiffViewer` 用 stub 避免 jsdom 下 CM merge 渲染问题）：

```ts
vi.mock("./fileviewer/DiffViewer.vue", () => ({
  default: { template: "<div class='diff-stub' />" },
}));

describe("SearchPanel 替换模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("initialMode=replace 时显示替换输入区", () => {
    const wrapper = mount(SearchPanel, {
      props: { workspacePath: "/ws", initialMode: "replace" },
    });
    expect(wrapper.find("input.replace-input").exists()).toBe(true);
  });

  it("搜索模式不显示替换输入区", () => {
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    expect(wrapper.find("input.replace-input").exists()).toBe(false);
  });

  it("预览替换调用 api 并渲染 DiffViewer", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue(EMPTY);
    (api.replaceInFilesPreview as any).mockResolvedValue({
      files: [{ file: "src/a.ts", original: "foo\n", replaced: "bar\n", matchCount: 1 }],
      totalMatches: 1,
      truncated: false,
    });
    const wrapper = mount(SearchPanel, {
      props: { workspacePath: "/ws", initialMode: "replace" },
    });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    await wrapper.find("input.replace-input").setValue("bar");
    await wrapper.find("button.preview-btn").trigger("click");
    await flushPromises();
    expect(api.replaceInFilesPreview).toHaveBeenCalledWith(
      "foo",
      "bar",
      "/ws",
      expect.objectContaining({ useRegex: false }),
    );
    expect(wrapper.find(".diff-stub").exists()).toBe(true);
  });

  it("全部应用调用 api 并 emit files-changed", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue(EMPTY);
    (api.replaceInFilesPreview as any).mockResolvedValue({
      files: [{ file: "src/a.ts", original: "foo\n", replaced: "bar\n", matchCount: 1 }],
      totalMatches: 1,
      truncated: false,
    });
    (api.applyReplacements as any).mockResolvedValue({ succeeded: ["/ws/src/a.ts"], failed: [] });
    const wrapper = mount(SearchPanel, {
      props: { workspacePath: "/ws", initialMode: "replace" },
    });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    await wrapper.find("input.replace-input").setValue("bar");
    await wrapper.find("button.preview-btn").trigger("click");
    await flushPromises();
    await wrapper.find("button.apply-all-btn").trigger("click");
    await flushPromises();
    expect(api.applyReplacements).toHaveBeenCalledWith([
      { path: "/ws/src/a.ts", content: "bar\n" },
    ]);
    expect(wrapper.emitted("files-changed")).toBeTruthy();
  });

  it("应用部分失败时 toast 提示 danger", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue(EMPTY);
    (api.replaceInFilesPreview as any).mockResolvedValue({
      files: [{ file: "src/a.ts", original: "foo\n", replaced: "bar\n", matchCount: 1 }],
      totalMatches: 1,
      truncated: false,
    });
    (api.applyReplacements as any).mockResolvedValue({
      succeeded: [],
      failed: [["/ws/src/a.ts", "写入失败: 权限"]],
    });
    const wrapper = mount(SearchPanel, {
      props: { workspacePath: "/ws", initialMode: "replace" },
    });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    await wrapper.find("input.replace-input").setValue("bar");
    await wrapper.find("button.preview-btn").trigger("click");
    await flushPromises();
    await wrapper.find("button.apply-all-btn").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("失败");
  });
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `pnpm vitest run src/components/SearchPanel.test.ts`
Expected: 新追加的 5 个测试失败（组件无 replace-input / preview-btn / apply-all-btn）。

- [ ] **Step 3: 实现替换模式**

修改 `src/components/SearchPanel.vue`：

1. **script 部分**：`defineProps` 加 `initialMode`；追加 import 与状态：

```ts
import DiffViewer from "./fileviewer/DiffViewer.vue";
import AToast from "../ui/AToast.vue";
import { useToast } from "../composables/useToast";
import type { ApplyResult, ReplacePreviewResponse } from "../types";

const props = withDefaults(
  defineProps<{
    workspacePath: string;
    initialMode?: "search" | "replace";
  }>(),
  { initialMode: "search" },
);

const emit = defineEmits<{ "files-changed": [] }>();

const mode = ref<"search" | "replace">(props.initialMode);
const replaceWith = ref("");
const previewing = ref(false);
const preview = ref<ReplacePreviewResponse | null>(null);
const previewError = ref("");
const applying = ref(false);
const applyResult = ref<ApplyResult | null>(null);
const activePreviewFile = ref<string | null>(null);
const queryInput = ref<HTMLInputElement | null>(null);

const { toastState, showToast } = useToast();

function switchMode(m: "search" | "replace") {
  mode.value = m;
}

async function runPreview() {
  const q = query.value.trim();
  if (!q) return;
  previewing.value = true;
  previewError.value = "";
  preview.value = null;
  applyResult.value = null;
  activePreviewFile.value = null;
  try {
    preview.value = await api.replaceInFilesPreview(
      q,
      replaceWith.value,
      props.workspacePath,
      options.value,
    );
  } catch (e) {
    previewError.value = String(e);
  } finally {
    previewing.value = false;
  }
}

function activePreview() {
  return preview.value?.files.find((f) => f.file === activePreviewFile.value) ?? null;
}

async function applyAll() {
  if (!preview.value) return;
  applying.value = true;
  try {
    const files = preview.value.files.map((f) => ({
      path: joinPath(props.workspacePath, f.file),
      content: f.replaced,
    }));
    applyResult.value = await api.applyReplacements(files);
    const ok = applyResult.value.succeeded.length;
    const fail = applyResult.value.failed.length;
    if (fail === 0) {
      showToast(`已替换 ${ok} 个文件`, "success");
    } else {
      showToast(`替换完成：${ok} 成功，${fail} 失败`, "danger");
    }
    emit("files-changed");
  } finally {
    applying.value = false;
  }
}

defineExpose({
  focusInput(m: "search" | "replace") {
    mode.value = m;
    queryInput.value?.focus();
  },
});
```

2. **template 部分**：在 option-row 之后加模式 toggle 行，替换输入区与预览区：

```html
    <div class="mode-row">
      <button class="mode-btn" :class="{ active: mode === 'search' }" @click="switchMode('search')">查找</button>
      <button class="mode-btn" :class="{ active: mode === 'replace' }" @click="switchMode('replace')">替换</button>
    </div>
    <div v-if="mode === 'replace'" class="replace-row">
      <input v-model="replaceWith" class="replace-input" placeholder="替换为…" spellcheck="false" />
      <button class="preview-btn" :disabled="!query.trim() || previewing" @click="runPreview">
        {{ previewing ? "预览中…" : "预览替换" }}
      </button>
    </div>
    <div v-if="previewError" class="error-line">{{ previewError }}</div>
    <div v-if="preview" class="preview-area">
      <div class="preview-file-list">
        <div
          v-for="f in preview.files"
          :key="f.file"
          class="preview-file-row"
          :class="{ active: activePreviewFile === f.file }"
          @click="activePreviewFile = f.file"
        >
          <span class="file-name">{{ f.file }}</span>
          <span class="file-count">{{ f.matchCount }} 处</span>
        </div>
      </div>
      <div v-if="activePreview()" class="preview-diff">
        <DiffViewer
          :pair="{
            oldText: activePreview()!.original,
            newText: activePreview()!.replaced,
            oldLabel: '原',
            newLabel: '替换后',
            status: 'modified',
            isBinary: false,
            eolOnly: false,
            tooBig: false,
          }"
          :file-path="activePreview()!.file"
          initial-mode="unified"
        />
      </div>
      <div v-if="preview.truncated" class="status-line">预览已截断（仅前 {{ preview.files.length }} 个文件）</div>
      <div class="preview-actions">
        <button class="apply-all-btn" :disabled="applying" @click="applyAll">
          {{ applying ? "应用中…" : `全部应用（${preview.files.length} 个文件）` }}
        </button>
      </div>
    </div>
    <AToast :state="toastState" />
```

3. **style 部分**追加（全部 `var(--aide-*)`）：

```css
.mode-row {
  display: flex;
  gap: 4px;
}
.mode-btn {
  flex: 1;
  background: var(--aide-surface);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius);
  color: var(--aide-text-dim);
  padding: 3px 0;
  font-size: 12px;
  cursor: pointer;
}
.mode-btn.active {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}
.replace-row {
  display: flex;
  gap: 6px;
}
.preview-btn,
.apply-all-btn {
  background: var(--aide-accent);
  border: none;
  border-radius: var(--aide-radius);
  color: var(--aide-bg);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.preview-btn:disabled,
.apply-all-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.preview-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius);
  padding: 6px;
  overflow: hidden;
}
.preview-file-list {
  max-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.preview-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: var(--aide-radius);
  cursor: pointer;
  user-select: none;
}
.preview-file-row:hover {
  background: var(--aide-surface-hover);
}
.preview-file-row.active {
  background: var(--aide-surface-hover);
  color: var(--aide-accent);
}
.preview-diff {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.preview-actions {
  display: flex;
  justify-content: flex-end;
}
```

4. **搜索输入框加 ref**：`<input v-model="query" ref="queryInput" class="search-input" ... />`

- [ ] **Step 4: 运行测试确认绿灯**

Run: `pnpm vitest run src/components/SearchPanel.test.ts`
Expected: 11 个测试（6 搜索 + 5 替换）全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/SearchPanel.vue src/components/SearchPanel.test.ts
git commit -m "feat(search): SearchPanel 替换模式——diff 预览 + 全部应用 + toast + files-changed"
```

---

### Task 7: App.vue 接线（tab + 快捷键 + 文件树刷新）

**Files:**
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: Task 6 的 `SearchPanel`（props `workspacePath` / `initialMode`，emit `files-changed`，expose `focusInput`）；`fileTreeRef.loadRoot()`（FileTree.vue:397 defineExpose）；`workspacePath` ref（App.vue:763 附近）；`rightCollapsed` / `rightTab` / `onRailSelect`（App.vue:62/371）

- [ ] **Step 1: 加 import 与 ref**

`src/App.vue` script 部分：

```ts
import SearchPanel from "./components/SearchPanel.vue";
```

`rightTab` 联合类型加 `"search"`（约 62 行）：

```ts
const rightTab = ref<"files" | "changes" | "git" | "search">("files");
```

`fileTreeRef` 附近加：

```ts
const searchPanelRef = ref<InstanceType<typeof SearchPanel> | null>(null);
```

- [ ] **Step 2: 加 tab 图标与注册**

`tabIconGit` 定义后加（放大镜，与现有 tabIcon* 同款 24x24 stroke 风格）：

```ts
const tabIconSearch = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
```

`rightTabs` computed 加一项：

```ts
const rightTabs = computed<Tab[]>(() => [
  { id: "files", icon: tabIconFiles },
  { id: "changes", icon: tabIconChanges, badge: changeCount.value || undefined },
  { id: "git", icon: tabIconGit, badge: unstagedFiles.value.length || undefined },
  { id: "search", icon: tabIconSearch },
]);
```

- [ ] **Step 3: 加快捷键与打开函数**

`handleKeydown` 里 Ctrl+Shift+D 诊断块之后加（IDEA 语义：Ctrl+Shift+F 只搜索、Ctrl+Shift+R 搜索+替换）：

```ts
  // Ctrl+Shift+F：全局搜索（只查找）；Ctrl+Shift+R：全局搜索+替换（IDEA 语义）
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyF" || e.key === "F")) {
    e.preventDefault();
    e.stopPropagation();
    openSearchPanel("search");
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyR" || e.key === "R")) {
    e.preventDefault();
    e.stopPropagation();
    openSearchPanel("replace");
    return;
  }
```

`onRailSelect` 附近加：

```ts
/** 快捷键打开搜索面板：展开右侧 + 切到 search tab + 预选模式并聚焦输入框。
 *  面板已打开时重复按快捷键 = 聚焦输入框（IDEA 行为）。 */
function openSearchPanel(mode: "search" | "replace") {
  if (rightCollapsed.value) {
    rightTab.value = "search";
    rightCollapsed.value = false;
  } else if (rightTab.value !== "search") {
    rightTab.value = "search";
  }
  searchPanelRef.value?.focusInput(mode);
}

function onSearchFilesChanged() {
  fileTreeRef.value?.loadRoot();
}
```

- [ ] **Step 4: 模板加 SearchPanel**

`panel-right-inner` 里 GitPanel 之后加：

```html
            <SearchPanel
              v-show="rightTab === 'search'"
              :workspace-path="workspacePath"
              ref="searchPanelRef"
              @files-changed="onSearchFilesChanged"
            />
```

- [ ] **Step 5: 类型检查 + 全量前端测试**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

Run: `pnpm vitest run`
Expected: 全部既有测试 + SearchPanel 测试 PASS。

- [ ] **Step 6: 手动验证（tauri dev）**

Run: `pnpm tauri dev`（Rust 侧已改，需重新编译；前端 HMR 生效）

手动清单：
1. Ctrl+Shift+F → 右侧面板展开并切到搜索 tab，搜索模式（无替换输入区），输入框聚焦
2. 输入 `foo` → 结果按文件分组出现，命中片段高亮
3. 点击匹配行 → 文件查看器打开并定位到该行
4. 勾选「正则」输入 `f.o` → 结果变化；勾选「Aa」→ 大小写敏感；勾选「全词」→ `foo` 不再匹配 `foobar`；掩码输入 `*.ts` → 只搜 .ts
5. Ctrl+Shift+R → 替换模式（替换输入区出现），搜索词保留
6. 输入替换词 → 「预览替换」→ 文件列表 + diff 预览（原/替换后）
7. 「全部应用」→ toast「已替换 N 个文件」+ 文件树刷新
8. 面板已打开时再按 Ctrl+Shift+F → 输入框聚焦
9. 输入非法正则（如 `(`）→ 错误行红字提示，不崩溃

- [ ] **Step 7: 提交**

```bash
git add src/App.vue
git commit -m "feat(search): 右侧搜索 tab + Ctrl+Shift+F/R 快捷键 + 替换后刷新文件树"
```

---

## 自检记录

- **Spec 覆盖**：§4.1 search_in_files → Task 1+3；§4.2 replace_in_files_preview → Task 2+3；§4.3 apply_replacements → Task 2+3；§5.1 布局 → Task 5/6；§5.2 搜索模式（防抖/竞态/分组/跳转/状态）→ Task 5；§5.3 替换模式（预览/确认/toast/刷新）→ Task 6；§5.4 接线（tab/快捷键/模式预选/重复按聚焦）→ Task 7；§7 错误处理 → 各任务测试覆盖；§8 测试 → 各任务。
- **占位符扫描**：无 TBD/TODO；每个代码步骤都有完整代码。
- **类型一致性**：`SearchOptions`/`SearchResponse`/`ReplacePreviewResponse`/`ReplaceFileInput`/`ApplyResult` 在 Rust（camelCase serde）与 TS 两侧字段名一致；`focusInput(mode)` / `files-changed` / `workspacePath` / `initialMode` 在 Task 6 定义、Task 7 消费，签名一致。
- **已知偏差**：spec §4.1 写「file 绝对路径」，实施改为**相对路径**（与 GrepMatch 约定一致），前端 `joinPath` 拼接——已在 Global Constraints 注明。
