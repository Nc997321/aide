// 会话域总入口：本文件只保留会话元数据（~/.aide/sessions/<id>.json 的
// CRUD / 偏好记忆 / 自动命名守门）与两处工作区会话扫描，外加子模块
// re-export 门面——外部（lib.rs / remote/rpc/handlers / automation）继续走
// `commands::session::X`，路径经下方 pub use 保持不变。

mod changes;
mod history;
mod jsonl;
mod transcript;

pub use changes::{append_session_change, load_session_changes, save_session_changes};
pub use history::load_messages;
pub use jsonl::{session_jsonl_size, session_last_event, session_truncate_jsonl};
// 供自动化 RunRecord.summary 读取末条消息摘要（automation/scheduler.rs）
pub(crate) use jsonl::last_jsonl_message;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use tauri::State;

use super::{
    claude_projects_dir, claude_sessions_dir, our_session_is_automation, our_session_name,
    our_sessions_dir, project_root_for_commands, Session, WorkspaceState,
};

// tauri 的 __cmd__<name> 宏跟随 fn 的定义模块（不随 pub use 转发），而
// lib.rs 的 generate_handler / remote handlers 按 `commands::session::X`
// 引用命令——把跨文件命令的宏 item 逐个转发回来，保证注册路径不变。
pub(crate) use changes::{
    __cmd__append_session_change, __cmd__load_session_changes, __cmd__save_session_changes,
    __tauri_command_name_append_session_change, __tauri_command_name_load_session_changes,
    __tauri_command_name_save_session_changes,
};
pub(crate) use history::{__cmd__load_messages, __tauri_command_name_load_messages};
pub(crate) use jsonl::{
    __cmd__session_jsonl_size, __cmd__session_last_event, __cmd__session_truncate_jsonl,
    __tauri_command_name_session_jsonl_size, __tauri_command_name_session_last_event,
    __tauri_command_name_session_truncate_jsonl,
};

/// 扫描目录 + 每个会话读一次 .jsonl 取末条消息，工作区会话多时是实打实的重 IO；
/// 同步 command 跑在主线程上会卡窗口，这里主线程只取工作区快照，扫描进 blocking 线程。
#[tauri::command]
pub async fn list_sessions(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<Session>, String> {
    let encoded = match workspace_state.key.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(key) => key.clone(),
            None => return Ok(Vec::new()),
        },
        Err(_) => return Ok(Vec::new()),
    };
    let root = project_root_for_commands(&workspace_state);
    tokio::task::spawn_blocking(move || list_sessions_blocking(encoded, root))
        .await
        .map_err(|e| format!("list_sessions task panicked: {}", e))?
}

/// 扫描单个项目目录下的 .jsonl 会话并追加到 sessions（按 session id 去重——
/// 同一工作区可能因目录编码差异分裂成多个目录，见 `resolve_project_dirs`，
/// 防御同一份 transcript 出现在多个目录时重复列出）。
fn scan_project_jsonl_sessions(
    proj_dir: &std::path::Path,
    sessions: &mut Vec<Session>,
) -> Result<(), String> {
    // 目录可能不存在（工作区登记后还没有任何对话），跳过即可
    if !proj_dir.exists() {
        return Ok(());
    }
    let read_dir =
        fs::read_dir(proj_dir).map_err(|e| format!("Failed to read project dir: {}", e))?;

    for entry in read_dir {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            continue;
        }
        let session_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if session_id.is_empty() || sessions.iter().any(|s| s.id == session_id) {
            continue;
        }
        // 自动化运行产物不进正常会话列表（tags 机制见 our_session_is_automation）
        if our_session_is_automation(&session_id) {
            continue;
        }

        let (name, started_at) =
            claude_session_meta(&session_id).unwrap_or_else(|| (session_id.clone(), 0));

        let timestamp = if started_at == 0 {
            path.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        } else {
            started_at
        };

        let display_name = our_session_name(&session_id).unwrap_or(name);

        sessions.push(Session {
            id: session_id,
            name: display_name,
            timestamp,
        });
    }
    Ok(())
}

