//! 内置 LSP 支持。设计见 docs/superpowers/specs/2026-08-04-lsp-builtin-design.md。
//! 状态住 `Core::lsp`；命令表 [`COMMANDS`]（编辑器用）+ `workspace_symbol::COMMANDS`。

pub mod agent_bridge;
pub mod agent_nav;
pub mod agent_query;
pub mod agent_readiness;
pub mod agent_status;
pub mod detector;
pub mod docs;
pub mod jump;
pub mod manager;
pub mod profiles;
pub mod protocol;
pub mod registry;
pub mod rpc;
pub mod transport;
pub mod vue_plugin;
pub mod workspace_access;
pub mod workspace_langs;
pub mod workspace_symbol;

pub static COMMANDS: &[HostCommand] = &[
    command!("lsp_detect_languages", lsp_detect_languages),
    command!("lsp_ensure_server", lsp_ensure_server),
    command!("lsp_did_open", lsp_did_open),
    command!("lsp_did_change", lsp_did_change),
    command!("lsp_did_close", lsp_did_close),
    command!("lsp_definition", lsp_definition),
    command!("lsp_references", lsp_references),
    command!("lsp_call_hierarchy", lsp_call_hierarchy),
    command!("lsp_completion", lsp_completion),
    command!("lsp_completion_resolve", lsp_completion_resolve),
    command!("lsp_signature_help", lsp_signature_help),
    command!("lsp_semantic_tokens", lsp_semantic_tokens),
    command!("lsp_inlay_hints", lsp_inlay_hints),
    command!("lsp_did_save", lsp_did_save),
    command!("lsp_hover", lsp_hover),
    command!("lsp_implementation", lsp_implementation),
    command!("lsp_document_symbol", lsp_document_symbol),
    command!("lsp_capabilities", lsp_capabilities),
    command!("lsp_shutdown_workspace", lsp_shutdown_workspace),
];

#[cfg(test)]
mod mock_server;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::registry::Command as HostCommand;
use crate::{command, Core};

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

    /// 退出清理：全量杀掉所有 LSP server（托盘「退出 Aide」的唯一调用点）。
    pub async fn kill_all(&self) {
        self.0.lock().await.kill_all().await;
    }
}

fn lang_from_id_str(s: &str) -> Option<crate::lsp::detector::LanguageId> {
    crate::lsp::detector::lang_from_id_str(s)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDetectLanguagesArgs {
    workspace_root: String,
}

async fn lsp_detect_languages(
    _core: Arc<Core>,
    a: LspDetectLanguagesArgs,
) -> Result<Vec<String>, String> {
    let LspDetectLanguagesArgs { workspace_root } = a;
    {
        // 探测要下钻（子目录 marker + 有界扩展名遍历）= 文件系统 IO：本机走 async 外壳不占
        // tokio worker；远程工作区在目标机上探测（WorkspaceAccess）。
        let access = crate::lsp::workspace_access::WorkspaceAccess::of(&workspace_root);
        let langs = access.detect_languages(&workspace_root).await;
        Ok(langs.iter().map(|l| l.id_str().to_string()).collect())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspEnsureServerArgs {
    workspace_root: String,
    lang: String,
}

async fn lsp_ensure_server(
    core: Arc<Core>,
    a: LspEnsureServerArgs,
) -> Result<EnsureOutcome, String> {
    let LspEnsureServerArgs {
        workspace_root,
        lang,
    } = a;
    let state = core.lsp.clone();
    let settings_service = core.settings.clone();
    let app = core.clone();
    {
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
        let settings =
            crate::app_settings::public_settings(&settings_service).map_err(|e| e.to_string())?;
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
            Err(e) => Ok(ensure_err_to_outcome(e)),
        }
    }
}

/// `ensure_server` 的 Err → `EnsureOutcome`。**命令与 agent 查询共用这段映射**
/// ——两份实现迟早漂移，而"server_not_found 该不该报成 no_server"正是要一致的东西。
pub(crate) fn ensure_err_to_outcome(e: EnsureError) -> EnsureOutcome {
    match e {
        EnsureError::ServerNotFound => EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("server_not_found"),
            error: None,
        },
        EnsureError::HandshakeFailed(msg) => EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("handshake_failed"),
            error: Some(msg),
        },
        EnsureError::SpawnFailed(msg) => EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("spawn_failed"),
            error: Some(msg),
        },
    }
}

