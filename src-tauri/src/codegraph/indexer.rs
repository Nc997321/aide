pub mod extract;
pub mod store;
pub mod walk;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::codegraph::embed::Embedder;
use crate::codegraph::meta::{now_epoch, Meta, META_VERSION};
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::IndexedPoint;

use extract::extract_symbols;

use std::sync::atomic::{AtomicU64, Ordering};

/// Per-process monotonic counter baked into each shard dir name so two builds in
/// the same wall-clock second (same `now_epoch`) still get distinct dirs. The
/// dir name is `qdrant-<epoch>-<counter>`; versioning means a rebuild NEVER
/// wipes a live shard's directory (EdgeShard::drop flushes on Drop — wiping a
/// still-referenced dir made Drop panic, both from the build-thread swap and
/// from in-flight goto Arc clones).
static SHARD_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn index_dir(project_root: &Path) -> PathBuf {
    project_root.join(".aide").join("index")
}

#[derive(Debug, Default, Clone, Copy)]
pub struct BuildStats {
    pub scanned_files: usize,
    pub files_with_symbols: usize,
    pub total_symbols: usize,
}

/// Parse the whole project into an in-memory SymbolTable + the points that
/// will be embedded into the shard. Pure w.r.t. shard/embedder — testable
/// without ONNX or Qdrant.
///
/// `on_status` is an optional callback invoked with a human-readable description
/// of the current step ("扫描文件树..." / "解析 <path> (i/N)"). Lets the command
/// layer report what's happening to the frontend for observability — so a slow
/// build is debuggable ("stuck parsing node_modules/X" vs "embed is just slow").
pub fn collect_symbols(
    project_root: &Path,
    parser_manager: &ParserManager,
    on_status: Option<&dyn Fn(&str)>,
) -> (SymbolTable, Vec<IndexedPoint>, BuildStats) {
    let exts = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    if let Some(f) = on_status {
        f("扫描文件树...");
    }
    let files = walk::walk_source_files(project_root, &ext_refs);
    let total_files = files.len();

    let mut table = SymbolTable::new();
    let mut all_points: Vec<IndexedPoint> = Vec::new();
    let mut stats = BuildStats::default();

    for (i, file_path) in files.iter().enumerate() {
        stats.scanned_files += 1;
        if let Some(f) = on_status {
            f(&format!(
                "解析 {} ({}/{})",
                file_path.display(),
                i + 1,
                total_files
            ));
        }
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("codegraph: read failed {}: {}", file_path.display(), e);
                continue;
            }
        };
        let (points, _edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        if points.is_empty() {
            continue;
        }
        stats.files_with_symbols += 1;
        stats.total_symbols += points.len();
        for p in &points {
            table.insert(p.symbol.clone());
        }
        all_points.extend(points);
    }
    (table, all_points, stats)
}