fn list_sessions_blocking(
    encoded: String,
    root: std::path::PathBuf,
) -> Result<Vec<Session>, String> {
    let mut sessions: Vec<Session> = Vec::new();

    // Scan .jsonl files if the project directory exists (created after first
    // conversation). If it doesn't exist yet, skip to metadata scan — sessions
    // that were started but never had a conversation still have metadata in
    // ~/.aide/claude/sessions/.
    // 同一工作区可能因 SDK 编码差异（`.` → `-`）分裂成多个项目目录，全部合并扫描。
    for proj_dir in super::resolve_project_dirs(&claude_projects_dir(), &encoded) {
        scan_project_jsonl_sessions(&proj_dir, &mut sessions)?;
    }

    // Second pass: scan ~/.aide/claude/sessions/ for sessions that have metadata
    // but no .jsonl file yet (Claude started, no conversation happened).
    // These sessions won't appear in the project dir scan above.
    let root_normalized = normalize_path_for_compare(&root.to_string_lossy());
    let sessions_dir = claude_sessions_dir();
    if sessions_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&sessions_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else {
                    continue;
                };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    let Ok(content) = fs::read_to_string(&path) else {
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<Value>(&content) else {
                        continue;
                    };

                    let session_cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
                    if normalize_path_for_compare(session_cwd) != root_normalized {
                        continue;
                    }

                    let session_id = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
                    if session_id.is_empty() {
                        continue;
                    }

                    // Skip if already in the list (has a .jsonl file)
                    if sessions.iter().any(|s| s.id == session_id) {
                        continue;
                    }

                    // 自动化运行产物不进正常会话列表
                    if our_session_is_automation(session_id) {
                        continue;
                    }

                    let name = v
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                    let display_name = our_session_name(&session_id).unwrap_or(name);

                    sessions.push(Session {
                        id: session_id.to_string(),
                        name: display_name,
                        timestamp: started_at,
                    });
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

/// 创建会话元数据。调用方传入 id——发消息、拿到 SDK 返回的真实 session id
/// 之后才会调用这个命令（见 CLAUDE.md「会话 ID 生命周期」），所以这里的 id
/// 从一开始就是终身 id，不存在草稿 id 需要事后改名的情况。
#[tauri::command]
pub fn create_session(id: String, name: String) -> Result<Session, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let meta =
        serde_json::json!({ "id": id, "name": name, "createdAt": timestamp, "nameSource": "auto" });
    let path = dir.join(format!("{}.json", id));
    fs::write(
        &path,
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write session: {}", e))?;

    Ok(Session {
        id,
        name,
        timestamp,
    })
}

#[tauri::command]
pub fn delete_session(
    _workspace_state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    let our_path = our_sessions_dir().join(format!("{}.json", id));
    if our_path.exists() {
        fs::remove_file(&our_path).map_err(|e| format!("Failed to delete metadata: {}", e))?;
    }

    // Remove the transcript wherever Claude actually stored it. `claude --resume
    // <id>` is global, so a session's .jsonl may live under a project folder whose
    // encoding differs from the cwd-encoding Aide would compute (e.g. Claude once
    // encoded '.' as '-' while Aide keeps it). Searching by id across all project
    // folders — instead of re-encoding the cwd — guarantees we delete the real
    // file rather than silently no-op'ing and leaving it resumable.
    for jsonl in super::find_session_jsonl_globally(&id) {
        fs::remove_file(&jsonl).map_err(|e| format!("Failed to delete session file: {}", e))?;
        // Drop the per-session sibling directory (<id>/, holds subagent transcripts)
        // if Claude created one next to the .jsonl.
        if let Some(dir) = jsonl.parent().map(|p| p.join(&id)) {
            if dir.is_dir() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }

    let ses_dir = claude_sessions_dir();
    if ses_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&ses_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else {
                    continue;
                };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(v) = serde_json::from_str::<Value>(&content) {
                            if v.get("sessionId").and_then(|s| s.as_str()) == Some(&id) {
                                let _ = fs::remove_file(&path);
                            }
                        }
                    }
                }
            }
        }
    }

    // 同步移除「最近访问」中已删会话（双保险，配合 list_recent 自愈）。
    let _ = super::recent::remove_recent_session(id);

    Ok(())
}

