//! 工作区的语言探测（LSP 服务归属 / 代表文件 / 有界遍历）。
//!
//! 从桌面 `src-tauri/src/lsp/detector.rs` 迁来（2026-09-29，远程工作区 LSP）：探测必须能
//! 在**目标机**上跑——SSH 工作区的文件桌面根本摸不到，WSL 的走 9P 也慢——所以和 fs / 搜索 /
//! git 一样住进 Tauri 无关的 aide-workspace，桌面与 aide-host 共用这一份。桌面旧路径
//! `crate::lsp::detector` 留 re-export 壳。

use std::path::Path;

/// LSP 能服务的语言 —— 即**服务归属**：谁给这些文件提供 LSP。
/// 新增语言时加 variant + from_ext/server_binary/probe_exts 映射。
///
/// **文档形态不是语言**：`.vue` 归 TypeScript（由 TS 服务器的 `@vue/typescript-plugin`
/// 覆盖），`.tsx`/`.jsx` 同理。独立的 `vue` id 已退役——`vue-language-server` 是**需要
/// 客户端桥接的 proxy**，宿主不桥接就一条请求都不答（2026-09-19 实测，见 `vue_plugin.rs`
/// 抬头）。didOpen 帧里该发哪个 languageId 是**另一件事**，见 `document_lang_id`。
/// `LanguageId::from_ext` 的定义域（全部认得的源码扩展名）。给 agent 文本兜底做掩码用；
/// 与 `from_ext` 的对账由测试 `known_source_exts_is_the_from_ext_domain` 钉住。
pub const KNOWN_SOURCE_EXTS: [&str; 22] = [
    "rs", "ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "vue", "go", "java", "kt", "kts",
    "py", "pyi", "dart", "cs", "rb", "php", "ex", "exs",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LanguageId {
    Rust,
    TypeScript,
    JavaScript,
    Go,
    Java,
    Python,
    Dart,
    CSharp,
    Ruby,
    Php,
    Elixir,
    Kotlin,
}

impl LanguageId {
    /// 文件扩展名 → 服务归属（谁给这个文件提供 LSP）。小写。
    pub fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" | "tsx" => Some(Self::TypeScript),
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            // .vue 由 TS 服务器 + Vue 插件服务（插件声明 languages:["vue"]，见 profiles/ts.rs）
            "vue" => Some(Self::TypeScript),
            "go" => Some(Self::Go),
            "java" => Some(Self::Java),
            "kt" | "kts" => Some(Self::Kotlin),
            "py" | "pyi" => Some(Self::Python),
            "dart" => Some(Self::Dart),
            "cs" => Some(Self::CSharp),
            "rb" => Some(Self::Ruby),
            "php" => Some(Self::Php),
            "ex" | "exs" => Some(Self::Elixir),
            _ => None,
        }
    }

    /// 服务 id：IPC 字符串、`settings.lsp.servers` 的键、面板行的键。
    pub fn id_str(&self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Go => "go",
            Self::Java => "java",
            Self::Kotlin => "kotlin",
            Self::Python => "python",
            Self::Dart => "dart",
            Self::CSharp => "csharp",
            Self::Ruby => "ruby",
            Self::Php => "php",
            Self::Elixir => "elixir",
        }
    }

    /// 默认 server 二进制名（registry 的 which 兜底用）。None = v1 不捆绑也不 PATH 发现。
    pub fn server_binary(&self) -> Option<&'static str> {
        match self {
            Self::Rust => Some("rust-analyzer"),
            Self::TypeScript | Self::JavaScript => Some("typescript-language-server"),
            Self::Go => Some("gopls"),
            Self::Python => Some("pyright-langserver"),
            Self::Java => Some("jdtls"),
            Self::Kotlin => Some("kotlin-language-server"),
            Self::Dart => Some("dart"),
            Self::Ruby => Some("solargraph"),
            Self::Php => Some("intelephense"),
            Self::Elixir => Some("elixir-ls"),
            Self::CSharp => Some("omnisharp"),
        }
    }

    /// **server 原生可解析**的源文件扩展名。靶子搜索与代表文件共用；
    /// 工作区源码语言由 `from_ext` 认领，不能把服务归属与原生探针资格混为一谈。
    ///
    /// `.vue` 不在这里：它要靠 `@vue/typescript-plugin` 才有服务，且 TLS 对它的
    /// `documentSymbol` 恒空（2026-09-19 实测 30 次 / 150s 零条，见
    /// docs/superpowers/spikes/2026-09-19-lsp-agent-tools §5）——递它当靶子 = 探不准。
    /// 它属于哪门语言是**服务分派**的事，见 `from_ext`；两者的一致性由
    /// `probe_exts_reconcile_with_from_ext` 对账。
    fn probe_exts(&self) -> &'static [&'static str] {
        match self {
            Self::Rust => &["rs"],
            Self::TypeScript => &["ts", "mts", "cts", "tsx"],
            Self::JavaScript => &["js", "mjs", "cjs", "jsx"],
            Self::Go => &["go"],
            Self::Java => &["java"],
            Self::Kotlin => &["kt", "kts"],
            Self::Python => &["py", "pyi"],
            Self::Dart => &["dart"],
            Self::CSharp => &["cs"],
            Self::Ruby => &["rb"],
            Self::Php => &["php"],
            Self::Elixir => &["ex", "exs"],
        }
    }
}

