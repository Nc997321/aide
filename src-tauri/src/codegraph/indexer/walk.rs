use std::path::{Path, PathBuf};
use ignore::WalkBuilder;

/// Walk a project directory, returning source files with supported extensions.
/// Respects .gitignore and other ignore rules via the `ignore` crate.
pub fn walk_source_files(
    project_root: &Path,
    supported_extensions: &[&str],
) -> Vec<PathBuf> {
    let exts: Vec<&str> = supported_extensions.to_vec();
    WalkBuilder::new(project_root)
        .standard_filters(true) // respect .gitignore, .ignore, etc.
        .hidden(false)          // include hidden files (extension filter still applies)
        .build()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return None;
            }
            let path = entry.into_path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if exts.contains(&ext) {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}
