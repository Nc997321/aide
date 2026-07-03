use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use tauri::State;

use super::{Session, ChatMessageItem, LastEventInfo, ChangeRoundData, WorkspaceState, project_root_for_commands, find_session_jsonl_globally, claude_projects_dir, claude_sessions_dir, our_sessions_dir};

#[tauri::command]
pub fn list_sessions(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<Session>, String> {
    let mut sessions: Vec<Session> = Vec::new();

    let encoded = if let Ok(key_guard) = workspace_state.key.lock() {
        match key_guard.as_ref() {
            Some(key) => key.clone(),
            None => return Ok(sessions),
        }
    } else {
        return Ok(sessions);
    };
    let proj_dir = claude_projects_dir().join(&encoded);

    // Scan .jsonl files if the project directory exists (created after first
    // conversation). If it doesn't exist yet, skip to metadata scan — sessions
    // that were started but never had a conversation still have metadata in
    // ~/.claude/sessions/.
    if proj_dir.exists() {
        let read_dir = fs::read_dir(&proj_dir)
            .map_err(|e| format!("Failed to read project dir: {}", e))?;

        for entry in read_dir {
            let Ok(entry) = entry else { continue; };
            let path = entry.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                let session_id = path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if session_id.is_empty() {
                    continue;
                }

                let (name, started_at) = claude_session_meta(&session_id)
                    .unwrap_or_else(|| (session_id.clone(), 0));

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

                let display_name = our_session_name(&session_id)
                    .unwrap_or(name);

                let last_msg = last_jsonl_message(&path);

                sessions.push(Session {
                    id: session_id,
                    name: display_name,
                    timestamp,
                    last_message: last_msg,
                });
            }
        }
    }

    // Second pass: scan ~/.claude/sessions/ for sessions that have metadata
    // but no .jsonl file yet (Claude started, no conversation happened).
    // These sessions won't appear in the project dir scan above.
    let root = project_root_for_commands(&workspace_state);
    let root_normalized = normalize_path_for_compare(&root.to_string_lossy());
    let sessions_dir = claude_sessions_dir();
    if sessions_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&sessions_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else { continue; };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    let Ok(content) = fs::read_to_string(&path) else { continue; };
                    let Ok(v) = serde_json::from_str::<Value>(&content) else { continue; };

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

                    let name = v.get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                    let display_name = our_session_name(&session_id).unwrap_or(name);

                    sessions.push(Session {
                        id: session_id.to_string(),
                        name: display_name,
                        timestamp: started_at,
                        last_message: String::new(),
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

    let meta = serde_json::json!({ "id": id, "name": name, "createdAt": timestamp });
    let path = dir.join(format!("{}.json", id));
    fs::write(&path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write session: {}", e))?;

    Ok(Session {
        id,
        name,
        timestamp,
        last_message: String::new(),
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
                let Ok(entry) = entry else { continue; };
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
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read: {}", e))?;
        let mut v: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;
        v["name"] = Value::String(name.clone());
        v
    } else {
        serde_json::json!({ "id": id, "name": name })
    };

    fs::write(&path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
pub fn load_messages(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<Vec<ChatMessageItem>, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(Vec::new());
    };

    let file = fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = BufReader::new(file);

    let mut messages: Vec<ChatMessageItem> = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("Read error at line {}: {}", i, e))?;
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let role = match msg_type {
                "user" => "user",
                "assistant" => "claude",
                _ => continue,
            };
            // "user" 类型 JSONL 行不都是人类打字:Skill 注入(isMeta)、中断占位符
            // (interruptedMessageId)、压缩摘要(isCompactSummary)、后台任务通知
            // (origin.kind = "task-notification")都以 role:"user" 落盘,但不是
            // 人说的话——不过滤会把这些内容渲染成用户气泡,造成"这不是我说的"的假象。
            if role == "user" && is_synthetic_user_entry(&v) {
                continue;
            }
            if let Some(content_val) = v.get("message").and_then(|m| m.get("content")) {
                let text = if let Some(s) = content_val.as_str() {
                    s.to_string()
                } else if let Some(arr) = content_val.as_array() {
                    let texts: Vec<&str> = arr.iter()
                        .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                        .collect();
                    texts.join("\n")
                } else {
                    continue;
                };
                if !text.is_empty() {
                    messages.push(ChatMessageItem {
                        role: role.to_string(),
                        content: text,
                        timestamp: i as u64,
                    });
                }
            }
        }
    }

    Ok(messages)
}

/// Whether a raw JSONL "user"-type entry is SDK/CLI-synthesized rather than
/// something the human actually typed (Skill injections, interrupt
/// placeholders, compaction summaries, background task notifications).
/// Confirmed against real transcripts: genuine typed messages never carry
/// these markers, and carrying one is never a byproduct of genuine input.
fn is_synthetic_user_entry(v: &Value) -> bool {
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return true;
    }
    if v.get("interruptedMessageId").is_some() {
        return true;
    }
    if v.get("isCompactSummary").and_then(|b| b.as_bool()).unwrap_or(false) {
        return true;
    }
    if let Some(kind) = v.get("origin").and_then(|o| o.get("kind")).and_then(|k| k.as_str()) {
        if kind != "human" {
            return true;
        }
    }
    false
}

/// Normalize a filesystem path so two paths pointing to the same location
/// compare equal: strip trailing separator, use forward slashes, lowercase.
fn normalize_path_for_compare(p: &str) -> String {
    p.trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase()
}

#[tauri::command]
pub fn session_last_event(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<LastEventInfo, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(LastEventInfo { event_type: None, stop_reason: None, timestamp: None });
    };

    let file = fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = BufReader::new(file);

    // Scan lines in reverse to find the last meaningful conversation event
    // (assistant or user). The actual last line is often a system or
    // file-history-snapshot event, which doesn't tell us if Claude is done.
    let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();
    for line in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if event_type == "assistant" || event_type == "user" {
                let stop_reason = v.get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                let timestamp = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string());
                return Ok(LastEventInfo {
                    event_type: Some(event_type.to_string()),
                    stop_reason,
                    timestamp,
                });
            }
        }
    }
    // No conversation events found — treat as empty
    Ok(LastEventInfo { event_type: None, stop_reason: None, timestamp: None })
}

