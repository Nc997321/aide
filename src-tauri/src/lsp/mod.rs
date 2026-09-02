//! 内置 LSP 支持。设计见 docs/superpowers/specs/2026-08-04-lsp-builtin-design.md。
//! 子模块逐 task 填充。每个 task 创建对应子模块文件后，在此取消注释其 pub mod 行。

pub mod detector;
pub mod docs;
pub mod manager;
pub mod profiles;
pub mod protocol;
pub mod registry;
pub mod rpc;
pub mod transport;

#[cfg(test)]
mod mock_server;

use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

pub use crate::lsp::manager::{EnsureError, LspManager};
pub use crate::lsp::protocol::CmCompletion;

#[derive(Debug, Serialize)]
pub struct EnsureOutcome {
    pub ok: bool,
    /// 功能就绪（区别于 ok=握手成功）。Java（jdtls）握手后仍索引中 → ready=false；
    /// 其余语言握手成功即 ready=true。前端据此在 Java 索引期显示「索引中」中间态。
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// 失败详情（spawn/handshake 的可读错误，含 stderr 摘要）。ServerNotFound 不带。
    /// 用 skip_serializing_if 保证旧前端忽略新字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 跳转类 LSP 请求（definition）的结果包装：把 ServerHandle::request() 的 RequestOutcome
/// 透传给前端，让前端区分「server 确认无结果」(Ok+空) 与「server 慢/未就绪/挂了」(其余)，
/// 据此决定 fallback codegraph 还是等/重试。其余 LSP 命令（completion/hover/...）暂不透传
/// status，保持原空行为（向后兼容），待后续渐进升级。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum JumpStatus {
    Ok,
    Timeout,
    NotReady,
    Gone,
}

#[derive(Debug, Serialize)]
pub struct LspJumpResult {
    pub status: JumpStatus,
    pub results: Vec<crate::codegraph::types::QueryResult>,
}

pub struct LspState(pub Arc<TokioMutex<LspManager>>);
impl LspState {
    pub fn new() -> Self {
        Self(Arc::new(TokioMutex::new(LspManager::new())))
    }
}

fn lang_from_id_str(s: &str) -> Option<crate::lsp::detector::LanguageId> {
    crate::lsp::detector::lang_from_id_str(s)
}

#[tauri::command]
pub async fn lsp_detect_languages(workspace_root: String) -> Result<Vec<String>, String> {
    let langs = crate::lsp::detector::detect_languages(std::path::Path::new(&workspace_root));
    Ok(langs.iter().map(|l| l.id_str().to_string()).collect())
}

#[tauri::command]
pub async fn lsp_ensure_server(
    workspace_root: String,
    lang: String,
    state: tauri::State<'_, Arc<LspState>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
    app: tauri::AppHandle,
) -> Result<EnsureOutcome, String> {
    // 信任门（spec §5.3）：与 workspace_set_lsp_enabled 同一道门。即便
    // lsp_enabled 被设过，未信任工作区也拒拉 server——untrust 后老 server
    // 自然消亡，不再 respawn。
    if !crate::commands::workspace::is_path_trusted(&workspace_root) {
        return Ok(EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("untrusted"),
            error: None,
        });
    }
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("server_not_found"),
            error: None,
        });
    };
    let settings = crate::commands::settings::public_settings(settings_service.inner())
        .map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    match mgr
        .ensure_server(&workspace_root, lang_id, &app, &settings)
        .await
    {
        Ok(h) => Ok(EnsureOutcome {
            ok: true,
            // Java 索引期 ready=false（握手成功但 jdtls 还没 ServiceReady）；其余 true。
            ready: h.ready.load(std::sync::atomic::Ordering::Relaxed),
            kind: None,
            error: None,
        }),
        Err(EnsureError::ServerNotFound) => Ok(EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("server_not_found"),
            error: None,
        }),
        Err(EnsureError::HandshakeFailed(e)) => Ok(EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("handshake_failed"),
            error: Some(e),
        }),
        Err(EnsureError::SpawnFailed(e)) => Ok(EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("spawn_failed"),
            error: Some(e),
        }),
    }
}

