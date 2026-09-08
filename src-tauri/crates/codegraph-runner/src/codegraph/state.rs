use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use crate::codegraph::edges::EdgeTable;
use crate::codegraph::embed::Embedder;
use crate::codegraph::parser;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;

/// Snapshot of a fully-built project index, swapped atomically into state.
///
/// `embed_ready` gates the semantic layer: false while the background embed is
/// filling the shard (or if embed was cancelled / unavailable). goto-definition
/// serves the **structure layer (SymbolTable) immediately** after swap — it does
/// not need the shard — so users get exact cross-file jumps without waiting for
/// the slow ONNX embed. Semantic search (shard) is only consulted once
/// `embed_ready` becomes true, which avoids concurrent `upsert` (embed) +
/// `search` (goto) on the same shard (not guaranteed safe by Qdrant Edge).
pub struct ProjectIndex {
    pub project_root: PathBuf,
    pub symbols: SymbolTable,
    pub edges: EdgeTable,
    pub shard: Arc<CodeShard>,
    pub indexed_at: SystemTime,
    pub embed_ready: Arc<AtomicBool>,
}

/// Per-project code graph state.
///
/// `inner` is a double buffer: the active index is read under a read lock;
/// a rebuild builds a fresh `ProjectIndex` offline (in spawn_blocking) and
/// swaps it in under a brief write lock. `embedder` is a lazy-initialized
/// ONNX model guarded by its own mutex. 本进程（aide-codegraph runner）内的
/// 单例：`main.rs` 构造一次，`Arc` 共享给每个请求的 `spawn_blocking` 任务
/// ——进程隔离后它只活在 runner 里，已不再注册进 Tauri state。
///
/// Fields are `pub(crate)` so the build / commands / incremental / resume
/// submodules can drive the state machine; the struct is only constructed
/// here (`new`) 与 `main.rs`。
pub struct CodeGraphState {
    pub(crate) inner: RwLock<Option<ProjectIndex>>,
    /// Lazily-initialized embedder, created from the configured backend on the
    /// first build (and re-created when the config's model_name changes). Trait
    /// object so the rest of CodeGraph is backend-agnostic.
    pub(crate) embedder: Mutex<Option<Box<dyn Embedder>>>,
    /// Cache of the configured embedder's `model_name()` + `dim()`, so a config
    /// change (backend/model switch) is detected without re-creating the
    /// embedder just to read its identity. Cleared together with `embedder`
    /// when a new config requires a different backend.
    pub(crate) embedder_model: Mutex<Option<(String, usize)>>,
    pub(crate) parser_manager: parser::ParserManager,
    /// Coarse build progress for the frontend to poll (no app.emit — see memory:
    /// cross-thread emit park主线程). Updated from the build's spawn_blocking
    /// task; read by the synchronous `codegraph_build_progress` command. All
    /// `Relaxed`: these are approximate progress hints, not synchronization.
    pub(crate) build_active: AtomicBool,
    pub(crate) build_done: AtomicUsize,
    pub(crate) build_total: AtomicUsize,
    /// 当前阶段/文件的可读描述（"扫描文件树..." / "解析 src/foo.ts (123/456)"
    /// / "建立索引 1340/2000" / "写盘..."）。低频更新（每文件/每批一次），用
    /// Mutex 而非 atomic——poll 命令读时极短 lock，纯内存。
    pub(crate) build_current: Mutex<String>,
    /// 取消正在跑的 embed（close/切项目时置 true，embed 循环下一批 check 后 break）。
    /// 避免孤儿 embed 继续浪费 CPU 写一个已被 take 走的 shard。
    pub(crate) build_cancel: AtomicBool,
    /// Agent 按需加载的临时索引单 slot 缓存：`execute_agent_query` 在 `inner`
    /// 单例 root ≠ query root（会话 cwd）时，按 query root 的 `<root>/.aide/index/`
    /// 自动 load 一份临时 `ProjectIndex` 供本次查询。**独立于 `inner`**——不参与
    /// build/close，不被前端 `ensureIndex` 触碰，单例仍由前端激活工作区管理。
    /// 单 root 连续多查命中缓存省一次 disk load；多 root 交替覆盖 slot 只是重
    /// load（不抖动 `inner`、不污染前端 goto 等单例消费者——这是 A2 相对「写
    /// 单例」方案的核心优势）。覆盖旧 slot 时旧 `Arc<ProjectIndex>` 的
    /// `CodeShard` drop 可能因 flush IO panic，须在锁外用
    /// `guard::drop_catching_panics` 释放（见 `agent.rs` 的 query_cache 覆盖
    /// 路径：148/154 行）。
    pub(crate) query_cache: Mutex<Option<(PathBuf, Arc<ProjectIndex>)>>,
}

impl CodeGraphState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(None),
            embedder: Mutex::new(None),
            embedder_model: Mutex::new(None),
            parser_manager: parser::ParserManager::new(),
            build_active: AtomicBool::new(false),
            build_done: AtomicUsize::new(0),
            build_total: AtomicUsize::new(0),
            build_current: Mutex::new(String::new()),
            build_cancel: AtomicBool::new(false),
            query_cache: Mutex::new(None),
        }
    }
}
