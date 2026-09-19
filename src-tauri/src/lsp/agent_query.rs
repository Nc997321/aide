//! agent 查询服务层：把「工具名 + 参数」变成一次或几次 LSP 往返。
//!
//! 流程固定三步，顺序不可调换：
//!   1. **定性**（trusted / server 在不在）——不满足就早退，不白等探测
//!   2. **执行**——调 `jump::` 的公共零件；空结果时才回头探测就绪
//!   3. **判定**——`ready` 的空才是「可信的没有」，否则是「未验证」
//!
//! 任一步失败都返回**带状态的结果**，绝不返回裸空数组。

use crate::lsp::agent_readiness::{await_ready, ReadinessBudget};
use crate::lsp::agent_status::AgentLspStatus;
use crate::lsp::jump;
use crate::lsp::manager::{RequestOutcome, ServerHandle};
use crate::lsp::workspace_symbol::SymbolCandidate;
use crate::lsp::LspState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// 已解析出的查询位置（1-based，与命令行/前端一致）。
pub struct Position {
    pub file: String,
    pub line: usize,
    pub character: usize,
}

/// 按名字解析的三种结局。**`Ambiguous` 必须与 `Found` 分开**：spec 明确要求
/// 「同名多义时列出候选、要求先 Read 消歧，不假装唯一」——静默取第一个就是假装
/// 唯一，实测已咬过人（`LspManager::get` 被解析成了另一个 `get`，回来 84 处引用
/// 而非该符号的 15 处）。
enum SymbolLookup {
    Found(SymbolCandidate),
    Ambiguous(Vec<SymbolCandidate>),
    Absent,
}

/// 查询结果的返回形状 = **上线的那份 JSON**：`{ok, status, error?, count?, results?, ...}`。
/// 与 codegraph 的 `agent_query -> Value` 同形。
///
/// 曾经外面还包着一个 `AgentQueryOutcome { ok, status, payload }`，但那两个字段在 payload
/// 里各有一份副本，**而真正上线的是 payload**（`build_result_command` 只是往它上面盖
/// `cmd`/`request_id`，sidecar 也照 payload 读）——同一份值摆两处，只会漂移，且那两个
/// 字段从没被读过。现在只有一份：payload。
pub type AgentQueryOutcome = Value;

/// 显式坐标（三个字段齐全）才算数；只给名字不算。
pub fn resolve_position(args: &Value) -> Option<Position> {
    let file = args.get("file")?.as_str()?.to_string();
    let line = args.get("line")?.as_u64()? as usize;
    let character = args.get("character")?.as_u64()? as usize;
    Some(Position {
        file,
        line,
        character,
    })
}

/// `LspManager::get` → `get`。server 的符号索引按**裸名**建，带限定路径直接查会返回空
/// ——而空会被误读成「没有」，所以这里必须剥。
pub fn symbol_query_name(name: &str) -> &str {
    name.rsplit("::").next().unwrap_or(name)
}

fn fail(status: AgentLspStatus, msg: &str) -> AgentQueryOutcome {
    json!({ "ok": false, "status": status.as_str(), "error": msg })
}

/// 本次查询该为哪些语言准备 server：显式坐标 → 该文件的扩展名；只给名字 →
/// 该工作区探测到的全部语言（agent 只拿得到一个名字，没有扩展名可据以分派）。
fn target_languages(args: &Value, workspace_root: &str) -> Vec<crate::lsp::detector::LanguageId> {
    if let Some(p) = resolve_position(args) {
        return crate::lsp::lang_from_ext_of(&p.file).into_iter().collect();
    }
    crate::lsp::detector::detect_languages(std::path::Path::new(workspace_root))
}