/// didOpen 帧里的 languageId：由**文件形态**决定，不由服务归属决定。
///
/// TLS 按它决定收不收这份文档、按什么 scriptKind 解析（2026-09-19 spike §2/§5）：
/// - `.vue` → `"vue"`：TS 服务器的 init_options 给插件声明了 `languages:["vue"]`，TLS 的
///   modeIds 才认这个 id；插件不在场 → TLS `return false` **静默丢弃**该文档（安全降级：
///   绝不会拿 TS 语法去解析 SFC、报一堆假错）。
/// - `.tsx`/`.jsx` → `"typescriptreact"`/`"javascriptreact"`：TLS 只把这两个 id 映到
///   TSX/JSX scriptKind；发 `"typescript"` 会按 TS 解析，JSX 语法全红。
/// - 其余 → 服务 id。扩展名不认识时退回 `lang`（调用方已经解析过它）。
pub fn document_lang_id(file_path: &str, lang: LanguageId) -> &'static str {
    match file_path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("vue") => "vue",
        Some("tsx") => "typescriptreact",
        Some("jsx") => "javascriptreact",
        _ => lang.id_str(),
    }
}

/// 有界遍历跳过的目录名（顶层与下钻**共用一份**：顶层的 `node_modules/` 与
/// `src/node_modules/` 一样不该当靶子，`target/` 那种上百 GB 的更不该走进去）。
/// 点目录（`.git`/`.idea`/`.gradle`/`.next`/`.nuxt`/`.vscode`）由 `starts_with('.')` 一并挡掉。
///
/// `coverage`/`__pycache__` 是**生成物**：不挡的话 `coverage/lcov-report/*.js` 会被
/// 当成源码，给纯 TS 工作区多报一个 JavaScript。
/// （`markers::should_skip_dir` 是 marker 腿的那份表，条目更多——两者服务不同
/// 问题：它认「项目住在哪」，这里认「哪些文件算源码」；`bin` 之类不在本表是故意的。点目录
/// 由 `starts_with('.')` 统一挡掉，故 `.aide`/`.next` 无需逐条登记。）
/// `pub`：桌面 `lsp::vue_plugin` 的子目录扫描共用同一份跳过表（纪律只有一份）。
pub fn is_skip_dir(name: &str) -> bool {
    const SKIP: [&str; 9] = [
        "node_modules",
        "target",
        "dist",
        "build",
        ".venv",
        "vendor",
        "out",
        "coverage",
        "__pycache__",
    ];
    name.starts_with('.') || SKIP.contains(&name)
}

/// 有界遍历：把目录树里的**源文件**交给 `visit`（路径 / 小写扩展名 / 服务归属）；
/// `visit` 返回 `false` 提前收工。
///
/// 靶子搜索与代表文件排名共用遍历；工作区报告复用同一跳目录与源码判据。
///
/// 深度两档：工作区报告 / 按扩展名查找 ≤ [`SOURCE_DEPTH`]；**找靶子 / 代表文件**
/// ≤ [`TARGET_DEPTH`]。曾经共用 4 层：Maven / Gradle 的 Java 源码天然在
/// `src/main/java/<包路径>/` 下（po-api 最浅的 `.java` 在第 7 层），于是 Java 工程永远找不到
/// 代表文件，就绪探针一次都没跑过（2026-10-15 真机）。计数不受影响：Java 靠 `pom.xml` 标记认出。
///
/// 测试文件不当靶子**也不计数**：工程配置十有八九把它们排除在外（本仓库 `tsconfig.json`
/// 的 exclude 排 `src/**/*.test.ts`），递一个不属于任何工程的孤文件 = 工程没加载
/// （真机上栽过两次）。
const SOURCE_DEPTH: usize = 4;
const TARGET_DEPTH: usize = 12;

fn walk_sources(root: &Path, visit: impl FnMut(&Path, &str, LanguageId) -> bool) {
    walk_sources_to(root, SOURCE_DEPTH, visit)
}

/// 找靶子 / 代表文件用的深遍历。只在「找到第一个就停」或有计数上限的调用方用。
fn walk_targets(root: &Path, visit: impl FnMut(&Path, &str, LanguageId) -> bool) {
    walk_sources_to(root, TARGET_DEPTH, visit)
}

fn walk_sources_to(root: &Path, max_depth: usize, mut visit: impl FnMut(&Path, &str, LanguageId) -> bool) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if depth < max_depth && !is_skip_dir(&name) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some((ext, lang)) = source_language(&path, &name) else {
                continue;
            };
            if !visit(&path, &ext, lang) {
                return;
            }
        }
    }
}

/// 探针靶子判据：server **原生**能解析的形态（见 `probe_exts`）。`.vue` 这种要靠插件的
/// 不算——递它当靶子探不准（documentSymbol 恒空）。
fn is_probe_target(ext: &str, lang: LanguageId) -> bool {
    lang.probe_exts().contains(&ext)
}

