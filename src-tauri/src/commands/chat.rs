use crate::commands::settings::{get_settings, DEFAULT_OUTPUT_STYLE};
use crate::commands::{project_root_for_commands, WorkspaceState};
use crate::runtime::env::build_runtime_env_vars;
use crate::runtime::AgentRuntimeManager;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::State;

async fn resolve_active_provider(
    service: std::sync::Arc<crate::settings::SettingsService>,
) -> Result<crate::runtime::provider::ProviderConfig, String> {
    tokio::task::spawn_blocking(move || {
        service
            .resolve_active_runtime_provider()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn resolve_provider_by_id(
    service: &std::sync::Arc<crate::settings::SettingsService>,
    id: &str,
) -> Result<crate::runtime::provider::ProviderConfig, String> {
    let service = service.clone();
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        service
            .resolve_runtime_provider(&id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 解析本次发送的 provider（三层，逐级回落）：
///  1. 前端透传的会话身份（stampProvider/restoreBinding 解析出的绑定，最权威）；
///  2. 会话元数据 `<sid>.json` 的 provider 字段（前端无绑定的历史会话兜底）；
///  3. 全局 active provider（新会话/两者皆无）。
/// 显式 id 在 provider 列表里不存在（被删除）→ 回落全局 active——与前端
/// sessionProvider 计算属性同一语义（供应商没了就用全局），不会硬失败。
async fn resolve_send_provider(
    service: std::sync::Arc<crate::settings::SettingsService>,
    session_id: &str,
    explicit_provider: Option<String>,
) -> Result<crate::runtime::provider::ProviderConfig, String> {
    let sid = session_id.to_string();
    let metadata_provider =
        tokio::task::spawn_blocking(move || crate::commands::our_session_provider_field(&sid))
            .await
            .map_err(|error| error.to_string())?;
    let preferred = explicit_provider.or(metadata_provider);
    let Some(id) = preferred.filter(|s| !s.is_empty()) else {
        return resolve_active_provider(service).await;
    };
    match resolve_provider_by_id(&service, &id).await {
        Ok(p) => Ok(p),
        Err(_) => resolve_active_provider(service).await,
    }
}

/// send 命令的可选行为（全部带 Default，调用点 `..Default::default()` 起步）。
///
/// 具名字段解决裸 bool 调用点（`false, true, true`）不可读问题；`jump_queue` 用
/// `bool`（原 `Option<bool>` 的 None 与 Some(false) 行为相同，三角态是假的）。
#[derive(Default)]
struct SendOptions<'a> {
    images: Option<&'a [serde_json::Value]>,
    // 发起方附带的渲染描述（@引用卡片/动作胶囊），Rust 不解释结构、原样透传给
    // sidecar，由它随 user_message 事件回灌到所有客户端。None（鸿蒙/PWA）→ 接收
    // 端降级渲染纯文本气泡。
    display: Option<serde_json::Value>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    initial_effort: Option<String>,
    permission_mode: Option<String>,
    jump_queue: bool,
    provider_switched: bool,
    thinking_enabled: bool,
    /// 输出样式名（见 settings.rs 的 DEFAULT_OUTPUT_STYLE）。**非默认才落字段**——
    /// 空串与 `"default"` 都不落，sidecar 缺席即按默认处理（判据在 attach_output_style）。
    output_style: String,
    /// @目录 授权：Rust 裁定结果（过闸的进 `additional_dirs`、被拒的进 `attach_rejected`，
    /// 后者是给前端的回声）。None（本就没带）与两者皆空都不落字段。
    /// 判定在 `workspace/attach.rs`，这里只搬运。
    attach: Option<crate::commands::workspace::attach::AttachResolution>,
}

/// 构造 `send` 命令的 JSON（纯函数，可单测）。骨架目录：必填字段 + 逐项附件，
/// 每个附件一个子函数（attach_*），零分支，读者可一眼读出"由哪几层组成"。
///
/// 关键：resume_id 进 `resume_session_id` 独立字段，**不覆盖 `session_id`**（路由键）。
/// SessionManager 按 session_id 路由到/建 worker；SessionWorker 在首条 send（无活 query）
/// 时把 resume_session_id 赋给 resumeSource，startLoop 的 forkResumeOptions 据此 resume。
/// 旧行为（resume_id 覆盖 session_id）会让路由键换成真 ID 但 resumeSource 仍空 → 不 resume。
fn build_send_command(
    session_id: &str,
    prompt: &str,
    cwd: &str,
    env_vars: &HashMap<String, String>,
    opts: SendOptions<'_>,
) -> serde_json::Value {
    let mut cmd = base_send_command(session_id, prompt, cwd, env_vars, &opts);
    attach_images(&mut cmd, opts.images);
    attach_display(&mut cmd, opts.display);
    attach_resume(&mut cmd, opts.resume_id);
    attach_env_override(&mut cmd, "ANTHROPIC_MODEL", opts.initial_model);
    attach_env_override(&mut cmd, "CLAUDE_CODE_EFFORT_LEVEL", opts.initial_effort);
    attach_permission_mode(&mut cmd, opts.permission_mode);
    attach_flag(&mut cmd, "jump_queue", opts.jump_queue);
    attach_flag(&mut cmd, "provider_switched", opts.provider_switched);
    attach_output_style(&mut cmd, &opts.output_style);
    attach_additional_dirs(&mut cmd, opts.attach.as_ref());
    cmd
}

/// @目录 授权：过闸的目录进 `additional_dirs`，被拒的进 `attach_rejected`（**回声**，
/// 前端据此显示"未注册，已忽略"——fail-closed 不能静默）。两者皆空则不落字段，
/// 与"没带这个功能"同形（旧端/鸿蒙缺席即此）。
fn attach_additional_dirs(
    cmd: &mut serde_json::Value,
    resolution: Option<&crate::commands::workspace::attach::AttachResolution>,
) {
    let Some(resolution) = resolution else { return };
    if !resolution.accepted.is_empty() {
        cmd["additional_dirs"] = json!(resolution.accepted);
    }
    if !resolution.rejected.is_empty() {
        cmd["attach_rejected"] = json!(resolution.rejected);
    }
}

/// 只在样式**非默认**时落字段：`"default"`（设置里最常见的值）与空串都不落。
///
/// 「与缺席同义」的边界要说清：对**新建** worker 成立（`outputStyle` 初值 null →
/// 不发控制请求）；对**已存在的 worker** 不成立——字段缺席时 sidecar 保留上次的
/// 值，query 重建后仍吃旧样式。即设置改动不回灌正在跑的会话（含其 query 重建），
/// 与「新会话生效」的口径一致。空串仅手改 config.json 能造出来，属防御。
///
/// 注：btw / automation 两条支线不下发本字段、不继承输出样式（见
/// agent-sidecar/src/engine/session-worker/outputStyle.ts 头注）。
fn attach_output_style(cmd: &mut serde_json::Value, output_style: &str) {
    if !output_style.is_empty() && output_style != DEFAULT_OUTPUT_STYLE {
        cmd["output_style"] = json!(output_style);
    }
}

/// 必填骨架。env 恒存在（`attach_env_override` 依赖此不变式，不做 get_mut 兜底）。
fn base_send_command(
    session_id: &str,
    prompt: &str,
    cwd: &str,
    env_vars: &HashMap<String, String>,
    opts: &SendOptions<'_>,
) -> serde_json::Value {
    json!({
        "cmd": "send",
        "session_id": session_id,
        "prompt": prompt,
        "cwd": cwd,
        "env": env_vars,
        "thinking_enabled": opts.thinking_enabled,
    })
}

/// images 非空才落（None 与空数组均不落字段）。
fn attach_images(cmd: &mut serde_json::Value, images: Option<&[serde_json::Value]>) {
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            cmd["images"] = json!(imgs);
        }
    }
}

/// 渲染描述原样透传（不校验结构——形状由发起端与 sidecar 的协议约定，Rust 层
/// 只做搬运：校验会把「新增 block 形态」变成需要改 Rust 的破坏性变更）。
/// None 与 null 均不落字段（无 display 等于「按纯文本渲染」）。
fn attach_display(cmd: &mut serde_json::Value, display: Option<serde_json::Value>) {
    if let Some(d) = display {
        if !d.is_null() {
            cmd["display"] = d;
        }
    }
}

/// resume_id 走独立字段（不动 session_id 路由键）。
fn attach_resume(cmd: &mut serde_json::Value, resume_id: Option<String>) {
    if let Some(rid) = resume_id {
        cmd["resume_session_id"] = json!(rid);
    }
}

/// 非空字符串走 env 覆盖（model / effort 同形）。None 与空串不注入（保留
/// provider env 原值）。env 恒存在（base 不变式），直接索引不兜底。
/// effort 注：CLAUDE_CODE_EFFORT_LEVEL 不在 connection_fingerprint 白名单里，
/// 不会触发 provider_switched 重启；也不会被 sidecar 透传成 CLI 的 env
/// （worker 显式删除，effort 只走 options.effort + applyFlagSettings）。
fn attach_env_override(cmd: &mut serde_json::Value, key: &str, value: Option<String>) {
    if let Some(v) = value {
        if !v.is_empty() {
            cmd["env"][key] = json!(v);
        }
    }
}

/// 非空 mode 才落 permission_mode 字段。
fn attach_permission_mode(cmd: &mut serde_json::Value, mode: Option<String>) {
    if let Some(m) = mode {
        if !m.is_empty() {
            cmd["permission_mode"] = json!(m);
        }
    }
}

/// 条件布尔：true 才落字段（false/缺省不写，与原 Option<bool> 的 None 行为一致）。
fn attach_flag(cmd: &mut serde_json::Value, key: &str, on: bool) {
    if on {
        cmd[key] = json!(true);
    }
}

/// 本会话该不该思考：**档位是唯一事实源**（2026-09-19 决策——快速 ⇒ 关思考）。
///
/// 原先还有一个「设置→通用 → 启用思考」的独立开关，已删除：两个事实源必然打架
/// （切了快速却又开着思考），而档位本身就表达了这个意图。
///
/// `effort` 缺席（旧端/鸿蒙不带该字段）→ 思考保持开启（与历史默认一致），
/// 不拿默认值当快速。大小写不敏感：provider 配置里的默认档位是大写（如 `LOW`，
/// 见 attach_env_override 注）。历史档位 medium/xhigh 归一后是进阶/极致，不会误判。
fn thinking_enabled_for_effort(effort: Option<&str>) -> bool {
    !effort.is_some_and(|e| e.eq_ignore_ascii_case("low"))
}

/// 该工作区配得上 LSP 的语言（sidecar 据此决定挂不挂 aide-lsp 工具）。
/// 探测要遍历工作区（有界，但仍是文件系统 IO）——放 `spawn_blocking`，不占 tokio worker
/// （与 `lsp::agent_query::first_source_files` 同一条纪律）。JoinError（任务取消/线程池关闭）
/// → 空表：退化成「不挂 LSP 工具」，与「探不到语言」走同一条路径。
async fn lsp_languages_for_send(app: &tauri::AppHandle, workspace_root: &str) -> Vec<String> {
    let app = app.clone();
    let root = workspace_root.to_string();
    tokio::task::spawn_blocking(move || {
        crate::commands::workspace::lsp_languages_for_path(&app, &root)
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    images: Option<Vec<serde_json::Value>>,
    // 发起方附带的渲染描述（见 SendOptions.display）；None = 按纯文本气泡渲染。
    display: Option<serde_json::Value>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    initial_effort: Option<String>,
    permission_mode: Option<String>,
    jump_queue: Option<bool>,
    workspace_root: Option<String>,
    // @目录 授权：**客户端已知的附加目录全量**（非"本条新增"）。这里只搬运，合法性由
    // workspace/attach.rs 裁定（只认已注册工作区）。缺席/空 = 不动会话账本。
    additional_dirs: Option<Vec<String>>,
    // 会话自持的 provider 身份（前端 stampProvider/restoreBinding 解析出的绑定）。
    // None = 前端无绑定，走会话元数据 → 全局 active 兜底（见 resolve_send_provider）。
    provider: Option<String>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
    workspace_state: State<'_, WorkspaceState>,
    settings_service: State<'_, std::sync::Arc<crate::settings::SettingsService>>,
    // Tauri 注入（不是 IPC 参数）：lsp_languages_for_path 需要它解析捆绑 server 的
    // 资源路径（registry::resolve）。同 lsp_ensure_server 的取用方式。
    app: tauri::AppHandle,
) -> Result<(), String> {
    let cwd = session_cwd(&session_id, &workspace_root, &workspace_state);
    let cwd_str = cwd.to_string_lossy().to_string();

    // 显式注册：会话 cwd 在发送前幂等落账进工作区注册表（新装首聊回落 home
    // 的隐式工作区由此照常出现在侧栏；automation 走 scopes 不经此路径）。
    // 登记失败不阻塞发送——它是落账不是门禁。
    if let Err(e) = crate::commands::workspace::ensure_workspace_registered(&cwd) {
        tracing::warn!(?e, cwd = %cwd.display(), "send_message: register workspace failed");
    }

    let active =
        resolve_send_provider(settings_service.inner().clone(), &session_id, provider).await?;
    // Clone the Arc before `get_settings` takes the `State` by value — the
    // permission snapshot below still needs the service.
    let snapshot_service = settings_service.inner().clone();
    // 读设置失败不阻塞发送（proxy / thinking / output_style 各有兜底），但不能无声：
    // 用户选了非默认输出样式却读不到设置时，这条日志是唯一线索（同上方登记工作区的
    // 「失败不阻塞但不静默」处理）。
    let settings = match get_settings(settings_service).await {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!(
                ?e,
                "send_message: read settings failed, falling back to defaults"
            );
            None
        }
    };
    let proxy = settings
        .as_ref()
        .map(|s| s.proxy.clone())
        .unwrap_or_default();
    let provider_env = build_runtime_env_vars(&active, &proxy);
    let provider_switched = runtime_mgr.connection_drifted(&session_id, &provider_env);
    runtime_mgr.upsert_fingerprint(&session_id, &provider_env);
    // 思考开关下发 sidecar：**档位是唯一事实源**（快速关、其余开，见
    // thinking_enabled_for_effort）。**只在 spawn（建 query）时生效**——SDK 没有
    // 运行时的 thinking setter，`applyFlagSettings({alwaysThinkingEnabled})` 被 CLI
    // 静默忽略（2026-09-19 实测，见 agent-sidecar 注释），所以档位漂移由 sidecar 在
    // 下一条 send 时**原地 resume 重启**兑现，本条字段就是那次重建的依据。
    let thinking_enabled = thinking_enabled_for_effort(initial_effort.as_deref());
    // 输出样式下发 sidecar（设置读取失败时按默认）：生效时机与 thinking 同款——
    // sidecar 只在新建会话（建 query）时落地，改动不影响已在跑的会话。
    let output_style = settings
        .as_ref()
        .map(|s| s.output_style.clone())
        .unwrap_or_else(|| DEFAULT_OUTPUT_STYLE.to_string());

    // @目录 授权：Rust 侧裁定后才下发——前端/远程客户端给什么都不作数（D4）。
    // 读 state.json 是轻量 IO（同 is_path_trusted 的口径），不必 spawn_blocking。
    let attach = additional_dirs
        .as_deref()
        .map(|dirs| crate::commands::workspace::attach::resolve_attach_dirs(dirs, &cwd_str));
    // 被拒的条目：界面上有回声（attach_rejected → workspace_attached），这里再落一条日志，
    // 方便对着"@ 了却没生效"的现场查是哪一环丢的（Rust 是唯一裁定入口）。
    if let Some(rejected) = attach.as_ref().map(|a| &a.rejected).filter(|r| !r.is_empty()) {
        tracing::warn!(?rejected, cwd = %cwd_str, "send_message: 附加目录被拒（未注册工作区/非法路径）");
    }

    let mut cmd = build_send_command(
        &session_id,
        &prompt,
        &cwd_str,
        &provider_env,
        SendOptions {
            images: images.as_deref(),
            display,
            resume_id,
            initial_model,
            initial_effort,
            permission_mode,
            jump_queue: jump_queue.unwrap_or(false),
            provider_switched,
            thinking_enabled,
            output_style,
            attach,
        },
    );

    // 工作区信任标志下发给 sidecar：不信任时 startLoop 据此跳过项目 CLAUDE.md /
    // 项目 .aide/claude/skills/ / 项目 .mcp.json（见 session-worker.ts startLoop）。
    cmd["trusted"] = json!(crate::commands::workspace::is_path_trusted(&cwd_str));
    // 工作区级代码索引开关：未开启的工作区不挂载 aide-codegraph MCP 工具
    // （挂载条件与 trusted 并列，见 codegraphTools.ts codegraphMcpRegistration）。
    cmd["codegraph_enabled"] = json!(crate::commands::workspace::is_codegraph_enabled_for_path(
        &cwd_str
    ));
    // 该工作区配得上 LSP 的语言：空数组则 sidecar 不挂 aide-lsp 工具
    // （挂载条件与 trusted/codegraph_enabled 并列，见 lspTools.ts 的四档闸门）。
    // 探不到语言的工作区连 settings 都不必读，故这个调用很便宜。
    cmd["lsp_languages"] = json!(lsp_languages_for_send(&app, &cwd_str).await);

    // Attach the permission policy snapshot so the sidecar's PreToolUse hook can
    // enforce it on the first query. Best-effort: if the snapshot build fails the
    // send still goes out and the sidecar defers to the provider permission mode.
    // `snapshot_service` was cloned above (before `get_settings` consumed the State).
    let snapshot_cwd = cwd.clone();
    if let Ok(Ok(snapshot)) = tokio::task::spawn_blocking(move || {
        snapshot_service.permission_snapshot_blocking(Some(&snapshot_cwd))
    })
    .await
    {
        cmd["permission_policy"] = json!(snapshot);
    }

    // Register/refresh the session's workspace route so future permission-rule
    // saves can broadcast `update_permission_policy` to this session.
    runtime_mgr.register_session_route(&session_id, Some(&cwd));

    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn permission_response(
    session_id: String,
    id: String,
    approved: bool,
    always: Option<bool>,
    answers: Option<HashMap<String, String>>,
    next_mode: Option<String>,
    // 拒绝理由：仅 approved=false 时生效，sidecar 交给 CLI 当 user feedback
    // （CLI 用官方模板包装后反馈给模型）。它不是工具结果正文——裸传会让模型
    // 把用户的话读成命令输出（2026-09-08 事故）。
    message: Option<String>,
    // 会话级规则草稿（前端在「允许」文件工具时推导，如「本会话内同文件不再询问」）：
    // 不透明透传给 sidecar 入库（PermissionRuleDraft 形状，Rust 不校验内容）。
    session_rules: Option<Vec<serde_json::Value>>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let mut cmd = json!({
        "cmd": "permission_response",
        "session_id": session_id,
        "id": id,
        "approved": approved,
        "always": always,
    });
    if let Some(a) = answers {
        cmd["answers"] = json!(a);
    }
    if let Some(mode) = next_mode {
        cmd["nextMode"] = json!(mode);
    }
    if let Some(m) = message {
        cmd["message"] = json!(m);
    }
    if let Some(rules) = session_rules {
        cmd["sessionRules"] = json!(rules);
    }
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn interrupt_session(
    session_id: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "interrupt", "session_id": session_id });
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn stop_bg_task(
    session_id: String,
    task_id: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "stop_bg_task", "session_id": session_id, "task_id": task_id });
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn set_model(
    session_id: String,
    model: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<bool, String> {
    let cmd = json!({ "cmd": "set_model", "session_id": session_id, "model": model });
    runtime_mgr.send_to_runtime(&cmd).await.map(|_| true)
}

/// 模型切换成本确认（model_switch_confirm 弹窗）的用户决定：转发 sidecar 裁决挂起的
/// PreModelSwitch hook。confirm_id 对不上（过期弹窗晚到）由 sidecar 静默忽略；
/// 挂起超时 sidecar 自行按 deny 收尾——本命令只负责送达，不承载裁决语义。
#[tauri::command]
pub async fn model_switch_confirm_decision(
    session_id: String,
    confirm_id: String,
    approve: bool,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({
        "cmd": "model_switch_confirm_decision",
        "session_id": session_id,
        "confirm_id": confirm_id,
        "approve": approve
    });
    runtime_mgr.send_to_runtime(&cmd).await
}

/// 会话级 effort 切换（provider-agnostic 字符串档位，Claude sidecar 解释为
/// low/medium/high/xhigh/max）。镜像 set_model：Runtime 不在时返回 false，
/// 前端按 deferred 处理（值会随下一条 send 的 env 通道带上）。
#[tauri::command]
pub async fn set_effort(
    session_id: String,
    effort: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<bool, String> {
    let cmd = json!({ "cmd": "set_effort", "session_id": session_id, "effort": effort });
    runtime_mgr.send_to_runtime(&cmd).await.map(|_| true)
}

#[tauri::command]
pub async fn set_permission_mode(
    session_id: String,
    mode: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "set_permission_mode", "session_id": session_id, "mode": mode });
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn stop_chat_session(
    session_id: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "session_stop", "session_id": session_id });
    let out = runtime_mgr.send_to_runtime(&cmd).await;
    // 不等 session_dead 事件就先落存活表：手机端点了停止就该立刻能换供应商，
    // 事件到达有 RTT（且进程已死时可能根本不来）。
    runtime_mgr.mark_session_dead(&session_id);
    out
}

/// btw 侧问：走**存活的**主会话进程内的官方 side_question 控制通道，不起新进程
/// （老路每次提问 spawn 一个 claude.exe，实测 init≈4.1s、总计 7.7~8s；本路温热态
/// 1.1~1.6s）。
///
/// 与 send_message 的关键区别：**没有 cwd/env/provider 装配**——本命令复用存活
/// query 的既有装配，不建进程。也**不做存活性校验**（Rust 保持哑管道）：查不到
/// worker 由 sidecar 判定并经 btw_answer(error) 事件回复。
///
/// 全程 fire-and-forget：正文与错误一律经 btw_answer 事件回来（UI 状态只认事件
/// 通道），本命令的 Result 只表示"命令写进 sidecar stdin 成没成"。
#[tauri::command]
pub async fn btw_ask(
    session_id: String,
    question: String,
    history: Option<Vec<serde_json::Value>>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    // session_id 是**主会话**路由键（btw 不再有独立会话 id）。
    let mut cmd = json!({
        "cmd": "btw_ask",
        "session_id": session_id,
        "question": question,
    });
    // 空/省略 = 无跨问连续性（对齐官方：调用方不传就没有）。
    if let Some(h) = history {
        if !h.is_empty() {
            cmd["history"] = json!(h);
        }
    }
    runtime_mgr.send_to_runtime(&cmd).await
}

/// cwd 的取值来源（只服务两件事：回落留痕，以及纯核可单测）。
#[derive(Debug, PartialEq, Eq)]
enum CwdSource {
    /// 客户端传的 workspace_root：会话归属的断言值，最高优先。
    Explicit,
    /// 会话档案 `<id>.json` 的 wsPath：会话自持的归属。
    Recorded,
    /// 当前活动工作区：前两者都缺席时的最后兜底。
    ActiveWorkspace,
}

/// cwd 的三个候选。具名而非三个位置参数：三者同为路径，靠位置区分就是
/// "交换即静默错位"的典型（把 recorded 传成 explicit 会让未授权的路径直接生效）。
struct CwdCandidates {
    /// 客户端传的 workspace_root：会话归属的断言值，最高优先。
    explicit: Option<PathBuf>,
    /// 会话档案 `<id>.json` 的 wsPath（存在性由调用方先判）。
    recorded: Option<PathBuf>,
    /// 当前活动工作区：前两者都缺席时的最后兜底。
    active: PathBuf,
}

/// 纯核：按优先级取第一个可用者。
fn pick_cwd(c: CwdCandidates) -> (PathBuf, CwdSource) {
    if let Some(p) = c.explicit {
        return (p, CwdSource::Explicit);
    }
    if let Some(p) = c.recorded {
        return (p, CwdSource::Recorded);
    }
    (c.active, CwdSource::ActiveWorkspace)
}

fn explicit_root(workspace_root: &Option<String>) -> Option<PathBuf> {
    match workspace_root {
        Some(root) if !root.is_empty() => Some(PathBuf::from(root)),
        _ => None,
    }
}

/// 档案里的归属路径。目录不存在（换了机器 / 已删）等同没记——回落链继续往下走。
fn recorded_root(session_id: &str) -> Option<PathBuf> {
    let p = PathBuf::from(crate::commands::our_session_workspace(session_id).path?);
    p.is_dir().then_some(p)
}

/// 会话工作目录：显式 workspace_root → 档案 wsPath → 当前活动工作区。
///
/// 最后那条**必须留痕**：前两条都缺席时，会话会整个跑在"此刻看着的工作区"里
/// （cwd / 记忆目录 / CLAUDE.md / 转录落点全跟着变），而界面上没有任何提示——
/// 2026-09-18 工作机的跨工作区串档正是这么发生的（历史会话重开后落进活动工作区）。
/// 查不到就回落是既定策略，但不许无声。
fn session_cwd(
    session_id: &str,
    workspace_root: &Option<String>,
    workspace_state: &State<'_, WorkspaceState>,
) -> PathBuf {
    let (cwd, source) = pick_cwd(CwdCandidates {
        explicit: explicit_root(workspace_root),
        recorded: recorded_root(session_id),
        active: project_root_for_commands(workspace_state),
    });
    if source == CwdSource::ActiveWorkspace {
        tracing::warn!(
            session_id,
            fallback_cwd = %cwd.display(),
            "send_message: 会话无工作区归属（客户端未传且档案无 wsPath），回落活动工作区"
        );
    }
    cwd
}

// ---- 静态数据（模型列表、权限模式） ----

fn resolve_sidecar_data_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let path = manifest
            .parent()
            .unwrap()
            .join("agent-sidecar")
            .join(file_name);
        if path.exists() {
            return Ok(path);
        }
        Err(format!("{} not found at {:?}", file_name, path))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let path = resource_dir.join("agent-runtime").join(file_name);
        if path.exists() {
            return Ok(path);
        }
        // fallback
        let fallback = resource_dir.join("agent-sidecar").join(file_name);
        if fallback.exists() {
            return Ok(fallback);
        }
        Err(format!("{} resource missing: {:?}", file_name, path))
    }
}

