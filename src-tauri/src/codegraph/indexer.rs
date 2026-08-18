pub mod extract;
pub mod store;
pub mod walk;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use crate::codegraph::edges::EdgeTable;
use crate::codegraph::embed::Embedder;
use crate::codegraph::meta::{now_epoch, Meta, META_VERSION};
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::state::ProjectIndex;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::IndexedPoint;

use extract::extract_symbols;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// 可索引源文件数上限（walk 之后、parse 之前检查）。超过即拒建——防止把
/// 超大目录（家目录、磁盘根、误挂的依赖树）当项目索引。实测家目录 walk 出
/// 数百万文件 / 405 万符号 / 3GB shard，embed 永远跑不完且 embed_complete
/// 永远 false → 每次打开都全量重扫的永动机。50k 对正常项目绰绰有余
/// （本仓库 ~371 文件；大型单体仓库一般 <20k）。
pub const MAX_INDEX_FILES: usize = 50_000;

/// 文件数超限时的错误消息；None = 未超限。单独成函数便于测试（测试不必
/// 真的创建 5 万个文件）。
pub fn file_count_error(total: usize) -> Option<String> {
    if total > MAX_INDEX_FILES {
        Some(format!(
            "项目过大：walk 出 {} 个源文件，超过上限 {} — 拒绝索引（请确认打开的是项目目录而非家目录/磁盘根）",
            total, MAX_INDEX_FILES
        ))
    } else {
        None
    }
}

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
///
/// `cancel` is an optional flag checked once per source file; when set, the walk
/// stops early and returns the symbols collected so far. Lets a workspace switch
/// cancel an in-flight Phase 1 promptly — Phase 1 doesn't otherwise observe
/// `build_cancel`, so without this check the old build task runs to completion in
/// the background, holding its shard Arc + points + embedder (memory leak across
/// workspace switches).
pub fn collect_symbols(
    project_root: &Path,
    parser_manager: &ParserManager,
    on_status: Option<&dyn Fn(&str)>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<(SymbolTable, EdgeTable, Vec<IndexedPoint>, BuildStats), String> {
    let exts = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    if let Some(f) = on_status {
        f("扫描文件树...");
    }
    let files = walk::walk_source_files(project_root, &ext_refs);
    // 规模保险丝：拒建超大目录（家目录/磁盘根误开），见 MAX_INDEX_FILES。
    if let Some(msg) = file_count_error(files.len()) {
        return Err(msg);
    }
    let total_files = files.len();

    let mut table = SymbolTable::new();
    let mut edges = EdgeTable::new();
    let mut all_points: Vec<IndexedPoint> = Vec::new();
    let mut stats = BuildStats::default();

    for (i, file_path) in files.iter().enumerate() {
        if let Some(c) = cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
        }
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
        let (points, file_edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        for e in file_edges {
            edges.insert(e);
        }
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
    Ok((table, edges, all_points, stats))
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
    // Optional cancel flag forwarded to `collect_symbols` so Phase 1 observes a
    // workspace-switch cancellation (see `collect_symbols` docs).
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<(SymbolTable, EdgeTable, Arc<CodeShard>, Vec<IndexedPoint>, BuildStats), Box<dyn std::error::Error>> {
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

    let (table, edges, points, stats) = collect_symbols(project_root, parser_manager, on_status, cancel)
        .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    // Persist SymbolTable + meta at structure-layer readiness (not waiting for
    // embed). Permission errors expected (`.aide/` may be read-only); other FS
    // errors logged so a silently failing persist is observable — otherwise it
    // forces a full rebuild every open with no diagnostic trail.
    if let Err(e) = table.save_json(&base.join("symbols.json")) {
        tracing::warn!("codegraph: symbols.json persist failed: {}", e);
    }
    if let Err(e) = edges.save_json(&base.join("edges.json")) {
        tracing::warn!("codegraph: edges.json persist failed: {}", e);
    }
    let meta = Meta {
        version: META_VERSION,
        model_name: model_name.to_string(),
        indexed_at: now_epoch(),
        symbol_count: table.len(),
        dim,
        shard_dir: shard_dir_name,
        // Phase 1: structure layer persisted, embedding NOT started/finished.
        // Flipped to true only after the Phase 2 embed completes (see
        // `codegraph_build_index`) or after an incremental reindex (which keeps
        // the prior complete vectors). A cancelled build leaves this false → the
        // shard is never reused (load_*_index check it), avoiding qdrant panics
        // on an inconsistent half-built shard.
        embed_complete: false,
    };
    if let Err(e) = meta.save(&base.join("meta.json")) {
        tracing::warn!("codegraph: meta.json persist failed: {}", e);
    }
    // 新 shard 目录已铸造——旧的 embed 断点（属于上一个 shard）必须作废，
    // 否则续跑会跳过从未进新 shard 的文件。shard_dir 不匹配时 load 侧也会
    // 拒绝（双保险），这里主动清空是主防线。
    clear_embed_checkpoint(&base);

    Ok((table, edges, Arc::new(shard), points, stats))
}

/// Embed 断点：记录「哪些文件的全部符号已 upsert 进 shard」。Phase 2 embed
/// 被中断（关 app / 切工作区 / 强杀）时 meta.embed_complete 留 false，但
/// 已 embed 的文件不必重做——下次构建走续跑路径（`load_resume_base`）只补
/// 剩余文件，而不是整棵全量重建。
///
/// 绑定 `shard_dir`：断点只对铸造它的那个 shard 有效；fresh build 换了新
/// shard 目录后旧断点必须视为不存在（`load_embed_checkpoint` 比对 shard_dir）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EmbedCheckpoint {
    pub shard_dir: String,
    pub files: std::collections::HashSet<String>,
}

pub fn embed_checkpoint_path(base: &Path) -> PathBuf {
    base.join("embed_checkpoint.json")
}

/// 读断点；文件缺失/损坏/shard_dir 不匹配 → None（视为零进度，安全降级为
/// 全部重 embed，幂等 upsert 不会产生重复点）。
pub fn load_embed_checkpoint(base: &Path, shard_dir: &str) -> Option<EmbedCheckpoint> {
    let bytes = std::fs::read(embed_checkpoint_path(base)).ok()?;
    let cp: EmbedCheckpoint = serde_json::from_slice(&bytes).ok()?;
    if cp.shard_dir != shard_dir {
        return None;
    }
    Some(cp)
}

/// 原子落盘断点（tmp + rename）：进程在写盘途中被强杀也不会留半截 JSON
/// （半截会被 load 拒绝 → 降级为零进度，安全）。每批 embed 后调用，成本
/// 是一次小文件写。
pub fn save_embed_checkpoint(base: &Path, cp: &EmbedCheckpoint) {
    let path = embed_checkpoint_path(base);
    let tmp = base.join("embed_checkpoint.json.tmp");
    match serde_json::to_vec(cp) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, &path)) {
                tracing::warn!("codegraph: embed checkpoint save failed: {}", e);
            }
        }
        Err(e) => tracing::warn!("codegraph: embed checkpoint serialize failed: {}", e),
    }
}