/// 会话元数据字段的三态写入语义。
///
/// 取代此前「空串 = 删字段」的魔法值约定（`if s.is_empty() { remove } else { write }`）：
/// 那种写法把操作类型编码进值域，读代码的人必须知道约定才能读懂，且无法表达
/// 「本次不动这个字段」——合并写入时只能靠"传空串"绕过，正是多字段并发写互相
/// 覆盖（lost update）的温床。
///
/// 前端 L1（`sessionMeta.ts` 的 MetaField）与本枚举同形，serde tag 对齐。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MetaField {
    /// 本次不动这个字段（缺省值——命令参数可省略）。
    Keep,
    /// 删掉这个字段，回到「没记过」。
    Clear,
    /// 写入该值。
    Set { value: String },
}

impl Default for MetaField {
    fn default() -> Self {
        MetaField::Keep
    }
}

/// `<id>.json` 的一次写入所需全部字段。缺省 = Keep（serde default + MetaField::default）。
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct SessionMetaPatch {
    pub name: MetaField,
    /// "manual" / "auto"：重命名守门字段，由 rename / auto_rename 内部置，不对外暴露。
    pub name_source: MetaField,
    pub provider: MetaField,
    pub model: MetaField,
    pub effort: MetaField,
}

fn apply_field(v: &mut Value, key: &str, f: &MetaField) {
    match f {
        MetaField::Keep => {}
        MetaField::Clear => {
            v.as_object_mut().map(|o| o.remove(key));
        }
        MetaField::Set { value } => {
            v[key] = Value::String(value.clone());
        }
    }
}

/// 会话元数据 `<id>.json` 的**唯一**写入路径：一次读、合并 patch、一次写。
///
/// 此前每个命令（rename / set_session_model / set_session_provider / set_session_effort）
/// 各自做一遍 read-modify-write，两个字段并发写会互相覆盖。收敛到这里之后：
///  - 多字段合并写入天然原子（同一份 Value 上改完一次落盘）；
///  - 将来要加串行化/文件锁，只需改这一处。
fn write_session_meta_blocking(id: &str, patch: &SessionMetaPatch) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    let path = dir.join(format!("{}.json", id));

    let mut v: Value = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
    } else {
        serde_json::json!({ "id": id })
    };

    apply_field(&mut v, "name", &patch.name);
    apply_field(&mut v, "nameSource", &patch.name_source);
    apply_field(&mut v, "provider", &patch.provider);
    apply_field(&mut v, "model", &patch.model);
    apply_field(&mut v, "effort", &patch.effort);

    fs::write(
        &path,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
pub fn rename_session(id: String, name: String) -> Result<(), String> {
    // 手动重命名：标记 nameSource=manual，此后自动生成的标题一律不得覆盖
    // （auto_rename_session 据此拒写）。
    write_session_meta_blocking(
        &id,
        &SessionMetaPatch {
            name: MetaField::Set { value: name },
            name_source: MetaField::Set {
                value: "manual".to_string(),
            },
            ..Default::default()
        },
    )
}

/// 自动命名（sidecar 首轮对话后生成的会话标题）：仅当用户没手动命名过时采纳。
/// `nameSource == "manual"` 直接拒写返回 false；缺该字段的旧数据视为 "auto"。
/// 判断 + 写入收在这一个函数里，防「自动标题生成的几秒内用户恰好手动改名」
/// 的竞态——前端拿到 true 才更新 UI。
/// 磁盘 IO 离开主线程（同 set_session_model，见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn auto_rename_session(id: String, name: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || auto_rename_session_blocking(&id, &name))
        .await
        .map_err(|e| format!("auto_rename_session task panicked: {}", e))?
}

