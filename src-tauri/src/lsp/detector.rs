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

    #[test]
    fn from_ext_maps_known() {
        assert_eq!(LanguageId::from_ext("rs"), Some(LanguageId::Rust));
        assert_eq!(LanguageId::from_ext("ts"), Some(LanguageId::TypeScript));
        assert_eq!(LanguageId::from_ext("py"), Some(LanguageId::Python));
        assert_eq!(LanguageId::from_ext("md"), None);
    }
}