/// 一个(工作区, 语言)的 server 是否已可用——**带 ensure**，不是只看 `mgr.get()`。
///
/// 存在的理由：agent 查询可能先于编辑器到达（用户没打开过该语言的文件），
/// 只 `get()` 会直接报 no_server，而正确行为是把 server 拉起来。
/// 信任门在内：未信任工作区一律 untrusted，即便调用方忘了查。
pub(crate) async fn ensure_lang(
    core: &crate::Core,
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
) -> Result<EnsureOutcome, String> {
    if !crate::commands::workspace::is_path_trusted(workspace_root) {
        return Ok(EnsureOutcome {
            ok: false,
            ready: false,
            kind: Some("untrusted"),
            error: None,
        });
    }
    let settings = crate::app_settings::public_settings(&core.settings)?;
    let mgr = core.lsp.0.lock().await;
    Ok(
        match mgr
            .ensure_server(workspace_root, lang_id, core, &settings)
            .await
        {
            Ok(h) => EnsureOutcome {
                ok: true,
                ready: h.ready.load(std::sync::atomic::Ordering::Relaxed),
                kind: None,
                error: None,
            },
            Err(e) => ensure_err_to_outcome(e),
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDidOpenArgs {
    workspace_root: String,
    file_path: String,
    lang: String,
    text: String,
}

async fn lsp_did_open(core: Arc<Core>, a: LspDidOpenArgs) -> Result<(), String> {
    let LspDidOpenArgs {
        workspace_root,
        file_path,
        lang,
        text,
    } = a;
    let state = core.lsp.clone();
    let settings_service = core.settings.clone();
    let app = core.clone();
    {
        let Some(lang_id) = lang_from_id_str(&lang) else {
            return Ok(());
        };
        let settings =
            crate::app_settings::public_settings(&settings_service).map_err(|e| e.to_string())?;
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
        // 文档 languageId **由文件形态推**，不透明传前端那个字符串（它是服务 id）：
        // `.vue` 要发 "vue"（TS 插件声明的 id）、`.tsx` 要发 "typescriptreact"，发错
        // 前者 TLS 丢弃文档、后者按 TS 解析（见 `detector::document_lang_id`）。
        let doc_lang = crate::lsp::detector::document_lang_id(&file_path, lang_id);
        // 去重与通知组装都在 `open_doc` 里——与 agent 查询路径**共用同一份**（唯一区别是
        // 来源标记）。这里标 `Editor`：用户真开着这个文件，它的诊断/通知该进 UI。
        h.open_doc(&uri, doc_lang, text, crate::lsp::docs::DocOrigin::Editor)
            .await
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDidChangeArgs {
    workspace_root: String,
    file_path: String,
    lang: String,
    text: String,
    #[serde(default)]
    version: Option<i64>,
}

async fn lsp_did_change(core: Arc<Core>, a: LspDidChangeArgs) -> Result<(), String> {
    let LspDidChangeArgs {
        workspace_root,
        file_path,
        lang,
        text,
        version,
    } = a;
    let state = core.lsp.clone();
    {
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
                         // 帧形状与 agent 路径共用（见 manager::did_change_notif）。
        let notif = crate::lsp::manager::did_change_notif(&uri, v, &text);
        h.transport.send(&notif).await.map_err(|e| e.to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDidCloseArgs {
    workspace_root: String,
    file_path: String,
    lang: String,
}

async fn lsp_did_close(core: Arc<Core>, a: LspDidCloseArgs) -> Result<(), String> {
    let LspDidCloseArgs {
        workspace_root,
        file_path,
        lang,
    } = a;
    let state = core.lsp.clone();
    {
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDefinitionArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    word: String,
}

async fn lsp_definition(core: Arc<Core>, a: LspDefinitionArgs) -> Result<LspJumpResult, String> {
    let LspDefinitionArgs {
        workspace_root,
        file_path,
        line,
        column,
        word,
    } = a;
    let state = core.lsp.clone();
    {
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
        let params = crate::lsp::jump::position_params(&uri, line, column);
        let outcome = crate::lsp::jump::issue(
            &h,
            "textDocument/definition",
            params,
            crate::lsp::manager::DEFINITION_TIMEOUT,
        )
        .await?;
        // Ok+空数组 = server 确认无结果（status=Ok, results 空）→ 前端据 status=ok 走 codegraph fallback；
        // 非 Ok → results 恒空，前端据 status 决定（timeout 等/重试，not_ready/gone fallback）。
        let (status, results) = crate::lsp::jump::map_outcome(outcome, &word, &workspace_root);
        Ok(LspJumpResult { status, results })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspReferencesArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    word: String,
}

async fn lsp_references(core: Arc<Core>, a: LspReferencesArgs) -> Result<LspJumpResult, String> {
    let LspReferencesArgs {
        workspace_root,
        file_path,
        line,
        column,
        word,
    } = a;
    let state = core.lsp.clone();
    {
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
        let params = crate::lsp::jump::references_params(&uri, line, column);
        let outcome = crate::lsp::jump::issue(
            &h,
            "textDocument/references",
            params,
            crate::lsp::manager::DEFINITION_TIMEOUT,
        )
        .await?;
        let (status, results) = crate::lsp::jump::map_outcome(outcome, &word, &workspace_root);
        Ok(LspJumpResult { status, results })
    }
}

/// 调用层级（callHierarchy）结果包装：root = prepare 到的层级根（prepare 空 → None，
/// 前端据此提示「该符号不支持调用层级」——类名/局部变量等不可调用符号）；nodes = 根的
/// 第一层调用方/被调用方。树形展开由前端逐层递归调用本命令实现（查询点 = 子节点声明位置）。
#[derive(Debug, Serialize)]
pub struct CallHierarchyResult {
    pub status: JumpStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<crate::lsp::protocol::CallHierarchyNode>,
    pub nodes: Vec<crate::lsp::protocol::CallHierarchyNode>,
}

/// 查调用层级（语言无关，按扩展名分派）：prepareCallHierarchy 拿层级根 →
/// callHierarchy/incomingCalls | outgoingCalls 展开一层。两段请求，任一段超时/未就绪
/// 整体透传 status（root 可能已就位——前端保留展示并提示重试）。
/// prepare 返回多 item（重载等罕见场景）取第一个；v1 不做根选择 UI。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallHierarchyArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    direction: String,
}

async fn lsp_call_hierarchy(
    core: Arc<Core>,
    a: LspCallHierarchyArgs,
) -> Result<CallHierarchyResult, String> {
    let LspCallHierarchyArgs {
        workspace_root,
        file_path,
        line,
        column,
        direction,
    } = a;
    let state = core.lsp.clone();
    {
        let dir = match direction.as_str() {
            "incoming" | "outgoing" => direction.as_str(),
            _ => return Err(format!("invalid direction: {direction}")),
        };
        let lang = lang_from_ext_of(&file_path);
        let Some(lang_id) = lang else {
            return Ok(CallHierarchyResult {
                status: JumpStatus::Ok,
                root: None,
                nodes: vec![],
            });
        };
        let mgr = state.0.lock().await;
        let Some(h) = mgr.get(&workspace_root, lang_id).await else {
            return Ok(CallHierarchyResult {
                status: JumpStatus::NotReady,
                root: None,
                nodes: vec![],
            });
        };
        let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
        let prepare_params = serde_json::json!({
            "textDocument":{"uri":uri},
            "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
        });
        let empty_result = |status: JumpStatus| CallHierarchyResult {
            status,
            root: None,
            nodes: vec![],
        };
        // 1. prepare：拿层级根 item（原样 JSON——展开请求要带 data 回传 server）
        let outcome = h
            .request(
                "textDocument/prepareCallHierarchy",
                prepare_params,
                crate::lsp::manager::DEFINITION_TIMEOUT,
            )
            .await?;
        let prepare_value = match outcome {
            crate::lsp::manager::RequestOutcome::Ok(v) => v,
            crate::lsp::manager::RequestOutcome::Timeout => {
                return Ok(empty_result(JumpStatus::Timeout))
            }
            crate::lsp::manager::RequestOutcome::NotReady => {
                return Ok(empty_result(JumpStatus::NotReady))
            }
            // server 拒答：与「没就绪」同类——空结果不是「没有子节点」的证据。
            crate::lsp::manager::RequestOutcome::ServerError(_) => {
                return Ok(empty_result(JumpStatus::NotReady))
            }
            crate::lsp::manager::RequestOutcome::ServerGone => {
                return Ok(empty_result(JumpStatus::Gone))
            }
        };
        let items = crate::lsp::protocol::prepare_call_hierarchy_items(&prepare_value);
        let Some(root_item) = items.into_iter().next() else {
            // server 确认该位置不是可调用符号（类名/字段等）→ Ok + root None
            return Ok(empty_result(JumpStatus::Ok));
        };
        let root = crate::lsp::protocol::call_hierarchy_item_to_node(&root_item, &workspace_root);
        // 2. 方向展开：item 原样回传（保 data）
        let call_params = serde_json::json!({"item": root_item});
        let method = if dir == "outgoing" {
            "callHierarchy/outgoingCalls"
        } else {
            "callHierarchy/incomingCalls"
        };
        let outcome = h
            .request(method, call_params, crate::lsp::manager::DEFINITION_TIMEOUT)
            .await?;
        let (status, value) = match outcome {
            crate::lsp::manager::RequestOutcome::Ok(v) => (JumpStatus::Ok, v),
            crate::lsp::manager::RequestOutcome::Timeout => {
                (JumpStatus::Timeout, serde_json::Value::Null)
            }
            crate::lsp::manager::RequestOutcome::NotReady => {
                (JumpStatus::NotReady, serde_json::Value::Null)
            }
            // server 拒答：同 NotReady（空结果不是证据）。
            crate::lsp::manager::RequestOutcome::ServerError(_) => {
                (JumpStatus::NotReady, serde_json::Value::Null)
            }
            crate::lsp::manager::RequestOutcome::ServerGone => {
                (JumpStatus::Gone, serde_json::Value::Null)
            }
        };
        let nodes =
            crate::lsp::protocol::call_hierarchy_calls_to_nodes(&value, dir, &workspace_root);
        Ok(CallHierarchyResult {
            status,
            root: Some(root),
            nodes,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
}

async fn lsp_completion(
    core: Arc<Core>,
    a: LspCompletionArgs,
) -> Result<Vec<CmCompletion>, String> {
    let LspCompletionArgs {
        workspace_root,
        file_path,
        line,
        column,
    } = a;
    let state = core.lsp.clone();
    {
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
}

/// completionItem/resolve（语言无关，按扩展名分派到对应 server）：支持 resolve 的
/// server（如 jdtls）补全条目常不带文档，前端选中条目时把原始 item 回传，
/// 取回完整 detail/documentation。
/// 失败路径（server 未就绪/超时/不支持 resolve）返回 null 字段，前端 info 面板不显示。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionResolveArgs {
    workspace_root: String,
    file_path: String,
    item: serde_json::Value,
}

async fn lsp_completion_resolve(
    core: Arc<Core>,
    a: LspCompletionResolveArgs,
) -> Result<serde_json::Value, String> {
    let LspCompletionResolveArgs {
        workspace_root,
        file_path,
        item,
    } = a;
    let state = core.lsp.clone();
    {
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
}

/// textDocument/signatureHelp（语言无关，按扩展名分派）：方法调用的参数提示。
/// 返回归一化形状（protocol::signature_help_to_view），无结果/未就绪返回 null。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureHelpArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
}

async fn lsp_signature_help(
    core: Arc<Core>,
    a: LspSignatureHelpArgs,
) -> Result<serde_json::Value, String> {
    let LspSignatureHelpArgs {
        workspace_root,
        file_path,
        line,
        column,
    } = a;
    let state = core.lsp.clone();
    {
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
}

/// textDocument/semanticTokens/full（语言无关，按扩展名分派到对应 server）：
/// 语义着色 token 全量。返回归一化数组（protocol::semantic_tokens_to_view：
/// delta 解码为绝对坐标 + tokenType 字符串），无结果/未就绪/不支持 → 空数组
/// （前端据此清空装饰）。只请求 full——不做 delta 增量，前端 didChange 防抖后整刷。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSemanticTokensArgs {
    workspace_root: String,
    file_path: String,
}

async fn lsp_semantic_tokens(
    core: Arc<Core>,
    a: LspSemanticTokensArgs,
) -> Result<Vec<serde_json::Value>, String> {
    let LspSemanticTokensArgs {
        workspace_root,
        file_path,
    } = a;
    let state = core.lsp.clone();
    {
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
}

/// 查 inlay hints（语言无关，按扩展名分派）：参数名/类型提示。params 必带 range
/// （协议要求），前端传可视区行范围（1-based 含头含尾）→ 此处转 0-based：end 行取
/// to_line 使 0-based end 落在「1-based to_line 的下一行行首」= 覆盖 to_line 整行。
/// 非 Ok（timeout/notready/gone）映射空（装饰类请求静默，同 semanticTokens）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInlayHintsArgs {
    workspace_root: String,
    file_path: String,
    from_line: usize,
    to_line: usize,
}

async fn lsp_inlay_hints(
    core: Arc<Core>,
    a: LspInlayHintsArgs,
) -> Result<Vec<crate::lsp::protocol::InlayHintItem>, String> {
    let LspInlayHintsArgs {
        workspace_root,
        file_path,
        from_line,
        to_line,
    } = a;
    let state = core.lsp.clone();
    {
        let Some(lang_id) = lang_from_ext_of(&file_path) else {
            return Ok(vec![]);
        };
        let mgr = state.0.lock().await;
        let Some(h) = mgr.get(&workspace_root, lang_id).await else {
            return Ok(vec![]);
        };
        // 握手已完成且 server 未声明 inlayHintProvider → 早退不发请求（读握手结果，
        // 语言无关；跳转类请求有明确「确认无定义」语义需发请求，装饰类高频请求则以
        // capability 短路省钱）。握手未完成（None）不早退——走正常请求路径由 server
        // 回 NotInitialized，前端退避重试兜底。
        {
            let caps = h.capabilities.lock().await;
            if let Some(raw) = caps.as_ref() {
                if !crate::lsp::protocol::LspCapabilities::from_caps(Some(raw)).inlay_hint_provider
                {
                    return Ok(vec![]);
                }
            }
        }
        let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
        let params = serde_json::json!({
            "textDocument": {"uri": uri},
            "range": {
                "start": {"line": (from_line as u64).saturating_sub(1), "character": 0},
                "end": {"line": to_line as u64, "character": 0}
            }
        });
        let outcome = h
            .request(
                "textDocument/inlayHint",
                params,
                crate::lsp::manager::REQUEST_TIMEOUT,
            )
            .await?;
        let result = match outcome {
            crate::lsp::manager::RequestOutcome::Ok(v) => v,
            _ => serde_json::Value::Null,
        };
        Ok(crate::lsp::protocol::inlay_hints_to_view(&result))
    }
}

/// textDocument/didSave 通知（语言无关，按扩展名分派到对应 server）。
/// 部分 server（如 jdtls）的编译级诊断依赖 save 触发完整编译刷新——
/// didChange 只做增量分析，编译错误级的部分不 save 永远不出现。
/// 文档未 open（防御，同 did_change）时静默跳过。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDidSaveArgs {
    workspace_root: String,
    file_path: String,
}

async fn lsp_did_save(core: Arc<Core>, a: LspDidSaveArgs) -> Result<(), String> {
    let LspDidSaveArgs {
        workspace_root,
        file_path,
    } = a;
    let state = core.lsp.clone();
    {
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
}

async fn lsp_hover(core: Arc<Core>, a: LspHoverArgs) -> Result<serde_json::Value, String> {
    let LspHoverArgs {
        workspace_root,
        file_path,
        line,
        column,
    } = a;
    let state = core.lsp.clone();
    {
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspImplementationArgs {
    workspace_root: String,
    file_path: String,
    line: usize,
    column: usize,
    word: String,
}

async fn lsp_implementation(
    core: Arc<Core>,
    a: LspImplementationArgs,
) -> Result<Vec<crate::codegraph::types::QueryResult>, String> {
    let LspImplementationArgs {
        workspace_root,
        file_path,
        line,
        column,
        word,
    } = a;
    let state = core.lsp.clone();
    {
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
        let params = crate::lsp::jump::position_params(&uri, line, column);
        let outcome = crate::lsp::jump::issue(
            &h,
            "textDocument/implementation",
            params,
            crate::lsp::manager::REQUEST_TIMEOUT,
        )
        .await?;
        // 历史行为：implementation **不透传 status**，非 Ok 一律当空结果（见 JumpStatus
        // 注释「其余命令保持原空行为，向后兼容」）。故丢掉 status 只取 results——与重构前等价。
        let (_, results) = crate::lsp::jump::map_outcome(outcome, &word, &workspace_root);
        Ok(results)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbolArgs {
    workspace_root: String,
    file_path: String,
}

async fn lsp_document_symbol(
    core: Arc<Core>,
    a: LspDocumentSymbolArgs,
) -> Result<Vec<crate::lsp::protocol::DocumentSymbolItem>, String> {
    let LspDocumentSymbolArgs {
        workspace_root,
        file_path,
    } = a;
    let state = core.lsp.clone();
    {
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCapabilitiesArgs {
    workspace_root: String,
    lang: String,
}

async fn lsp_capabilities(
    core: Arc<Core>,
    a: LspCapabilitiesArgs,
) -> Result<crate::lsp::protocol::LspCapabilities, String> {
    let LspCapabilitiesArgs {
        workspace_root,
        lang,
    } = a;
    let state = core.lsp.clone();
    {
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspShutdownWorkspaceArgs {
    workspace_root: String,
}

async fn lsp_shutdown_workspace(
    core: Arc<Core>,
    a: LspShutdownWorkspaceArgs,
) -> Result<(), String> {
    let LspShutdownWorkspaceArgs { workspace_root } = a;
    let state = core.lsp.clone();
    {
        state.0.lock().await.kill_workspace(&workspace_root).await;
        core.emit(
            "lsp-diagnostics",
            serde_json::json!({"workspaceRoot":workspace_root,"clear":true}),
        );
        Ok(())
    }
}

// ── helpers ──

pub(crate) fn lang_from_ext_of(file_path: &str) -> Option<crate::lsp::detector::LanguageId> {
    let ext = file_path.rsplit('.').next().map(|e| e.to_lowercase())?;
    crate::lsp::detector::LanguageId::from_ext(&ext)
}

pub(crate) fn parse_locations(result: &serde_json::Value) -> Vec<lsp_types::Location> {
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
        let _ = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
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

    #[tokio::test]
    async fn mock_end_to_end_call_hierarchy() {
        // lsp_call_hierarchy 两段链路：prepareCallHierarchy → 根 item（含 data）→
        // callHierarchy/incomingCalls（item 原样回传）→ from/fromRanges → 树节点归一化。
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
        let _ = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        // 1. prepare（与 lsp_call_hierarchy 命令同参形状：position 0-based）
        let (msg, id, tx, rx) = router.next_request(
            "textDocument/prepareCallHierarchy",
            serde_json::json!({
                "textDocument":{"uri":"file:///mock/main.rs"},
                "position":{"line":638,"character":7}
            }),
        );
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let prep = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        let items = crate::lsp::protocol::prepare_call_hierarchy_items(&prep);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["data"]["ctx"], 42); // data 原样保留
        let root = crate::lsp::protocol::call_hierarchy_item_to_node(&items[0], "/mock");
        assert_eq!(root.name, "init_handshake");
        assert_eq!(root.file, "main.rs");
        assert_eq!(root.line, 639); // 0-based 638 → 1-based
                                    // 2. incoming 展开（item 原样回传——保 data）
        let (msg, id, tx, rx) = router.next_request(
            "callHierarchy/incomingCalls",
            serde_json::json!({"item": items[0]}),
        );
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        let nodes =
            crate::lsp::protocol::call_hierarchy_calls_to_nodes(&result, "incoming", "/mock");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "spawn_and_init");
        assert_eq!(nodes[0].line, 269);
        assert_eq!(nodes[0].call_sites.len(), 2);
        assert_eq!(nodes[0].call_sites[0].line, 287);
        assert_eq!(nodes[0].call_sites[1].column, 10);
    }

    #[tokio::test]
    async fn mock_end_to_end_inlay_hints() {
        // lsp_inlay_hints 同构链路：textDocument/inlayHint（params 必带 range，
        // 1-based 含头含尾 → 0-based）→ InlayHint[] → inlay_hints_to_view
        // （parts 拼接 / kind 过滤 / 1-based / padding 透传）。
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
        let _ = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        // inlayHint（与 lsp_inlay_hints 命令同参形状：可视区 1-based 3..=5 →
        // start.line=2、end.line=5 覆盖整段）
        let (msg, id, tx, rx) = router.next_request(
            "textDocument/inlayHint",
            serde_json::json!({
                "textDocument":{"uri":"file:///mock/main.rs"},
                "range":{
                    "start":{"line":2,"character":0},
                    "end":{"line":5,"character":0}
                }
            }),
        );
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = pump_until(&mut reader, &mut framer, &table_r, rx)
            .await
            .unwrap();
        let hints = crate::lsp::protocol::inlay_hints_to_view(&result);
        // mock 3 条中 kind=9 规范外 → 归一化后 2 条
        assert_eq!(hints.len(), 2);
        assert_eq!(hints[0].kind, "param");
        assert_eq!(hints[0].label, "count: "); // parts 扁平拼接
        assert_eq!(hints[0].line, 3); // 0-based 2 → 1-based
        assert_eq!(hints[0].column, 9);
        assert!(hints[0].padding_left);
        assert!(hints[0].padding_right);
        assert_eq!(hints[1].kind, "type");
        assert_eq!(hints[1].label, "usize");
        assert_eq!(hints[1].line, 4);
        assert_eq!(hints[1].column, 5);
        assert!(hints[1].padding_left);
        assert!(!hints[1].padding_right);
    }

    /// 把 mock server 的帧读进来，直到 waiter 结算。
    /// `WaiterReply` 里的 `Err`（server 拒答）在这里**直接判用例失败**：这些用例全走
    /// happy path，真收到拒答就是链路坏了——错误原文比 `unwrap()` 的 panic 更能说明问题。
    async fn pump_until(
        reader: &mut tokio::io::BufReader<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
        framer: &mut crate::lsp::transport::Framer,
        table: &std::sync::Arc<tokio::sync::Mutex<crate::lsp::transport::RequestTable>>,
        mut rx: tokio::sync::oneshot::Receiver<crate::lsp::transport::WaiterReply>,
    ) -> Result<serde_json::Value, ()> {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                r = &mut rx => {
                    return match r {
                        Ok(Ok(v)) => Ok(v),
                        Ok(Err(msg)) => panic!("mock server refused the request: {msg}"),
                        Err(_) => Err(()),
                    };
                }
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