fn auto_rename_session_blocking(id: &str, name: &str) -> Result<bool, String> {
    // 守门读：nameSource=manual 拒写。判与写仍是两段（与原实现同），
    // 但写这一侧走唯一路径 write_session_meta_blocking。
    let path = our_sessions_dir().join(format!("{}.json", id));
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        let v: Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
        if v.get("nameSource").and_then(|s| s.as_str()) == Some("manual") {
            return Ok(false);
        }
    }

    write_session_meta_blocking(
        id,
        &SessionMetaPatch {
            name: MetaField::Set {
                value: name.to_string(),
            },
            name_source: MetaField::Set {
                value: "auto".to_string(),
            },
            ..Default::default()
        },
    )?;
    Ok(true)
}

/// 会话元数据的唯一写入命令：provider / model / effort 一次写齐（一次读、一次写）。
///
/// 取代 set_session_provider / set_session_model / set_session_effort 三个单字段命令：
/// 它们各自对同一个 `<id>.json` 做一遍 read-modify-write，前端 L1 并发写两个字段时
/// 后写的覆盖先写的（lost update）。合并后结构上不可能再丢字段。
///
/// name 不在参数里——重命名带 nameSource 守门语义，走 rename_session /
/// auto_rename_session，内部与本命令共用 `write_session_meta_blocking`。
/// 磁盘 IO 离开主线程（见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn set_session_meta(
    id: String,
    provider: MetaField,
    model: MetaField,
    effort: MetaField,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_session_meta_blocking(
            &id,
            &SessionMetaPatch {
                provider,
                model,
                effort,
                ..Default::default()
            },
        )
    })
    .await
    .map_err(|e| format!("set_session_meta task panicked: {}", e))?
}

/// 读回会话记住的模型选择；没有元数据文件或没记过 → None。
#[tauri::command]
pub async fn session_model(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = our_sessions_dir().join(format!("{}.json", id));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        let v: Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
        Ok(v.get("model")
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("session_model task panicked: {}", e))?
}

/// 读回会话记住的 effort 选择；没有元数据文件或没记过 → None。
#[tauri::command]
pub async fn session_effort(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = our_sessions_dir().join(format!("{}.json", id));
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        let v: Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
        Ok(v.get("effort")
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("session_effort task panicked: {}", e))?
}

/// 读回会话绑定的供应商 id；没有元数据文件或没记过 → None（前端回落全局激活供应商）。
/// 字段读取与 send_message 的元数据兜底共用 `our_session_provider_field` 同一口径；
/// 读取失败降级为 None（与缺文件同语义，前端已 catch 兜底）。
#[tauri::command]
pub async fn session_provider(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || Ok(crate::commands::our_session_provider_field(&id)))
        .await
        .map_err(|e| format!("session_provider task panicked: {}", e))?
}

/// 发送前的身份漂移判定（桌面端与鸿蒙端共用）：本次将生效的 provider / model 与
/// 会话上次坐实的基线逐维比对，**先供应商、再模型**——两者都相同才算无漂移。
///
/// 基线口径与 `session_provider` / `session_model` 完全一致（同一份 `<id>.json`）；
/// 基线缺失（无元数据 / 字段为空 / 会话从未发过）→ 该维度 false：无基线不弹确认，
/// 与桌面 `needsConfirm` 的 `last = null → false` 同义。
///
/// 判定下沉到 Rust 的理由：规则只此一份，两端 UI 都调它，避免同一规则在
/// aide-sdk（confirmGate）与 ArkTS 侧各存一份、日后各自漂移。
/// 本命令只回答「哪一维漂了」，**不做 UI 决策**——弹不弹、文案怎么写归调用方。
#[derive(Serialize)]
pub struct IdentityDrift {
    #[serde(rename = "providerDrift")]
    pub provider_drift: bool,
    #[serde(rename = "modelDrift")]
    pub model_drift: bool,
    /// 会话记住的供应商 id（无 → null）：UI 组文案用。
    #[serde(rename = "lastProvider")]
    pub last_provider: Option<String>,
    #[serde(rename = "lastModel")]
    pub last_model: Option<String>,
}

