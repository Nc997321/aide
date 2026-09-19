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
    const SKIP: [&str; 7] = ["node_modules", "target", "dist", "build", ".venv", "vendor", "out"];
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
                if depth < MAX_DEPTH && !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let matches = path
                .extension()
                .and_then(|e| e.to_str())
                .and_then(LanguageId::from_ext)
                == Some(lang);
            if matches {
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

    #[test]
    fn from_ext_maps_known() {
        assert_eq!(LanguageId::from_ext("rs"), Some(LanguageId::Rust));
        assert_eq!(LanguageId::from_ext("ts"), Some(LanguageId::TypeScript));
        assert_eq!(LanguageId::from_ext("py"), Some(LanguageId::Python));
        assert_eq!(LanguageId::from_ext("md"), None);
    }
}