fn read_sidecar_data_json(
    app: &tauri::AppHandle,
    file_name: &str,
) -> Result<serde_json::Value, String> {
    let path = resolve_sidecar_data_path(app, file_name)?;
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", file_name, e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", file_name, e))
}

#[tauri::command]
pub fn get_default_models() -> Result<serde_json::Value, String> {
    // 单一真源：catalog 预设里 system_default 的 models 字段。
    // 此前是读 agent-sidecar/default-models.json 兜底——SDK 协议翻译层需要别名
    // 与真名两种形态，但现在下拉/比对/展示已统一用真名（详见 sonnet 越界修复），
    // 这条数据是前端唯一的"系统默认供应商"模型列表入口，删冗余文件后归位。
    use crate::runtime::provider::{catalog, ProviderKind};
    let models = catalog::catalog_find(ProviderKind::SystemDefault)
        .map(|p| p.models.clone())
        .unwrap_or_default();
    let arr: Vec<serde_json::Value> = models
        .into_iter()
        .map(|m| serde_json::json!({ "value": m, "displayName": m }))
        .collect();
    Ok(serde_json::Value::Array(arr))
}

#[tauri::command]
pub fn get_default_permission_modes(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-permission-modes.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 会话 cwd 的优先级：显式 > 档案 > 活动工作区（2026-09-18 串档修复的纯核）。
    #[test]
    fn pick_cwd_prefers_explicit_then_recorded_then_active() {
        let cand = |explicit: Option<&str>, recorded: Option<&str>| CwdCandidates {
            explicit: explicit.map(PathBuf::from),
            recorded: recorded.map(PathBuf::from),
            active: PathBuf::from("C:/active"),
        };

        assert_eq!(
            pick_cwd(cand(Some("C:/explicit"), Some("C:/recorded"))),
            (PathBuf::from("C:/explicit"), CwdSource::Explicit)
        );
        assert_eq!(
            pick_cwd(cand(None, Some("C:/recorded"))),
            (PathBuf::from("C:/recorded"), CwdSource::Recorded)
        );
        // 两条都缺席 = 会在生产里留 warn 的那条路径
        assert_eq!(
            pick_cwd(cand(None, None)),
            (PathBuf::from("C:/active"), CwdSource::ActiveWorkspace)
        );
    }

    /// 空串 workspace_root 视同缺席（前端 `undefined` 与 `""` 同义，别当成路径）。
    #[test]
    fn explicit_root_treats_empty_as_absent() {
        assert_eq!(explicit_root(&Some(String::new())), None);
        assert_eq!(explicit_root(&None), None);
        assert_eq!(
            explicit_root(&Some("C:/proj".to_string())),
            Some(PathBuf::from("C:/proj"))
        );
    }

    /// 默认开 thinking_enabled（与 send_message 生产路径的默认一致）。
    fn base_opts() -> SendOptions<'static> {
        SendOptions {
            thinking_enabled: true,
            ..Default::default()
        }
    }

    /// @目录 授权：过闸的进 `additional_dirs`（数组），被拒的进 `attach_rejected`
    /// （**回声**——fail-closed 不能静默，前端据此显示"未注册，已忽略"）。
    #[test]
    fn build_send_command_carries_additional_dirs_and_rejections() {
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                attach: Some(crate::commands::workspace::attach::AttachResolution {
                    accepted: vec!["C:\\repo".to_string(), "D:\\other".to_string()],
                    rejected: vec!["C:\\Windows".to_string()],
                }),
                ..base_opts()
            },
        );
        assert_eq!(cmd["additional_dirs"], json!(["C:\\repo", "D:\\other"]));
        assert_eq!(cmd["attach_rejected"], json!(["C:\\Windows"]));
    }

    /// 授权字段的缺席形态：没带（None）与两者皆空都不落字段——与"没有这个功能"
    /// 同形（旧端/鸿蒙缺席即此）。全部被拒时只落回声、不落 additional_dirs。
    #[test]
    fn build_send_command_omits_attach_fields_when_empty() {
        let absent = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert!(absent.get("additional_dirs").is_none());
        assert!(absent.get("attach_rejected").is_none());

        let empty = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                attach: Some(crate::commands::workspace::attach::AttachResolution::default()),
                ..base_opts()
            },
        );
        assert!(empty.get("additional_dirs").is_none());
        assert!(empty.get("attach_rejected").is_none());

        let all_rejected = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                attach: Some(crate::commands::workspace::attach::AttachResolution {
                    accepted: vec![],
                    rejected: vec!["C:\\Windows".to_string()],
                }),
                ..base_opts()
            },
        );
        assert!(all_rejected.get("additional_dirs").is_none());
        assert_eq!(all_rejected["attach_rejected"], json!(["C:\\Windows"]));
    }

    #[test]
    fn send_message_cmd_has_session_id() {
        // 回归：所有命令必须带 session_id，否则 Runtime 无法路由
        let cmd = json!({ "cmd": "send", "session_id": "test-sid", "prompt": "hello", "cwd": "/tmp", "env": {} });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["cmd"], "send");
    }

    #[test]
    fn session_stop_cmd_has_session_id() {
        let cmd = json!({ "cmd": "session_stop", "session_id": "test-sid" });
        assert_eq!(cmd["session_id"], "test-sid");
    }

    #[test]
    fn permission_response_cmd_has_session_id() {
        let cmd = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": true,
            "always": serde_json::Value::Null,
        });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["id"], "perm-1");
        assert_eq!(cmd["approved"], true);
    }

    /// 回归：拒绝带理由时 permission_response 必须携带 message（sidecar 交给
    /// CLI 当 user feedback）；无理由时不得出现该键（保持旧行为）。
    #[test]
    fn permission_response_cmd_message_optional() {
        let with_msg = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": false,
            "always": serde_json::Value::Null,
            "message": "改用相对路径",
        });
        assert_eq!(with_msg["message"], "改用相对路径");

        let without_msg = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": false,
            "always": serde_json::Value::Null,
        });
        assert!(without_msg.get("message").is_none());
    }

    /// 会话级规则草稿：带则透传 sessionRules，不带则不得出现该键。
    #[test]
    fn permission_response_cmd_session_rules_optional() {
        let with_rules = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": true,
            "always": serde_json::Value::Null,
            "sessionRules": [{
                "effect": "allow",
                "tool": "Edit",
                "matcher": { "kind": "path", "field": "file_path", "file": "C:/x.ts" },
            }],
        });
        assert_eq!(with_rules["sessionRules"][0]["tool"], "Edit");
        assert_eq!(with_rules["sessionRules"][0]["matcher"]["file"], "C:/x.ts");

        let without_rules = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": true,
            "always": serde_json::Value::Null,
        });
        assert!(without_rules.get("sessionRules").is_none());
    }

    #[test]
    fn interrupt_cmd_has_session_id() {
        let cmd = json!({ "cmd": "interrupt", "session_id": "test-sid" });
        assert_eq!(cmd["session_id"], "test-sid");
    }

    #[test]
    fn set_model_cmd_has_session_id() {
        let cmd = json!({ "cmd": "set_model", "session_id": "test-sid", "model": "sonnet" });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["model"], "sonnet");
    }

    /// 回归：决策命令的 wire 形状必须与 sidecar SidecarCommand 的
    /// model_switch_confirm_decision 成员同形（缺 confirm_id/approve 任一键，
    /// guard 的 resolveConfirm 会因 ID 对不上静默忽略，切换挂到超时 deny）。
    #[test]
    fn model_switch_confirm_decision_cmd_shape() {
        let cmd = json!({
            "cmd": "model_switch_confirm_decision",
            "session_id": "test-sid",
            "confirm_id": "switch-confirm-1",
            "approve": true
        });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["confirm_id"], "switch-confirm-1");
        assert_eq!(cmd["approve"], true);
    }

    /// 回归：普通 send 不携带 btw/fork_from/provider_switched，SessionWorker 不应该
    /// 把 session_id 当作 fork 源（否则 SDK 会尝试 resume 不存在的会话导致 404）。
    #[test]
    fn send_message_cmd_no_fork_triggers_for_normal_session() {
        let cmd = json!({ "cmd": "send", "session_id": "normal-sid", "prompt": "hello", "cwd": "/tmp", "env": {} });
        // 普通会话不应有 fork 标记
        assert!(cmd.get("btw").is_none() || cmd["btw"] == false);
        assert!(cmd.get("fork_from").is_none());
        assert!(cmd.get("provider_switched").is_none() || cmd["provider_switched"] == false);
        assert_eq!(cmd["session_id"], "normal-sid"); // 路由键仍然存在
    }

    /// btw_ask 命令形状：session_id 是**主会话**路由键（btw 不再有独立会话 id），
    /// history 空/省略时不带该键（对齐官方：调用方不传就没有跨问连续性）。
    #[test]
    fn btw_ask_cmd_uses_main_session_id_and_omits_empty_history() {
        let main_sid = "main-session-id";
        let mut cmd = json!({
            "cmd": "btw_ask",
            "session_id": main_sid,
            "question": "顺便问",
        });
        assert_eq!(cmd["session_id"], main_sid);
        assert!(cmd.get("history").is_none());

        cmd["history"] = json!([{ "question": "旧问", "response": "旧答" }]);
        assert_eq!(cmd["history"][0]["question"], "旧问");
        assert_eq!(cmd["history"][0]["response"], "旧答");
    }

    /// 回归（Bug 2）：resume_id 必须进 resume_session_id 字段，不能覆盖 session_id（路由键）。
    /// 覆盖了会让 SessionManager 用真 ID 建 worker，但 SessionWorker.resumeSource 仍空 → 不 resume。
    #[test]
    fn build_send_command_resume_goes_to_separate_field() {
        let cmd = build_send_command(
            "main-sid", // session_id（路由键 = 前端 sid）
            "继续聊",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                resume_id: Some("resume-xyz".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["cmd"], "send");
        assert_eq!(cmd["session_id"], "main-sid"); // 路由键不变
        assert_eq!(cmd["resume_session_id"], "resume-xyz"); // resume 进独立字段
        assert!(cmd.get("provider_switched").is_none() || cmd["provider_switched"] == false);
    }

    /// 回归：无 resume_id 时不出 resume_session_id 字段（普通新会话）。
    #[test]
    fn build_send_command_no_resume_field_when_absent() {
        let cmd = build_send_command("temp-1", "hi", "/tmp", &HashMap::new(), base_opts());
        assert_eq!(cmd["session_id"], "temp-1");
        assert!(cmd.get("resume_session_id").is_none());
    }

    /// images 非空才落字段（Some 非空 → cmd.images；空数组与 None 均不落）。
    #[test]
    fn build_send_command_carries_images_when_nonempty() {
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                images: Some(&[json!({"mime": "image/png", "data": "aGk="})]),
                ..base_opts()
            },
        );
        assert_eq!(cmd["images"][0]["mime"], "image/png");
        // 空数组：与 None 一样不落字段
        let empty = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                images: Some(&[]),
                ..base_opts()
            },
        );
        assert!(empty.get("images").is_none());
    }

    /// initial_model 注入 env.ANTHROPIC_MODEL 覆盖 provider 默认；空串不注入
    /// （保留 provider env 原值）。与 effort 共用 attach_env_override（带值/空串臂）。
    #[test]
    fn build_send_command_carries_initial_model() {
        let env: HashMap<String, String> = HashMap::from([(
            "ANTHROPIC_MODEL".to_string(),
            "claude-sonnet-4-5".to_string(),
        )]);
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &env,
            SendOptions {
                initial_model: Some("claude-opus-4-1".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["env"]["ANTHROPIC_MODEL"], "claude-opus-4-1");
        // 空串：不注入，provider env 原值保留
        let blank = build_send_command(
            "s",
            "hi",
            "/tmp",
            &env,
            SendOptions {
                initial_model: Some(String::new()),
                ..base_opts()
            },
        );
        assert_eq!(blank["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4-5");
    }

    /// effort 与 initial_model 同形：initial_effort 注入 env.CLAUDE_CODE_EFFORT_LEVEL
    /// 覆盖 provider 默认；缺省/空串则不注入（保留 provider env 原值）。
    #[test]
    fn build_send_command_carries_initial_effort() {
        let env: HashMap<String, String> =
            HashMap::from([("CLAUDE_CODE_EFFORT_LEVEL".to_string(), "LOW".to_string())]);
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &env,
            SendOptions {
                initial_effort: Some("max".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "max");
        // 缺省：provider env 原值保留（sidecar 读作 provider 默认档位）
        let cmd2 = build_send_command("s", "hi", "/tmp", &env, base_opts());
        assert_eq!(cmd2["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "LOW");
    }

    /// 快速 ⇒ 关思考（2026-09-19 决策）。**档位是唯一事实源**——那个独立的
    /// 「启用思考」设置已删除，所以这里不再有"设置关掉"这条臂。
    /// 大小写不敏感是硬要求：provider 配置里的默认档位是大写 `LOW`。
    #[test]
    fn fast_effort_disables_thinking() {
        assert!(!thinking_enabled_for_effort(Some("low")));
        assert!(!thinking_enabled_for_effort(Some("LOW")));
        // 其余档位恒开
        assert!(thinking_enabled_for_effort(Some("high")));
        assert!(thinking_enabled_for_effort(Some("max")));
        // 历史档位归一后不是快速，不能误判
        assert!(thinking_enabled_for_effort(Some("medium")));
        assert!(thinking_enabled_for_effort(Some("xhigh")));
        // 档位缺席（旧端/鸿蒙不带该字段）→ 保持开，不拿默认值当快速
        assert!(thinking_enabled_for_effort(None));
    }

    /// permission_mode 非空才落字段；空串不落。
    #[test]
    fn build_send_command_carries_permission_mode() {
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                permission_mode: Some("writeEdits".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["permission_mode"], "writeEdits");
        // 空串：不落字段
        let blank = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                permission_mode: Some(String::new()),
                ..base_opts()
            },
        );
        assert!(blank.get("permission_mode").is_none());
    }

    /// jump_queue 仅 true 落字段（false 与缺省一致，不落）。
    #[test]
    fn build_send_command_carries_jump_queue_when_enabled() {
        let on = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                jump_queue: true,
                ..base_opts()
            },
        );
        assert_eq!(on["jump_queue"], true);
        let off = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert!(off.get("jump_queue").is_none());
    }

    /// display（用户气泡渲染描述）原样透传，Rust 层不解释结构。None 与 null 都不落
    /// 字段——两者对 sidecar 等价于「按纯文本渲染」（鸿蒙 v1 就是不带这个字段）。
    #[test]
    fn build_send_command_carries_display_when_present() {
        let display = json!([{ "type": "text", "text": "hi" }]);
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                display: Some(display.clone()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["display"], display);

        // 缺省：不落字段
        let absent = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert!(absent.get("display").is_none());

        // 显式 null：与缺省同义，也不落字段
        let nulled = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                display: Some(serde_json::Value::Null),
                ..base_opts()
            },
        );
        assert!(nulled.get("display").is_none());
    }

    /// 回归：provider_switched 仍照常带，且不干扰 resume_session_id。
    #[test]
    fn build_send_command_provider_switched_and_resume_coexist() {
        let cmd = build_send_command(
            "main-sid",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                resume_id: Some("resume-xyz".to_string()),
                provider_switched: true,
                ..base_opts()
            },
        );
        assert_eq!(cmd["session_id"], "main-sid");
        assert_eq!(cmd["resume_session_id"], "resume-xyz");
        assert_eq!(cmd["provider_switched"], true);
    }

    /// 思考开关（settings.thinkingEnabled）随 send 命令下发给 sidecar：
    /// false 时 spawn 的 thinking 参数为 disabled（会话内无效，只影响新建会话）。
    #[test]
    fn build_send_command_carries_thinking_enabled_flag() {
        let on = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert_eq!(on["thinking_enabled"], true);
        let off = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                thinking_enabled: false,
                ..base_opts()
            },
        );
        assert_eq!(off["thinking_enabled"], false);
    }

    /// 输出样式（settings.outputStyle）随 send 命令下发给 sidecar：非默认才落字段。
    /// 默认值 `"default"` 与空串都不落——sidecar 缺席即按默认处理，三条等价。
    #[test]
    fn build_send_command_carries_output_style_when_set() {
        // 生产最常见路径：设置里就是默认值（serde 默认恒为 "default"），不落字段。
        let defaulted = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                output_style: DEFAULT_OUTPUT_STYLE.to_string(),
                ..base_opts()
            },
        );
        assert!(defaulted.get("output_style").is_none());

        // 空串（仅手改 config.json 能造出来）同样不落。
        let blank = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert!(blank.get("output_style").is_none());

        let set = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                output_style: "Explanatory".to_string(),
                ..base_opts()
            },
        );
        assert_eq!(set["output_style"], "Explanatory");
    }
}
