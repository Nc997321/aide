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
use crate::lsp::workspace_access::WorkspaceAccess;
use crate::lsp::workspace_symbol::SymbolCandidate;
use crate::lsp::LspState;
use serde_json::{json, Value};
use std::sync::Arc;

/// 已解析出的查询位置（1-based，与命令行/前端一致）。
pub struct Position {
    pub file: String,
    pub line: usize,
    pub character: usize,
}

/// 按名字解析的结局。**`Ambiguous` 必须与 `Found` 分开**：spec 明确要求
/// 「同名多义时列出候选、要求先 Read 消歧，不假装唯一」——静默取第一个就是假装
/// 唯一，实测已咬过人（`LspManager::get` 被解析成了另一个 `get`，回来 84 处引用
/// 而非该符号的 15 处）。
enum SymbolLookup {
    Found(SymbolCandidate),
    Ambiguous(Vec<SymbolCandidate>),
    /// 没能给出可信答案——**按名查询只有这一个否定出口**。
    ///
    /// 为什么没有「确认没有」：我们**证明不了「符号索引覆盖了整个工作区」**。真机实测
    /// （2026-09-19，三次 E2E + probe-navto）：
    ///   - 只递根层 `vite.config.ts`（属于只含它一个文件的 `tsconfig.node.json`）→
    ///     `workspace/symbol` 20s 也回空；
    ///   - 递 `src/*.test.ts`（被 `exclude` 排除，走单文件推断工程）→ 同样回空；
    ///   - 而就绪探针（documentSymbol 探**已递过的**文件）每一次都过。
    /// 也就是说空结果可能只是「那个文件所在的工程没加载」，而没有任何 LSP 信号能证明
    /// 加载完成。既证明不了，就不许说「没有」——这正是本条红线的意思。
    Unverified { silent: Vec<(&'static str, String)> },
}

/// 单个候选语言的答复（裁决前）。
enum Consulted {
    /// 该语言不在本工具的服务范围内（server 没装）：不问，也不进文案。
    OutOfScope,
    /// 命中若干候选——1 个 = Found、多个 = Ambiguous，由调用方定案。
    Hits(Vec<SymbolCandidate>),
    /// 没答上 / 答了空 / 拒答：**都不是「没有」的证据**。带原因（原因会进模型看到的文案）。
    Silent(String),
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
/// 探测本身是文件系统遍历，走 async 外壳（不占 tokio worker——与 `first_source_files` 同一条纪律）。
async fn target_languages(
    access: &WorkspaceAccess,
    args: &Value,
    workspace_root: &str,
) -> Vec<crate::lsp::detector::LanguageId> {
    if let Some(p) = resolve_position(args) {
        return crate::lsp::lang_from_ext_of(&p.file).into_iter().collect();
    }
    // `outline` 只给文件不给坐标：同样按该文件的扩展名定语言。
    if let Some(file) = outline_file(args) {
        return crate::lsp::lang_from_ext_of(file).into_iter().collect();
    }
    access.queryable_languages(workspace_root).await
}

/// 调用方给的时间预算（`budget_ms`），封顶于该步骤自己的默认预算。
///
/// 为什么要它：模型那头有耐心上限。真机转录里一发 LSP 等 20–60s 换回「没答上」，
/// 几次之后 agent 就再也不碰这组工具了（09-20 之后 84 个会话调用 1 次）。sidecar 给每发
/// 查询定预算，超了就用文本兜底**当场**回答；这里让后端的等待也跟着收口，别在没人等的
/// 请求上空转。
fn budget(args: &Value, default: std::time::Duration) -> std::time::Duration {
    args.get("budget_ms")
        .and_then(|v| v.as_u64())
        .map(std::time::Duration::from_millis)
        .map_or(default, |b| b.min(default))
}

/// `outline` 的目标文件（只有 `file`，没有坐标）。
fn outline_file(args: &Value) -> Option<&str> {
    args.get("file").and_then(|v| v.as_str())
}

/// 一个文件的结构最多等这么久（tsserver 工程加载中会先回空，见 `agent_nav::outline`）。
const OUTLINE_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

/// 就绪探针的默认预算（空结果时才用，见 `probe_ready`）。
const PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

/// agent 语义查询入口。
pub async fn run_agent_query(
    core: &crate::Core,
    tool: &str,
    args: &Value,
    workspace_root: &str,
) -> AgentQueryOutcome {
    // 纯文本兜底不需要语言服务器（语义层没答上时 sidecar 用它补位），最先分派。
    if tool == "text" {
        let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
            return fail(AgentLspStatus::Error, "missing `name`");
        };
        let access = WorkspaceAccess::of(workspace_root);
        return crate::lsp::agent_nav::text_search(&access, workspace_root, symbol_query_name(name)).await;
    }
    let state: &LspState = &core.lsp;
    // 1. **确保 server 起来**。agent 查询可能先于编辑器到达（用户没打开过该语言的
    //    文件）——只 `mgr.get()` 会直接报 no_server，而正确行为是把它拉起来。
    // 工作区文件的读法（本机直读 / 远程问 aide-host）只在这里定一次，往下一路带着。
    let access = WorkspaceAccess::of(workspace_root);
    let access = &access;
    let langs = target_languages(access, args, workspace_root).await;
    if langs.is_empty() {
        return fail(AgentLspStatus::NoServer, "no language detected for this query");
    }
    // 预热：**每一种**语言都拉起来并探到就绪，**不执行查询**。sidecar 在会话早期
    // fire-and-forget 调用它，把 46–73s 的冷启动挪出 agent 的关键路径。
    // （曾经跟查询共用下面那个「第一个可用语言就 break」的循环——结果只热了一种语言，
    // 另一种的第一次真查询照样撞冷启动。）
    if tool == "warm" {
        return warm_all(access, state, core, workspace_root, &langs).await;
    }
    let mut warmed = AgentLspStatus::NoServer;
    for lang_id in &langs {
        match crate::lsp::ensure_lang(core, workspace_root, *lang_id).await {
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
    if tool == "outline" {
        let Some(file) = outline_file(args) else {
            return fail(AgentLspStatus::Error, "missing `file`");
        };
        let Some((lang_id, h)) = server_for(state, workspace_root, file).await else {
            return fail(AgentLspStatus::NoServer, "no language server for this file");
        };
        if let Err(e) = ensure_doc_open(access, &h, workspace_root, file, lang_id).await {
            tracing::debug!(file, error = %e, "agent lsp: outline 前 didOpen 失败，继续");
        }
        let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, file);
        return crate::lsp::agent_nav::outline(&h, &uri, budget(args, OUTLINE_BUDGET)).await;
    }
    // 2. 坐标
    let pos = match resolve_position(args) {
        Some(p) => p,
        None => {
            let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
                // 参数给错是**调用方的错**（内部错误），不是「这个符号不存在」。
                return fail(
                    AgentLspStatus::Error,
                    "missing `name` or `{file,line,character}`",
                );
            };
            let deadline = std::time::Instant::now()
                + budget(args, crate::lsp::manager::SYMBOL_SEARCH_TIMEOUT);
            match lookup_symbol(access, state, core, symbol_query_name(name), workspace_root, deadline)
                .await
            {
                // `symbols` 问的就是「这个名字在哪声明」——命中本身就是答案。曾经还要拿它
                // 再发一次 definition：tsserver 在声明处的 definition 常回空，空再被探针认证成
                // 「确认没有」（2026-09-29 复现，见 agent_nav::refine_to_name）。
                Ok(SymbolLookup::Found(c)) if tool == "symbols" => {
                    return ok_with(AgentLspStatus::Ready, vec![candidate_result(&c)]);
                }
                Ok(SymbolLookup::Found(c)) => Position {
                    file: c.file_path,
                    line: c.line,
                    character: c.column,
                },
                Ok(SymbolLookup::Ambiguous(cands)) => {
                    return ambiguous_outcome(symbol_query_name(name), cands)
                }
                // 没能答上：**不许说「没有」**——如实交出「谁为什么没答」。按名查询没有
                // 「确认没有」这个出口，理由见 `SymbolLookup::Unverified`。
                Ok(SymbolLookup::Unverified { silent }) => {
                    return unverified_outcome(symbol_query_name(name), &silent)
                }
                Err(s) => return fail(s, "symbol lookup failed"),
            }
        }
    };
    run_jump(access, state, tool, &pos, workspace_root, budget(args, PROBE_BUDGET)).await
}

/// 预热：并发地把每种语言拉起来、递一个代表文件（把工程加载出来）、探到就绪。
///
/// 返回 `ready` = 至少一种语言的语义层可用（sidecar 据此打开「grep 顺带给语义答案」的
/// 快路径）；逐语言明细在 `languages` 里。**锁只圈住取句柄**：探测可能花掉几十秒，
/// 曾经整段持锁，预热期间编辑器的所有 LSP 请求都被挡住。
async fn warm_all(
    access: &WorkspaceAccess,
    state: &LspState,
    core: &crate::Core,
    workspace_root: &str,
    langs: &[crate::lsp::detector::LanguageId],
) -> AgentQueryOutcome {
    let one = |lang_id: crate::lsp::detector::LanguageId| async move {
        let status = match crate::lsp::ensure_lang(core, workspace_root, lang_id).await {
            Ok(o) => AgentLspStatus::from_ensure(&o),
            Err(_) => AgentLspStatus::Error,
        };
        if !matches!(status, AgentLspStatus::Ready | AgentLspStatus::Indexing) {
            return (lang_id, status);
        }
        let handle = {
            let mgr = state.0.lock().await;
            mgr.get(workspace_root, lang_id).await
        };
        let Some(h) = handle else {
            return (lang_id, AgentLspStatus::Gone);
        };
        prime_project(access, &h, workspace_root, lang_id).await;
        let Some(probe_file) = first_source_file(access, workspace_root, lang_id).await else {
            return (lang_id, AgentLspStatus::Indexing);
        };
        let ready = probe_ready(access, &h, &probe_file, workspace_root, WARM_PROBE_BUDGET).await;
        (lang_id, if ready { AgentLspStatus::Ready } else { AgentLspStatus::Indexing })
    };
    let results = futures_util::future::join_all(langs.iter().map(|l| one(*l))).await;
    let any_ready = results.iter().any(|(_, s)| *s == AgentLspStatus::Ready);
    let languages: Vec<Value> = results
        .iter()
        .map(|(l, s)| json!({ "lang": l.id_str(), "status": s.as_str() }))
        .collect();
    json!({
        "ok": any_ready,
        "status": if any_ready { AgentLspStatus::Ready } else { AgentLspStatus::Indexing }.as_str(),
        "count": 0,
        "results": [],
        "languages": languages,
    })
}

/// 预热的就绪探测预算：比查询路径宽——没人在等它，而冷启动实测 46–73s。
const WARM_PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

/// 按名字解析坐标：逐个候选语言去问，再裁决。
///
/// `Err(AgentLspStatus)` 只留给**整条路径不可用**（未信任 / 一个语言都探不到）——
/// 「某个语言没答上」是 `Unverified` 而不是 Err：它必须带着「谁答了、谁没答、为什么」
/// 进文案，否则模型只能看到一句无差别的「查不到」。
async fn lookup_symbol(
    access: &WorkspaceAccess,
    state: &LspState,
    core: &crate::Core,
    name: &str,
    workspace_root: &str,
    deadline: std::time::Instant,
) -> Result<SymbolLookup, AgentLspStatus> {
    let langs =
        access.queryable_languages(workspace_root).await;
    if langs.is_empty() {
        return Err(AgentLspStatus::NoServer);
    }
    let mut silent = Vec::new();
    // 共享 deadline（调用方按预算算好）：这次查询总共只等这么久（**不是每个语言各等一份**）。
    // **并发问所有语言**：串行时总耗时 = Σ 每个语言的预算，本仓库三台 server（rust /
    // typescript / javascript）就是三倍上限。并发后总耗时 ≈ 一个 deadline。
    // 代价：某个语言卡住时会等到它（≤deadline）才定案，不会因为后面的语言先答上来而提前返回
    // ——换来的是**结论稳定**（按语言顺序取第一个有命中的，不随调度抖动）。
    let answers = futures_util::future::join_all(
        langs
            .iter()
            .map(|lang_id| consult_language(access, state, core, workspace_root, *lang_id, name, deadline)),
    )
    .await;
    for (lang_id, answer) in langs.iter().zip(answers) {
        match answer? {
            Consulted::OutOfScope => {}
            Consulted::Silent(why) => silent.push((lang_id.id_str(), why)),
            // **第一个给出候选的语言即定案**，不跨语言合并：`get` 在 Rust 与 TS 里
            // 同时存在是常态，合并会把两个不同语言的同名符号当成「同一个符号的重载」。
            Consulted::Hits(mut hits) if hits.len() == 1 => {
                return Ok(SymbolLookup::Found(hits.remove(0)))
            }
            Consulted::Hits(hits) => return Ok(SymbolLookup::Ambiguous(hits)),
        }
    }
    if silent.is_empty() {
        // 一个语言都没被问到（探测到的语言全都不在服务范围内）——这是「没有 server」，
        // 与「问了、没人答」不是一回事（后者是未验证）。
        Err(AgentLspStatus::NoServer)
    } else {
        Ok(SymbolLookup::Unverified { silent })
    }
}

/// 问一个语言「有没有这个名字」。
///
/// 固定四步：**拉起 server → 递一个它的真实文件 → workspace/symbol → 空则探就绪**。
/// 第三步的「递文件」不是优化而是前提：tsserver 的 `navto` 在工程未加载时直接抛
/// `No Project.`（实测：didOpen 之前必拒，didOpen 之后 500ms 内精确命中）。
/// RA 这类不需要它的 server 递了也无害——与 `run_jump` 的「先递文件再提问」同一条
/// 纪律，差别只是这里没有现成的查询目标文件。
async fn consult_language(
    access: &WorkspaceAccess,
    state: &LspState,
    core: &crate::Core,
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
    name: &str,
    deadline: std::time::Instant,
) -> Result<Consulted, AgentLspStatus> {
    let status = match crate::lsp::ensure_lang(core, workspace_root, lang_id).await {
        Ok(o) => AgentLspStatus::from_ensure(&o),
        Err(_) => return Err(AgentLspStatus::Error),
    };
    match status {
        // 未信任是工作区级的：整条路径都不该答（上层文案说「去信任工作区」）。
        AgentLspStatus::Untrusted => Err(AgentLspStatus::Untrusted),
        AgentLspStatus::NoServer => Ok(Consulted::OutOfScope),
        // 装了却起不来（spawn/handshake 失败，如本机那个必崩的 vue-language-server）：
        // **它没答上**，这个语言的名字查询从此不可信。
        AgentLspStatus::Error => Ok(Consulted::Silent(
            "its language server failed to start".into(),
        )),
        // ready 与 indexing 都值得问：索引还没好的 server 也可能直接命中。
        AgentLspStatus::Ready | AgentLspStatus::Indexing => {
            ask_language(access, state, workspace_root, lang_id, name, deadline).await
        }
        AgentLspStatus::NoSymbol | AgentLspStatus::Timeout | AgentLspStatus::Gone => Ok(
            Consulted::Silent("its language server is not usable".into()),
        ),
    }
}

/// server 的按名查询是**模糊**的，候选必须逐条对名字才能进裁决。
///
/// 实测（2026-09-19，两个独立会话 + 复现）：rust-analyzer 对 `rnjmp` 回 **11 个"符号"**
/// ——`r…n…j…m…p` 子序列把 `run_jump` 和一堆无关函数全凑出来了（其中
/// `manager.rs` 那个的真身是 `answer_server_request_non_java_lang_returns_empty_settings`）。
/// tsserver 的 `navto` 同样是前缀/子串打分。
///
/// 不过滤的后果是**假阳性**：问一个不存在的名字却拿到坐标，模型照着读，读到的是别人的
/// 函数。假阴性只是让人绕路，假阳性是给错地址——比它更贵。顺带也修掉措辞谎言：歧义文案
/// 断言「N symbols named `X`」，而模糊候选根本不是那个名字。
///
/// 精确匹配的要求**只加在 agent 这条路**：`lsp_workspace_symbol` 命令保持模糊——按名
/// 「搜索」本来就该模糊。同一份解析、两种语义，分界在这一层。
fn exact_matches(hits: Vec<SymbolCandidate>, name: &str) -> Vec<SymbolCandidate> {
    hits.into_iter()
        .filter(|c| names_the_symbol(&c.name, name))
        .collect()
}

/// 候选的名字是否**就是**查询的那个（剥掉参数表与限定路径之后再比）。
/// 各 server 返回的形状不一：Rust 常给裸名、Java 给 `get(int)`、有的给 `Type::method`。
fn names_the_symbol(candidate: &str, query: &str) -> bool {
    let head = candidate.split('(').next().unwrap_or(candidate);
    let bare = head.rsplit("::").next().unwrap_or(head);
    bare.rsplit('.').next().unwrap_or(bare) == query
}

/// 真正发问：递文件 → `workspace/symbol` → 空则探就绪。
///
/// 「空」只有在**探针通过**（该语言的索引确实可用）时才降级成 `Empty`；探针不过就是
/// `Silent`——这正是「空 ≠ 没有」在按名查询这一侧的落点。
async fn ask_language(
    access: &WorkspaceAccess,
    state: &LspState,
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
    name: &str,
    deadline: std::time::Instant,
) -> Result<Consulted, AgentLspStatus> {
    // 锁只圈住「取句柄」这一步：后面的请求 + 探针可能花掉几十秒，不许占着管理器。
    let handle = {
        let mgr = state.0.lock().await;
        mgr.get(workspace_root, lang_id).await
    };
    let Some(h) = handle else {
        return Ok(Consulted::Silent(
            "its language server is not running".into(),
        ));
    };
    // 结构上答不了的语言**别发问**：握手没声明 `workspaceSymbolProvider`（如 Volar），
    // 发出去只会换回一句 `-32601` 并污染裁决。`None`（没握手成功/信息缺失）不当判据。
    let caps = h.capabilities.lock().await.clone();
    if let Some(caps) = caps {
        if !crate::lsp::manager::declares_workspace_symbol(&caps) {
            return Ok(Consulted::Silent("does not implement symbol search".into()));
        }
    }
    prime_project(access, &h, workspace_root, lang_id).await;
    // 两段式：先快问一次；没命中就**按文本递文件**（名字出现在哪，就把那里的工程加载出来）
    // 再问到 deadline。多工程仓库里只递一个代表文件时，别的工程从不加载——实测
    // `resolveLspResult`（在 agent-sidecar 工程里）按名永远 0 命中，见 agent_nav::files_mentioning。
    // 第一段只给**总预算的三分之一**（且不超过 QUICK_SEARCH）：短预算的调用方（grep 顺带作答
    // 给 ~3s）若被第一段吃光，递文件那一段就永远轮不到——真机评测里正是这样漏掉了
    // agent-sidecar 工程里的符号。
    let now = std::time::Instant::now();
    let quick = deadline.min(now + QUICK_SEARCH.min(deadline.saturating_duration_since(now) / 3));
    let first = search_symbol(&h, lang_id, name, quick, RETRY_INTERVAL).await;
    let answer = match first {
        Ok(hits) if !hits.is_empty() => Ok(hits),
        _ => {
            let files =
                crate::lsp::agent_nav::files_mentioning(access, workspace_root, name, lang_id, MAX_TEXT_PRIMED)
                    .await;
            for file in files {
                if let Err(e) = ensure_doc_open(access, &h, workspace_root, &file, lang_id).await {
                    tracing::debug!(file = %file, error = %e, "agent lsp: 按文本递文件失败，继续");
                }
            }
            search_symbol(&h, lang_id, name, deadline, RETRY_INTERVAL).await
        }
    };
    match answer {
        Ok(hits) if !hits.is_empty() => Ok(Consulted::Hits(refine_candidates(access, hits, name).await)),
        // 空到底：**也不许说「没有」**——证明不了符号索引覆盖了整个工作区（就绪探针探的是
        // 「已递过的那个文件」，工程没加载它照样过，见 `SymbolLookup` 的实测记录）。
        Ok(_) => Ok(Consulted::Silent(
            "no symbol of that name was found, but its symbol search may not cover files whose \
             project is not loaded — unverified, not a confirmed negative"
                .into(),
        )),
        Err(why) => Ok(Consulted::Silent(why)),
    }
}

/// 按名查询 + **空结果重试**。返回 Err 时附「没答上」的原因（进模型看到的文案）。
///
/// 为什么要重试：**空不等于「没有」，也不等于「答不了」——它还可能是「还没加载完」**。
/// 实测（2026-09-19，本仓库，`probe-navto.mjs`）：tsserver 打开一个工程内文件后，配置
/// 工程仍在异步加载，期间 `workspace/symbol` 返回**空数组**（不是错误）：同一会话
/// 4s 时回空、20s 时精确命中；复跑时 4s 就命中——窗口随机器负载浮动（2–20s 量级）。
/// 不重试就是把「还在加载」读成「确认没有」，正好是这条红线要防的假阴性。
///
/// 预算取 `SYMBOL_SEARCH_TIMEOUT`（与单次请求同量级），每 2s 一发；单发用
/// `DEFINITION_TIMEOUT`，好让重试真的有机会发出去。**已知残余**：工程加载慢于预算时
/// 仍可能假阴性——这是概率收敛，不是证明，见 spike README §10。
async fn search_symbol(
    h: &Arc<ServerHandle>,
    lang_id: crate::lsp::detector::LanguageId,
    name: &str,
    deadline: std::time::Instant,
    interval: std::time::Duration,
) -> Result<Vec<SymbolCandidate>, String> {
    loop {
        let params = json!({ "query": name });
        // **单次请求的预算是「这次查询剩下的时间」，不是 8s。** 真机（2026-09-20）：
        // 每个人给 8s 的结果是三个语言全报 `did not answer within the budget`——
        // 带 Vue 插件的 tsserver 与忙着的 rust-analyzer（本机两个 RA、7.6GB、一个在烧 CPU）
        // 8s 内根本答不完，于是**永远等不到答案**。空结果的快答照旧（那是重试要处理的），
        // 这里只保证「慢但会答」的 server 有机会答完。
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let attempt_timeout = if remaining.is_zero() {
            crate::lsp::manager::DEFINITION_TIMEOUT
        } else {
            remaining
        };
        match jump::issue(h, "workspace/symbol", params, attempt_timeout).await
        {
            // `null` 是 JSON-RPC 合法的「无结果」（RA 会这么回），与空数组同义。
            Ok(RequestOutcome::Ok(v)) if v.is_array() || v.is_null() => {
                // 先过滤模糊候选再裁决——不过滤就是假阳性（见 `exact_matches`）。
                let hits = exact_matches(
                    crate::lsp::workspace_symbol::parse_workspace_symbols(&v, lang_id.id_str()),
                    name,
                );
                if !hits.is_empty() {
                    return Ok(hits);
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(vec![]); // 空到底：交给就绪探针定性，不在这里下结论
                }
            }
            // 拒答的原文要留着（如 `No Project.`）——它是这条链路唯一的诊断线索。
            Ok(RequestOutcome::ServerError(msg)) => {
                return Err(format!("its server refused the query: {msg}"))
            }
            Ok(RequestOutcome::Timeout) => {
                return Err("it did not answer within the budget".into())
            }
            Ok(RequestOutcome::NotReady) => return Err("its index is not ready".into()),
            Ok(RequestOutcome::ServerGone) => return Err("its server exited".into()),
            // 非数组非 null：畸形应答。**不许让它冒充「空」**（那是「确认没有」的形状）。
            Ok(RequestOutcome::Ok(_)) => {
                return Err("the server answered with an unusable payload".into())
            }
            Err(e) => return Err(format!("its request failed: {e}")),
        }
        tokio::time::sleep(interval).await;
    }
}

/// 重试间隔。预算（deadline）**按一次查询算、不按语言算**：本仓库就有
/// rust / typescript / javascript 三台 server，各给 20s 会让「问一个不存在的名字」
/// 等满一分钟——那正是把模型推回 Grep 的体验。`lookup_symbol` 起一个共享 deadline，
/// 后面的语言分剩下的时间。
const RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// 递给 server **一个**它自己的真实文件，把工程加载出来（只影响命中率，不影响结论）。
///
/// 递哪个：`representative_sources` 挑的——该语言文件最多的顶层目录里的第一个非测试文件。
/// 不挑会怎样（实测 2026-09-19）：根层 `vite.config.ts` 属于只含它一个文件的
/// `tsconfig.node.json`，`src/*.test.ts` 被 `include/exclude` 排除走单文件推断工程——
/// 递这两种等于没加载主工程。
///
/// **为什么只递一个**（同日对照实测）：递四个（src + agent-sidecar + packages + ohos）
/// 时 navto 对同一个名字**回 1 → 1 → 0 → 1** —— 多工程并发加载时，答案随"那一刻谁加载好了"
/// 抖动；只递 `src/api.ts` 一个则四次运行四次命中。少即是多。
async fn prime_project(
    access: &WorkspaceAccess,
    h: &Arc<ServerHandle>,
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
) {
    for file in &first_source_files(access, workspace_root, lang_id, MAX_PRIMED).await {
        if let Err(e) = ensure_doc_open(access, h, workspace_root, file, lang_id).await {
            tracing::debug!(file = %file, error = %e, "agent lsp: 预热 didOpen 失败，继续查询");
        }
    }
}

/// 两段式按名查询的第一段预算：工程已加载时 navto 百毫秒内就答，给足余量即可。
const QUICK_SEARCH: std::time::Duration = std::time::Duration::from_secs(3);

/// 按文本递文件的个数上限（每个文件可能拖起一个工程加载）。
const MAX_TEXT_PRIMED: usize = 3;

/// 把命中挪到名字本身上（见 `agent_nav::refine_to_name`）。读盘放 spawn_blocking。
async fn refine_candidates(
    access: &WorkspaceAccess,
    hits: Vec<SymbolCandidate>,
    name: &str,
) -> Vec<SymbolCandidate> {
    let mut out = Vec::with_capacity(hits.len());
    for mut c in hits {
        // 读不到就保留原位置——**别把命中丢掉**（丢 = 另一种结论）。
        if let Ok(text) = access.read_text(&c.file_path).await {
            if let Some((line, column)) =
                crate::lsp::agent_nav::refine_to_name(&text, c.line, c.column, name)
            {
                c.line = line;
                c.column = column;
            }
        }
        out.push(c);
    }
    out
}

/// 命中（名字位置）→ 与跳转结果同形的一条结果（绝对路径，与 `map_outcome_absolute` 一致）。
fn candidate_result(c: &SymbolCandidate) -> crate::codegraph::types::QueryResult {
    use crate::codegraph::types::{Confidence, QueryResult, SymbolDef, SymbolKind};
    QueryResult {
        symbol: SymbolDef {
            name: c.name.clone(),
            kind: SymbolKind::Function, // 占位：与 location_to_query_result 同（sidecar 从结构里取种类）
            file: c.file_path.clone(),
            line: c.line,
            column: c.column,
            parent: None,
            end_line: 0,
        },
        confidence: Confidence::Structure,
        score: None,
        snippet: None,
    }
}

/// 预热递文件的个数：**1**。多递会让多工程并发加载、命中率反而抖（见 `prime_project`）。
const MAX_PRIMED: usize = 1;

/// 「没能给出可信答案」：`status` 跟着 `indexing` 走（不是 ready，也不是 no_symbol），
/// 并把**逐语言的明细**放进 `error`——sidecar 会把它贴在「索引没好」的文案后面。
/// 明细不是装饰：模型据此才知道该用 Grep 兜哪一部分（也是这次事故的唯一可取之处）。
fn unverified_outcome(name: &str, silent: &[(&'static str, String)]) -> AgentQueryOutcome {
    let detail = silent
        .iter()
        .map(|(lang, why)| format!("{lang}: {why}"))
        .collect::<Vec<_>>()
        .join("; ");
    fail(
        AgentLspStatus::Indexing,
        &format!(
            "`{name}` was not found by name search — {detail}. \
             Not a confirmed negative: treat it as unverified."
        ),
    )
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
async fn first_source_file(
    access: &WorkspaceAccess,
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
) -> Option<String> {
    first_source_files(access, workspace_root, lang_id, 1)
        .await
        .into_iter()
        .next()
}

/// 该语言的代表文件（每个顶层目录一个，最多 `max` 个）。
///
/// 遍历本体在 `detector::representative_sources`（有界；TS profile 判「这工作区有没有 .vue」
/// 用的是 `find_source_with_ext`——同一套边界纪律只留一份）；本机走 spawn_blocking，
/// 远程工作区在目标机上算（`WorkspaceAccess`）。
async fn first_source_files(
    access: &WorkspaceAccess,
    workspace_root: &str,
    lang_id: crate::lsp::detector::LanguageId,
    max: usize,
) -> Vec<String> {
    access.representative_sources(workspace_root, lang_id, max).await
}

/// 工具名 → (LSP 方法, 参数)。**纯函数**，值得有自己的测试而不是埋在 `run_jump` 里：
/// 这条映射错一下，代价就是「查到了」被说成「确认没有」（见 `symbols` 那一行）。
fn method_for(
    tool: &str,
    uri: &str,
    pos: &Position,
) -> Result<(&'static str, serde_json::Value), String> {
    Ok(match tool {
        "references" => (
            "textDocument/references",
            jump::references_params(uri, pos.line, pos.character),
        ),
        // `symbols` 的语义就是「这个符号在哪定义」：名字已经解析成坐标，落点自然是 definition。
        // **绝不能让它掉进 unknown tool**：真机（2026-09-19）`lsp_symbols {name:"run_jump"}`
        // 名字解析成功后回「unknown tool `symbols`」，侧车照状态渲染成「confirmed negative」
        // 报给模型——明明查到了，模型读到的是「确认没有」。
        "definition" | "symbols" => (
            "textDocument/definition",
            jump::position_params(uri, pos.line, pos.character),
        ),
        "implementations" => (
            "textDocument/implementation",
            jump::position_params(uri, pos.line, pos.character),
        ),
        // 未知工具是**内部错误**，不是语义否定——调用方据此回 Error 而不是 no_symbol。
        other => return Err(format!("unknown tool `{other}`")),
    })
}

/// 执行跳转类查询。先按当前状态直接发；**只有结果为空时才回头探测就绪**
/// ——非空结果本身就是「server 可用」的铁证，探测一次都不必花。
async fn run_jump(
    access: &WorkspaceAccess,
    state: &LspState,
    tool: &str,
    pos: &Position,
    workspace_root: &str,
    probe_budget: std::time::Duration,
) -> AgentQueryOutcome {
    let Some((lang_id, h)) = server_for(state, workspace_root, &pos.file).await else {
        // 语言认不出、或 server 没能 ensure 起来——都是「这条路径没有 server」，
        // 不是「还没好」（后者是 indexing）。两句话对用户的可操作性不同。
        return fail(AgentLspStatus::NoServer, "no language server for this file");
    };
    // **先递文件再提问**。失败不判死：RA 这类不需要 didOpen 的 server 照常能答；
    // 真答不了的会被空结果 + probe 定性成 indexing（宁可说「没答上来」，不说「没有」）。
    if let Err(e) = ensure_doc_open(access, &h, workspace_root, &pos.file, lang_id).await {
        tracing::debug!(file = %pos.file, error = %e, "agent lsp: didOpen 失败，继续查询");
    }
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, &pos.file);
    let (method, params) = match method_for(tool, &uri, pos) {
        Ok(v) => v,
        Err(e) => return fail(AgentLspStatus::Error, &e),
    };
    let outcome = match jump::issue(&h, method, params, crate::lsp::manager::DEFINITION_TIMEOUT).await
    {
        Ok(o) => o,
        Err(e) => return fail(AgentLspStatus::Error, &e),
    };
    // 拒答要带原文：`No Project.` 这类消息是这条链路唯一的诊断线索，别在状态映射里丢掉。
    if let RequestOutcome::ServerError(msg) = &outcome {
        return fail(
            AgentLspStatus::Error,
            &format!("the language server refused the request: {msg}"),
        );
    }
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
    let confirmed = probe_ready(access, &h, &pos.file, workspace_root, probe_budget).await;
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
async fn probe_ready(
    access: &WorkspaceAccess,
    h: &Arc<ServerHandle>,
    file: &str,
    workspace_root: &str,
    total: std::time::Duration,
) -> bool {
    // 探测靶子也要先打开：tsserver 对没打开的文档一律回空，那会把 probe 变成**恒失败**，
    // 于是 references 的空被定性成 indexing——「面板说就绪、工具说在索引」那个坑的另一半。
    if let Some(lang) = crate::lsp::lang_from_ext_of(file) {
        let _ = ensure_doc_open(access, h, workspace_root, file, lang).await;
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
            total,
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
    access: &WorkspaceAccess,
    h: &Arc<ServerHandle>,
    workspace_root: &str,
    file_path: &str,
    lang_id: crate::lsp::detector::LanguageId,
) -> Result<(), String> {
    if crate::lsp::manager::is_excluded(file_path, &h.exclude_globs) {
        return Err("path is in the workspace exclude list".to_string());
    }
    // 读盘经 `WorkspaceAccess`：本机走 spawn_blocking（不占 tokio worker），远程向 aide-host 要。
    let text = access.read_text(file_path).await?;
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, file_path);
    // 文档 languageId 与编辑器路径**同一个出口**（`document_lang_id`）：`.vue` 发 "vue"
    // 才被 TS 服务器的 Vue 插件覆盖，发服务 id（"typescript"）会按 TS 解析整个 SFC。
    h.open_doc(
        &uri,
        crate::lsp::detector::document_lang_id(file_path, lang_id),
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

    /// 预算只能收紧、不能放宽：调用方给的比默认大，按默认算（别让一个参数把后端拖成无限等）。
    #[test]
    fn budget_is_capped_by_the_default() {
        let d = std::time::Duration::from_secs(20);
        assert_eq!(budget(&json!({}), d), d);
        assert_eq!(budget(&json!({"budget_ms": 3000}), d), std::time::Duration::from_secs(3));
        assert_eq!(budget(&json!({"budget_ms": 90_000}), d), d);
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

    /// **「没人答上」不许冒充「没有」。** 状态是 indexing（不是 no_symbol），明细逐语言点名——
    /// 模型据此才知道该用 Grep 兜哪一部分，也才知道这句「查不到」不算数。真机事故的回归闸门。
    #[test]
    fn unverified_names_the_silent_languages() {
        let v = unverified_outcome(
            "useInlineMention",
            &[
                ("rust", "it did not answer within the budget".into()),
                ("vue", "does not implement symbol search".into()),
            ],
        );
        assert_eq!(v["ok"], false);
        assert_eq!(v["status"], "indexing", "不是 no_symbol：这不是「确认没有」");
        let err = v["error"].as_str().unwrap();
        assert!(err.contains("rust"), "没答的语言要逐个写出来：{err}");
        assert!(err.contains("vue"), "没答的语言要逐个写出来：{err}");
        assert!(err.contains("does not implement"), "原因要带上：{err}");
        assert!(
            err.to_lowercase().contains("not a confirmed negative"),
            "必须明说这不是确认否定：{err}"
        );
    }

    /// **模糊候选必须被挡住。** 真机实例：查 `rnjmp`（不存在的名字）时 rust-analyzer
    /// 回了 11 个「符号」，`answer_server_request_non_java_lang_returns_empty_settings`
    /// 只是子序列凑出来的。放过去 = 给模型一个错地址。
    #[test]
    fn fuzzy_candidates_are_not_symbols() {
        assert!(!names_the_symbol(
            "answer_server_request_non_java_lang_returns_empty_settings",
            "run_jump"
        ));
        assert!(names_the_symbol("run_jump", "run_jump"));
    }

    /// 各 server 返回的形状都要认：裸名 / 限定路径 / Java 参数表。
    #[test]
    fn qualified_and_signature_shapes_still_match() {
        assert!(names_the_symbol("LspManager::get", "get"), "Rust 限定路径");
        assert!(names_the_symbol("get(int)", "get"), "Java 参数表");
        assert!(names_the_symbol("Note.get", "get"), "点号限定");
        assert!(!names_the_symbol("getter", "get"), "前缀不是同一个名字");
    }

    /// 过滤只留精确的，且不动顺序（歧义清单的次序即候选次序）。
    #[test]
    fn exact_matches_keeps_only_the_named_symbol() {
        let cand = |name: &str| SymbolCandidate {
            name: name.to_string(),
            kind: 0,
            file_path: "/p/a.rs".into(),
            line: 1,
            column: 1,
            lang: "rust".into(),
        };
        let kept = exact_matches(vec![cand("getter"), cand("get"), cand("LspManager::get")], "get");
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].name, "get");
        assert_eq!(kept[1].name, "LspManager::get");
    }

    /// 空的明细列表也别写出语法残缺的句子（这条只是措辞护栏）。
    #[test]
    fn unverified_with_empty_detail_still_reads_as_a_sentence() {
        let v = unverified_outcome("X", &[]);
        let err = v["error"].as_str().unwrap();
        assert!(err.contains("`X` was not found by name search"), "{err}");
        assert_eq!(v["status"], "indexing");
    }

    /// `symbols` 与 `definition` 同落点（名字已解析成坐标，问的就是「在哪定义」）。
    /// 这条映射曾经缺失，后果是「查到了」被渲染成「确认没有」。
    #[test]
    fn symbols_maps_to_definition_not_unknown_tool() {
        let pos = Position {
            file: "/p/a.ts".into(),
            line: 3,
            character: 5,
        };
        let (m, params) = method_for("symbols", "file:///p/a.ts", &pos).unwrap();
        assert_eq!(m, "textDocument/definition");
        assert_eq!(params["position"]["line"], 2, "1-based → 0-based");
        assert_eq!(params["position"]["character"], 4);
        assert_eq!(
            method_for("definition", "file:///p/a.ts", &pos).unwrap().0,
            "textDocument/definition"
        );
        assert_eq!(
            method_for("references", "file:///p/a.ts", &pos).unwrap().0,
            "textDocument/references"
        );
        assert_eq!(
            method_for("implementations", "file:///p/a.ts", &pos).unwrap().0,
            "textDocument/implementation"
        );
        // 未知工具是错误（调用方回 Error 状态），**不是**语义否定。
        assert!(method_for("nope", "file:///p/a.ts", &pos).is_err());
    }

    // ── 按名查询：跑在真实 request→dispatch→table 链上的行为（不只测纯函数）──

    /// 短预算：用例关心的是「重试与过滤的行为」，不是 20s 的真实窗口。
    fn short_deadline() -> std::time::Instant {
        std::time::Instant::now() + std::time::Duration::from_millis(200)
    }
    const SHORT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);

    /// 起一个带剧本的 mock + 真传输层 handle（reader 把响应送回 waiter）。
    fn scripted_handle(
        responses: Vec<serde_json::Value>,
        document_symbol: serde_json::Value,
    ) -> std::sync::Arc<ServerHandle> {
        use crate::lsp::manager::tests::{make_handle, start_test_reader};
        let mock = crate::lsp::mock_server::spawn_mock_lsp_scripted(responses, document_symbol);
        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            mock.transport_stdin,
            mock.transport_stdout,
        );
        let h = make_handle(transport, true);
        start_test_reader(h.clone());
        h
    }

    /// **空结果要重试。** 复刻真机窗口：tsserver 的工程还在加载时 `workspace/symbol` 回
    /// **空数组而不是错误**（实测 4s 空 / 20s 命中）。不重试就是把「还在加载」读成
    /// 「确认没有」——这条链路上的空曾直接被认证成否定。
    #[tokio::test]
    async fn empty_symbol_search_is_retried() {
        let h = scripted_handle(
            vec![
                json!([]), // 第一次：工程还在加载
                json!([{
                    "name": "useInlineMention",
                    "kind": 12,
                    "location": {
                        "uri": "file:///c:/p/src/useInlineMention.ts",
                        "range": { "start": { "line": 68, "character": 0 } }
                    }
                }]),
            ],
            json!([]),
        );
        let hits = search_symbol(
            &h,
            crate::lsp::detector::LanguageId::TypeScript,
            "useInlineMention",
            std::time::Instant::now() + std::time::Duration::from_secs(5),
            SHORT_INTERVAL,
        )
        .await
        .expect("重试后应当命中");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 69, "0-based → 1-based");
    }

    /// 模糊候选一个都不许进裁决：RA 查 `rnjmp` 会回一串子序列凑出来的「符号」（实测 11 个），
    /// 其中 0 个真叫这个名字。放进去 = 给模型一个错地址。
    #[tokio::test]
    async fn fuzzy_candidates_never_reach_the_verdict() {
        let h = scripted_handle(
            vec![json!([
                { "name": "run_jump", "kind": 12,
                  "location": { "uri": "file:///c:/p/a.rs",
                                "range": { "start": { "line": 0, "character": 0 } } } },
                { "name": "answer_server_request_non_java_lang_returns_empty_settings", "kind": 12,
                  "location": { "uri": "file:///c:/p/b.rs",
                                "range": { "start": { "line": 947, "character": 7 } } } }
            ])],
            json!([]),
        );
        let hits = search_symbol(
            &h,
            crate::lsp::detector::LanguageId::Rust,
            "rnjmp",
            short_deadline(),
            SHORT_INTERVAL,
        )
        .await
        .expect("空到底也是「没命中」，不是错误");
        assert!(hits.is_empty(), "模糊候选不许进裁决：{hits:?}");
    }

    /// RA 回 `null` 表示「无结果」（JSON-RPC 合法），与空数组同义——**不是畸形应答**。
    #[tokio::test]
    async fn null_result_is_empty_not_an_error() {
        let h = scripted_handle(vec![json!(null)], json!([]));
        let r = search_symbol(
            &h,
            crate::lsp::detector::LanguageId::Rust,
            "whatever",
            short_deadline(),
            SHORT_INTERVAL,
        )
        .await;
        assert!(matches!(r, Ok(ref v) if v.is_empty()), "got {r:?}");
    }

    /// 真·畸形应答（对象）不许冒充「空」——那是「确认没有」的形状。
    #[tokio::test]
    async fn malformed_payload_is_an_error_not_an_empty() {
        let h = scripted_handle(vec![json!({"unexpected": true})], json!([]));
        let r = search_symbol(
            &h,
            crate::lsp::detector::LanguageId::Rust,
            "whatever",
            short_deadline(),
            SHORT_INTERVAL,
        )
        .await;
        assert!(r.is_err(), "畸形应答必须报错，got {r:?}");
    }

    /// **端到端（真 tsserver，默认不跑）**：把 `ask_language` 的两步——先递文件、再按名查——
    /// 跑在一个真实进程的 `typescript-language-server` 上，验证「未打开过的文件里的符号」
    /// 能按名找到。这是真机那个假否定的复现装置（`prime_project` + `search_symbol`）。
    ///
    /// **已知未解决**：本机环境下它三次里空两次——tsserver 在多工程仓库里**何时**把主工程
    /// 加载进来还没拿下（见 spike README §11）。所以空了**不是回归**：空只会让按名查询回
    /// 「未验证」，不会再变成「确认没有」（那条出口已退掉）。
    ///
    /// ```bash
    /// AIDE_TLS_CLI=<node>/node_modules/typescript-language-server/lib/cli.mjs \
    ///   cargo test --lib real_tsserver -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "起真实语言服务器：见本测试的 doc 注释"]
    async fn real_tsserver_finds_a_symbol_by_name_in_an_unopened_file() {
        use tokio::io::AsyncWriteExt; // 给 transport.send 用的 trait 在作用域里
        let cli = std::env::var("AIDE_TLS_CLI").expect("设 AIDE_TLS_CLI=<tls>/lib/cli.mjs");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("仓库根")
            .to_string_lossy()
            .replace('\\', "/");

        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(&cli)
            .arg("--stdio")
            .current_dir(&root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别在桌面弹控制台
        let mut child = cmd.spawn().expect("起 typescript-language-server");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");

        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            Box::new(stdin),
            Box::new(stdout),
        );
        let h = crate::lsp::manager::tests::make_handle(transport, true);
        crate::lsp::manager::tests::start_test_reader(h.clone());

        let root_uri = crate::lsp::protocol::path_to_uri(&root);
        let init = h
            .request(
                "initialize",
                json!({
                    "processId": null,
                    "rootUri": root_uri,
                    "workspaceFolders": [{"uri": root_uri, "name": "aide"}],
                    "capabilities": { "workspace": { "symbol": {} } },
                }),
                std::time::Duration::from_secs(120),
            )
            .await
            .expect("initialize 往返");
        assert!(
            matches!(init, RequestOutcome::Ok(_)),
            "握手要成功：{init:?}"
        );
        h.transport
            .send(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
            .await
            .expect("initialized 通知");

        // 与 `ask_language` 同序：先递一个该语言的真实文件（顺带触发工程加载），再按名查。
        let primed =
            first_source_files(&WorkspaceAccess::Local, &root, crate::lsp::detector::LanguageId::TypeScript, MAX_PRIMED)
                .await;
        assert!(!primed.is_empty(), "工作区里应当找得到 .ts 代表文件");
        eprintln!("primed = {primed:?}");
        prime_project(&WorkspaceAccess::Local, &h, &root, crate::lsp::detector::LanguageId::TypeScript).await;

        let hits = search_symbol(
            &h,
            crate::lsp::detector::LanguageId::TypeScript,
            "useInlineMention",
            std::time::Instant::now() + crate::lsp::manager::SYMBOL_SEARCH_TIMEOUT,
            RETRY_INTERVAL,
        )
        .await
        .expect("按名查询本身要走通");
        assert!(
            hits.iter().any(|c| c.file_path.contains("useInlineMention")),
            "按名查得到未打开文件里的符号（空={}）：{hits:?}",
            hits.is_empty()
        );
        // 收尾：kill_on_drop 兜底，这里显式放它走。
        let _ = child.kill().await;
    }
}