pub fn clear_embed_checkpoint(base: &Path) {
    let _ = std::fs::remove_file(embed_checkpoint_path(base));
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

/// Decide whether an incremental reindex is worthwhile given how many files
/// changed vs. the total. Incremental (reindex only the changed files, reuse
/// the rest) is faster than a full rebuild only when the delta is small; past
/// a threshold a clean full rebuild is both faster and avoids reusing a
/// possibly-dirty old shard. Rule: changed ≤ 20% of total AND changed ≤ 200
/// → incremental (true); otherwise full rebuild (false).
pub fn decide_increment(changed: usize, total: usize) -> bool {
    // ≤20% of files AND ≤200 files. `changed*5 <= total` avoids floating-point
    // and handles total==0 (only changed==0 satisfies 0<=0).
    changed * 5 <= total && changed <= 200
}

/// Walk source files and return those modified after `indexed_at`, plus the
/// total source-file count. One walk serves both the delta list (for
/// `reindex_one`) and the threshold (`decide_increment`). Mirrors
/// `is_stale`/`rescan` mtime semantics (`>`, strict — `indexed_at` is second
/// granularity, file mtimes are sub-second).
pub fn changed_files_since(
    project_root: &Path,
    exts: &[&str],
    indexed_at: u64,
) -> (Vec<PathBuf>, usize) {
    use std::time::UNIX_EPOCH;
    let files = walk::walk_source_files(project_root, exts);
    let total = files.len();
    let changed: Vec<PathBuf> = files
        .into_iter()
        .filter(|f| {
            f.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|mt| mt.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() > indexed_at)
                .unwrap_or(false)
        })
        .collect();
    (changed, total)
}

