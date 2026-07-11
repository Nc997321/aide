use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

pub const META_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub version: u32,
    pub model_name: String,
    pub indexed_at: u64, // unix epoch seconds
    pub symbol_count: usize,
}

impl Meta {
    pub fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, bytes)
    }
}

pub fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// True if any indexable source file was modified after `indexed_at`.
pub fn is_stale(project_root: &Path, indexed_at: u64, exts: &[&str]) -> bool {
    for entry in WalkBuilder::new(project_root)
        .standard_filters(true)
        .hidden(false)
        .build()
        .flatten()
    {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !exts.contains(&ext) {
            continue;
        }
        if let Ok(meta) = path.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(d) = modified.duration_since(UNIX_EPOCH) {
                    if d.as_secs() > indexed_at {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meta_roundtrip_and_staleness() {
        let dir = std::env::temp_dir().join(format!("cg_meta_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.json");
        let m = Meta {
            version: 1,
            model_name: "all-MiniLM-L6-v2".into(),
            indexed_at: 1_000,
            symbol_count: 3,
        };
        m.save(&path).unwrap();
        let loaded = Meta::load(&path).unwrap();
        assert_eq!(loaded.symbol_count, 3);
        assert_eq!(loaded.model_name, "all-MiniLM-L6-v2");

        // a source file with mtime now (>> 1000) → stale
        std::fs::write(dir.join("A.java"), "class A {}").unwrap();
        assert!(
            is_stale(&dir, 1_000, &["java"]),
            "recent file must mark index stale"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}