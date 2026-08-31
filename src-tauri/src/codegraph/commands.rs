//! CodeGraph Tauri 命令（RPC 桩，优化项二）。
//!
//! 六个命令的**签名与返回形状与迁移前完全一致**（前端 / remote-rpc 调用方
//! 零改动），命令体从「进程内直调引擎」改为「政策判定 + 转发 RPC」：
//!
//! - 门控（trust / 工作区索引开关）——政策，留主进程；
//! - settings 读取（embedder 配置 / 查询阈值）——同上，序列化后随参数下传；
//! - proxy 探测——同上；
//! - `ensure_aide_excluded`（信任工作区的 .aide/ git exclude）——主进程的
//!   仓库治理职责；
//! - 重活（ONNX / 向量库 / 解析）——runner 进程。
//!
//! 迁移对账（相对原命令体）：
//! | 原命令                    | 桩内保留的政策逻辑                    | 下沉 runner            |
//! |---------------------------|----------------------------------------|------------------------|
//! | codegraph_build_index     | gate + ensure_aide_excluded + 配置/proxy | build_index 全流程   |
//! | codegraph_goto_definition | query_score_threshold                  | 结构+语义查询          |
//! | codegraph_close           | —                                      | optimize + drop        |
//! | codegraph_reindex_file    | gate                                   | 单文件增量             |
//! | codegraph_rescan          | gate                                   | mtime walk + 增量      |
//! | codegraph_build_progress  | —（读进度镜像，同步命令不变）          | 通知来源               |

use std::sync::Arc;

use serde_json::{json, Value};

use codegraph_core::types::QueryResult;

use super::embed_config::{load_embedder_config, query_score_threshold};
use super::gate;
use super::CodeGraphService;

/// Tauri command: build (or load) the full index for a project.
///
/// 分钟级长请求：invoke 全程 await（与迁移前一致），期间进度经 runner 通知
/// 刷新主进程镜像，前端照旧轮询 `codegraph_build_progress`。
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    force: Option<bool>,
    state: tauri::State<'_, Arc<CodeGraphService>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
) -> Result<Value, String> {
    let force = force.unwrap_or(false);
    let svc = state.inner().clone();
    let ss = settings_service.inner().clone();
    let gate_root = project_root.clone(); // project_root 本体留给 svc 调用
                                          // 政策层：门控 + embedder 配置 + proxy 探测 + .aide/ exclude——全部
                                          // 阻塞 IO，收进 spawn_blocking（与迁移前的命令体一致）。
    let prep = tokio::task::spawn_blocking(move || {
        // 政策读（trust + 工作区开关）是调用方表达式；gate 只做纯判定。
        if let Some(reason) = gate::skip_reason(
            crate::commands::workspace::is_path_trusted(&gate_root),
            crate::commands::workspace::is_codegraph_enabled_for_path(&gate_root),
        ) {
            return Err(json!({
                "loaded": false,
                "skipped": reason,
                "total_symbols": 0,
                "scanned_files": 0,
                "files_with_symbols": 0,
            }));
        }
        // 已信任工作区激活索引：顺带确保该仓库 exclude 忽略 `.aide/`——覆盖
        // 历史已信任的工作区（幂等，失败仅记日志）。
        crate::commands::workspace::ensure_aide_excluded(&std::path::PathBuf::from(&gate_root));
        let cfg = load_embedder_config(&ss);
        let proxy = crate::commands::proxy::detect_proxy();
        Ok((cfg, proxy))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    let (cfg, proxy) = match prep {
        Ok(v) => v,
        Err(skip) => return Ok(skip), // 门控跳过：形状与迁移前一致
    };
    svc.build_index(&project_root, force, cfg, proxy).await
}

/// Tauri command: goto-definition query.
///
/// 结构层（精确、跨文件）+ 语义层都在 runner 里跑；本桩只解析 query-time 的
/// 分数阈值（纯过滤，改了立即生效，与迁移前一致）。
#[tauri::command]
pub async fn codegraph_goto_definition(
    word: String,
    #[allow(unused_variables)] file: String,
    line: usize,
    #[allow(unused_variables)] column: usize,
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, Arc<CodeGraphService>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
) -> Result<Vec<QueryResult>, String> {
    let svc = state.inner().clone();
    let ss = settings_service.inner().clone();
    let score_threshold = tokio::task::spawn_blocking(move || query_score_threshold(&ss))
        .await
        .map_err(|e| format!("join error: {e}"))?;
    svc.goto_definition(&word, &file, line, column, &project_root, score_threshold)
        .await
}

/// Tauri command: close and flush the index for a project.
#[tauri::command]
pub async fn codegraph_close(
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, Arc<CodeGraphService>>,
) -> Result<(), String> {
    let svc = state.inner().clone();
    svc.close(&project_root).await
}

/// Tauri command: incrementally re-index a single file after it is saved.
///
/// skip 响应形状与迁移前一致（`reindexed:false, skipped:<reason>`）——门控
/// 原因在桩里判，runner 侧的 no-op 原因（no_active_index / not_in_project /
/// embed_not_ready）由 runner 原样返回。
#[tauri::command]
pub async fn codegraph_reindex_file(
    project_root: String,
    file: String,
    state: tauri::State<'_, Arc<CodeGraphService>>,
) -> Result<Value, String> {
    let svc = state.inner().clone();
    let gate_root = project_root.clone(); // project_root 本体留给 svc 调用
                                          // 门控：不信任 / 该工作区索引开关未开则跳过（读 state.json，轻量 IO）。
    let skip = tokio::task::spawn_blocking(move || {
        gate::skip_reason(
            crate::commands::workspace::is_path_trusted(&gate_root),
            crate::commands::workspace::is_codegraph_enabled_for_path(&gate_root),
        )
        .map(|reason| json!({ "reindexed": false, "skipped": reason }))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    if let Some(skip) = skip {
        return Ok(skip);
    }
    svc.reindex_file(&project_root, &file).await
}

/// Tauri command: incrementally rescan changed files (manual「更新索引」button).
#[tauri::command]
pub async fn codegraph_rescan(
    project_root: String,
    state: tauri::State<'_, Arc<CodeGraphService>>,
) -> Result<Value, String> {
    let svc = state.inner().clone();
    let gate_root = project_root.clone(); // project_root 本体留给 svc 调用
    let skip = tokio::task::spawn_blocking(move || {
        gate::skip_reason(
            crate::commands::workspace::is_path_trusted(&gate_root),
            crate::commands::workspace::is_codegraph_enabled_for_path(&gate_root),
        )
        .map(|reason| {
            json!({
                "active_index": false,
                "rescanned_files": 0,
                "skipped": reason,
            })
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    if let Some(skip) = skip {
        return Ok(skip);
    }
    svc.rescan(&project_root).await
}

/// Tauri command: poll coarse build progress.
///
/// Pure atomic reads —— runner 的 `progress` 通知持续刷新镜像，本命令照旧
/// 同步直读（freeze 硬化的一部分：inline sync 命令做纯内存工作）。前端
/// 轮询合同不变：`{ active, done, total, current, index_ready }`。
#[tauri::command]
pub fn codegraph_build_progress(
    state: tauri::State<'_, Arc<CodeGraphService>>,
) -> serde_json::Value {
    state.inner().progress_snapshot()
}
