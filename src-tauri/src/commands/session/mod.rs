// 会话域总入口：本文件只保留会话元数据（~/.aide/sessions/<id>.json 的
// CRUD / 偏好记忆 / 自动命名守门）与两处工作区会话扫描，外加子模块
// re-export 门面——外部（lib.rs / remote/rpc/handlers / automation）继续走
// `commands::session::X`，路径经下方 pub use 保持不变。

mod changes;
mod history;
mod jsonl;

pub use changes::{append_session_change, load_session_changes, save_session_changes};
pub use history::load_messages;
pub use jsonl::{session_jsonl_size, session_last_event, session_truncate_jsonl};
// 供自动化 RunRecord.summary 读取末条消息摘要（automation/scheduler.rs）
pub(crate) use jsonl::last_jsonl_message;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
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
    workspace_state: State<'_, std::sync::Arc<WorkspaceState>>,
    app: tauri::AppHandle,
) -> Result<Vec<Session>, String> {
    let active_root = project_root_for_commands(&workspace_state);
    if let Some((host, posix)) = active_root
        .to_str()
        .and_then(crate::remote_workspace::path::parse)
    {
        return remote_sessions(&app, &host, &posix).await;
    }
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

/// 远程工作区的会话列表：目标机给转录原料（id / CLI 元数据 / mtime），桌面叠加自己的
/// 元数据（显示名、自动化标签过滤）——与本机列表同一口径。
async fn remote_sessions(
    app: &tauri::AppHandle,
    host: &crate::remote_workspace::path::HostId,
    posix_root: &str,
) -> Result<Vec<Session>, String> {
    let v = crate::remote_workspace::sessions::transcript_call(
        app,
        host,
        "transcript_list",
        serde_json::json!({ "root": posix_root }),
    )
    .await?;
    let entries: Vec<aide_workspace::transcripts::TranscriptEntry> =
        serde_json::from_value(v).map_err(|e| e.to_string())?;
    let mut sessions: Vec<Session> = entries
        .into_iter()
        .filter(|e| !our_session_is_automation(&e.id))
        .map(|e| Session {
            name: our_session_name(&e.id)
                .or(e.cli_name)
                .unwrap_or_else(|| e.id.clone()),
            timestamp: if e.started_at == 0 { e.mtime_ms } else { e.started_at },
            id: e.id,
        })
        .collect();
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
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
pub async fn create_session(id: String, name: String) -> Result<Session, String> {
    tokio::task::spawn_blocking(move || create_session_blocking(id, name))
        .await
        .map_err(|e| format!("create_session task panicked: {e}"))?
}

/// 磁盘 IO 离开主线程：`create_dir_all` + `fs::write` 是真落盘，且固定在
/// `session_init` 之后由 onSessionCreated 触发（App.vue），恰好压在会话起步的
/// 繁忙点上。2026-09-05 一份 2.9 秒的主线程阻塞报告正卡在这个位置——当时它连
/// trace 都没埋，是 `stuckCommand=None` 的结构性盲区。
///
/// 建档案走**合并写**（`write_session_created`）：同一条会话在 finalize 那一刻
/// 还有别的写者（`settleOnSend` 的 provider、工作区归属），盲写整文件会把对方
/// 刚落的键抹掉。
fn create_session_blocking(id: String, name: String) -> Result<Session, String> {
    let timestamp = crate::commands::recent::now_ms();
    let path = our_sessions_dir().join(format!("{}.json", id));
    write_session_created(&path, &id, &name, timestamp)?;
    Ok(Session {
        id,
        name,
        timestamp,
    })
}

/// 建档案落盘：只覆写本命令负责的四个键（id/name/createdAt/nameSource），
/// 文件里已有的其余键原样保留。与 `write_session_meta_blocking` 共用一把锁，
/// 保证与并发 patch 写者互不丢字段。
fn write_session_created(path: &Path, id: &str, name: &str, timestamp: u64) -> Result<(), String> {
    let _guard = lock_meta_write();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    }
    let existing = fs::read_to_string(path).unwrap_or_default();
    // 非空却解析不出：按空档案重建（本命令语义是"确保档案在"，报错会让会话创建
    // 整个卡住），但绝不静默——留痕后再降级。
    let mut v: Value = match serde_json::from_str(&existing) {
        Ok(v) => v,
        Err(e) => {
            if !existing.is_empty() {
                tracing::warn!(?e, %id, "create_session: 既有档案非法 JSON，按空档案重建");
            }
            serde_json::json!({})
        }
    };
    v["id"] = serde_json::json!(id);
    v["name"] = serde_json::json!(name);
    v["createdAt"] = serde_json::json!(timestamp);
    v["nameSource"] = serde_json::json!("auto");
    fs::write(
        path,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write session: {}", e))
}

#[tauri::command]
pub async fn delete_session(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_session_blocking(id))
        .await
        .map_err(|e| format!("delete_session task panicked: {e}"))?
}

/// 磁盘 IO 离开主线程：删元数据 + 全局搜 jsonl 逐个删 + 扫 claude sessions 目录，
/// 每一步都是真 IO（全局搜索本身就是遍历）。原先挂着一个从未使用的
/// `State<WorkspaceState>` 形参，一并去掉——死参数。
fn delete_session_blocking(id: String) -> Result<(), String> {
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
    // 走阻塞实现而非 async 命令：本函数已在阻塞线程上，不必再绕一次跨线程。
    let _ = super::recent::remove_recent_session_blocking(&id);

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
    /// 会话自持的工作区归属（根路径）。会话「属于哪个工作区」是它自己的属性，
    /// 不是 UI 当下看着哪个：丢了它，send_message 只能回落活动工作区，
    /// 整个进程（cwd / 记忆目录 / CLAUDE.md / 转录落点）就跑到别的项目里去了。
    /// 由前端在定名后（finalize）与每次发送时落盘，见 useSessionWorkspaces。
    pub ws_path: MetaField,
    /// 工作区编码 key：与 ws_path 成对落盘（侧栏分组 / 布局快照 / 最近访问
    /// 都按 key 索引，缺 key 的条目会被静默丢弃）。
    pub ws_key: MetaField,
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

/// `<id>.json` 的读-改-写互斥：每次都读整个文件、改若干键、整体覆写，两个写者
/// 交错就会丢字段（后写者拿的是旧快照）。写者分散在各自 spawn_blocking 的阻塞
/// 线程上（create_session / rename / auto_rename / set_session_meta），只有一把
/// 进程级锁能罩住。锁中毒（持锁线程 panic）不放大成后续全部写失败：取回内层
/// 数据继续用——档案是缓存态的元数据，宁可继续写也不连锁瘫痪。
static META_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock_meta_write() -> MutexGuard<'static, ()> {
    META_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 会话元数据 `<id>.json` 的**唯一**写入路径：一次读、合并 patch、一次写。
///
/// 此前每个命令（rename / set_session_model / set_session_provider / set_session_effort）
/// 各自做一遍 read-modify-write，两个字段并发写会互相覆盖。收敛到这里之后：
///  - 多字段合并写入天然原子（同一份 Value 上改完一次落盘）；
///  - 并发调用由 `META_WRITE_LOCK` 串行化（2026-09-08 讨论稿留的"只改这一处"）。
fn write_session_meta_blocking(id: &str, patch: &SessionMetaPatch) -> Result<(), String> {
    let _guard = lock_meta_write();
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
    apply_field(&mut v, "wsPath", &patch.ws_path);
    apply_field(&mut v, "wsKey", &patch.ws_key);

    fs::write(
        &path,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
pub async fn rename_session(id: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || rename_session_blocking(id, name))
        .await
        .map_err(|e| format!("rename_session task panicked: {e}"))?
}

/// 磁盘 IO 离开主线程（读-改-写会话元数据 json）。
fn rename_session_blocking(id: String, name: String) -> Result<(), String> {
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

/// 会话元数据的唯一写入命令：provider / model / effort / 工作区归属一次写齐
/// （一次读、一次写、一把锁）。
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

/// 写会话自持的工作区归属（wsPath + wsKey 成对）。
///
/// 为什么不并进 `set_session_meta`：那会让它变成 id + 5 个同型 MetaField 的
/// 六输入签名（相邻同型参数交换即静默错位），而工作区归属与
/// provider/model/effort 的写入时机也不同源（前者 = 每次发送对账，后者 =
/// 身份切换）——按职责分开，两条命令各自 ≤3 输入。
///
/// 两条命令共用 `write_session_meta_blocking`（同一把锁 + 合并写），所以拆开
/// **不会**退回到 2026-09-08 修掉的 lost update：并发写者被串行化，各改各的键。
#[tauri::command]
pub async fn set_session_workspace(
    id: String,
    ws_path: MetaField,
    ws_key: MetaField,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_session_meta_blocking(
            &id,
            &SessionMetaPatch {
                ws_path,
                ws_key,
                ..Default::default()
            },
        )
    })
    .await
    .map_err(|e| format!("set_session_workspace task panicked: {}", e))?
}

/// 读回会话自持的工作区归属（根路径 + 编码 key）；没记过 / 没档案 → None。
///
/// 与 `session_model` / `session_provider` 同族同口径（同一份 `<id>.json`），
/// 值可能缺席是常态：存量会话（本字段落地前建的）就是没有。调用方按
/// 「查不到就回落」处理，**不推断、不回写**。
#[tauri::command]
pub async fn session_workspace(
    id: String,
) -> Result<Option<super::SessionWorkspaceRef>, String> {
    tokio::task::spawn_blocking(move || {
        let ws = super::our_session_workspace(&id);
        // wsPath 是承重字段（发送 cwd 用它）；只有 key 没有 path 视为没记过。
        if ws.path.is_none() {
            return Ok(None);
        }
        Ok(Some(ws))
    })
    .await
    .map_err(|e| format!("session_workspace task panicked: {}", e))?
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
pub async fn list_sessions_for_workspace(
    app: tauri::AppHandle,
    ws_key: String,
) -> Result<Vec<Session>, String> {
    // 远程工作区（WSL / SSH）：转录在目标机上。key 不能反解成路径（UNC 形态），查注册表。
    let registered = crate::commands::workspace::registered_path_for_key(
        &crate::commands::settings::load_state(),
        &ws_key,
    );
    if let Some((host, posix)) = registered
        .as_deref()
        .and_then(crate::remote_workspace::path::parse)
    {
        return remote_sessions(&app, &host, &posix).await;
    }
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
    aide_workspace::transcripts::cli_session_meta(&claude_sessions_dir(), session_id)
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
pub async fn find_sessions_since(
    workspace_state: State<'_, std::sync::Arc<WorkspaceState>>,
    since_ms: u64,
) -> Result<Vec<String>, String> {
    // 工作区根路径在主线程上取好（锁内一次 exists() stat，够轻），
    // 真正的重活（扫目录 + 逐个读 json 解析）整体搬进阻塞线程。
    let root = project_root_for_commands(&workspace_state);
    tokio::task::spawn_blocking(move || find_sessions_since_blocking(root, since_ms))
        .await
        .map_err(|e| format!("find_sessions_since task panicked: {e}"))?
}

fn find_sessions_since_blocking(root: PathBuf, since_ms: u64) -> Result<Vec<String>, String> {
    let sessions_dir = claude_sessions_dir();
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

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
        assert_eq!(
            compute_identity_drift(None, None, "p_a", "m1"),
            (false, false)
        );
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

        let session = create_session_blocking(id.clone(), "测试会话".to_string()).unwrap();
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

        create_session_blocking(id.clone(), "新会话 12:00:00".to_string()).unwrap();
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

        create_session_blocking(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        rename_session_blocking(id.clone(), "我自己起的名".to_string()).unwrap();
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

        create_session_blocking(id.clone(), "新会话 12:00:00".to_string()).unwrap();
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

        create_session_blocking(id.clone(), "新会话 12:00:00".to_string()).unwrap();
        rename_session_blocking(id.clone(), "我自己起的名".to_string()).unwrap();
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

        create_session_blocking(id.clone(), "模型会话".to_string()).unwrap();
        assert_eq!(session_model(id.clone()).await.unwrap(), None);

        write_model(
            &id,
            MetaField::Set {
                value: "sonnet".to_string(),
            },
        )
        .await;
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("sonnet".to_string())
        );

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("模型会话"));

        // 覆盖写 + 清空（清空后读回 None）
        write_model(
            &id,
            MetaField::Set {
                value: "opus".to_string(),
            },
        )
        .await;
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

        create_session_blocking(id.clone(), "供应商会话".to_string()).unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), None);

        write_provider(
            &id,
            MetaField::Set {
                value: "p_abc".to_string(),
            },
        )
        .await;
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_abc".to_string())
        );

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("供应商会话"));

        // 覆盖写 + 清空（清空后读回 None）
        write_provider(
            &id,
            MetaField::Set {
                value: "p_def".to_string(),
            },
        )
        .await;
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

        create_session_blocking(id.clone(), "一次写会话".to_string()).unwrap();

        set_session_meta(
            id.clone(),
            MetaField::Set {
                value: "p_1".to_string(),
            },
            MetaField::Set {
                value: "m_1".to_string(),
            },
            MetaField::Set {
                value: "high".to_string(),
            },
        )
        .await
        .unwrap();

        // 三个字段必须同时在盘上（旧实现下 model 会被 provider 的写覆盖掉）
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_1".to_string())
        );
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("m_1".to_string())
        );
        assert_eq!(
            session_effort(id.clone()).await.unwrap(),
            Some("high".to_string())
        );

        // Keep 的字段不动：只改 model，provider/effort 必须原样
        set_session_meta(
            id.clone(),
            MetaField::Keep,
            MetaField::Set {
                value: "m_2".to_string(),
            },
            MetaField::Keep,
        )
        .await
        .unwrap();
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_1".to_string())
        );
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("m_2".to_string())
        );
        assert_eq!(
            session_effort(id.clone()).await.unwrap(),
            Some("high".to_string())
        );

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn set_session_workspace_round_trips_and_preserves_identity() {
        // 工作区归属是会话自持属性、与身份字段同档：写它不许动别人（合并写）。
        let id = "test-ws-roundtrip-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        create_session_blocking(id.clone(), "归属会话".to_string()).unwrap();
        write_provider(
            &id,
            MetaField::Set {
                value: "p_1".to_string(),
            },
        )
        .await;
        write_model(
            &id,
            MetaField::Set {
                value: "m_1".to_string(),
            },
        )
        .await;

        set_session_workspace(
            id.clone(),
            MetaField::Set {
                value: "C:/proj/a".to_string(),
            },
            MetaField::Set {
                value: "C--proj-a".to_string(),
            },
        )
        .await
        .unwrap();

        let ws = session_workspace(id.clone())
            .await
            .unwrap()
            .expect("wsPath 已落盘则必须读得回来");
        assert_eq!(ws.path.as_deref(), Some("C:/proj/a"));
        assert_eq!(ws.key.as_deref(), Some("C--proj-a"));
        // 身份字段原样活着（合并写而非整档覆写）
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_1".to_string())
        );
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("m_1".to_string())
        );
        assert_eq!(our_session_name(&id).as_deref(), Some("归属会话"));

        // 清掉后读回 None：前端据此走「回落活动工作区 + 警告」分支
        set_session_workspace(id.clone(), MetaField::Clear, MetaField::Clear)
            .await
            .unwrap();
        assert!(session_workspace(id.clone()).await.unwrap().is_none());

        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn create_session_merge_keeps_fields_written_by_other_writers() {
        // 回归（2026-09-18）：finalize 那一刻 create_session 与身份/归属写者并发
        // （App.vue 不 await createSession，useChatSession 又 await finalizeSpawn）。
        // 此前 create_session 盲写整个文件，后到者会把对方刚落下的 provider / wsPath
        // 一起抹掉。改成读-合并-写后只覆写自己负责的四个键。
        let id = "test-create-merge-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        write_provider(
            &id,
            MetaField::Set {
                value: "p_x".to_string(),
            },
        )
        .await;
        set_session_workspace(
            id.clone(),
            MetaField::Set {
                value: "C:/proj/b".to_string(),
            },
            MetaField::Set {
                value: "C--proj-b".to_string(),
            },
        )
        .await
        .unwrap();

        create_session_blocking(id.clone(), "合并写会话".to_string()).unwrap();

        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_x".to_string())
        );
        assert_eq!(
            session_workspace(id.clone())
                .await
                .unwrap()
                .and_then(|w| w.path),
            Some("C:/proj/b".to_string())
        );
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("合并写会话"));
        assert_eq!(v.get("nameSource").and_then(|x| x.as_str()), Some("auto"));
        assert!(v.get("createdAt").and_then(|x| x.as_u64()).is_some());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn concurrent_meta_writes_do_not_lose_fields() {
        // 锁的回归：并发写者各改各的键，全部必须活着。无锁时读-改-写交错会丢字段
        // （2026-09-08 讨论稿留的 TODO，2026-09-18 补上）。
        let id = "test-meta-lock-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        let handles: Vec<_> = (0..16)
            .map(|i| {
                let id = id.clone();
                std::thread::spawn(move || {
                    let patch = if i % 2 == 0 {
                        SessionMetaPatch {
                            provider: MetaField::Set {
                                value: "p_lock".to_string(),
                            },
                            ..Default::default()
                        }
                    } else {
                        SessionMetaPatch {
                            ws_path: MetaField::Set {
                                value: "C:/lock".to_string(),
                            },
                            ..Default::default()
                        }
                    };
                    write_session_meta_blocking(&id, &patch).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v.get("provider").and_then(|x| x.as_str()), Some("p_lock"));
        assert_eq!(v.get("wsPath").and_then(|x| x.as_str()), Some("C:/lock"));

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

    /// 覆盖新加的 async 包装层：async 命令 → spawn_blocking → `*_blocking`。
    /// 其余测试直接打 `*_blocking`，绕过了这一层——而取 State、跨线程搬运返回值、
    /// panic 转 Err 这些恰恰只在包装层出错，编译期看不出来，必须真跑一趟。
    #[tokio::test]
    async fn session_commands_round_trip_through_async_wrappers() {
        let id = "test-async-roundtrip-aa11bb22".to_string();
        let path = our_sessions_dir().join(format!("{}.json", id));
        let _ = fs::remove_file(&path);

        let session = create_session(id.clone(), "异步往返".to_string())
            .await
            .unwrap();
        assert_eq!(session.id, id);
        assert!(path.exists(), "async 包装后仍应落盘元数据");

        rename_session(id.clone(), "改过的名".to_string())
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("改过的名"));
        assert_eq!(
            v.get("nameSource").and_then(|x| x.as_str()),
            Some("manual"),
            "手动改名必须标 manual，否则自动标题会覆盖它"
        );

        delete_session(id.clone()).await.unwrap();
        assert!(!path.exists(), "async 包装后仍应删除元数据");
    }
}