/// Sanity check that an `embed_complete` shard actually has vectors. A build
/// that silently dropped every batch (Ollama down — the bug this fixes) still
/// flipped `embed_complete=true`, producing a vector-less shard the loaders
/// would serve as "complete" (semantic search then returned 0). Returns true
/// if the shard's point count is far below the declared symbol count → caller
/// treats it as a broken shard and rebuilds. Conservative 50% threshold: a
/// completed shard should have nearly all symbols embedded (NaN-skips are a
/// handful); well under half is unambiguous breakage.
fn shard_point_count_broken(shard: &CodeShard, meta: &Meta) -> bool {
    let pc = shard.point_count();
    let half = meta.symbol_count / 2;
    if pc < half {
        tracing::warn!(
            "codegraph: shard point_count {} << meta.symbol_count {}, treating as broken → rebuild",
            pc,
            meta.symbol_count
        );
        true
    } else {
        false
    }
}

/// Load a compatible on-disk index **ignoring staleness**. Returns the
/// `SymbolTable`, the `CodeShard`, and the `Meta` (whose `indexed_at` drives
/// the changed-files delta) if the on-disk meta matches the configured
/// embedder (`model_name` + `dim`) AND `symbols.json` + shard are loadable.
/// Unlike `load_project_index`, this does NOT check `is_stale` — used by the
/// incremental build path to load the old index as a base to reindex only the
/// changed files. Returns `None` when there is no reusable base (no meta,
/// model/dim mismatch, or symbols/shard unloadable) → caller must full-rebuild.
pub fn load_compatible_index(
    project_root: &Path,
    expect_model: &str,
    expect_dim: usize,
) -> Option<(SymbolTable, EdgeTable, Arc<CodeShard>, Meta)> {
    let base = index_dir(project_root);
    let meta = Meta::load(&base.join("meta.json"))?;
    if meta.model_name != expect_model || meta.dim != expect_dim {
        return None;
    }
    // Never reuse an incomplete shard (build cancelled mid-embed): it has partial
    // vectors and an inconsistent field index → reindex_one's delete_by_file
    // panics in qdrant (`value not found in value_to_points`). Force a full
    // rebuild instead, which creates a fresh clean shard.
    if !meta.embed_complete {
        return None;
    }
    let table = SymbolTable::load_json(&base.join("symbols.json"))?;
    let edges = EdgeTable::load_json(&base.join("edges.json"))?;
    let shard = CodeShard::load(&base.join(&meta.shard_dir), expect_dim).ok()?;
    if shard_point_count_broken(&shard, &meta) {
        return None;
    }
    Some((table, edges, Arc::new(shard), meta))
}

