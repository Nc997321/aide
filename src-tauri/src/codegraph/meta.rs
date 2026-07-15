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
    /// Vector dimension the shard was built with. `#[serde(default)]` so old
    /// meta.json (pre-pluggable-embedder, always 384) still deserializes; a
    /// missing dim is treated as 0 and forces a rebuild against the configured
    /// embedder's real dim (load_project_index checks equality).
    #[serde(default)]
    pub dim: usize,
    /// Name of the directory under `.aide/index/` holding this build's shard
    /// (e.g. `qdrant-1700000000-3`). `#[serde(default = "legacy_shard_dir")]`
    /// so old meta.json (which used the implicit `qdrant` dir) still loads.
    /// Versioned dirs mean a rebuild NEVER wipes a live shard's directory —
    /// EdgeShard::drop flushes to disk on Drop, and wiping a still-referenced
    /// dir made Drop panic (build-thread swap + in-flight goto Arc clones).
    #[serde(default = "legacy_shard_dir")]
    pub shard_dir: String,
    /// Whether the semantic-layer embedding finished for this shard. Written
    /// `false` at structure-layer persist (Phase 1, before embed) and `true`
    /// only after Phase 2 embed completes (or after an incremental reindex,
    /// which preserves the prior complete vectors). `#[serde(default)]` so
    /// old meta.json (which never tracked this) deserializes as `false` → the
    /// index is treated as incomplete and rebuilt, never reused. This prevents
    /// reusing a shard from a build that was cancelled mid-embed — such a shard
    /// has incomplete vectors AND an inconsistent field index, so operating on
    /// it (delete_by_file / upsert) panics inside qdrant (`value not found in
    /// value_to_points`) and surfaces as a `join error` build failure.
    #[serde(default)]
    pub embed_complete: bool,
}

/// Legacy shard dir name used before versioned dirs existed.
fn legacy_shard_dir() -> String {
    "qdrant".to_string()
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
                    // `>=` (not `>`): file mtime has sub-second precision but
                    // `indexed_at` is truncated to whole seconds. A file changed
                    // in the same wall-clock second as the build but after it
                    // must still count as stale. Conservative: may trigger one
                    // extra rebuild when a file predates the build in the same
                    // second — safe and cheap.
                    if d.as_secs() >= indexed_at {
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
            dim: 384,
            shard_dir: "qdrant-1".into(),
            embed_complete: true,
        };
        m.save(&path).unwrap();
        let loaded = Meta::load(&path).unwrap();
        assert_eq!(loaded.symbol_count, 3);
        assert_eq!(loaded.model_name, "all-MiniLM-L6-v2");
        assert_eq!(loaded.dim, 384);
        assert_eq!(loaded.shard_dir, "qdrant-1");

        // Old meta.json without `dim`/`shard_dir` deserializes to defaults
        // (0 / "qdrant") — load path treats 0 dim as "unknown" forcing a rebuild,
        // and legacy shard_dir "qdrant" still loads the pre-versioned dir.
        std::fs::write(&path, r#"{"version":1,"model_name":"x","indexed_at":1,"symbol_count":1}"#).unwrap();
        let legacy = Meta::load(&path).unwrap();
        assert_eq!(legacy.dim, 0);
        assert_eq!(legacy.shard_dir, "qdrant");

        // a source file with mtime now (>> 1000) → stale
        std::fs::write(dir.join("A.java"), "class A {}").unwrap();
        assert!(
            is_stale(&dir, 1_000, &["java"]),
            "recent file must mark index stale"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}