#[tauri::command]
pub fn load_session_changes(session_id: String) -> Result<Vec<ChangeRoundData>, String> {
    let path = our_sessions_dir().join(format!("{}-changes.json", session_id));
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read changes: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse changes: {}", e))
}

#[tauri::command]
pub fn save_session_changes(session_id: String, rounds: Vec<ChangeRoundData>) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let path = dir.join(format!("{}-changes.json", session_id));
    let content = serde_json::to_string_pretty(&rounds)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
pub fn session_jsonl_size(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<u64, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(0);
    };

    let metadata = fs::metadata(&jsonl_path)
        .map_err(|e| format!("Failed to read jsonl metadata: {}", e))?;

    Ok(metadata.len())
}

#[tauri::command]
pub fn session_truncate_jsonl(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
    byte_pos: u64,
) -> Result<(), String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(());
    };

    let file = fs::OpenOptions::new()
        .write(true)
        .open(&jsonl_path)
        .map_err(|e| format!("Failed to open jsonl: {}", e))?;

    file.set_len(byte_pos)
        .map_err(|e| format!("Failed to truncate jsonl: {}", e))?;

    Ok(())
}

/// List sessions for a specific workspace by its encoded key, without relying
/// on the current WorkspaceState. Used by the frontend to load sessions for
/// non-active (but expanded) workspaces.
#[tauri::command]
pub fn list_sessions_for_workspace(ws_key: String) -> Result<Vec<Session>, String> {
    let mut sessions: Vec<Session> = Vec::new();

    let proj_dir = claude_projects_dir().join(&ws_key);

    if proj_dir.exists() {
        let read_dir = fs::read_dir(&proj_dir)
            .map_err(|e| format!("Failed to read project dir: {}", e))?;

        for entry in read_dir {
            let Ok(entry) = entry else { continue; };
            let path = entry.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                let session_id = path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if session_id.is_empty() {
                    continue;
                }

                let (name, started_at) = claude_session_meta(&session_id)
                    .unwrap_or_else(|| (session_id.clone(), 0));

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
                let last_msg = last_jsonl_message(&path);

                sessions.push(Session {
                    id: session_id,
                    name: display_name,
                    timestamp,
                    last_message: last_msg,
                });
            }
        }
    }

    // Second pass: scan ~/.claude/sessions/ for sessions with metadata but no .jsonl
    let root = super::resolve_path_from_key(&ws_key).unwrap_or_default();
    let root_normalized = normalize_path_for_compare(&root);
    let sessions_dir = claude_sessions_dir();
    if sessions_dir.exists() && !root.is_empty() {
        if let Ok(read_dir) = fs::read_dir(&sessions_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else { continue; };
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    let Ok(content) = fs::read_to_string(&path) else { continue; };
                    let Ok(v) = serde_json::from_str::<Value>(&content) else { continue; };

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

                    let name = v.get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
                    let display_name = our_session_name(&session_id).unwrap_or(name);

                    sessions.push(Session {
                        id: session_id.to_string(),
                        name: display_name,
                        timestamp: started_at,
                        last_message: String::new(),
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
        let Ok(entry) = entry else { continue; };
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&content) {
                    if v.get("sessionId").and_then(|s| s.as_str()) == Some(session_id) {
                        let name = v.get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("未命名")
                            .to_string();
                        let started_at = v.get("startedAt")
                            .and_then(|t| t.as_u64())
                            .unwrap_or(0);
                        return Some((name, started_at));
                    }
                }
            }
        }
    }
    None
}