/// Phase 1 of a full rebuild: walk + parse + create shard + persist symbols/meta.
/// Returns the symbol table, an empty shard, the collected points (for the
/// caller to embed in Phase 2), and build stats. **Does not embed** — embedding
/// is the caller's job (see `store::embed_and_store`).
///
/// Splitting structure-collect from embed lets the command layer swap the
/// structure-layer index in *before* embedding, so goto-definition (which uses
/// the in-memory `SymbolTable`, not the shard) works immediately without
/// waiting for the slow ONNX embed. The embedder fills the shard in the
/// background; `embed_ready` is flipped only after embed completes.
///
/// `on_status` is invoked with a human-readable step description ("扫描文件树..."
/// / "解析 <path> (i/N)") for build observability.
///
/// `dim` + `model_name` come from the configured embedder and are stamped into
/// `meta.json` + used to size the shard. A later build with a different embedder
/// (different `model_name` or `dim`) won't match this meta → `load_project_index`
/// returns None → full rebuild. Vectors of a different dimension are physically
/// incompatible with an existing shard, so the model_name/dim pair is the
/// cache key for the on-disk index.
pub fn build_structure_index(
    project_root: &Path,
    parser_manager: &ParserManager,
    dim: usize,
    model_name: &str,
    on_status: Option<&dyn Fn(&str)>,
) -> Result<(SymbolTable, Arc<CodeShard>, Vec<IndexedPoint>, BuildStats), Box<dyn std::error::Error>> {
    let base = index_dir(project_root);
    std::fs::create_dir_all(&base)?;

    // Versioned shard dir: a fresh, unique directory per build. We NEVER wipe the
    // previous build's `qdrant-*` dir here — the old CodeShard (still held by the
    // old ProjectIndex in state, and possibly by in-flight goto Arc clones) would
    // flush to a deleted dir on Drop and panic. Orphans are cleaned at process
    // start (`cleanup_orphan_shard_dirs`) when no live shards exist. The only
    // dir we ever remove is one we just generated and that already exists (a
    // crashed previous build left it) — safe because no live shard references a
    // name we just minted.
    let shard_dir_name = format!(
        "qdrant-{}-{}",
        now_epoch(),
        SHARD_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let qdir = base.join(&shard_dir_name);
    if qdir.exists() {
        let _ = std::fs::remove_dir_all(&qdir);
    }
    let shard = CodeShard::create(&qdir, dim)?;

    let (table, points, stats) = collect_symbols(project_root, parser_manager, on_status);

    // Persist SymbolTable + meta at structure-layer readiness (not waiting for
    // embed). Permission errors expected (`.aide/` may be read-only); other FS
    // errors logged so a silently failing persist is observable — otherwise it
    // forces a full rebuild every open with no diagnostic trail.
    if let Err(e) = table.save_json(&base.join("symbols.json")) {
        tracing::warn!("codegraph: symbols.json persist failed: {}", e);
    }
    let meta = Meta {
        version: META_VERSION,
        model_name: model_name.to_string(),
        indexed_at: now_epoch(),
        symbol_count: table.len(),
        dim,
        shard_dir: shard_dir_name,
    };
    if let Err(e) = meta.save(&base.join("meta.json")) {
        tracing::warn!("codegraph: meta.json persist failed: {}", e);
    }

    Ok((table, Arc::new(shard), points, stats))
}

/// Remove `qdrant*` directories under `base` except the one named `keep`. Only
/// safe to call when no live `CodeShard` references any of those dirs — i.e. at
/// process start (state `inner` is None, no in-flight gotos). Best-effort: FS
/// errors are logged, not fatal (an orphan dir just costs disk until next try).
pub fn cleanup_orphan_shard_dirs(base: &Path, keep: &str) {
    let entries = match std::fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == keep || !name.starts_with("qdrant") {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&path) {
                tracing::warn!("codegraph: orphan shard dir cleanup failed {}: {}", path.display(), e);
            }
        }
    }
}

/// Fast path: reuse on-disk index if fresh and compatible with the configured
/// embedder. None → caller must full-rebuild.
///
/// `expect_model` / `expect_dim` are the configured embedder's `model_name()` /
/// `dim()`. The on-disk `meta.json` must match both — a backend or model switch
/// (different model name) or a dimension change (different model) invalidates
/// the shard because vectors from one embedding space are not comparable to
/// another. A missing/zero `meta.dim` (legacy meta) never matches a real dim,
/// so it forces a rebuild, which is the safe thing.
pub fn load_project_index(
    project_root: &Path,
    parser_manager: &ParserManager,
    expect_model: &str,
    expect_dim: usize,
) -> Option<(SymbolTable, Arc<CodeShard>)> {
    let base = index_dir(project_root);
    let meta = Meta::load(&base.join("meta.json"))?;
    if meta.model_name != expect_model || meta.dim != expect_dim {
        return None;
    }
    let exts = parser_manager.supported_extensions();
    if crate::codegraph::meta::is_stale(project_root, meta.indexed_at, &exts) {
        return None;
    }
    let table = SymbolTable::load_json(&base.join("symbols.json"))?;
    // Load the shard from the versioned dir recorded in meta (legacy meta without
    // shard_dir defaults to "qdrant").
    let shard = CodeShard::load(&base.join(&meta.shard_dir), expect_dim).ok()?;
    Some((table, Arc::new(shard)))
}

