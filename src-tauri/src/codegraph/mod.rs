//! CodeGraph 主进程侧（优化项二：进程隔离后的形状）。
//!
//! 重依赖（ONNX 推理 / qdrant-edge 向量库 / tree-sitter 解析）已全部下沉到
//! 独立进程 `aide-codegraph.exe`（crates/codegraph-runner）。本目录只剩：
//!
//! - `proxy` —— `CodeGraphService`：runner 的生命周期管理（惰性拉起 / 崩溃
//!   惰性重启 / 空闲回收）+ stdio JSON-RPC 客户端 + 进度镜像。主进程对
//!   runner 的全部通信都过它——「跨层必过对账点」。
//! - `commands` —— 6 个 Tauri 命令的 RPC 桩：签名与迁移前完全一致（前端/
//!   remote-rpc 零改动），门控（trust / 工作区索引开关）与 settings 读取留
//!   在桩里——政策归主进程，runner 盲执行。
//! - `gate` —— 命令级门控判定（开关判定按工作区 key 查 state.json）。
//! - `agent_bridge` —— agent-sidecar 的 `codegraph_query` 事件解析与结果
//!   回写命令组装（sidecar 协议是主进程的合同，不进 runner）。
//! - `embed_config` —— embedder 配置 / 查询阈值：读 SettingsService，属于
//!   主进程政策层；配置序列化后随 RPC 参数传给 runner。
//!
//! `types` 从 codegraph-core re-export（lsp 层共用同一份 DTO——数据唯一主人）。

pub mod agent_bridge;
pub mod commands;
pub mod embed_config;
pub mod gate;
pub mod proxy;

pub mod types {
    pub use codegraph_core::types::*;
}

pub use proxy::CodeGraphService;

// Re-exported so `runtime/mod.rs` keeps using `crate::codegraph::query_score_threshold`.
pub(crate) use embed_config::query_score_threshold;