/// On-demand load of an on-disk index for an agent query (find_symbol /
/// call_graph / semantic_search) when the live `CodeGraphState.inner` singleton
/// holds a different project's index — i.e. the sidecar's session cwd (the
/// query root) ≠ the active workspace whose index the frontend `ensureIndex`
/// keeps warm in the singleton.
///
/// Unlike `load_project_index` (which calls `is_stale` and walks the whole
/// source tree), this does NOT walk/extract/embed: it reuses the pure-load
/// `load_compatible_index` and only assembles a `ProjectIndex` for the query.
/// Agent queries tolerate a slightly stale symbol set; the frontend's
/// `ensureIndex` / per-turn rescan keeps the on-disk index fresh for the active
/// workspace, and other roots' indexes are simply read as last-built.
///
/// `embed_ready` is set `true` up front: `load_compatible_index` already gates
/// on `meta.embed_complete == true` and `shard_point_count_broken` (sufficient
/// vectors), so any shard that survives the load is fully embedded — no
/// re-embedder is needed on the query path.
///
/// `expect_model` / `expect_dim` come from the cached embedder identity
/// (`CodeGraphState.embedder_model`). When the embedder hasn't been initialized
/// (app restart before any build), the caller returns `wrong_project` rather
/// than calling this — it lets the frontend `ensureIndex` build + initialize.
pub fn load_index_for_query(
    project_root: &Path,
    expect_model: &str,
    expect_dim: usize,
) -> Option<ProjectIndex> {
    let (symbols, edges, shard, _meta) =
        load_compatible_index(project_root, expect_model, expect_dim)?;
    Some(ProjectIndex {
        project_root: project_root.to_path_buf(),
        symbols,
        edges,
        shard,
        indexed_at: SystemTime::now(),
        embed_ready: Arc::new(AtomicBool::new(true)),
    })
}

/// Load the base for an EMBED RESUME: the on-disk meta matches the configured
/// embedder (model_name + dim), the structure layer (symbols.json + edges.json)
/// and the partial shard load — but `embed_complete` is FALSE (a previous build
/// was interrupted mid-embed). Returns the structure layer + partial shard +
/// embed checkpoint (files already embedded, empty if none) so the caller can
/// re-embed only the remaining files instead of full-rebuilding.
///
/// Returns None when there's no resumable base (no meta / model·dim mismatch /
/// embed already complete — that goes to the reuse/incremental paths instead /
/// structure files or shard unloadable) → caller falls back to a full rebuild.
pub fn load_resume_base(
    project_root: &Path,
    expect_model: &str,
    expect_dim: usize,
) -> Option<(SymbolTable, EdgeTable, Arc<CodeShard>, Meta, EmbedCheckpoint)> {
    let base = index_dir(project_root);
    let meta = Meta::load(&base.join("meta.json"))?;
    if meta.model_name != expect_model || meta.dim != expect_dim {
        return None;
    }
    if meta.embed_complete {
        return None;
    }
    let table = SymbolTable::load_json(&base.join("symbols.json"))?;
    let edges = EdgeTable::load_json(&base.join("edges.json"))?;
    let shard = CodeShard::load(&base.join(&meta.shard_dir), expect_dim).ok()?;
    let checkpoint = load_embed_checkpoint(&base, &meta.shard_dir).unwrap_or(EmbedCheckpoint {
        shard_dir: meta.shard_dir.clone(),
        files: std::collections::HashSet::new(),
    });
    Some((table, edges, Arc::new(shard), meta, checkpoint))
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
) -> Option<(SymbolTable, EdgeTable, Arc<CodeShard>)> {
    let base = index_dir(project_root);
    let meta = Meta::load(&base.join("meta.json"))?;
    if meta.model_name != expect_model || meta.dim != expect_dim {
        return None;
    }
    // Never reuse an incomplete shard (build cancelled mid-embed): it has partial
    // vectors and an inconsistent field index → operating on it panics in qdrant.
    if !meta.embed_complete {
        return None;
    }
    let exts = parser_manager.supported_extensions();
    if crate::codegraph::meta::is_stale(project_root, meta.indexed_at, &exts) {
        return None;
    }
    let table = SymbolTable::load_json(&base.join("symbols.json"))?;
    let edges = EdgeTable::load_json(&base.join("edges.json"))?;
    // Load the shard from the versioned dir recorded in meta (legacy meta without
    // shard_dir defaults to "qdrant").
    let shard = CodeShard::load(&base.join(&meta.shard_dir), expect_dim).ok()?;
    if shard_point_count_broken(&shard, &meta) {
        return None;
    }
    Some((table, edges, Arc::new(shard)))
}

