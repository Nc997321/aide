use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

/// 始终 prune 的目录名（不依赖 .gitignore 是否存在）。
///
/// 背景：`ignore` crate 的 `standard_filters` 只在项目有 `.gitignore` 时才忽略
/// node_modules / target 等。一个没有 `.gitignore`（或非 git 仓库）的项目会让
/// walk 钻进 node_modules，把里面成千上万的 .js/.ts 全量 parse + embed，构建
/// 因此慢到不可用。这里硬编码一份"构建产物 / 依赖 / 工具缓存"黑名单兜底，与
/// gitignore 叠加——即使无 .gitignore 也快。`.aide` 是 CodeGraph 自己的索引
/// 目录，必须排除（避免索引自身）。
const ALWAYS_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".git",
    ".aide",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    ".angular",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

/// 单文件大小上限：超过则跳过。minified bundle 动辄几 MB，tree-sitter parse
/// 极慢且无符号价值。`ignore` crate 的 `max_filesize` 在 walk 层直接跳过。
const MAX_FILE_BYTES: u64 = 1_000_000;

/// Walk a project directory, returning source files with supported extensions.
/// Respects .gitignore and other ignore rules via the `ignore` crate, **plus**
/// a hardcoded junk-dir blacklist that prunes subtrees regardless of gitignore
/// (so projects without a .gitignore still skip node_modules / target / etc.),
/// plus a max-file-size cap and minified-file skip.
pub fn walk_source_files(
    project_root: &Path,
    supported_extensions: &[&str],
) -> Vec<PathBuf> {
    let exts: Vec<&str> = supported_extensions.to_vec();
    WalkBuilder::new(project_root)
        .standard_filters(true) // respect .gitignore, .ignore, etc.
        .hidden(false) // include hidden files (extension filter still applies)
        .max_filesize(Some(MAX_FILE_BYTES)) // skip huge files at walk layer
        .filter_entry(|entry| {
            // Prune junk dirs — never descend into them. Applies whether or not
            // the project has a .gitignore.
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    if ALWAYS_IGNORE_DIRS.contains(&name) {
                        return false;
                    }
                }
            }
            true
        })
        .build()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return None;
            }
            let path = entry.into_path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // minified 文件：单行巨长、无符号价值、parse 慢——跳过。
            if name.contains(".min.") {
                return None;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if exts.contains(&ext) {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 无 .gitignore 的项目里，junk 目录（node_modules / target）仍应被 prune，
    /// minified 与大文件应被跳过——这是 walk 慢的根因兜底。
    #[test]
    fn skips_junk_dirs_minified_and_huge_files_without_gitignore() {
        let dir = std::env::temp_dir().join(format!("cg_walk_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.ts"), "export const x = 1;").unwrap();

        // node_modules 应被 prune（即使项目无 .gitignore）
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("node_modules/pkg/b.js"), "module.exports = 1;").unwrap();

        // target 应被 prune
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/c.rs"), "fn main(){}").unwrap();

        // minified 跳过
        std::fs::write(dir.join("src/x.min.js"), "var a=1;").unwrap();

        // 大文件跳过（>1MB）
        std::fs::write(dir.join("src/big.ts"), "x".repeat(1_000_001)).unwrap();

        let pm = crate::codegraph::parser::ParserManager::new();
        let exts: Vec<&str> = pm.supported_extensions().iter().copied().collect();
        let files = walk_source_files(&dir, &exts);
        let names: Vec<String> = files
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();

        assert!(names.contains(&"a.ts".to_string()), "src/a.ts 应被收集: {:?}", names);
        assert!(!names.contains(&"b.js".to_string()), "node_modules 应被 prune: {:?}", names);
        assert!(!names.contains(&"c.rs".to_string()), "target 应被 prune: {:?}", names);
        assert!(!names.contains(&"x.min.js".to_string()), "minified 应跳过: {:?}", names);
        assert!(!names.contains(&"big.ts".to_string()), "大文件应跳过: {:?}", names);

        std::fs::remove_dir_all(&dir).ok();
    }
}