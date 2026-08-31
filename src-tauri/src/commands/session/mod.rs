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

#[tauri::command]
pub fn rename_session(id: String, name: String) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    let path = dir.join(format!("{}.json", id));

    let meta = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        let mut v: Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
        v["name"] = Value::String(name.clone());
        v
    } else {
        serde_json::json!({ "id": id, "name": name })
    };
    // 手动重命名：标记 nameSource=manual，此后自动生成的标题一律不得覆盖
    // （auto_rename_session 据此拒写）。
    let mut meta = meta;
    meta["nameSource"] = Value::String("manual".to_string());

    fs::write(
        &path,
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write: {}", e))
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
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    let path = dir.join(format!("{}.json", id));

    let mut v: Value = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
    } else {
        serde_json::json!({ "id": id })
    };

    if v.get("nameSource").and_then(|s| s.as_str()) == Some("manual") {
        return Ok(false);
    }
    v["name"] = Value::String(name.to_string());
    v["nameSource"] = Value::String("auto".to_string());

    fs::write(
        &path,
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write: {}", e))?;
    Ok(true)
}

/// 记住会话的模型选择：merge 写进会话元数据 `<id>.json` 的 `model` 字段
/// （与 rename_session 同一模式），重开会话/重启 app 后由前端恢复选择器。
/// model 为空 = 清除（跟随 provider 默认）。磁盘 IO 离开主线程（杀软扫描
/// 小文件也可能堵，见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn set_session_model(id: String, model: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        let path = dir.join(format!("{}.json", id));

        let mut v: Value = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
        } else {
            serde_json::json!({ "id": id })
        };
        if model.is_empty() {
            v.as_object_mut().map(|o| o.remove("model"));
        } else {
            v["model"] = Value::String(model);
        }

        fs::write(
            &path,
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write: {}", e))
    })
    .await
    .map_err(|e| format!("set_session_model task panicked: {}", e))?
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

/// 记住会话的 effort 选择：merge 写进会话元数据 `<id>.json` 的 `effort` 字段
/// （与 set_session_model 同一模式），重开会话/重启 app 后由前端恢复选择器。
/// effort 为空 = 清除（退回 provider 默认 / high）。磁盘 IO 离开主线程。
#[tauri::command]
pub async fn set_session_effort(id: String, effort: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        let path = dir.join(format!("{}.json", id));

        let mut v: Value = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
        } else {
            serde_json::json!({ "id": id })
        };
        if effort.is_empty() {
            v.as_object_mut().map(|o| o.remove("effort"));
        } else {
            v["effort"] = Value::String(effort);
        }

        fs::write(
            &path,
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write: {}", e))
    })
    .await
    .map_err(|e| format!("set_session_effort task panicked: {}", e))?
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

/// 记住会话 spawn 时绑定的供应商 id：merge 写进会话元数据 `<id>.json` 的 `provider`
/// 字段（与 set_session_model / set_session_effort 同一模式），重开 app 后由前端恢复
/// 会话的供应商绑定（只恢复该会话绑定，不动全局激活供应商）。provider 为空 = 清除。
/// 磁盘 IO 离开主线程（同 set_session_model，见 CLAUDE.md「同步 command 禁止重 IO」）。
#[tauri::command]
pub async fn set_session_provider(id: String, provider: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = our_sessions_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
        let path = dir.join(format!("{}.json", id));

        let mut v: Value = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read: {}", e))?;
            serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?
        } else {
            serde_json::json!({ "id": id })
        };
        if provider.is_empty() {
            v.as_object_mut().map(|o| o.remove("provider"));
        } else {
            v["provider"] = Value::String(provider);
        }

        fs::write(
            &path,
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write: {}", e))
    })
    .await
    .map_err(|e| format!("set_session_provider task panicked: {}", e))?
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

        set_session_model(id.clone(), "sonnet".to_string())
            .await
            .unwrap();
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("sonnet".to_string())
        );

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("模型会话"));

        // 覆盖写 + 清空（清空后读回 None）
        set_session_model(id.clone(), "opus".to_string())
            .await
            .unwrap();
        assert_eq!(
            session_model(id.clone()).await.unwrap(),
            Some("opus".to_string())
        );
        set_session_model(id.clone(), String::new()).await.unwrap();
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

        set_session_provider(id.clone(), "p_abc".to_string())
            .await
            .unwrap();
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_abc".to_string())
        );

        // name 字段必须还活着（merge 而非覆盖）
        let content = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("供应商会话"));

        // 覆盖写 + 清空（清空后读回 None）
        set_session_provider(id.clone(), "p_def".to_string())
            .await
            .unwrap();
        assert_eq!(
            session_provider(id.clone()).await.unwrap(),
            Some("p_def".to_string())
        );
        set_session_provider(id.clone(), String::new())
            .await
            .unwrap();
        assert_eq!(session_provider(id.clone()).await.unwrap(), None);

        let _ = fs::remove_file(&path);
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
