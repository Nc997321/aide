//! CodeGraph 命令（RPC 桩，优化项二）。服务本体 [`crate::codegraph::CodeGraphService`] 住 `Core::codegraph`。
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

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use codegraph_core::types::QueryResult;

use crate::codegraph::embed_config::{load_embedder_config, query_score_threshold};
use crate::codegraph::gate;
use crate::commands::workspace::{ensure_aide_excluded, is_codegraph_enabled_for_path, is_path_trusted};
use crate::registry::{blocking, Command as HostCommand};
use crate::{command, Core};

pub static COMMANDS: &[HostCommand] = &[
    command!("codegraph_build_index", codegraph_build_index),
    command!("codegraph_goto_definition", codegraph_goto_definition),
    command!("codegraph_close", codegraph_close),
    command!("codegraph_reindex_file", codegraph_reindex_file),
    command!("codegraph_rescan", codegraph_rescan),
    command!("codegraph_build_progress", codegraph_build_progress),
];

/// 政策读（trust + 工作区开关）是这里的表达式；gate 只做纯判定。
fn skip_reason(root: &str) -> Option<&'static str> {
    gate::skip_reason(is_path_trusted(root), is_codegraph_enabled_for_path(root))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIndexArgs {
    project_root: String,
    #[serde(default)]
    force: Option<bool>,
}

/// Build (or load) the full index for a project.
///
/// 分钟级长请求：全程 await（与迁移前一致），期间进度经 runner 通知
/// 刷新镜像，前端照旧轮询 `codegraph_build_progress`。
async fn codegraph_build_index(core: Arc<Core>, a: BuildIndexArgs) -> Result<Value, String> {
    let force = a.force.unwrap_or(false);
    let ss = core.settings.clone();
    let gate_root = a.project_root.clone();
    // 政策层：门控 + embedder 配置 + proxy 探测 + .aide/ exclude——全部阻塞 IO。
    let prep = blocking(move || {
        if let Some(reason) = skip_reason(&gate_root) {
            return Ok(Err(json!({
                "loaded": false,
                "skipped": reason,
                "total_symbols": 0,
                "scanned_files": 0,
                "files_with_symbols": 0,
            })));
        }
        // 已信任工作区激活索引：顺带确保该仓库 exclude 忽略 `.aide/`——覆盖
        // 历史已信任的工作区（幂等，失败仅记日志）。
        ensure_aide_excluded(&PathBuf::from(&gate_root));
        Ok(Ok((load_embedder_config(&ss), crate::proxy::detect_proxy())))
    })
    .await?;
    let (cfg, proxy) = match prep {
        Ok(v) => v,
        Err(skip) => return Ok(skip), // 门控跳过：形状与迁移前一致
    };
    core.codegraph.build_index(&a.project_root, force, cfg, proxy).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GotoDefinitionArgs {
    word: String,
    file: String,
    line: usize,
    column: usize,
    project_root: String,
}

/// Goto-definition query. 结构层（精确、跨文件）+ 语义层都在 runner 里跑；本桩只解析
/// query-time 的分数阈值（纯过滤，改了立即生效）。
async fn codegraph_goto_definition(
    core: Arc<Core>,
    a: GotoDefinitionArgs,
) -> Result<Vec<QueryResult>, String> {
    let ss = core.settings.clone();
    let score_threshold = blocking(move || Ok(query_score_threshold(&ss))).await?;
    core.codegraph
        .goto_definition(&a.word, &a.file, a.line, a.column, &a.project_root, score_threshold)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRootArgs {
    project_root: String,
}

/// Close and flush the index for a project.
async fn codegraph_close(core: Arc<Core>, a: ProjectRootArgs) -> Result<(), String> {
    core.codegraph.close(&a.project_root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexFileArgs {
    project_root: String,
    file: String,
}

/// Incrementally re-index a single file after it is saved.
///
/// skip 响应形状与迁移前一致（`reindexed:false, skipped:<reason>`）——门控原因在桩里判，
/// runner 侧的 no-op 原因（no_active_index / not_in_project / embed_not_ready）原样返回。
async fn codegraph_reindex_file(core: Arc<Core>, a: ReindexFileArgs) -> Result<Value, String> {
    let gate_root = a.project_root.clone();
    let skip = blocking(move || {
        Ok(skip_reason(&gate_root).map(|reason| json!({ "reindexed": false, "skipped": reason })))
    })
    .await?;
    if let Some(skip) = skip {
        return Ok(skip);
    }
    core.codegraph.reindex_file(&a.project_root, &a.file).await
}

/// Incrementally rescan changed files (manual「更新索引」button).
async fn codegraph_rescan(core: Arc<Core>, a: ProjectRootArgs) -> Result<Value, String> {
    let gate_root = a.project_root.clone();
    let skip = blocking(move || {
        Ok(skip_reason(&gate_root).map(|reason| {
            json!({
                "active_index": false,
                "rescanned_files": 0,
                "skipped": reason,
            })
        }))
    })
    .await?;
    if let Some(skip) = skip {
        return Ok(skip);
    }
    core.codegraph.rescan(&a.project_root).await
}

/// Poll coarse build progress. 纯原子读——runner 的 `progress` 通知持续刷新镜像。
/// 前端轮询合同不变：`{ active, done, total, current, index_ready }`。
async fn codegraph_build_progress(
    core: Arc<Core>,
    _a: crate::commands::NoArgs,
) -> Result<Value, String> {
    Ok(core.codegraph.progress_snapshot())
}