/// agent 语义查询入口。
pub async fn run_agent_query(
    app: &AppHandle,
    tool: &str,
    args: &Value,
    workspace_root: &str,
) -> AgentQueryOutcome {
    let Some(state) = app.try_state::<Arc<LspState>>() else {
        return fail(AgentLspStatus::NoServer, "lsp state unavailable");
    };
    let state = state.inner();
    // 1. **确保 server 起来**。agent 查询可能先于编辑器到达（用户没打开过该语言的
    //    文件）——只 `mgr.get()` 会直接报 no_server，而正确行为是把它拉起来。
    let langs = target_languages(args, workspace_root);
    if langs.is_empty() {
        return fail(AgentLspStatus::NoServer, "no language detected for this query");
    }
    let mut warmed = AgentLspStatus::NoServer;
    for lang_id in &langs {
        match crate::lsp::ensure_lang(state, app, workspace_root, *lang_id).await {
            Ok(o) => {
                let s = AgentLspStatus::from_ensure(&o);
                if matches!(s, AgentLspStatus::Ready | AgentLspStatus::Indexing) {
                    warmed = s;
                    break;
                }
                warmed = s;
            }
            Err(e) => return fail(AgentLspStatus::Error, &e),
        }
    }
    if !matches!(warmed, AgentLspStatus::Ready | AgentLspStatus::Indexing) {
        return fail(warmed, "no usable language server for this workspace");
    }
    // 预热：只确保 server 起来并等到就绪，**不执行查询**。sidecar 在会话早期
    // fire-and-forget 调用它，把 46–73s 的冷启动挪出 agent 的关键路径——否则
    // agent 第一次真查询会撞上 probe_ready 的 30s 预算而只能拿到 indexing。
    if tool == "warm" {
        return warm_only(state, workspace_root, &langs).await;
    }
    // 2. 坐标
    let pos = match resolve_position(args) {
        Some(p) => p,
        None => {
            let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
                return fail(AgentLspStatus::NoSymbol, "missing `name` or `{file,line,character}`");
            };
            match lookup_symbol(state, symbol_query_name(name), workspace_root).await {
                Ok(SymbolLookup::Found(c)) => Position {
                    file: c.file_path,
                    line: c.line,
                    character: c.column,
                },
                Ok(SymbolLookup::Ambiguous(cands)) => {
                    return ambiguous_outcome(symbol_query_name(name), cands)
                }
                Ok(SymbolLookup::Absent) => {
                    return fail(
                        AgentLspStatus::NoSymbol,
                        &format!("no symbol named `{}`", symbol_query_name(name)),
                    )
                }
                Err(s) => return fail(s, "symbol lookup failed"),
            }
        }
    };
    run_jump(state, tool, &pos, workspace_root).await
}

/// 预热：逐个语言探测就绪，**不做任何查询**。
///
/// 返回 `ready` 表示至少一种语言的语义层可用；`indexing` 表示进程在但还没好
/// （调用方不关心——预热是 fire-and-forget，失败不影响对话）。
async fn warm_only(
    state: &LspState,
    workspace_root: &str,
    langs: &[crate::lsp::detector::LanguageId],
) -> AgentQueryOutcome {
    let mgr = state.0.lock().await;
    for lang_id in langs {
        let Some(h) = mgr.get(workspace_root, *lang_id).await else {
            continue;
        };
        let Some(probe_file) = first_source_file(workspace_root, *lang_id).await else {
            continue;
        };
        if probe_ready(&h, &probe_file, workspace_root).await {
            return ok_with(AgentLspStatus::Ready, vec![]);
        }
    }
    ok_with(AgentLspStatus::Indexing, vec![])
}