#[tauri::command]
pub async fn lsp_did_open(
    workspace_root: String,
    file_path: String,
    lang: String,
    text: String,
    state: tauri::State<'_, Arc<LspState>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(());
    };
    let settings = crate::commands::settings::public_settings(settings_service.inner())
        .map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    let h = match mgr
        .ensure_server(&workspace_root, lang_id, &app, &settings)
        .await
    {
        Ok(h) => h,
        Err(_) => return Ok(()),
    };
    // §5.4 排除集跳过
    if crate::lsp::manager::is_excluded(&file_path, &h.exclude_globs) {
        return Ok(());
    }
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    // 去重：文档已在 jdtls 打开（导航回退时 cmLsp 不发 didClose，文档保持打开）→
    // 跳过重发 didOpen，否则 jdtls 报 "document already open"，且省去重新解析导入绑定
    // 的秒级延迟（回退后立刻跳转才拿得到定义）。
    let already_open = {
        let mut docs = h.docs.lock().await;
        if docs.contains(&uri) {
            true
        } else {
            docs.open(uri.clone(), text.clone());
            false
        }
    };
    if already_open {
        return Ok(());
    }
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":uri,"languageId":lang,"version":1,"text":text}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_did_change(
    workspace_root: String,
    file_path: String,
    lang: String,
    text: String,
    version: Option<i64>,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(());
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(());
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    // 防御：前端漏发 did_open / 乱序时 OpenDocs::change 会 panic。未开 → 跳过，不崩。
    {
        let docs = h.docs.lock().await;
        if !docs.contains(&uri) {
            return Ok(()); // doc not open (no preceding did_open) — skip, don't panic
        }
    }
    let v = h.docs.lock().await.change(&uri, text.clone());
    let _ = version; // Full 同步：用 docs 内部 version
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":v},
                  "contentChanges":[{"text":text}]}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_did_close(
    workspace_root: String,
    file_path: String,
    lang: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(());
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(());
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    h.docs.lock().await.close(&uri);
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didClose",
        "params":{"textDocument":{"uri":uri}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_definition(
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    word: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<LspJumpResult, String> {
    // lang 识别不出 → Ok+空（前端 fallback codegraph，与今天同）。
    let lang = lang_from_ext_of(&file_path);
    let Some(lang_id) = lang else {
        return Ok(LspJumpResult {
            status: JumpStatus::Ok,
            results: vec![],
        });
    };
    let mgr = state.0.lock().await;
    // server 未起/失败 → NotReady（前端显示「未就绪」并 auto-fallback codegraph）。
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(LspJumpResult {
            status: JumpStatus::NotReady,
            results: vec![],
        });
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let outcome = h
        .request(
            "textDocument/definition",
            params,
            crate::lsp::manager::DEFINITION_TIMEOUT,
        )
        .await?;
    let (status, value) = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => (JumpStatus::Ok, v),
        crate::lsp::manager::RequestOutcome::Timeout => {
            (JumpStatus::Timeout, serde_json::Value::Null)
        }
        crate::lsp::manager::RequestOutcome::NotReady => {
            (JumpStatus::NotReady, serde_json::Value::Null)
        }
        crate::lsp::manager::RequestOutcome::ServerGone => {
            (JumpStatus::Gone, serde_json::Value::Null)
        }
    };
    // Ok+空数组 = server 确认无结果（status=Ok, results 空）→ 前端据 status=ok 走 codegraph fallback；
    // 非 Ok → results 恒空，前端据 status 决定（timeout 等/重试，not_ready/gone fallback）。
    let locs = parse_locations(&value);
    let results = crate::lsp::protocol::locations_to_query_results(&locs, &word, &workspace_root);
    Ok(LspJumpResult { status, results })
}

#[tauri::command]
pub async fn lsp_references(
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    word: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<LspJumpResult, String> {
    // 与 lsp_definition 同构（status 透传），仅 method 换为 textDocument/references
    // （符号→使用点，方向与 definition 相反）。context.includeDeclaration=false：
    // 查引用场景声明本身是噪声，前端另有自引用过滤兜底。
    let lang = lang_from_ext_of(&file_path);
    let Some(lang_id) = lang else {
        return Ok(LspJumpResult {
            status: JumpStatus::Ok,
            results: vec![],
        });
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(LspJumpResult {
            status: JumpStatus::NotReady,
            results: vec![],
        });
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)},
        "context":{"includeDeclaration":false}
    });
    let outcome = h
        .request(
            "textDocument/references",
            params,
            crate::lsp::manager::DEFINITION_TIMEOUT,
        )
        .await?;
    let (status, value) = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => (JumpStatus::Ok, v),
        crate::lsp::manager::RequestOutcome::Timeout => {
            (JumpStatus::Timeout, serde_json::Value::Null)
        }
        crate::lsp::manager::RequestOutcome::NotReady => {
            (JumpStatus::NotReady, serde_json::Value::Null)
        }
        crate::lsp::manager::RequestOutcome::ServerGone => {
            (JumpStatus::Gone, serde_json::Value::Null)
        }
    };
    let locs = parse_locations(&value);
    let results = crate::lsp::protocol::locations_to_query_results(&locs, &word, &workspace_root);
    Ok(LspJumpResult { status, results })
}