/// Incremental: drop a file's symbols/points, re-parse it, update table + shard,
/// then re-persist symbols.json + meta so disk stays in sync with the live table.
/// `abs_file` is absolute; it is stripped against `project_root` for the shard
/// key. A missing file is treated as deletion only (table + shard cleared).
pub fn reindex_one(
    project_root: &Path,
    abs_file: &Path,
    table: &mut SymbolTable,
    shard: &CodeShard,
    embedder: Option<&dyn Embedder>,
    model_name: &str,
    dim: usize,
    parser_manager: &ParserManager,
) -> Result<(), Box<dyn std::error::Error>> {
    let rel = abs_file
        .strip_prefix(project_root)
        .unwrap_or(abs_file)
        .to_string_lossy()
        .replace('\\', "/");

    // remove stale entries for this file
    table.remove_file(&rel);
    shard.delete_by_file(&rel)?;

    let source = match std::fs::read_to_string(abs_file) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file gone → deletion only
    };
    let (points, _edges) = extract::extract_symbols(abs_file, &source, parser_manager, project_root);
    for p in &points {
        table.insert(p.symbol.clone());
    }
    if let Some(embedder) = embedder {
        for chunk in points.chunks(256) {
            let _ = store::embed_and_store(chunk, embedder, shard);
        }
    }

    // Re-persist symbols.json + meta (keep disk in sync with live table).
    // Permission errors silent (read-only `.aide/`); other FS errors logged.
    let base = project_root.join(".aide").join("index");
    if let Err(e) = table.save_json(&base.join("symbols.json")) {
        tracing::warn!("codegraph: symbols.json re-persist failed: {}", e);
    }
    // Preserve the existing shard_dir (reindex writes into the SAME shard, not a
    // new versioned dir). Fall back to the legacy "qdrant" name if meta is gone.
    let shard_dir = crate::codegraph::meta::Meta::load(&base.join("meta.json"))
        .map(|m| m.shard_dir)
        .unwrap_or_else(|| "qdrant".to_string());
    let meta = crate::codegraph::meta::Meta {
        version: crate::codegraph::meta::META_VERSION,
        model_name: model_name.to_string(),
        indexed_at: crate::codegraph::meta::now_epoch(),
        symbol_count: table.len(),
        dim,
        shard_dir,
    };
    if let Err(e) = meta.save(&base.join("meta.json")) {
        tracing::warn!("codegraph: meta.json re-persist failed: {}", e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::codegraph::parser::ParserManager;
    use super::{collect_symbols, cleanup_orphan_shard_dirs};

    #[test]
    fn collect_builds_cross_file_table() {
        let dir = std::env::temp_dir().join(format!("cg_collect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("UserService.java"),
            "class UserService { void save() {} }").unwrap();
        std::fs::write(dir.join("OrderService.java"),
            "class OrderService { void save() {} }").unwrap();

        let pm = ParserManager::new();
        let (table, points, stats) = collect_symbols(&dir, &pm, None);

        // `save` defined in two files → both reachable
        assert_eq!(table.lookup("save").len(), 2);
        assert!(table.lookup("UserService").len() == 1);
        assert!(stats.files_with_symbols == 2);
        assert!(!points.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `cleanup_orphan_shard_dirs` removes every `qdrant*` dir under base except
    /// the one named `keep`. Non-qdrant entries (symbols.json, meta.json, an
    /// unrelated dir) are left untouched. This is the safety valve that lets
    /// versioned shard dirs accumulate during a session and be reclaimed at
    /// process start without ever wiping a live shard's directory.
    #[test]
    fn cleanup_keeps_named_dir_removes_other_qdrant_dirs() {
        let base = std::env::temp_dir().join(format!("cg_cleanup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(base.join("qdrant-1-0")).unwrap();
        std::fs::create_dir_all(base.join("qdrant-1-1")).unwrap();
        std::fs::create_dir_all(base.join("qdrant-2-0")).unwrap();
        std::fs::write(base.join("symbols.json"), "{}").unwrap();
        std::fs::write(base.join("meta.json"), "{}").unwrap();
        // A non-qdrant dir must survive.
        std::fs::create_dir_all(base.join("other")).unwrap();

        cleanup_orphan_shard_dirs(&base, "qdrant-2-0");

        assert!(base.join("qdrant-2-0").exists(), "keep dir must survive");
        assert!(!base.join("qdrant-1-0").exists(), "older orphan removed");
        assert!(!base.join("qdrant-1-1").exists(), "older orphan removed");
        assert!(base.join("symbols.json").exists(), "non-qdrant files untouched");
        assert!(base.join("meta.json").exists());
        assert!(base.join("other").exists(), "non-qdrant dir untouched");
        std::fs::remove_dir_all(&base).ok();
    }

    /// Legacy `qdrant` dir (no counter suffix, from pre-versioned builds) is
    /// also matched by the `qdrant*` prefix and cleaned unless it's the keep dir.
    #[test]
    fn cleanup_handles_legacy_qdrant_dir() {
        let base = std::env::temp_dir().join(format!("cg_cleanup_legacy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(base.join("qdrant")).unwrap();
        std::fs::create_dir_all(base.join("qdrant-1-0")).unwrap();

        // keep the new versioned one → legacy qdrant is an orphan and removed.
        cleanup_orphan_shard_dirs(&base, "qdrant-1-0");
        assert!(base.join("qdrant-1-0").exists());
        assert!(!base.join("qdrant").exists());

        // keep the legacy one → it survives.
        std::fs::create_dir_all(base.join("qdrant")).unwrap();
        cleanup_orphan_shard_dirs(&base, "qdrant");
        assert!(base.join("qdrant").exists());
        std::fs::remove_dir_all(&base).ok();
    }
}