/// **每个顶层目录各取一个**该语言的源文件（根自身排最后），最多 `max` 个。
///
/// 为什么不是「全仓取第一个」（2026-09-19 实测）：工程是**按文件归属**加载的。本仓库根层的
/// `vite.config.ts` 属于 `tsconfig.node.json`（只含它一个文件）——先打开它，加载的就是那个
/// 只有一个文件的工程，`workspace/symbol` 永远看不见 `src/` 里的符号（**20s 重试也没用**）；
/// 而打开 `src/` 下任意一个文件，主工程才会加载。代表文件必须按目录摊开，不能撞上谁算谁。
///
/// 取哪几个目录：**按该语言的文件数排序取前 `max` 个**，不是 readdir 撞上谁算谁。
/// 真实一跑就证明了前者是撞运气：本仓库按 readdir 顺序取到的前四个是
/// `agent-sidecar / docs / ohos / packages`——**主工程在 `src/`，一个都没沾上**。
/// 「代码最多的地方」是语言无关且稳定的判据，正好对应「工程住在哪」。
pub fn representative_sources(
    root: &Path,
    lang: LanguageId,
    max: usize,
) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<(usize, std::path::PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            if !p.is_dir() || is_skip_dir(&name) {
                continue;
            }
            let (count, first) = count_and_first(&p, lang);
            if let Some(f) = first {
                dirs.push((count, f));
            }
        }
    }
    // 多的在前；同数按路径定序，免得结果随 readdir 抖动。
    dirs.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut out: Vec<std::path::PathBuf> = dirs.into_iter().take(max).map(|(_, f)| f).collect();
    // 根自身兜底（单目录项目 / 源码就在根层）——放最后：根层文件常常属于边角工程。
    if let Some(f) = find_probe_target(root, lang) {
        if out.len() < max && !out.contains(&f) {
            out.push(f);
        }
    }
    out
}

/// 名字像测试的文件（各语言通行的那几种写法）。见 `count_and_first` 里的用法。
fn is_test_file(name: &str) -> bool {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    [".test", ".spec", "_test", "_spec"]
        .iter()
        .any(|suffix| stem.ends_with(suffix))
}

/// 报告与文件遍历共用源码判据；服务归属不要求这个文件能充当原生探针。
fn source_language(path: &Path, name: &str) -> Option<(String, LanguageId)> {
    if is_test_file(name) {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let lang = LanguageId::from_ext(&ext)?;
    Some((ext, lang))
}

/// 有界遍历一个目录：数该语言的**探针靶子**文件个数，并返回遇到的第一个（当代表）。
/// `COUNT_CAP` 封顶——只为排名，数到够分辨大小就行，不必数完（`target/` 那种目录
/// 本来就被 `is_skip_dir` 挡在外面）。
fn count_and_first(dir: &Path, lang: LanguageId) -> (usize, Option<std::path::PathBuf>) {
    const COUNT_CAP: usize = 5_000;
    let mut count = 0usize;
    let mut first: Option<std::path::PathBuf> = None;
    walk_targets(dir, |path, ext, l| {
        if l != lang || !is_probe_target(ext, lang) {
            return true;
        }
        count += 1;
        if first.is_none() {
            first = Some(path.to_path_buf());
        }
        count < COUNT_CAP
    });
    (count, first)
}

/// 同一次工作区扫描得到的事实。项目推荐只取 project；源码存在不等于项目存在。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LanguageDetection {
    pub project_languages: Vec<LanguageId>,
    pub source_languages: Vec<LanguageId>,
}

impl LanguageDetection {
    /// Agent 查询需要的服务集合；纯投影，不额外扫描文件系统。
    pub fn query_languages(&self) -> Vec<LanguageId> {
        let mut out = self.project_languages.clone();
        for lang in &self.source_languages {
            if !out.contains(lang) {
                out.push(*lang);
            }
        }
        out.sort_by_key(LanguageId::id_str);
        out
    }
}

const DETECTION_DIR_CAP: usize = 2_000;
const DETECTION_SOURCE_CAP: usize = 20_000;

/// 工作区语言事实的唯一探测实现：一次有界下钻，同时收集项目证据与源码服务归属。
/// marker 只匹配当前目录；文件数量不再承担「认领项目」的职责。
pub fn detect_workspace_languages(root: &Path) -> LanguageDetection {
    let mut report = LanguageDetection::default();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut directories = 0;
    let mut sources = 0;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        directories += 1;
        for id in super::markers::project_language_ids(&dir) {
            if let Some(lang) = lang_from_id_str(id) {
                if !report.project_languages.contains(&lang) {
                    report.project_languages.push(lang);
                }
            }
        }
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let mut children = Vec::new();
        for entry in entries {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            // file_type 不跟随符号链接，避免重复扫描和越过工作区边界。
            if kind.is_dir() {
                if depth < SOURCE_DEPTH
                    && !is_skip_dir(&name)
                    && children.len() + stack.len() < DETECTION_DIR_CAP - directories
                {
                    children.push((path, depth + 1));
                }
            } else if kind.is_file() && sources < DETECTION_SOURCE_CAP {
                if let Some((_, lang)) = source_language(&path, &name) {
                    sources += 1;
                    if !report.source_languages.contains(&lang) {
                        report.source_languages.push(lang);
                    }
                }
            }
        }
        if directories >= DETECTION_DIR_CAP {
            break;
        }
        stack.extend(children.into_iter().rev());
    }
    report.project_languages.sort_by_key(LanguageId::id_str);
    report.source_languages.sort_by_key(LanguageId::id_str);
    report
}

/// 所有异步消费者共用此外壳，文件系统 IO 不占 tokio worker。
pub async fn detect_workspace_languages_async(root: std::path::PathBuf) -> LanguageDetection {
    match tokio::task::spawn_blocking(move || detect_workspace_languages(&root)).await {
        Ok(report) => report,
        Err(e) => {
            tracing::warn!("language detection task failed: {e}");
            LanguageDetection::default()
        }
    }
}