#[tauri::command]
pub async fn lsp_completion(
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<CmCompletion>, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(vec![]);
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(vec![]);
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let outcome = h
        .request(
            "textDocument/completion",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    // 向后兼容：非 Ok（timeout/notready/gone）映射 Null，parse 返空 = 旧行为；status 暂不透传。
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    let items = parse_completion_items(&result);
    Ok(crate::lsp::protocol::completion_items_to_cm(&items))
}

/// completionItem/resolve（语言无关，按扩展名分派到对应 server）：支持 resolve 的
/// server（如 jdtls）补全条目常不带文档，前端选中条目时把原始 item 回传，
/// 取回完整 detail/documentation。
/// 失败路径（server 未就绪/超时/不支持 resolve）返回 null 字段，前端 info 面板不显示。
#[tauri::command]
pub async fn lsp_completion_resolve(
    workspace_root: String,
    file_path: String,
    item: serde_json::Value,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<serde_json::Value, String> {
    let empty = serde_json::json!({"detail": null, "documentation": null});
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(empty);
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(empty);
    };
    let outcome = h
        .request(
            "completionItem/resolve",
            item,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    Ok(serde_json::json!({
        "detail": result.get("detail").and_then(|v| v.as_str()),
        "documentation": crate::lsp::protocol::extract_documentation(result.get("documentation")),
    }))
}

/// textDocument/signatureHelp（语言无关，按扩展名分派）：方法调用的参数提示。
/// 返回归一化形状（protocol::signature_help_to_view），无结果/未就绪返回 null。
#[tauri::command]
pub async fn lsp_signature_help(
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<serde_json::Value, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(serde_json::Value::Null);
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(serde_json::Value::Null);
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let outcome = h
        .request(
            "textDocument/signatureHelp",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    Ok(crate::lsp::protocol::signature_help_to_view(&result))
}

/// textDocument/semanticTokens/full（语言无关，按扩展名分派到对应 server）：
/// 语义着色 token 全量。返回归一化数组（protocol::semantic_tokens_to_view：
/// delta 解码为绝对坐标 + tokenType 字符串），无结果/未就绪/不支持 → 空数组
/// （前端据此清空装饰）。只请求 full——不做 delta 增量，前端 didChange 防抖后整刷。
#[tauri::command]
pub async fn lsp_semantic_tokens(
    workspace_root: String,
    file_path: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<serde_json::Value>, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(vec![]);
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(vec![]);
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({"textDocument": {"uri": uri}});
    let outcome = h
        .request(
            "textDocument/semanticTokens/full",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    Ok(crate::lsp::protocol::semantic_tokens_to_view(&result))
}

/// textDocument/didSave 通知（语言无关，按扩展名分派到对应 server）。
/// 部分 server（如 jdtls）的编译级诊断依赖 save 触发完整编译刷新——
/// didChange 只做增量分析，编译错误级的部分不 save 永远不出现。
/// 文档未 open（防御，同 did_change）时静默跳过。
#[tauri::command]
pub async fn lsp_did_save(
    workspace_root: String,
    file_path: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(());
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(());
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    {
        let docs = h.docs.lock().await;
        if !docs.contains(&uri) {
            return Ok(()); // doc not open — skip
        }
    }
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didSave",
        "params":{"textDocument":{"uri":uri}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_hover(
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<serde_json::Value, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(serde_json::json!({"content":null}));
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(serde_json::json!({"content":null}));
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let outcome = h
        .request(
            "textDocument/hover",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    let content = parse_hover_content(&result);
    {
        let raw: String = serde_json::to_string(&result)
            .unwrap_or_default()
            .chars()
            .take(400)
            .collect();
        eprintln!(
            "[hover] rust raw(400)={} content_some={}",
            raw,
            content.is_some()
        );
    }
    Ok(serde_json::json!({"content":content}))
}

#[tauri::command]
pub async fn lsp_implementation(
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    word: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<crate::codegraph::types::QueryResult>, String> {
    // 与 lsp_definition 同构，仅 method 换为 textDocument/implementation（父→子）。
    // 返回 Location[] → 归一为 QueryResult[]；前端据此挂向下箭头，并反推向上箭头。
    let lang = lang_from_ext_of(&file_path);
    let Some(lang_id) = lang else {
        return Ok(vec![]);
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(vec![]);
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let outcome = h
        .request(
            "textDocument/implementation",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    let locs = parse_locations(&result);
    Ok(crate::lsp::protocol::locations_to_query_results(
        &locs,
        &word,
        &workspace_root,
    ))
}

#[tauri::command]
pub async fn lsp_document_symbol(
    workspace_root: String,
    file_path: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<crate::lsp::protocol::DocumentSymbolItem>, String> {
    // 枚举文档声明符号（Class/Interface/Method/Function...），供前端筛可视区声明查 implementation。
    // 客户端已声明 hierarchicalSupport → server 多返 DocumentSymbol[]（带 children）；
    // 解析器兼容 SymbolInformation[]（扁平，有 location）兜底。
    let Some(lang_id) = lang_from_ext_of(&file_path) else {
        return Ok(vec![]);
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(vec![]);
    };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({ "textDocument":{"uri":uri} });
    let outcome = h
        .request(
            "textDocument/documentSymbol",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
    let result = match outcome {
        crate::lsp::manager::RequestOutcome::Ok(v) => v,
        _ => serde_json::Value::Null,
    };
    Ok(parse_document_symbols(&result))
}

#[tauri::command]
pub async fn lsp_capabilities(
    workspace_root: String,
    lang: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<crate::lsp::protocol::LspCapabilities, String> {
    // 按语言查 server 的可选能力开关。server 未启动 → 默认全 false（前端据 isLspOn + caps
    // 决定是否启用 gutter 标记；server 后续就绪时 watch 会 reconfigure）。
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(Default::default());
    };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else {
        return Ok(Default::default());
    };
    let caps = h.capabilities.lock().await;
    Ok(crate::lsp::protocol::LspCapabilities::from_caps(
        caps.as_ref(),
    ))
}

#[tauri::command]
pub async fn lsp_shutdown_workspace(
    workspace_root: String,
    state: tauri::State<'_, Arc<LspState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.0.lock().await.kill_workspace(&workspace_root).await;
    let _ = tauri::Emitter::emit(
        &app,
        "lsp-diagnostics",
        serde_json::json!({"workspaceRoot":workspace_root,"clear":true}),
    );
    Ok(())
}

/// 打开随包分发的 LSP 安装向导 HTML（resource_dir/lsp-install-guide.html），系统默认浏览器。
/// 同步命令（spawn start/xdg-open/open 是轻子进程），照 show_in_explorer 模式埋 trace_command。
#[tauri::command]
pub fn open_lsp_install_guide(app: tauri::AppHandle) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("open_lsp_install_guide");
    use tauri::Manager;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let html = res_dir.join("lsp-install-guide.html");
    let html = if html.exists() {
        html
    } else {
        // dev：bundle resources 不拷进 resource_dir（打包才生效），回落源码目录
        let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/lsp-install-guide.html");
        if dev.exists() {
            dev
        } else {
            return Err(format!(
                "lsp-install-guide.html not found (release: {:?}, dev: {:?})",
                html, dev
            ));
        }
    };
    // Windows 上 resource_dir 是 \\?\ verbatim 路径，传给外部进程前必须 dunce 剥前缀（CLAUDE.md 红线）
    let html = dunce::simplified(&html);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        // start 的第一个引号参数是窗口标题（空串），路径带空格也没问题
        cmd.arg("/C").arg("start").arg("").arg(&html);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：不弹控制台
        cmd.spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&html)
            .spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&html)
            .spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    Ok(())
}

// ── helpers ──

fn lang_from_ext_of(file_path: &str) -> Option<crate::lsp::detector::LanguageId> {
    let ext = file_path.rsplit('.').next().map(|e| e.to_lowercase())?;
    crate::lsp::detector::LanguageId::from_ext(&ext)
}

fn parse_locations(result: &serde_json::Value) -> Vec<lsp_types::Location> {
    use lsp_types::Location;
    if result.is_null() {
        return vec![];
    }
    if let Some(arr) = result.as_array() {
        arr.iter()
            .filter_map(|v| serde_json::from_value::<Location>(v.clone()).ok())
            .collect()
    } else {
        serde_json::from_value::<Location>(result.clone())
            .ok()
            .into_iter()
            .collect()
    }
}

/// documentSymbol 结果 → 扁平 DocumentSymbolItem[]。兼容两种形态：
/// - DocumentSymbol（有 selectionRange，可能带 children）→ 用 selectionRange.start，递归 children
/// - SymbolInformation（有 location）→ 用 location.range.start
/// 不依赖 lsp_types::DocumentSymbol（其 SymbolKind newtype 内部私有，as u32 不便），
/// 直接按 JSON 字段取，规避类型摩擦。
fn parse_document_symbols(
    result: &serde_json::Value,
) -> Vec<crate::lsp::protocol::DocumentSymbolItem> {
    let Some(arr) = result.as_array() else {
        return vec![];
    };
    let mut out = Vec::new();
    for item in arr {
        flatten_symbol(item, &mut out);
    }
    out
}

fn flatten_symbol(
    item: &serde_json::Value,
    out: &mut Vec<crate::lsp::protocol::DocumentSymbolItem>,
) {
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kind = item.get("kind").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    // DocumentSymbol 用 selectionRange.start；SymbolInformation 用 location.range.start
    let start = item
        .get("selectionRange")
        .and_then(|sr| sr.get("start"))
        .or_else(|| {
            item.get("location")
                .and_then(|l| l.get("range"))
                .and_then(|r| r.get("start"))
        });
    if let Some(start) = start {
        let line = start.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let column = start.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        out.push(crate::lsp::protocol::DocumentSymbolItem {
            name,
            kind,
            line: line + 1, // LSP 0-based → 1-based
            column: column + 1,
        });
    }
    if let Some(children) = item.get("children").and_then(|v| v.as_array()) {
        for child in children {
            flatten_symbol(child, out);
        }
    }
}

fn parse_completion_items(result: &serde_json::Value) -> Vec<lsp_types::CompletionItem> {
    if let Some(arr) = result.get("items").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|v| serde_json::from_value::<lsp_types::CompletionItem>(v.clone()).ok())
            .collect()
    } else if let Some(arr) = result.as_array() {
        arr.iter()
            .filter_map(|v| serde_json::from_value::<lsp_types::CompletionItem>(v.clone()).ok())
            .collect()
    } else {
        vec![]
    }
}

fn parse_hover_content(result: &serde_json::Value) -> Option<String> {
    let contents = result.get("contents")?;
    match contents {
        serde_json::Value::String(s) => Some(s.clone()),
        obj if obj.is_object() => obj.get("value").and_then(|v| v.as_str()).map(String::from),
        arr if arr.is_array() => {
            // MarkedString[]（LSP 旧格式，jdtls 某些场景仍用）：元素是 string 或
            // {language, value}，拼成多段。MarkupContent（{kind,value}）走上面的 object 分支。
            let parts: Vec<String> = arr
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|el| {
                    el.as_str()
                        .map(String::from)
                        .or_else(|| el.get("value").and_then(|v| v.as_str()).map(String::from))
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        _ => None,
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::manager::{build_exclude_globs, is_excluded};

    #[test]
    fn lsp_location_to_query_result_via_protocol() {
        let locs = vec![
            serde_json::from_value::<lsp_types::Location>(serde_json::json!({
                "uri": "file:///C:/p/x.rs",
                "range": {
                    "start": { "line": 3, "character": 5 },
                    "end":   { "line": 3, "character": 8 },
                }
            }))
            .unwrap(),
        ];
        let r = crate::lsp::protocol::locations_to_query_results(&locs, "foo", "C:/p");
        assert_eq!(r[0].symbol.name, "foo");
        assert_eq!(r[0].symbol.line, 4);
        assert_eq!(r[0].symbol.column, 6);
    }

    #[test]
    fn did_open_skips_excluded_paths() {
        let globs = build_exclude_globs(&vec!["generated".into()]);
        assert!(is_excluded("C:/p/generated/x.rs", &globs));
        assert!(!is_excluded("C:/p/src/main.rs", &globs));
    }

    #[test]
    fn parse_document_symbols_handles_hierarchical_and_flat() {
        // DocumentSymbol[]（带 selectionRange + children）→ 扁平化，0-based → 1-based
        let ds = serde_json::json!([
            {"name":"Foo","kind":5,
             "range":{"start":{"line":0,"character":0},"end":{"line":10,"character":0}},
             "selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":9}},
             "children":[{"name":"bar","kind":6,
                          "range":{"start":{"line":2,"character":2},"end":{"line":3,"character":2}},
                          "selectionRange":{"start":{"line":2,"character":2},"end":{"line":2,"character":5}}}]}
        ]);
        let items = parse_document_symbols(&ds);
        assert_eq!(items.len(), 2); // Foo + bar（children 扁平化）
        assert_eq!(items[0].name, "Foo");
        assert_eq!(items[0].kind, 5);
        assert_eq!(items[0].line, 1); // line 0 → 1-based 1
        assert_eq!(items[0].column, 7); // character 6 → 7
        assert_eq!(items[1].name, "bar");
        assert_eq!(items[1].kind, 6);
        assert_eq!(items[1].line, 3); // line 2 → 3

        // SymbolInformation[]（扁平，有 location）→ 用 location.range.start
        let si = serde_json::json!([
            {"name":"baz","kind":11,
             "location":{"uri":"file:///x","range":{"start":{"line":5,"character":0},"end":{"line":5,"character":3}}},
             "containerName":"Foo"}
        ]);
        let items2 = parse_document_symbols(&si);
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].name, "baz");
        assert_eq!(items2[0].kind, 11);
        assert_eq!(items2[0].line, 6); // line 5 → 6

        // null / 空数组 → 空
        assert!(parse_document_symbols(&serde_json::json!(null)).is_empty());
        assert!(parse_document_symbols(&serde_json::json!([])).is_empty());
    }

    #[test]
    fn parse_hover_content_formats() {
        // MarkupContent（新格式，jdtls 常用）：{kind, value}
        let mk = serde_json::json!({"contents":{"kind":"markdown","value":"**foo**"}});
        assert_eq!(parse_hover_content(&mk).as_deref(), Some("**foo**"));
        // MarkedString[]（旧格式）：[string, {language, value}] → 拼多段
        let arr = serde_json::json!({"contents":[{"language":"java","value":"public void foo()"},"plain"]});
        let c = parse_hover_content(&arr).unwrap();
        assert!(c.contains("public void foo()") && c.contains("plain"));
        // 纯字符串
        assert_eq!(
            parse_hover_content(&serde_json::json!({"contents":"hi"})).as_deref(),
            Some("hi")
        );
        // null / 缺 contents → None
        assert_eq!(parse_hover_content(&serde_json::Value::Null), None);
        assert_eq!(parse_hover_content(&serde_json::json!({"nope":1})), None);
        // 空数组 → None
        assert_eq!(
            parse_hover_content(&serde_json::json!({"contents":[]})),
            None
        );
    }

    #[tokio::test]
    async fn mock_end_to_end_definition() {
        let mock = crate::lsp::mock_server::spawn_mock_lsp();
        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            mock.transport_stdin,
            mock.transport_stdout,
        );
        let router = crate::lsp::rpc::Router::new();
        let table = transport.table_handle();
        let mut reader = tokio::io::BufReader::new(transport.take_reader_source().await);
        let table_r = table.clone();
        let mut framer = crate::lsp::transport::Framer::new();
        // initialize
        let (msg, id, tx, rx) = router.next_request("initialize", serde_json::json!({
            "rootUri":"file:///mock","capabilities":{},"workspaceFolders":[{"uri":"file:///mock","name":"mock"}]
        }));
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let init = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        let _ = init;
        // definition
        let (msg, id, tx, rx) = router.next_request(
            "textDocument/definition",
            serde_json::json!({
                "textDocument":{"uri":"file:///mock/main.rs"},"position":{"line":0,"character":0}
            }),
        );
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        let locs = parse_locations(&result);
        assert_eq!(locs.len(), 1);
        let qr = crate::lsp::protocol::locations_to_query_results(&locs, "sym", "/mock");
        assert_eq!(qr[0].symbol.file, "def.rs"); // 相对 mock workspace root
    }

    #[tokio::test]
    async fn mock_end_to_end_references() {
        // lsp_references 同构链路：textDocument/references（带 context.includeDeclaration）
        // → Location[] → parse_locations → locations_to_query_results（相对化+1-based）。
        let mock = crate::lsp::mock_server::spawn_mock_lsp();
        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            mock.transport_stdin,
            mock.transport_stdout,
        );
        let router = crate::lsp::rpc::Router::new();
        let table = transport.table_handle();
        let mut reader = tokio::io::BufReader::new(transport.take_reader_source().await);
        let table_r = table.clone();
        let mut framer = crate::lsp::transport::Framer::new();
        let (msg, id, tx, rx) = router.next_request("initialize", serde_json::json!({
            "rootUri":"file:///mock","capabilities":{},"workspaceFolders":[{"uri":"file:///mock","name":"mock"}]
        }));
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let _ = pump_until(&mut reader, &mut framer, &table_r, rx).await.unwrap();
        // references（与 lsp_references 命令同参形状：position 0-based + context）
        let (msg, id, tx, rx) = router.next_request(
            "textDocument/references",
            serde_json::json!({
                "textDocument":{"uri":"file:///mock/main.rs"},
                "position":{"line":2,"character":6},
                "context":{"includeDeclaration":false}
            }),
        );
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        let locs = parse_locations(&result);
        assert_eq!(locs.len(), 2);
        let qr = crate::lsp::protocol::locations_to_query_results(&locs, "sym", "/mock");
        assert_eq!(qr[0].symbol.file, "use1.rs");
        assert_eq!(qr[0].symbol.line, 6); // 0-based 5 → 1-based 6
        assert_eq!(qr[1].symbol.file, "use2.rs");
        assert_eq!(qr[1].symbol.line, 10);
    }

    async fn pump_until(
        reader: &mut tokio::io::BufReader<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
        framer: &mut crate::lsp::transport::Framer,
        table: &std::sync::Arc<tokio::sync::Mutex<crate::lsp::transport::RequestTable>>,
        mut rx: tokio::sync::oneshot::Receiver<serde_json::Value>,
    ) -> Result<serde_json::Value, ()> {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                r = &mut rx => { return r.map_err(|_| ()); }
                n = reader.read(&mut buf) => {
                    let n = n.map_err(|_| ())?;
                    if n == 0 { tokio::task::yield_now().await; continue; }
                    for msg in framer.feed(&buf[..n]) {
                        if let crate::lsp::rpc::Action::ResolveWaiter { id, result } = crate::lsp::rpc::dispatch(&msg) {
                            if let Some(tx) = table.lock().await.take(id) { let _ = tx.send(result); }
                        }
                    }
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => { return Err(()); }
            }
        }
    }

    #[test]
    fn jump_status_serializes_snake_case() {
        // 前端按字符串字面量分流（"ok"/"timeout"/"not_ready"/"gone"），snake_case 必须稳定。
        assert_eq!(serde_json::to_string(&JumpStatus::Ok).unwrap(), "\"ok\"");
        assert_eq!(
            serde_json::to_string(&JumpStatus::Timeout).unwrap(),
            "\"timeout\""
        );
        assert_eq!(
            serde_json::to_string(&JumpStatus::NotReady).unwrap(),
            "\"not_ready\""
        );
        assert_eq!(
            serde_json::to_string(&JumpStatus::Gone).unwrap(),
            "\"gone\""
        );
    }
}