/// 按名字解析坐标。
///
/// `Err(Indexing)` 与 `Ok(None)` 是**两件不同的事**：前者是「没能证实到底有没有」，
/// 后者是「探测过了，索引是好的，确实没这个符号」。
///
/// **空结果不能直接断言「没有」**：冷启动时未建好索引的 server 同样回 `Ok` + 空数组。
/// 所以每个返回空的候选语言都要拿一个该语言的**真实文件**做 `documentSymbol` 探测——
/// 探测通过才计一次 `confirmed_absent`。没有靶子文件时宁可不置（保守报 indexing），
/// 也绝不误报「没这个符号」。
async fn lookup_symbol(
    state: &LspState,
    name: &str,
    workspace_root: &str,
) -> Result<SymbolLookup, AgentLspStatus> {
    let langs = crate::lsp::detector::detect_languages(std::path::Path::new(workspace_root));
    if langs.is_empty() {
        return Err(AgentLspStatus::NoServer);
    }
    let mgr = state.0.lock().await;
    let mut confirmed_absent = false;
    for lang_id in langs {
        let Some(h) = mgr.get(workspace_root, lang_id).await else {
            continue;
        };
        let params = json!({ "query": name });
        let Ok(RequestOutcome::Ok(v)) = jump::issue(
            &h,
            "workspace/symbol",
            params,
            crate::lsp::manager::DEFINITION_TIMEOUT,
        )
        .await
        else {
            continue;
        };
        let hits =
            crate::lsp::workspace_symbol::parse_workspace_symbols(&v, lang_id.id_str());
        // **第一个给出候选的语言即定案**，不跨语言合并：`get` 在 Rust 与 TS 里
        // 同时存在是常态，合并会把两个不同语言的同名符号当成「同一个符号的重载」。
        match hits.len() {
            0 => {}
            1 => return Ok(SymbolLookup::Found(hits.into_iter().next().unwrap())),
            _ => return Ok(SymbolLookup::Ambiguous(hits)),
        }
        let Some(probe_file) = first_source_file(workspace_root, lang_id).await else {
            continue; // 没靶子 → 无法证实
        };
        if probe_ready(&h, &probe_file, workspace_root).await {
            confirmed_absent = true;
        }
    }
    if confirmed_absent {
        Ok(SymbolLookup::Absent)
    } else {
        Err(AgentLspStatus::Indexing)
    }
}

/// 同名多义：**不替模型选**，把候选原样交出去 + 明确要求它先读再定。
///
/// `status` 仍是 `ready`——候选清单本身就是可信的答案；不可信的是「哪个才是你要的」，
/// 而那必须由模型读代码决定（spec 的原话：不假装唯一）。
fn ambiguous_outcome(name: &str, cands: Vec<SymbolCandidate>) -> AgentQueryOutcome {
    let n = cands.len();
    json!({
        "ok": true,
        "status": AgentLspStatus::Ready.as_str(),
        "ambiguous": true,
        "count": n,
        "candidates": cands,
        "error": format!(
            "{n} symbols named `{name}` — read them and re-query with an explicit                  {{file, line, character}} for the one you want"
        ),
    })
}

/// 找一个该语言的源文件，用作就绪探测的靶子（`probe_ready` 要一个磁盘上真实存在的文件）。
///
/// 遍历本体在 `detector::find_source_file`（有界；TS profile 判「这工作区有没有 .vue」
/// 也用它——同一套边界纪律只留一份）。**放 spawn_blocking**：遍历文件系统属重 IO，
/// 不许占 tokio worker（CLAUDE.md 的同步命令红线同理）。
async fn first_source_file(
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
) -> Option<String> {
    let root = std::path::PathBuf::from(workspace_root);
    tokio::task::spawn_blocking(move || {
        crate::lsp::detector::find_source_file(&root, lang_id)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
    })
    .await
    .ok()
    .flatten()
}