/// "rust" → LanguageId::Rust。与 LanguageId::id_str 互逆。
/// **只认服务 id**：文档 languageId（`"vue"`/`"typescriptreact"`，见 `document_lang_id`）
/// 不是服务，走这里一律 None——那些形态的服务归属已经在 `from_ext` 里定死。
pub fn lang_from_id_str(s: &str) -> Option<LanguageId> {
    match s {
        "rust" => Some(LanguageId::Rust),
        "typescript" => Some(LanguageId::TypeScript),
        "javascript" => Some(LanguageId::JavaScript),
        "go" => Some(LanguageId::Go),
        "java" => Some(LanguageId::Java),
        "kotlin" => Some(LanguageId::Kotlin),
        "python" => Some(LanguageId::Python),
        "dart" => Some(LanguageId::Dart),
        "csharp" => Some(LanguageId::CSharp),
        "ruby" => Some(LanguageId::Ruby),
        "php" => Some(LanguageId::Php),
        "elixir" => Some(LanguageId::Elixir),
        _ => None,
    }
}

/// 在工作区里找一个该语言的**探针靶子**文件（server 原生可解析的形态，`.vue` 不算）。
/// **有界**：深度 ≤4、跳过重目录、点目录不下钻——它服务的场景是「要一个磁盘上真实存在、
/// 递得出去的靶子文件」（就绪探测），不是「找全」。
///
/// 同步（`fs::read_dir` 循环）：重场景的调用方（`agent_query::first_source_file`）自己
/// 放进 `spawn_blocking`。
fn find_probe_target(root: &Path, lang: LanguageId) -> Option<std::path::PathBuf> {
    let mut found = None;
    walk_targets(root, |path, ext, l| {
        if l == lang && is_probe_target(ext, lang) {
            found = Some(path.to_path_buf());
            return false;
        }
        true
    });
    found
}

