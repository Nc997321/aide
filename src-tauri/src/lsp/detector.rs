use std::path::Path;

/// LSP 能服务的语言。新增语言时加 variant + from_ext/server_binary 映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LanguageId {
    Rust,
    TypeScript,
    JavaScript,
    Vue,
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
    /// 文件扩展名 → 语言（兜底探测器用）。小写。
    pub fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "js" | "mjs" | "cjs" => Some(Self::JavaScript),
            "vue" => Some(Self::Vue),
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

    /// LSP protocol languageId 字符串（didOpen 传它）。
    pub fn id_str(&self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Vue => "vue",
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
            Self::Vue => Some("vue-language-server"), // Volar
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
}

/// 有界遍历跳过的目录名（顶层与下钻**共用一份**：顶层的 `node_modules/` 与
/// `src/node_modules/` 一样不该当靶子，`target/` 那种上百 GB 的更不该走进去）。
fn is_skip_dir(name: &str) -> bool {
    const SKIP: [&str; 7] = ["node_modules", "target", "dist", "build", ".venv", "vendor", "out"];
    name.starts_with('.') || SKIP.contains(&name)
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
    if let Some(f) = find_source_file(root, lang) {
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

/// 有界遍历一个目录：数该语言的源文件个数，并返回遇到的第一个（当代表）。
/// `COUNT_CAP` 封顶——只为排名，数到够分辨大小就行，不必数完（`target/` 那种目录
/// 本来就被 `is_skip_dir` 挡在外面）。
fn count_and_first(dir: &Path, lang: LanguageId) -> (usize, Option<std::path::PathBuf>) {
    const MAX_DEPTH: usize = 4;
    const COUNT_CAP: usize = 5_000;
    let mut count = 0usize;
    let mut first: Option<std::path::PathBuf> = None;
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if depth < MAX_DEPTH && !is_skip_dir(&name) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if is_test_file(&name) {
                // 测试文件**不当代表、也不计入排名**：工程配置十有八九把它们排除在外
                // （本仓库 `tsconfig.json` 的 exclude 就排除 `src/**/*.test.ts`），
                // 递一个不属于任何工程的孤文件 = 工程没加载（实测踩过两次）。
                continue;
            }
            if path.extension().and_then(|e| e.to_str()).and_then(LanguageId::from_ext) == Some(lang)
            {
                count += 1;
                if first.is_none() {
                    first = Some(path);
                }
                if count >= COUNT_CAP {
                    return (count, first);
                }
            }
        }
    }
    (count, first)
}

/// 探测某工作区涉及的语言集合（去重，无序）。
/// 先用项目 marker 探测器链（Tauri→{rust,ts,vue} 等），再用一层目录扩展名频次兜底。
pub fn detect_languages(root: &Path) -> Vec<LanguageId> {
    let mut out: Vec<LanguageId> = Vec::new();
    // 1. 项目 marker 探测器链
    for id_str in crate::commands::detectors::detect_languages_from_markers(root) {
        if let Some(lang) = lang_from_id_str(id_str) {
            if !out.contains(&lang) {
                out.push(lang);
            }
        }
    }
    // 2. 一层目录扩展名频次兜底（无 marker 或 marker 漏的语言）
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut counts: std::collections::HashMap<LanguageId, usize> =
            std::collections::HashMap::new();
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                    if let Some(lang) = LanguageId::from_ext(&ext.to_lowercase()) {
                        *counts.entry(lang).or_insert(0) += 1;
                    }
                }
            }
        }
        // 频次 ≥2 才认（避免单个 .go 文件误触发；marker 已覆盖主流项目）
        for (lang, n) in counts {
            if n >= 2 && !out.contains(&lang) {
                out.push(lang);
            }
        }
    }
    out
}