/// Incremental: drop a file's symbols/points, re-parse it, update table + shard,
/// then re-persist symbols.json + meta so disk stays in sync with the live table.
/// `abs_file` is absolute; it is stripped against `project_root` for the shard
/// key. A missing file is treated as deletion only (table + shard cleared).
pub fn reindex_one(
    project_root: &Path,
    abs_file: &Path,
    table: &mut SymbolTable,
    edges: &mut EdgeTable,
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
    edges.remove_file(&rel);
    shard.delete_by_file(&rel)?;

    let source = match std::fs::read_to_string(abs_file) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file gone → deletion only
    };
    let (points, file_edges) = extract::extract_symbols(abs_file, &source, parser_manager, project_root);
    for e in file_edges {
        edges.insert(e);
    }
    for p in &points {
        table.insert(p.symbol.clone());
    }
    if let Some(embedder) = embedder {
        for chunk in points.chunks(super::EMBED_BATCH_SIZE) {
            let _ = store::embed_and_store(chunk, embedder, shard);
        }
    }

    // Re-persist symbols.json + meta (keep disk in sync with live table).
    // Permission errors silent (read-only `.aide/`); other FS errors logged.
    let base = project_root.join(".aide").join("index");
    if let Err(e) = table.save_json(&base.join("symbols.json")) {
        tracing::warn!("codegraph: symbols.json re-persist failed: {}", e);
    }
    if let Err(e) = edges.save_json(&base.join("edges.json")) {
        tracing::warn!("codegraph: edges.json re-persist failed: {}", e);
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
        // Incremental reindex runs only on an already-embed-complete shard
        // (load_*_index gate on embed_complete), and it preserves the prior
        // complete vectors while re-embedding the changed file's symbols. So
        // the shard stays embed-complete after reindex.
        embed_complete: true,
    };
    if let Err(e) = meta.save(&base.join("meta.json")) {
        tracing::warn!("codegraph: meta.json re-persist failed: {}", e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::codegraph::parser::ParserManager;
    use super::{collect_symbols, cleanup_orphan_shard_dirs, decide_increment};

    /// 4 维假 embedder：批次原样返回零向量，让测试 shard 真有向量以通过加载层
    /// 的 point_count 兜底校验（向量数远少于 symbol_count 即判残缺 → 重建）。
    struct FakeEmb;
    impl crate::codegraph::embed::Embedder for FakeEmb {
        fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
            Ok(texts.iter().map(|_| vec![0.0f32; 4]).collect())
        }
        fn dim(&self) -> usize { 4 }
        fn model_name(&self) -> &str { "test" }
    }

    /// `collect_symbols` must stop after the first file when `cancel` is pre-set,
    /// returning an empty table. Phase 1 observing the cancel promptly is what lets
    /// a workspace switch drain an in-flight build instead of letting it run to
    /// completion holding its shard/points/embedder (the memory leak this guards).
    #[test]
    fn collect_symbols_stops_immediately_when_cancelled() {
        let dir = std::env::temp_dir().join(format!("cg_cancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..10 {
            std::fs::write(dir.join(format!("f{i}.ts")), format!("function g{i}() {{}}")).unwrap();
        }
        let pm = ParserManager::new();
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let (table, _edges, _points, stats) = collect_symbols(&dir, &pm, None, Some(&cancel)).unwrap();
        assert_eq!(stats.scanned_files, 0, "cancel must stop before scanning any file");
        assert_eq!(table.len(), 0, "no symbols collected under cancel");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Without cancel, all files are scanned — confirms the cancel check doesn't
    /// short-circuit the normal path.
    #[test]
    fn collect_symbols_scans_all_when_not_cancelled() {
        let dir = std::env::temp_dir().join(format!("cg_nocancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.ts")), format!("function g{i}() {{}}")).unwrap();
        }
        let pm = ParserManager::new();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (table, _edges, _points, stats) = collect_symbols(&dir, &pm, None, Some(&cancel)).unwrap();
        assert_eq!(stats.scanned_files, 5, "all files scanned without cancel");
        assert_eq!(table.len(), 5, "one symbol per file collected");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decide_increment_small_delta_is_incremental() {
        assert!(decide_increment(0, 100), "no changes → incremental");
        assert!(decide_increment(5, 100), "5% → incremental");
        assert!(decide_increment(20, 100), "exactly 20% → incremental (boundary)");
        assert!(decide_increment(0, 0), "empty project, no changes → incremental");
    }

    #[test]
    fn file_count_error_only_above_cap() {
        assert!(super::file_count_error(super::MAX_INDEX_FILES).is_none(), "at cap → ok");
        assert!(super::file_count_error(super::MAX_INDEX_FILES + 1).is_some(), "over cap → error");
        let msg = super::file_count_error(super::MAX_INDEX_FILES + 1).unwrap();
        assert!(msg.contains("拒绝索引"), "error must be actionable, got: {}", msg);
    }

    #[test]
    fn embed_checkpoint_roundtrip_and_shard_dir_binding() {
        let base = std::env::temp_dir().join(format!("cg_ckpt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let mut files = std::collections::HashSet::new();
        files.insert("src/a.ts".to_string());
        files.insert("src/b.ts".to_string());
        let cp = super::EmbedCheckpoint { shard_dir: "qdrant-1-0".into(), files };
        super::save_embed_checkpoint(&base, &cp);
        // 同 shard_dir → 读回
        let loaded = super::load_embed_checkpoint(&base, "qdrant-1-0").expect("checkpoint loads");
        assert_eq!(loaded.files.len(), 2);
        assert!(loaded.files.contains("src/a.ts"));
        // shard_dir 不匹配（fresh build 换了新目录）→ 拒绝，视为零进度
        assert!(super::load_embed_checkpoint(&base, "qdrant-2-0").is_none(),
            "checkpoint from another shard must be rejected");
        // 半截损坏文件 → None（安全降级）
        std::fs::write(super::embed_checkpoint_path(&base), b"{\"shard_dir\":").unwrap();
        assert!(super::load_embed_checkpoint(&base, "qdrant-1-0").is_none(),
            "corrupt checkpoint must be rejected");
        // clear 后 → None
        super::clear_embed_checkpoint(&base);
        assert!(super::load_embed_checkpoint(&base, "qdrant-1-0").is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_resume_base_only_for_incomplete_matching_index() {
        let dir = std::env::temp_dir().join(format!("cg_resume_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "class A { save() {} }").unwrap();
        let pm = ParserManager::new();
        let shard_dir_name;
        {
            let (_t, _edges, shard, _p, _s) =
                super::build_structure_index(&dir, &pm, 4, "test-model", None, None).unwrap();
            shard_dir_name = crate::codegraph::meta::Meta::load(
                &super::index_dir(&dir).join("meta.json")).unwrap().shard_dir;
            drop(shard);
        }
        // embed_complete=false + model/dim 匹配 → 可续跑
        let loaded = super::load_resume_base(&dir, "test-model", 4);
        assert!(loaded.is_some(), "incomplete matching index must be resumable");
        let (t, _e, shard, meta, cp) = loaded.unwrap();
        assert!(t.len() > 0, "structure layer must load");
        assert!(!meta.embed_complete);
        assert!(cp.files.is_empty(), "no checkpoint yet → zero progress");
        drop(shard);
        // 写入断点后再载 → 断点随基座一起返回
        let mut files = std::collections::HashSet::new();
        files.insert("a.ts".to_string());
        super::save_embed_checkpoint(&super::index_dir(&dir),
            &super::EmbedCheckpoint { shard_dir: shard_dir_name.clone(), files });
        let (_t2, _e2, shard2, _m2, cp2) = super::load_resume_base(&dir, "test-model", 4).unwrap();
        assert_eq!(cp2.files.len(), 1, "checkpoint must ride along");
        drop(shard2);
        // model/dim 不匹配 → None
        assert!(super::load_resume_base(&dir, "other", 4).is_none());
        assert!(super::load_resume_base(&dir, "test-model", 999).is_none());
        // embed_complete=true → None（走复用/增量路径，不是续跑）
        {
            let base = super::index_dir(&dir);
            let mut m = crate::codegraph::meta::Meta::load(&base.join("meta.json")).unwrap();
            m.embed_complete = true;
            m.save(&base.join("meta.json")).unwrap();
        }
        assert!(super::load_resume_base(&dir, "test-model", 4).is_none(),
            "complete index must not be a resume base");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decide_increment_large_fraction_is_full_rebuild() {
        assert!(!decide_increment(21, 100), "21% > 20% → full rebuild");
        assert!(!decide_increment(50, 100), "50% → full rebuild");
        assert!(!decide_increment(3, 10), "30% → full rebuild (small project)");
    }

    #[test]
    fn decide_increment_over_absolute_cap_is_full_rebuild() {
        assert!(!decide_increment(201, 100_000), ">200 absolute → full rebuild");
        assert!(decide_increment(200, 100_000), "exactly 200 → incremental (boundary)");
    }

    #[test]
    fn changed_files_since_returns_all_when_index_is_old() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let dir = std::env::temp_dir().join(format!("cg_changed_old_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "export const x = 1;").unwrap();
        std::fs::write(dir.join("b.ts"), "export const y = 2;").unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let (changed, total) = super::changed_files_since(&dir, &["ts"], now - 1000);
        assert_eq!(total, 2, "total source files");
        assert_eq!(changed.len(), 2, "both files are newer than the old index");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn changed_files_since_returns_none_when_index_newer_than_all_files() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let dir = std::env::temp_dir().join(format!("cg_changed_new_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "export const x = 1;").unwrap();
        std::fs::write(dir.join("b.ts"), "export const y = 2;").unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let (changed, total) = super::changed_files_since(&dir, &["ts"], now + 1000);
        assert_eq!(total, 2);
        assert!(changed.is_empty(), "no file is newer than the future index");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_compatible_index_loads_stale_index_ignoring_staleness() {
        let dir = std::env::temp_dir().join(format!("cg_compat_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "class A { save() {} }").unwrap();
        let pm = ParserManager::new();
        // Build an on-disk index (structure layer + shard + meta). Drop the
        // returned shard so its dir is released on disk before we re-load it.
        {
            let (_table, _edges, shard, points, _stats) =
                super::build_structure_index(&dir, &pm, 4, "test-model", None, None).unwrap();
            // Embed the points so the shard has vectors — the loaders now
            // sanity-check point_count against meta.symbol_count (a vector-less
            // "complete" shard is rejected as broken, the bug this fixes).
            for chunk in points.chunks(crate::codegraph::EMBED_BATCH_SIZE) {
                let _ = super::store::embed_and_store(chunk, &FakeEmb, &shard);
            }
            drop(shard);
        }
        // Phase 1 writes `embed_complete: false`; flip it to true to simulate a
        // finished embed — `load_compatible_index` rejects incomplete shards.
        {
            let base = super::index_dir(&dir);
            let mut m = crate::codegraph::meta::Meta::load(&base.join("meta.json")).unwrap();
            m.embed_complete = true;
            m.save(&base.join("meta.json")).unwrap();
        }
        // Mutate a file → index is now stale (is_stale would be true).
        std::fs::write(dir.join("a.ts"), "class A { save() {} load() {} }").unwrap();
        // load_compatible_index must still load it (ignores staleness).
        let loaded = super::load_compatible_index(&dir, "test-model", 4);
        assert!(loaded.is_some(), "stale but compatible index must load");
        let (t, _e, _s, meta) = loaded.unwrap();
        assert_eq!(meta.model_name, "test-model");
        assert_eq!(meta.dim, 4);
        assert!(t.len() > 0, "loaded table must have symbols");
        drop(_s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_compatible_index_none_on_model_or_dim_mismatch_or_missing_meta() {
        let dir = std::env::temp_dir().join(format!("cg_compat_none_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "class A { save() {} }").unwrap();
        let pm = ParserManager::new();
        super::build_structure_index(&dir, &pm, 4, "test-model", None, None).unwrap();
        // model mismatch → None
        assert!(super::load_compatible_index(&dir, "other-model", 4).is_none(), "model mismatch");
        // dim mismatch → None
        assert!(super::load_compatible_index(&dir, "test-model", 999).is_none(), "dim mismatch");
        // no meta → None
        std::fs::remove_file(dir.join(".aide/index/meta.json")).unwrap();
        assert!(super::load_compatible_index(&dir, "test-model", 4).is_none(), "missing meta");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_compatible_index_none_when_embed_incomplete() {
        // A shard left by a build cancelled mid-embed has `embed_complete: false`
        // (exactly what `build_structure_index` writes). Reusing it would let
        // `reindex_one`'s `delete_by_file` hit qdrant's
        // `value not found in value_to_points` panic → `join error`. Both loaders
        // must reject it and force a full rebuild instead.
        let dir = std::env::temp_dir().join(format!("cg_incomplete_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "class A { save() {} }").unwrap();
        let pm = ParserManager::new();
        {
            let (_t, _edges, shard, _p, _s) =
                super::build_structure_index(&dir, &pm, 4, "test-model", None, None).unwrap();
            drop(shard);
        }
        // meta.json now has embed_complete=false (Phase 1 only) — must NOT load.
        assert!(
            super::load_compatible_index(&dir, "test-model", 4).is_none(),
            "an embed-incomplete shard must not be reused"
        );
        assert!(
            super::load_project_index(&dir, &pm, "test-model", 4).is_none(),
            "load_project_index must also reject an embed-incomplete shard"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn collect_builds_cross_file_table() {
        let dir = std::env::temp_dir().join(format!("cg_collect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("UserService.java"),
            "class UserService { void save() { persist(); } void persist() {} }").unwrap();
        std::fs::write(dir.join("OrderService.java"),
            "class OrderService { void save() {} }").unwrap();

        let pm = ParserManager::new();
        let (table, edges, points, stats) = collect_symbols(&dir, &pm, None, None).unwrap();

        assert_eq!(table.lookup("save").len(), 2);
        assert!(table.lookup("UserService").len() == 1);
        assert!(stats.files_with_symbols == 2);
        assert!(!points.is_empty());
        // 调用边随符号一起收集：persist 在 save 内被调用
        let e = edges.callers_of("persist");
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].caller, "save");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_persists_edges_json_and_loaders_require_it() {
        let dir = std::env::temp_dir().join(format!("cg_edges_persist_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"),
            "function caller() { target(); }\nfunction target() {}\n").unwrap();
        let pm = ParserManager::new();
        {
            let (_t, edges, shard, points, _s) =
                super::build_structure_index(&dir, &pm, 4, "test-model", None, None).unwrap();
            assert_eq!(edges.callers_of("target").len(), 1);
            // Embed points so the shard has vectors — loaders sanity-check
            // point_count vs meta.symbol_count and reject a vector-less shard.
            for chunk in points.chunks(crate::codegraph::EMBED_BATCH_SIZE) {
                let _ = super::store::embed_and_store(chunk, &FakeEmb, &shard);
            }
            drop(shard);
        }
        let base = super::index_dir(&dir);
        assert!(base.join("edges.json").exists(), "build must persist edges.json");
        // embed 标记完成后 loader 必须连边一起载回
        {
            let mut m = crate::codegraph::meta::Meta::load(&base.join("meta.json")).unwrap();
            m.embed_complete = true;
            m.save(&base.join("meta.json")).unwrap();
        }
        let (_t, edges, _s, _meta) =
            super::load_compatible_index(&dir, "test-model", 4).expect("compatible index loads");
        assert_eq!(edges.callers_of("target").len(), 1, "edges survive persist+load");
        // edges.json 缺失 → 视为不兼容（旧索引），强制全量重建
        std::fs::remove_file(base.join("edges.json")).unwrap();
        assert!(super::load_compatible_index(&dir, "test-model", 4).is_none(),
            "missing edges.json must force rebuild");
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