/// 执行跳转类查询。先按当前状态直接发；**只有结果为空时才回头探测就绪**
/// ——非空结果本身就是「server 可用」的铁证，探测一次都不必花。
async fn run_jump(
    state: &LspState,
    tool: &str,
    pos: &Position,
    workspace_root: &str,
) -> AgentQueryOutcome {
    let Some((lang_id, h)) = server_for(state, workspace_root, &pos.file).await else {
        // 语言认不出、或 server 没能 ensure 起来——都是「这条路径没有 server」，
        // 不是「还没好」（后者是 indexing）。两句话对用户的可操作性不同。
        return fail(AgentLspStatus::NoServer, "no language server for this file");
    };
    // **先递文件再提问**。失败不判死：RA 这类不需要 didOpen 的 server 照常能答；
    // 真答不了的会被空结果 + probe 定性成 indexing（宁可说「没答上来」，不说「没有」）。
    if let Err(e) = ensure_doc_open(&h, workspace_root, &pos.file, lang_id).await {
        tracing::debug!(file = %pos.file, error = %e, "agent lsp: didOpen 失败，继续查询");
    }
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, &pos.file);
    let (method, params) = match tool {
        "references" => (
            "textDocument/references",
            jump::references_params(&uri, pos.line, pos.character),
        ),
        "definition" => (
            "textDocument/definition",
            jump::position_params(&uri, pos.line, pos.character),
        ),
        "implementations" => (
            "textDocument/implementation",
            jump::position_params(&uri, pos.line, pos.character),
        ),
        other => return fail(AgentLspStatus::NoSymbol, &format!("unknown tool `{other}`")),
    };
    let outcome = match jump::issue(&h, method, params, crate::lsp::manager::DEFINITION_TIMEOUT).await
    {
        Ok(o) => o,
        Err(e) => return fail(AgentLspStatus::Error, &e),
    };
    let (status, results) = jump::map_outcome_absolute(outcome, "");
    if status != crate::lsp::JumpStatus::Ok || !results.is_empty() {
        // 结果非空 → ready 铁证；status 非 Ok → 直接透传（不冒充 ready）。
        let agent_status = match status {
            crate::lsp::JumpStatus::Ok => AgentLspStatus::Ready,
            crate::lsp::JumpStatus::Timeout => AgentLspStatus::Timeout,
            crate::lsp::JumpStatus::NotReady => AgentLspStatus::Indexing,
            crate::lsp::JumpStatus::Gone => AgentLspStatus::Gone,
        };
        return ok_with(agent_status, results);
    }
    // 空且 Ok —— 唯一需要探测的岔路：到底是「真没有」还是「还没索引好」。
    let confirmed = probe_ready(&h, &pos.file, workspace_root).await;
    ok_with(
        if confirmed {
            AgentLspStatus::Ready
        } else {
            AgentLspStatus::Indexing
        },
        results,
    )
}

fn ok_with(
    status: AgentLspStatus,
    results: Vec<crate::codegraph::types::QueryResult>,
) -> AgentQueryOutcome {
    // `ok` 的判据只算一次：ready（可信的否定）或结果非空（铁证）——两者都不是就是
    // 「没能回答」，`ok:false` 让 sidecar 走非 ready 的文案分支。
    let ok = status == AgentLspStatus::Ready || !results.is_empty();
    json!({
        "ok": ok,
        "status": status.as_str(),
        "count": results.len(),
        "results": results,
    })
}

/// 就绪判定：对一个**已知存在于磁盘的文件**做 `documentSymbol`。
/// 返回 true = 语义层可用（空结果可信）；false = 还没好（空结果不可信）。
async fn probe_ready(h: &Arc<ServerHandle>, file: &str, workspace_root: &str) -> bool {
    // 探测靶子也要先打开：tsserver 对没打开的文档一律回空，那会把 probe 变成**恒失败**，
    // 于是 references 的空被定性成 indexing——「面板说就绪、工具说在索引」那个坑的另一半。
    if let Some(lang) = crate::lsp::lang_from_ext_of(file) {
        let _ = ensure_doc_open(h, workspace_root, file, lang).await;
    }
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, file);
    let probe = || async {
        matches!(
            h.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                crate::lsp::manager::REQUEST_TIMEOUT,
            )
            .await,
            Ok(RequestOutcome::Ok(ref v)) if v.as_array().is_some_and(|a| !a.is_empty())
        )
    };
    await_ready(
        AgentLspStatus::Ready,
        probe,
        ReadinessBudget {
            total: std::time::Duration::from_secs(30),
            interval: std::time::Duration::from_secs(2),
        },
    )
    .await
        == AgentLspStatus::Ready
}

async fn server_for(
    state: &LspState,
    workspace_root: &str,
    file_path: &str,
) -> Option<(crate::lsp::detector::LanguageId, Arc<ServerHandle>)> {
    let lang_id = crate::lsp::lang_from_ext_of(file_path)?;
    let mgr = state.0.lock().await;
    let h = mgr.get(workspace_root, lang_id).await?;
    Some((lang_id, h))
}