/// 纯判定（可单测）：本次值 vs 基线。**空串 = 本次未指定**（由下游按供应商默认
/// 解析），无从比对 → 该维度 false；基线缺失同理。
fn compute_identity_drift(
    last_provider: Option<&str>,
    last_model: Option<&str>,
    provider_id: &str,
    model: &str,
) -> (bool, bool) {
    let provider_drift = last_provider
        .filter(|_| !provider_id.is_empty())
        .map(|last| last != provider_id)
        .unwrap_or(false);
    let model_drift = last_model
        .filter(|_| !model.is_empty())
        .map(|last| last != model)
        .unwrap_or(false);
    (provider_drift, model_drift)
}

#[tauri::command]
pub async fn session_identity_drift(
    id: String,
    provider_id: String,
    model: String,
) -> Result<IdentityDrift, String> {
    let last_provider = session_provider(id.clone()).await.unwrap_or(None);
    let last_model = session_model(id).await.unwrap_or(None);
    let (provider_drift, model_drift) = compute_identity_drift(
        last_provider.as_deref(),
        last_model.as_deref(),
        &provider_id,
        &model,
    );
    Ok(IdentityDrift {
        provider_drift,
        model_drift,
        last_provider,
        last_model,
    })
}

/// 会话进程是否存活（唯一权威来源：Rust 侧存活表，见 `AgentRuntimeManager::session_alive`）。
///
/// 远程端用它决定模型下拉的口径：
///  - **存活** → 锁定会话自己的供应商。此时切到别的供应商的模型，请求会带着新模型名
///    打到旧供应商的 baseUrl 上，直接 400（手机端报的 `glm` 送到 deepseek 就是这么来的）。
///  - **未存活** → 跟随全局激活供应商，与桌面「有活进程才锁定」同一语义。
///
/// 此前远程端无从判断，只能无条件按全局算下拉，于是存活会话也被换成了别的供应商的模型。
#[tauri::command]
pub fn session_alive(
    id: String,
    runtime_mgr: State<'_, crate::runtime::AgentRuntimeManager>,
) -> Result<bool, String> {
    Ok(runtime_mgr.is_session_alive(&id))
}

/// List sessions for a specific workspace by its encoded key, without relying
/// on the current WorkspaceState. Used by the frontend to load sessions for
/// non-active (but expanded) workspaces (侧栏展开工作区 / 分屏布局恢复).
///
/// 同 `list_sessions`：扫目录 + 逐会话读 .jsonl/JSON 元数据是重同步 IO，必须
/// async + spawn_blocking，否则堵主线程（诊断黑匣子实锤过同类命令 `session_jsonl_size`
/// 堵死主线程 30s+，这个命令逻辑更重，是同一类风险，一并修）。
#[tauri::command]
pub async fn list_sessions_for_workspace(ws_key: String) -> Result<Vec<Session>, String> {
    tokio::task::spawn_blocking(move || list_sessions_for_workspace_blocking(ws_key))
        .await
        .map_err(|e| format!("list_sessions_for_workspace task panicked: {}", e))?
}