/// "rust" → LanguageId::Rust。与 LanguageId::id_str 互逆。
pub fn lang_from_id_str(s: &str) -> Option<LanguageId> {
    match s {
        "rust" => Some(LanguageId::Rust),
        "typescript" => Some(LanguageId::TypeScript),
        "javascript" => Some(LanguageId::JavaScript),
        "vue" => Some(LanguageId::Vue),
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

/// 在工作区里找一个**该语言**的源文件。**有界**：深度 ≤4、跳过重目录、点目录不下钻
/// ——它服务的场景是「要一个磁盘上真实存在的靶子文件」（就绪探测、判「这工作区有没有
/// Vue」），不是「找全」。
///
/// 同步（`fs::read_dir` 循环）：重场景的调用方（`agent_query::first_source_file`）自己
/// 放进 `spawn_blocking`；只做一次 `is_some()` 判定的调用方（TS profile）直接同步调。
pub fn find_source_file(root: &Path, lang: LanguageId) -> Option<std::path::PathBuf> {
    const MAX_DEPTH: usize = 4;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if depth < MAX_DEPTH && !is_skip_dir(&name) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let matches = path
                .extension()
                .and_then(|e| e.to_str())
                .and_then(LanguageId::from_ext)
                == Some(lang);
            // 测试文件不当靶子：它常被工程配置排除在外（见 `representative_sources`），
            // 递它等于递了一个不属于任何工程的孤文件。
            if matches && !is_test_file(&name) {
                return Some(path);
            }
        }
    }
    None
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
    fn tauri_yields_three_languages() {
        let d = tmp_dir("tauri");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        assert!(langs.contains(&LanguageId::TypeScript), "{:?}", langs);
        // Vue 不由 Tauri 探测器声明（marker 无 .vue 文件频次时不出）；仅断言 rust+ts。
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cargo_yields_rust() {
        let d = tmp_dir("cargo");
        fs::write(d.join("Cargo.toml"), "").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn node_yields_ts_js() {
        let d = tmp_dir("node");
        fs::write(d.join("package.json"), "{}").unwrap();
        let langs = detect_languages(&d);
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
        let langs = detect_languages(&d);
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
        let langs = detect_languages(&d);
        // 任何 pom.xml → Java（SpringBootMaven 或 JavaMaven 探测器）
        assert!(langs.contains(&LanguageId::Java), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn file_ext_fallback_no_marker() {
        // 无任何项目 marker，但目录里有若干 .py 文件 → 兜底探测器给 python。
        let d = tmp_dir("extfb");
        fs::write(d.join("a.py"), "print(1)").unwrap();
        fs::write(d.join("b.py"), "print(2)").unwrap();
        fs::write(d.join("c.txt"), "x").unwrap(); // 非源码，不计数
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Python), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cross_language_union() {
        // Tauri 项目根 + 根层两个 .go 文件 → rust/ts(来自 marker) ∪ go(来自扩展名兜底)
        let d = tmp_dir("cross");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        // 根层两个 .go 文件 → 扩展名兜底加 Go
        fs::write(d.join("a.go"), "package main").unwrap();
        fs::write(d.join("b.go"), "package main").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        assert!(langs.contains(&LanguageId::Go), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    /// 有界遍历的边界纪律：重目录不下钻（node_modules 里的同语言文件不该被当靶子），
    /// 正常位置的要找得到。**本用例原在 agent_query.rs，随遍历本体一并迁来**——
    /// 边界只留一份实现，测试也跟着走。
    #[test]
    fn find_source_file_skips_heavy_dirs() {
        let d = tmp_dir("findfile");
        let deep = d.join("node_modules").join("pkg");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("hidden.rs"), "fn x() {}").unwrap();
        assert!(
            find_source_file(&d, LanguageId::Rust).is_none(),
            "node_modules 里的文件不该当探测靶子"
        );

        fs::write(d.join("real.rs"), "fn y() {}").unwrap();
        let found = find_source_file(&d, LanguageId::Rust);
        assert!(
            found.as_deref().is_some_and(|f| f.ends_with("real.rs")),
            "got {found:?}"
        );
    }

    /// 代表文件要**按顶层目录摊开**，且重目录不当代表。
    /// 本仓库实测：只递根层的 `vite.config.ts`（属于只含它一个文件的 `tsconfig.node.json`），
    /// `src/` 里的符号按名**永远**查不到（20s 重试也没用）。
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
}