/// 按**扩展名**找源文件（不看服务归属）：插件门用——`vue_plugin::has_vue_files` 问的是
/// 「这工作区有没有 `.vue` 文件」，与「`.vue` 归哪门语言」是两件事（后者见 `from_ext`）。
pub fn find_source_with_ext(root: &Path, want: &str) -> Option<std::path::PathBuf> {
    let mut found = None;
    walk_sources(root, |path, ext, _lang| {
        if ext == want {
            found = Some(path.to_path_buf());
            return false;
        }
        true
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aide_lsp_det_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tauri_yields_rust_and_ts() {
        let d = tmp_dir("tauri");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        let langs = detect_workspace_languages(&d).query_languages();
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        assert!(langs.contains(&LanguageId::TypeScript), "{:?}", langs);
        // 没有 "vue" 这门语言了：.vue 归 TS（服务），由 TS 服务器的插件覆盖。
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cargo_yields_rust() {
        let d = tmp_dir("cargo");
        fs::write(d.join("Cargo.toml"), "").unwrap();
        let langs = detect_workspace_languages(&d).query_languages();
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn node_yields_ts_js() {
        let d = tmp_dir("node");
        fs::write(d.join("package.json"), "{}").unwrap();
        let langs = detect_workspace_languages(&d).query_languages();
        // Node 探测器声明 typescript+javascript
        assert!(
            langs.contains(&LanguageId::TypeScript) || langs.contains(&LanguageId::JavaScript),
            "{:?}",
            langs
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn go_yields_go() {
        let d = tmp_dir("go");
        fs::write(d.join("go.mod"), "module x").unwrap();
        let langs = detect_workspace_languages(&d).query_languages();
        assert!(langs.contains(&LanguageId::Go), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn spring_boot_yields_java() {
        let d = tmp_dir("spring");
        fs::write(
            d.join("pom.xml"),
            "<project><artifactId>a</artifactId></project>",
        )
        .unwrap();
        let langs = detect_workspace_languages(&d).query_languages();
        // 任何 pom.xml → Java（SpringBootMaven 或 JavaMaven 探测器）
        assert!(langs.contains(&LanguageId::Java), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn project_languages_ignore_auxiliary_sources() {
        let d = tmp_dir("project_aux");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        for dir in ["scripts", "docs/experiments", "helpers"] {
            fs::create_dir_all(d.join(dir)).unwrap();
            for ext in ["py", "rb", "go"] {
                for name in ["a", "b"] {
                    fs::write(d.join(dir).join(format!("{name}.{ext}")), "").unwrap();
                }
            }
        }
        let report = detect_workspace_languages(&d);
        let projects = &report.project_languages;
        assert!(projects.contains(&LanguageId::Rust), "{projects:?}");
        assert!(projects.contains(&LanguageId::TypeScript), "{projects:?}");
        let broad = report.query_languages();
        for lang in [LanguageId::Python, LanguageId::Ruby, LanguageId::Go] {
            assert!(
                !projects.contains(&lang),
                "辅助源码不应推荐为项目：{projects:?}"
            );
            assert!(report.source_languages.contains(&lang), "{report:?}");
            assert!(broad.contains(&lang), "语言发现仍须覆盖辅助源码：{broad:?}");
        }
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn project_languages_require_more_than_source_files() {
        for dir in ["", "scripts", "arbitrary/nested"] {
            let d = tmp_dir(&format!("project_sources_{}", dir.replace('/', "_")));
            let src = d.join(dir);
            fs::create_dir_all(&src).unwrap();
            for ext in KNOWN_SOURCE_EXTS {
                for name in ["a", "b"] {
                    fs::write(src.join(format!("{name}.{ext}")), "").unwrap();
                }
            }
            let report = detect_workspace_languages(&d);
            assert!(report.project_languages.is_empty(), "{dir}");
            assert!(!report.source_languages.is_empty(), "{dir}");
            assert_eq!(LanguageId::from_ext("py"), Some(LanguageId::Python));
            assert!(find_probe_target(&d, LanguageId::Python).is_some());
            fs::remove_dir_all(&d).ok();
        }
    }

    #[test]
    fn project_languages_python_metadata_without_run_entry() {
        for marker in ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"] {
            let d = tmp_dir(&format!("project_python_{marker}"));
            fs::write(d.join(marker), "").unwrap();
            let report = detect_workspace_languages(&d);
            assert_eq!(
                report.project_languages,
                vec![LanguageId::Python],
                "{marker}"
            );
            assert!(
                report.query_languages().contains(&LanguageId::Python),
                "{marker}"
            );
            assert!(
                crate::detect::markers::detect_run_targets(&d).is_empty(),
                "不要伪造运行入口"
            );
            fs::remove_dir_all(&d).ok();
        }
    }

    #[test]
    fn project_languages_python_entry_is_not_project_evidence() {
        let d = tmp_dir("project_python_entry");
        fs::write(d.join("main.py"), "print(1)").unwrap();
        fs::write(d.join("app.py"), "print(2)").unwrap();
        fs::write(d.join("requirements.txt"), "pillow").unwrap();
        let report = detect_workspace_languages(&d);
        assert!(report.project_languages.is_empty());
        assert_eq!(report.source_languages, vec![LanguageId::Python]);
        assert!(!crate::detect::markers::detect_run_targets(&d).is_empty());
        fs::write(d.join("manage.py"), "").unwrap();
        assert_eq!(
            detect_workspace_languages(&d).project_languages,
            vec![LanguageId::Python]
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn project_languages_reach_nested_projects_and_deduplicate() {
        let d = tmp_dir("project_nested");
        for (path, marker) in [
            ("backend", "pom.xml"),
            ("packages/frontend", "package.json"),
            ("services/python", "pyproject.toml"),
            ("scripts/tool", "Pipfile"),
            ("one/two/three/four", "Cargo.toml"),
        ] {
            fs::create_dir_all(d.join(path)).unwrap();
            fs::write(d.join(path).join(marker), "{}").unwrap();
        }
        let report = detect_workspace_languages(&d);
        let langs = &report.project_languages;
        assert_eq!(langs.len(), 5, "{langs:?}");
        let broad = report.query_languages();
        for lang in [
            LanguageId::Java,
            LanguageId::TypeScript,
            LanguageId::JavaScript,
            LanguageId::Python,
            LanguageId::Rust,
        ] {
            assert!(langs.contains(&lang), "{langs:?}");
            assert!(
                broad.contains(&lang),
                "推荐的项目语言也必须能被查询：{broad:?}"
            );
        }
        assert_eq!(detect_workspace_languages(&d), report);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn project_languages_skip_dependencies_generated_dirs_and_excess_depth() {
        let d = tmp_dir("project_skip");
        for dir in [
            "node_modules/pkg",
            "target/debug",
            "dist",
            "build",
            "vendor",
            "out",
            "coverage",
            "__pycache__",
            ".venv",
            ".hidden",
            "one/two/three/four/five",
        ] {
            fs::create_dir_all(d.join(dir)).unwrap();
            fs::write(d.join(dir).join("pyproject.toml"), "").unwrap();
            fs::write(d.join(dir).join("Cargo.toml"), "").unwrap();
        }
        assert!(detect_workspace_languages(&d).project_languages.is_empty());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn real_workspace_project_languages_exclude_helper_scripts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let report = detect_workspace_languages(&root);
        let projects = &report.project_languages;
        for lang in [
            LanguageId::Rust,
            LanguageId::TypeScript,
            LanguageId::JavaScript,
        ] {
            assert!(projects.contains(&lang), "{projects:?}");
        }
        assert!(!projects.contains(&LanguageId::Python), "{projects:?}");
        assert!(report.source_languages.contains(&LanguageId::Python));
        assert!(report.query_languages().contains(&LanguageId::Python));
    }

    #[test]
    fn query_projection_is_a_deduplicated_union_without_io() {
        let report = LanguageDetection {
            project_languages: vec![LanguageId::Rust],
            source_languages: vec![LanguageId::Python, LanguageId::Rust],
        };
        assert_eq!(
            report.query_languages(),
            vec![LanguageId::Python, LanguageId::Rust]
        );
    }

    #[test]
    fn single_source_is_a_file_fact_not_a_project() {
        for (name, lang) in [
            ("helper.py", LanguageId::Python),
            ("main.py", LanguageId::Python),
            ("App.vue", LanguageId::TypeScript),
            ("one.go", LanguageId::Go),
        ] {
            let d = tmp_dir(name);
            fs::write(d.join(name), "").unwrap();
            let report = detect_workspace_languages(&d);
            assert!(report.project_languages.is_empty(), "{name}: {report:?}");
            assert_eq!(report.source_languages, vec![lang], "{name}");
            assert_eq!(report.query_languages(), vec![lang], "{name}");
            fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn report_directory_budget_is_bounded_and_stable() {
        let d = tmp_dir("report_dir_cap");
        for i in 0..DETECTION_DIR_CAP - 1 {
            fs::create_dir(d.join(format!("d{i:04}"))).unwrap();
        }
        fs::create_dir(d.join("zz-project")).unwrap();
        fs::write(d.join("zz-project/go.mod"), "module beyond_budget").unwrap();
        fs::write(d.join("Cargo.toml"), "").unwrap();
        let report = detect_workspace_languages(&d);
        assert_eq!(report.project_languages, vec![LanguageId::Rust]);
        assert_eq!(detect_workspace_languages(&d), report);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn source_budget_does_not_stop_project_discovery() {
        let d = tmp_dir("report_source_cap");
        for i in 0..DETECTION_SOURCE_CAP {
            fs::write(d.join(format!("s{i:05}.py")), "").unwrap();
        }
        fs::write(d.join("z.go"), "package main").unwrap();
        fs::create_dir(d.join("zz-project")).unwrap();
        fs::write(d.join("zz-project/go.mod"), "module after_sources").unwrap();
        let report = detect_workspace_languages(&d);
        assert_eq!(report.source_languages, vec![LanguageId::Python]);
        assert_eq!(report.project_languages, vec![LanguageId::Go]);
        assert_eq!(
            report.query_languages(),
            vec![LanguageId::Go, LanguageId::Python]
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn report_does_not_follow_directory_or_source_symlinks() {
        let d = tmp_dir("report_symlinks");
        fs::create_dir(d.join(".external")).unwrap();
        fs::write(d.join(".external/pyproject.toml"), "").unwrap();
        fs::write(d.join(".external/helper.py"), "").unwrap();
        std::os::unix::fs::symlink(d.join(".external"), d.join("linked_project")).unwrap();
        std::os::unix::fs::symlink(d.join(".external/helper.py"), d.join("linked.py")).unwrap();
        std::os::unix::fs::symlink(&d, d.join("loop")).unwrap();
        assert_eq!(detect_workspace_languages(&d), LanguageDetection::default());
        fs::remove_dir_all(d).unwrap();
    }

    #[tokio::test]
    async fn async_report_uses_the_same_detector() {
        let d = tmp_dir("report_async");
        fs::write(d.join("Cargo.toml"), "").unwrap();
        fs::write(d.join("helper.py"), "").unwrap();
        assert_eq!(
            detect_workspace_languages_async(d.clone()).await,
            detect_workspace_languages(&d)
        );
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn source_languages_without_project_markers() {
        // 源码语言只记录文件事实，不再靠数量阈值认领项目。
        let d = tmp_dir("extfb");
        fs::write(d.join("a.py"), "print(1)").unwrap();
        fs::write(d.join("b.py"), "print(2)").unwrap();
        fs::write(d.join("c.txt"), "x").unwrap(); // 非源码，不计数
        let langs = detect_workspace_languages(&d).query_languages();
        assert!(langs.contains(&LanguageId::Python), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    /// **2026-09-29 agri-ai-agent 实测形状**：仓库根是 Maven（pom.xml），前端在
    /// `frontend/` 子目录（Vite+Vue）。修前只报 Java——两条腿都只认根层。
    #[test]
    fn workspace_report_sees_project_in_subdir() {
        let d = tmp_dir("subdir_project");
        fs::write(
            d.join("pom.xml"),
            "<project><artifactId>a</artifactId></project>",
        )
        .unwrap();
        let fe = d.join("frontend");
        fs::create_dir_all(fe.join("src")).unwrap();
        fs::write(fe.join("package.json"), "{}").unwrap();
        fs::write(fe.join("src/main.ts"), "").unwrap();
        fs::write(fe.join("src/App.vue"), "<template/>").unwrap();

        let langs = detect_workspace_languages(&d).query_languages();
        assert!(langs.contains(&LanguageId::Java), "{langs:?}");
        assert!(
            langs.contains(&LanguageId::TypeScript),
            "子目录里的 Node 项目必须被认领：{langs:?}"
        );
        fs::remove_dir_all(&d).ok();
    }

    /// 生成物目录既不进入报告，也不提供探针靶子。
    #[test]
    fn generated_dirs_are_not_sources() {
        let d = tmp_dir("skipgen");
        let cov = d.join("coverage").join("lcov-report");
        fs::create_dir_all(&cov).unwrap();
        fs::write(cov.join("a.js"), "").unwrap();
        fs::write(cov.join("b.js"), "").unwrap();
        let pycache = d.join("__pycache__");
        fs::create_dir_all(&pycache).unwrap();
        fs::write(pycache.join("x.py"), "").unwrap();

        // 深层靶子遍历与工作区报告分别守住同一跳目录纪律。
        assert!(
            find_probe_target(&d, LanguageId::Python).is_none(),
            "__pycache__ 里不该有靶子"
        );
        assert!(
            find_probe_target(&d, LanguageId::JavaScript).is_none(),
            "coverage 里不该有靶子"
        );
        assert_eq!(detect_workspace_languages(&d), LanguageDetection::default());
        fs::remove_dir_all(&d).ok();
    }

    /// 没有清单的源码子目录只进入源码集合。
    #[test]
    fn workspace_report_sees_sources_in_subdir_without_marker() {
        let d = tmp_dir("subdir_ext");
        let scripts = d.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(scripts.join("a.ts"), "").unwrap();
        fs::write(scripts.join("b.ts"), "").unwrap();
        let report = detect_workspace_languages(&d);
        assert!(report.project_languages.is_empty());
        assert_eq!(report.source_languages, vec![LanguageId::TypeScript]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cross_language_union() {
        // 项目集合与源码集合只在查询投影合并，不能把 Go 源码认成 Go 项目。
        let d = tmp_dir("cross");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        fs::write(d.join("a.go"), "package main").unwrap();
        fs::write(d.join("b.go"), "package main").unwrap();
        let report = detect_workspace_languages(&d);
        assert!(report.project_languages.contains(&LanguageId::Rust));
        assert!(!report.project_languages.contains(&LanguageId::Go));
        assert_eq!(report.source_languages, vec![LanguageId::Go]);
        assert!(report.query_languages().contains(&LanguageId::Rust));
        assert!(report.query_languages().contains(&LanguageId::Go));
        fs::remove_dir_all(&d).ok();
    }

    /// 有界遍历的边界纪律：重目录不下钻（node_modules 里的同语言文件不该被当靶子），
    /// 正常位置的要找得到。**本用例原在 agent_query.rs，随遍历本体一并迁来**——
    /// 边界只留一份实现，测试也跟着走。
    #[test]
    fn find_probe_target_skips_heavy_dirs() {
        let d = tmp_dir("findfile");
        let deep = d.join("node_modules").join("pkg");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("hidden.rs"), "fn x() {}").unwrap();
        assert!(
            find_probe_target(&d, LanguageId::Rust).is_none(),
            "node_modules 里的文件不该当探测靶子"
        );

        fs::write(d.join("real.rs"), "fn y() {}").unwrap();
        let found = find_probe_target(&d, LanguageId::Rust);
        assert!(
            found.as_deref().is_some_and(|f| f.ends_with("real.rs")),
            "got {found:?}"
        );
    }

    /// 代表文件要**按顶层目录摊开**，且重目录不当代表。
    /// 本仓库实测：只递根层的 `vite.config.ts`（属于只含它一个文件的 `tsconfig.node.json`），
    /// `src/` 里的符号按名**永远**查不到（20s 重试也没用）。
    #[test]
    fn representative_sources_reach_maven_package_depth() {
        // Maven 标准布局：源码在 src/main/java/<包路径>/ 下，比语言计数的 4 层深得多
        let d = tmp_dir("maven");
        let pkg = d.join("src/main/java/net/acebridge/java/api/core");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(pkg.join("MediaService.java"), "class MediaService {}").unwrap();
        fs::write(d.join("pom.xml"), "<project/>").unwrap();
        let got = representative_sources(&d, LanguageId::Java, 1);
        assert!(got.first().is_some_and(|p| p.ends_with("MediaService.java")), "{got:?}");
        assert!(find_probe_target(&d, LanguageId::Java).is_some());
    }

    #[test]
    fn representative_sources_spread_across_top_level_dirs() {
        let d = tmp_dir("reps");
        fs::write(d.join("vite.config.ts"), "").unwrap(); // 根层：边角工程那种
        fs::create_dir_all(d.join("src")).unwrap();
        fs::write(d.join("src/a.ts"), "").unwrap();
        fs::create_dir_all(d.join("pkg")).unwrap();
        fs::write(d.join("pkg/b.ts"), "").unwrap();
        let deep = d.join("node_modules").join("p");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("x.ts"), "").unwrap();

        let got = representative_sources(&d, LanguageId::TypeScript, 4);
        assert!(got.iter().any(|p| p.ends_with("src/a.ts")), "{got:?}");
        assert!(got.iter().any(|p| p.ends_with("pkg/b.ts")), "{got:?}");

        // 测试文件不当代表：它们常被工程配置排除在外（本仓库 `src/**/*.test.ts` 就是），
        // 拿它当代表 = 递了一个不属于任何工程的孤文件。真机上栽在这上面两次。
        let tdir = tmp_dir("reps_test");
        fs::create_dir_all(tdir.join("src")).unwrap();
        fs::write(tdir.join("src/a.test.ts"), "").unwrap();
        fs::write(tdir.join("src/real.ts"), "").unwrap();
        let got2 = representative_sources(&tdir, LanguageId::TypeScript, 4);
        assert!(
            got2.iter().all(|p| !p.ends_with("a.test.ts")),
            "测试文件不许当代表：{got2:?}"
        );
        assert!(got2.iter().any(|p| p.ends_with("real.ts")), "{got2:?}");
        fs::remove_dir_all(&tdir).ok();
        assert!(
            !got.iter().any(|p| p.to_string_lossy().contains("node_modules")),
            "重目录不当代表：{got:?}"
        );
        assert!(got.len() <= 4, "上限要守住：{got:?}");
        assert_eq!(
            representative_sources(&d, LanguageId::TypeScript, 1).len(),
            1,
            "max 要真的封顶"
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn from_ext_maps_known() {
        assert_eq!(LanguageId::from_ext("rs"), Some(LanguageId::Rust));
        assert_eq!(LanguageId::from_ext("ts"), Some(LanguageId::TypeScript));
        assert_eq!(LanguageId::from_ext("py"), Some(LanguageId::Python));
        assert_eq!(LanguageId::from_ext("md"), None);
    }

    /// 扩展名掩码表与 `from_ext` 同域：表里的每个都认得；`from_ext` 的 match 臂里的
    /// 字面量也都在表里（源码扫描——`from_ext` 加了新扩展名而表没跟上，这里会红）。
    #[test]
    fn known_source_exts_is_the_from_ext_domain() {
        for e in KNOWN_SOURCE_EXTS {
            assert!(LanguageId::from_ext(e).is_some(), "`{e}` 在表里却不被 from_ext 认");
        }
        let src = include_str!("languages.rs");
        let body = src
            .split("pub fn from_ext(ext: &str) -> Option<Self> {")
            .nth(1)
            .and_then(|b| b.split("_ => None").next())
            .expect("from_ext 的 match 体");
        for lit in body.split('"').skip(1).step_by(2) {
            assert!(KNOWN_SOURCE_EXTS.contains(&lit), "from_ext 认 `{lit}`，掩码表却没有");
        }
    }

    /// 文档形态 → 服务归属：`.vue` 与 React 的 `.tsx`/`.jsx` 都归 TS 家族
    /// （同一个 `typescript-language-server`；`.vue` 靠它的 Vue 插件）。
    #[test]
    fn doc_forms_route_to_ts_family() {
        assert_eq!(LanguageId::from_ext("vue"), Some(LanguageId::TypeScript));
        assert_eq!(LanguageId::from_ext("tsx"), Some(LanguageId::TypeScript));
        assert_eq!(LanguageId::from_ext("jsx"), Some(LanguageId::JavaScript));
    }

    /// **对账**：`probe_exts` 与 `from_ext` 必须同域——每个 probe 扩展名都要能被 `from_ext`
    /// 映射回该语言（两张表漂移过一次：前端那张表里 `.tsx`/`.jsx` 谁都没登记）。
    /// 反向不成立是**有意的**：`.vue` 归 TS，但不当探针靶子（见 `probe_exts` 注释）。
    #[test]
    fn probe_exts_reconcile_with_from_ext() {
        // 新增语言时这里也要加，否则对账会漏掉它（编译器的穷尽检查只覆盖 from_ext 的 match）
        const ALL: [LanguageId; 12] = [
            LanguageId::Rust,
            LanguageId::TypeScript,
            LanguageId::JavaScript,
            LanguageId::Go,
            LanguageId::Java,
            LanguageId::Kotlin,
            LanguageId::Python,
            LanguageId::Dart,
            LanguageId::CSharp,
            LanguageId::Ruby,
            LanguageId::Php,
            LanguageId::Elixir,
        ];
        // 编译器强制：新增 variant 时这条 match 会编译失败，逼作者同时补进 ALL
        // （否则对账会静默跳过新语言，用例照样绿）。
        fn assert_registered(l: LanguageId) {
            match l {
                LanguageId::Rust
                | LanguageId::TypeScript
                | LanguageId::JavaScript
                | LanguageId::Go
                | LanguageId::Java
                | LanguageId::Kotlin
                | LanguageId::Python
                | LanguageId::Dart
                | LanguageId::CSharp
                | LanguageId::Ruby
                | LanguageId::Php
                | LanguageId::Elixir => {}
            }
        }
        for lang in ALL {
            assert_registered(lang);
            for ext in lang.probe_exts() {
                assert_eq!(LanguageId::from_ext(ext), Some(lang), "`{ext}` 该归 {lang:?}");
            }
        }
        // 故意的不对称**只有一处**：需要插件的形态归语言、但不当靶子。新增这类形态时
        // 也要登记进这个清单（它是上面「probe_exts 与 from_ext 同域」的唯一例外）。
        const PLUGIN_ONLY: [&str; 1] = ["vue"];
        for ext in PLUGIN_ONLY {
            assert!(LanguageId::from_ext(ext).is_some(), "`{ext}` 该有服务归属");
            assert!(
                !ALL.iter().any(|l| l.probe_exts().contains(&ext)),
                "`{ext}` 不当靶子（TLS 对它的 documentSymbol 恒空）"
            );
        }
    }

    /// didOpen 帧里的 languageId 由**文件形态**定，不是服务 id：
    /// `.vue` 必须是 "vue"（TS 插件声明的 id，否则 TLS 直接丢弃文档）、
    /// `.tsx`/`.jsx` 必须是 `*react`（发 "typescript" 会按 TS 解析，JSX 全红）。
    #[test]
    fn document_lang_id_follows_file_form() {
        use LanguageId::*;
        assert_eq!(document_lang_id("/w/App.vue", TypeScript), "vue");
        assert_eq!(document_lang_id("/w/a.tsx", TypeScript), "typescriptreact");
        assert_eq!(document_lang_id("/w/a.jsx", JavaScript), "javascriptreact");
        assert_eq!(document_lang_id("/w/a.ts", TypeScript), "typescript");
        assert_eq!(document_lang_id("/w/a.mts", TypeScript), "typescript");
        assert_eq!(document_lang_id("/w/a.rs", Rust), "rust");
        // 扩展名不认识 → 退回服务 id（调用方已经解析过它）
        assert_eq!(document_lang_id("/w/README", Rust), "rust");
    }

    /// `.vue` 不给 TS 当探针靶子（server 原生解析不了它、documentSymbol 恒空），
    /// 但插件门按扩展名照样找得到它——两件事，两个入口。
    #[test]
    fn vue_is_served_by_ts_but_never_a_probe_target() {
        let d = tmp_dir("vueforms");
        fs::write(d.join("App.vue"), "<template/>").unwrap();
        assert!(
            find_probe_target(&d, LanguageId::TypeScript).is_none(),
            ".vue 不该被递给 TS 当靶子"
        );
        assert!(
            find_source_with_ext(&d, "vue").is_some(),
            "插件门（has_vue_files）要能找到 .vue"
        );
        fs::remove_dir_all(&d).ok();
    }
}