fn last_jsonl_message(jsonl_path: &std::path::Path) -> String {
    let file = match fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let reader = BufReader::new(file);
    let last_line = reader.lines().filter_map(|l| l.ok()).last();
    match last_line {
        Some(line) => {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(content_val) = v.get("message").and_then(|m| m.get("content")) {
                    let text = if let Some(s) = content_val.as_str() {
                        s.to_string()
                    } else if let Some(arr) = content_val.as_array() {
                        let texts: Vec<&str> = arr.iter()
                            .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
                            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                            .collect();
                        texts.join(" ")
                    } else {
                        String::new()
                    };
                    if !text.is_empty() {
                        return text.chars().take(80).collect();
                    }
                }
            }
            String::new()
        }
        None => String::new(),
    }
}

fn our_session_name(session_id: &str) -> Option<String> {
    let dir = our_sessions_dir();
    let path = dir.join(format!("{}.json", session_id));
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                return v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
            }
        }
    }
    None
}

/// Lightweight session discovery used during new-session polling.
///
/// Scans only `~/.claude/sessions/` (small JSON metadata, no .jsonl reads) and
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

    let read_dir = fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Failed to read sessions dir: {}", e))?;

    let mut candidates: Vec<(String, u64)> = Vec::new();

    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        let path = entry.path();
        if !path.extension().map(|e| e == "json").unwrap_or(false) {
            continue;
        }

        let Ok(content) = fs::read_to_string(&path) else { continue; };
        let Ok(v) = serde_json::from_str::<Value>(&content) else { continue; };

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

    // 回归：真实会话记录里，Skill 注入(isMeta)、中断占位符
    // (interruptedMessageId)、压缩摘要(isCompactSummary)、后台任务通知
    // (origin.kind != "human") 都以 role:"user" 落盘，但都不是人类真正打的字——
    // 曾经被 load_messages 原样当用户消息渲染，在 UI 上显示成"用户说的话"。
    #[test]
    fn synthetic_user_entries_are_detected() {
        assert!(is_synthetic_user_entry(&serde_json::json!({ "isMeta": true })));
        assert!(is_synthetic_user_entry(&serde_json::json!({ "interruptedMessageId": "msg_1" })));
        assert!(is_synthetic_user_entry(&serde_json::json!({ "isCompactSummary": true })));
        assert!(is_synthetic_user_entry(&serde_json::json!({ "origin": { "kind": "task-notification" } })));
    }

    #[test]
    fn genuine_human_entries_are_not_filtered() {
        // 新版 SDK：显式标注 origin.kind == "human"
        assert!(!is_synthetic_user_entry(&serde_json::json!({ "origin": { "kind": "human" } })));
        // 旧版 transcript：没有 origin 字段，也没有任何合成标记——必须保留，
        // 否则会把老会话里的真实提问全部隐藏掉。
        assert!(!is_synthetic_user_entry(&serde_json::json!({})));
    }
}