/// 确保 agent 要查的文件已对 server 打开（`DocOrigin::Agent`）。
///
/// **为什么必需**：tsserver 只回答**它打开过的**文档。未 didOpen 时 `references` 与
/// `documentSymbol` 都回空数组（2026-09-19 实测，见 spike README §5）——空结果让就绪
/// 探测也跟着失败，于是整条查询路径恒报 `indexing`，而面板上那些 server 明明「就绪」。
///
/// rust-analyzer 不需要这一步（它的工程图来自 `cargo metadata`，未打开的文件照样答）。
/// C1 当时**只测了 RA**，于是「按需 didOpen」被记为不实施，并写下触发条件：
/// 「某个语言上观察到 references 恒为空且 probe 恒失败」——TS 正是那个反例，条件已到。
///
/// 标 `Agent` 是因为这些文档用户多半没打开过：它们的诊断由推送侧挡在 UI 之外
/// （见 manager 的 `EmitDiagnostics` 分支）。
async fn ensure_doc_open(
    h: &Arc<ServerHandle>,
    workspace_root: &str,
    file_path: &str,
    lang_id: crate::lsp::detector::LanguageId,
) -> Result<(), String> {
    if crate::lsp::manager::is_excluded(file_path, &h.exclude_globs) {
        return Err("path is in the workspace exclude list".to_string());
    }
    // 读盘放 spawn_blocking：文件 IO 不占 tokio worker（与同步命令红线同一条纪律）。
    let path = file_path.to_string();
    let text = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, file_path);
    h.open_doc(
        &uri,
        lang_id.id_str(),
        text,
        crate::lsp::docs::DocOrigin::Agent,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_position_wins() {
        let p = resolve_position(&json!({"file":"/a/b.rs","line":216,"character":19})).unwrap();
        assert_eq!(p.file, "/a/b.rs");
        assert_eq!(p.line, 216);
        assert_eq!(p.character, 19);
    }

    #[test]
    fn bare_name_is_not_a_position() {
        assert!(resolve_position(&json!({"name":"LspManager::get"})).is_none());
    }

    #[test]
    fn partial_position_is_rejected() {
        assert!(resolve_position(&json!({"file":"/a/b.rs","line":1})).is_none());
    }

    /// 名字里带 `::` 时取最后一段做 workspace/symbol 的 query——
    /// server 的符号索引按裸名建，`LspManager::get` 直接查会空。
    #[test]
    fn symbol_query_name_takes_last_segment() {
        assert_eq!(symbol_query_name("LspManager::get"), "get");
        assert_eq!(symbol_query_name("is_excluded"), "is_excluded");
        assert_eq!(symbol_query_name("a::b::c"), "c");
    }

    /// 空 results 时 `ok` 必须是 false——`ok:true` + 空会被读成「查到了，就是没有」。
    #[test]
    fn empty_results_never_claim_ok_unless_ready() {
        let indexing = ok_with(AgentLspStatus::Indexing, vec![]);
        assert_eq!(indexing["ok"], false);
        assert_eq!(indexing["status"], "indexing");

        let ready = ok_with(AgentLspStatus::Ready, vec![]);
        assert_eq!(ready["ok"], true, "ready + 空 = 可信的「没有」");
    }

    /// 回包就是**上线的那份 JSON**——`lsp_agent` 只往它上面盖 `cmd`/`request_id`，
    /// sidecar 按名读这些键。少了任何一个都是**静默**降级（状态或结果变 undefined，
    /// 文案走兜底分支、不报错），所以键集在这里钉住。
    #[test]
    fn wire_shape_keeps_the_keys_the_sidecar_reads() {
        let ok = ok_with(AgentLspStatus::Ready, vec![]);
        assert_eq!(ok["count"], 0);
        for key in ["ok", "status", "count", "results"] {
            assert!(ok.get(key).is_some(), "成功回包缺 key `{key}`：{ok}");
        }

        let f = fail(AgentLspStatus::Timeout, "boom");
        for key in ["ok", "status", "error"] {
            assert!(f.get(key).is_some(), "失败回包缺 key `{key}`：{f}");
        }

        let amb = ambiguous_outcome("get", vec![]);
        for key in ["ok", "status", "ambiguous", "count", "candidates"] {
            assert!(amb.get(key).is_some(), "歧义回包缺 key `{key}`：{amb}");
        }
        assert_eq!(amb["status"], "ready", "候选清单本身是可信答案");
    }
}