fn list_sessions_for_workspace_blocking(ws_key: String) -> Result<Vec<Session>, String> {
    let mut sessions: Vec<Session> = Vec::new();

    // 同 list_sessions_blocking：dot 归一匹配所有候选项目目录，合并扫描。
    for proj_dir in super::resolve_project_dirs(&claude_projects_dir(), &ws_key) {
        scan_project_jsonl_sessions(&proj_dir, &mut sessions)?;
    }

    // Second pass: scan ~/.aide/claude/sessions/ for sessions with metadata but no .jsonl
    let root = super::resolve_path_from_key(&ws_key).unwrap_or_default();
    let root_normalized = normalize_path_for_compare(&root);
    let sessions_dir = claude_sessions_dir();
    if sessions_dir.exists() && !root.is_empty() {
        if let Ok(read_dir) = fs::read_dir(&sessions_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else {
                    continue;
                };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    let Ok(content) = fs::read_to_string(&path) else {
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<Value>(&content) else {
                        continue;
                    };

                    let session_cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
                    if normalize_path_for_compare(session_cwd) != root_normalized {
                        continue;
                    }

                    let session_id = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
                    if session_id.is_empty() {
                        continue;
                    }

                    if sessions.iter().any(|s| s.id == session_id) {
                        continue;
                    }

                    let name = v
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                    let display_name = our_session_name(&session_id).unwrap_or(name);

                    sessions.push(Session {
                        id: session_id.to_string(),
                        name: display_name,
                        timestamp: started_at,
                    });
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

// ── Internal helpers ──

fn claude_session_meta(session_id: &str) -> Option<(String, u64)> {
    let dir = claude_sessions_dir();
    if !dir.exists() {
        return None;
    }
    let read_dir = fs::read_dir(&dir).ok()?;
    for entry in read_dir {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&content) {
                    if v.get("sessionId").and_then(|s| s.as_str()) == Some(session_id) {
                        let name = v
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("未命名")
                            .to_string();
                        let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                        return Some((name, started_at));
                    }
                }
            }
        }
    }
    None
}

/// Normalize a filesystem path so two paths pointing to the same location
/// compare equal: strip trailing separator, use forward slashes, lowercase.
fn normalize_path_for_compare(p: &str) -> String {
    p.trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase()
}

/// Lightweight session discovery used during new-session polling.
///
/// Scans only `~/.aide/claude/sessions/` (small JSON metadata, no .jsonl reads) and
/// returns IDs of sessions whose `startedAt > since_ms` that belong to the
/// current workspace. Results are sorted newest-first so the caller can pick the
/// first ID that isn't already mapped to an active PTY.
#[tauri::command]
pub fn find_sessions_since(
    workspace_state: State<'_, WorkspaceState>,
    since_ms: u64,
) -> Result<Vec<String>, String> {
    let sessions_dir = claude_sessions_dir();
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    let root = project_root_for_commands(&workspace_state);
    let root_normalized = normalize_path_for_compare(&root.to_string_lossy());

    let read_dir =
        fs::read_dir(&sessions_dir).map_err(|e| format!("Failed to read sessions dir: {}", e))?;

    let mut candidates: Vec<(String, u64)> = Vec::new();

    for entry in read_dir {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.extension().map(|e| e == "json").unwrap_or(false) {
            continue;
        }

        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&content) else {
            continue;
        };

        let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
        if started_at <= since_ms {
            continue;
        }

        let session_cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
        if normalize_path_for_compare(session_cwd) != root_normalized {
            continue;
        }

        let session_id = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
        if session_id.is_empty() {
            continue;
        }

        candidates.push((session_id.to_string(), started_at));
    }

    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(candidates.into_iter().map(|(id, _)| id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 身份漂移判定（session_identity_drift 的纯函数核心）──

    #[test]
    fn drift_none_when_provider_and_model_both_match() {
        // 两者都一样才不弹窗
        assert_eq!(
            compute_identity_drift(Some("p_a"), Some("m1"), "p_a", "m1"),
            (false, false)
        );
    }

    #[test]
    fn drift_detected_on_provider_change() {
        assert_eq!(
            compute_identity_drift(Some("p_a"), Some("m1"), "p_b", "m1"),
            (true, false)
        );
    }

    #[test]
    fn drift_detected_on_model_change_only() {
        assert_eq!(
            compute_identity_drift(Some("p_a"), Some("m1"), "p_a", "m2"),
            (false, true)
        );
    }

    #[test]
    fn drift_detected_on_both_change() {
        assert_eq!(
            compute_identity_drift(Some("p_a"), Some("m1"), "p_b", "m2"),
            (true, true)
        );
    }

    #[test]
    fn drift_false_without_baseline() {
        // 无基线 = 首次 / 未知，不弹确认（与桌面 needsConfirm 的 last=null 同义）
        assert_eq!(compute_identity_drift(None, None, "p_a", "m1"), (false, false));
    }

    #[test]
    fn drift_false_when_current_value_unspecified() {
        // 空串 = 本次未指定，由下游按供应商默认解析，无从比对
        assert_eq!(
            compute_identity_drift(Some("p_a"), Some("m1"), "", ""),
            (false, false)
        );
    }

    #[test]
    fn create_session_writes_metadata_under_caller_supplied_id() {
        // 回归：create_session 不再自造 new_<ts> id，必须原样用调用方传入的
        // （真实）id 落盘——这个 id 就是终身 id，没有事后改名这一步。
        let id = "test-fixed-id-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path); // 防止上次失败留下的残留

        let session = create_session(id.clone(), "测试会话".to_string()).unwrap();
        assert_eq!(session.id, id);
        assert_eq!(session.name, "测试会话");

        let content = fs::read_to_string(&path).expect("metadata file should exist");
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("id").and_then(|x| x.as_str()), Some(id.as_str()));
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("测试会话"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn create_session_marks_name_source_auto() {
        // 自动命名的判定依据：新建的会话名字是默认名（可覆盖），必须标 nameSource=auto。
        let id = "test-namesource-create-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("auto"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rename_session_marks_name_source_manual() {
        // 用户手动改过的名字必须标 manual——自动标题生成回来也不能覆盖它。
        let id = "test-namesource-rename-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        rename_session(id.clone(), "我自己起的名".to_string()).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("我自己起的名"));
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("manual"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_adopts_when_never_named_manually() {
        let id = "test-autorename-adopt-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        let adopted = auto_rename_session(id.clone(), "修复登录 Bug".to_string())
            .await
            .unwrap();
        assert!(adopted, "auto 命名的会话应采纳自动标题");

        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("修复登录 Bug"));
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("auto"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_refused_after_manual_rename() {
        // 竞态防线：标题生成要几秒，期间用户可能已手动改名——manual 一律拒写。
        let id = "test-autorename-refuse-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        rename_session(id.clone(), "我自己起的名".to_string()).unwrap();
        let adopted = auto_rename_session(id.clone(), "修复登录 Bug".to_string())
            .await
            .unwrap();
        assert!(!adopted, "manual 命名的会话必须拒绝自动标题");

        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("我自己起的名"));

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_treats_missing_name_source_as_auto() {
        // 旧数据没有 nameSource 字段——视为 auto（否则老会话永远拿不到自动标题）。
        let id = "test-autorename-legacy-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            serde_json::json!({ "id": id, "name": "旧会话" }).to_string(),
        )
        .unwrap();

        let adopted = auto_rename_session(id.clone(), "旧会话的新标题".to_string())
            .await
            .unwrap();
        assert!(adopted, "缺 nameSource 的旧数据应视为 auto");

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn auto_rename_creates_metadata_when_missing() {
        // 元数据文件还没建（极端时序：标题先于 create_session 到达）也能落盘。
        let id = "test-autorename-create-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        let adopted = auto_rename_session(id.clone(), "直接生成的标题".to_string())
            .await
            .unwrap();
        assert!(adopted);
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            v.get("name").and_then(|x| x.as_str()),
            Some("直接生成的标题")
        );

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn session_model_roundtrip_and_preserves_other_fields() {
        // 回归：模型选择记进会话元数据并能读回；merge 写不能冲掉 name 等既有字段。
        let id = "test-model-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "模型会话".to_string()).unwrap();
        assert_eq!(session_model(id.clone()).await.unwrap(), None);

        write_model(&id, MetaField::Set { value: "sonnet".to_string() }).await;
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("sonnet".to_string())
        );

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("模型会话"));

        // 覆盖写 + 清空（清空后读回 None）
        write_model(&id, MetaField::Set { value: "opus".to_string() }).await;
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("opus".to_string())
        );
        write_model(&id, MetaField::Clear).await;
        assert_eq!(session_model(id.clone()).await.unwrap(), None);

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn session_model_returns_none_for_unknown_session() {
        // 没记过的会话 → None，前端据此走默认选择逻辑
        assert_eq!(
            session_model("test-model-never-exists-aa11bb22".to_string())
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn session_provider_roundtrip_and_preserves_other_fields() {
        // 回归：供应商绑定记进会话元数据并能读回；merge 写不能冲掉 name/model 等既有字段。
        let id = "test-provider-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "供应商会话".to_string()).unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), None);

        write_provider(&id, MetaField::Set { value: "p_abc".to_string() }).await;
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_abc".to_string())
        );

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("供应商会话"));

        // 覆盖写 + 清空（清空后读回 None）
        write_provider(&id, MetaField::Set { value: "p_def".to_string() }).await;
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_def".to_string())
        );
        write_provider(&id, MetaField::Clear).await;
        assert_eq!(session_provider(id.clone()).await.unwrap(), None);

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn set_session_meta_writes_all_fields_in_one_pass() {
        // 回归（2026-09-08）：此前 provider / model / effort 各是一条命令，每条都
        // 自己 read-modify-write 一遍 `<id>.json`；前端 L1 用 Promise.all 并发写两个
        // 字段时，后落盘的覆盖先落盘的（lost update）。合并命令一次读、一次写，
        // 调用方一次写齐，结构上不可能再丢字段。
        let id = "test-meta-onepass-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session(id.clone(), "一次写会话".to_string()).unwrap();

        set_session_meta(
            id.clone(),
            MetaField::Set { value: "p_1".to_string() },
            MetaField::Set { value: "m_1".to_string() },
            MetaField::Set { value: "high".to_string() },
        )
        .await
        .unwrap();

        // 三个字段必须同时在盘上（旧实现下 model 会被 provider 的写覆盖掉）
        assert_eq!(session_provider(id.clone()).await.unwrap(), Some("p_1".to_string()));
        assert_eq!(session_model(id.clone()).await.unwrap(), Some("m_1".to_string()));
        assert_eq!(session_effort(id.clone()).await.unwrap(), Some("high".to_string()));

        // Keep 的字段不动：只改 model，provider/effort 必须原样
        set_session_meta(
            id.clone(),
            MetaField::Keep,
            MetaField::Set { value: "m_2".to_string() },
            MetaField::Keep,
        )
        .await
        .unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), Some("p_1".to_string()));
        assert_eq!(session_model(id.clone()).await.unwrap(), Some("m_2".to_string()));
        assert_eq!(session_effort(id.clone()).await.unwrap(), Some("high".to_string()));

        let _ = fs::remove_file(&path);
    }

    /// 测试辅助：只写 model 字段（其余 Keep）。
    async fn write_model(id: &str, model: MetaField) {
        set_session_meta(id.to_string(), MetaField::Keep, model, MetaField::Keep)
            .await
            .unwrap();
    }

    /// 测试辅助：只写 provider 字段（其余 Keep）。
    async fn write_provider(id: &str, provider: MetaField) {
        set_session_meta(id.to_string(), provider, MetaField::Keep, MetaField::Keep)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn session_provider_returns_none_for_unknown_session() {
        // 没记过的会话 → None，前端据此走全局激活供应商回落
        assert_eq!(
            session_provider("test-provider-never-exists-aa11bb22".to_string())
                .await
                .unwrap(),
            None
        );
    }
}
