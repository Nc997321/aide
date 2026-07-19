use std::collections::HashMap;
use std::path::Path;
use tree_sitter::{Language, Parser, Tree};

/// Maps file extensions to tree-sitter Language grammars.
///
/// Currently supports 5 language families: Java, TypeScript/JS/TSX, Python,
/// Rust, and Vue (via script-block extraction — no standalone grammar needed).
pub struct ParserManager {
    languages: HashMap<String, Language>,
    extensions: Vec<(&'static str, &'static str)>, // (ext, lang_name)
}

impl ParserManager {
    pub fn new() -> Self {
        let mut languages: HashMap<String, Language> = HashMap::new();
        let mut extensions: Vec<(&str, &str)> = Vec::new();

        // Java
        languages.insert("java".into(), tree_sitter_java::LANGUAGE.into());
        extensions.push(("java", "java"));

        // TypeScript
        languages.insert("ts".into(), tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
        extensions.push(("ts", "typescript"));
        // JavaScript (same grammar, different extension)
        languages.insert("js".into(), tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
        extensions.push(("js", "javascript"));
        // TSX
        languages.insert("tsx".into(), tree_sitter_typescript::LANGUAGE_TSX.into());
        extensions.push(("tsx", "tsx"));

        // Python
        languages.insert("py".into(), tree_sitter_python::LANGUAGE.into());
        extensions.push(("py", "python"));

        // Rust
        languages.insert("rs".into(), tree_sitter_rust::LANGUAGE.into());
        extensions.push(("rs", "rust"));

        // Vue — no grammar registered; .vue script blocks are extracted and
        // parsed as TypeScript in extract_symbols (see extract_vue_sfc).
        // The extension entry is only needed so walk_source_files picks up .vue files.
        extensions.push(("vue", "vue"));

        Self { languages, extensions }
    }

    /// Get the Language for a file extension, if supported.
    pub fn get_language(&self, ext: &str) -> Option<&Language> {
        self.languages.get(ext)
    }

    /// List all supported extensions.
    pub fn supported_extensions(&self) -> Vec<&str> {
        self.extensions.iter().map(|(ext, _)| *ext).collect()
    }

    /// Parse a file's source code, returning the syntax tree.
    /// Returns None if the language isn't supported or parsing fails.
    pub fn parse_file(
        &self,
        file_path: &Path,
        source: &str,
    ) -> Option<Tree> {
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let language = self.get_language(ext)?;
        let mut parser = Parser::new();
        parser.set_language(language).ok()?;
        parser.parse(source, None)
    }
}
