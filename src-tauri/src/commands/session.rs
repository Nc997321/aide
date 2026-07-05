use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use tauri::State;

use super::{Session, ChatMessageItem, HistoryBlock, LastEventInfo, ChangeRoundData, WorkspaceState, project_root_for_commands, find_session_jsonl_globally, claude_projects_dir, claude_sessions_dir, our_sessions_dir};

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
    let lines: Vec<String> = reader
        .lines()
        .enumerate()
        .map(|(i, l)| l.map_err(|e| format!("Read error at line {}: {}", i, e)))
        .collect::<Result<_, _>>()?;

    Ok(parse_transcript_lines(&lines))
}

/// Agent/Task 是子代理调用（CC v2.1.63 把 Task 改名成 Agent，两个都认，跟
/// agent-sidecar/src/subagents.ts 的 SUBAGENT_TOOL_NAMES 保持同一份清单——两边
/// 语言不同没法共享常量，靠注释手动同步）。这次历史重建不管子代理：它们内部的
/// 分步进度 Claude CLI 从不落盘，做了也补不全，维持原有降级行为——整段跳过。
const SUBAGENT_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

/// 把 Claude CLI 落盘的会话 `.jsonl`（每行一条消息）解析成前端要渲染的历史消息，
/// 按原始顺序重建 text/tool_call 两种内容块（`HistoryBlock`）。从 `load_messages`
/// 抽出来是纯函数、不摸文件系统，方便直接拿假 transcript 单测。
///
/// 两遍扫描：tool_result 落在稍后（也可能更早，顺序不保证）的另一行 user 消息里，
/// 必须先扫一遍全量建好 `tool_use_id → (content, is_error)` 的表，再回填进对应的
/// tool_call 块，不能假设 tool_result 总跟在 tool_use 后面紧挨着那一行。
fn parse_transcript_lines(lines: &[String]) -> Vec<ChatMessageItem> {
    let mut tool_results: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(arr) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(|t| t.as_str()) else {
                continue;
            };
            let is_error = block.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
            let content = match block.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            tool_results.insert(tool_use_id.to_string(), (content, is_error));
        }
    }

    let mut messages: Vec<ChatMessageItem> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
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
        let Some(content_val) = v.get("message").and_then(|m| m.get("content")) else {
            continue;
        };

        let blocks: Vec<HistoryBlock> = if let Some(s) = content_val.as_str() {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![HistoryBlock::Text { text: s.to_string() }]
            }
        } else if let Some(arr) = content_val.as_array() {
            arr.iter()
                .filter_map(|block| match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(|t| HistoryBlock::Text { text: t.to_string() }),
                    Some("tool_use") => {
                        let id = block.get("id").and_then(|t| t.as_str())?.to_string();
                        let name = block.get("name").and_then(|t| t.as_str())?.to_string();
                        if SUBAGENT_TOOL_NAMES.contains(&name.as_str()) {
                            return None;
                        }
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let (result, is_error) = tool_results
                            .get(&id)
                            .map(|(c, e)| (Some(c.clone()), Some(*e)))
                            .unwrap_or((None, None));
                        Some(HistoryBlock::ToolCall { id, name, input, result, is_error })
                    }
                    // 图片等其余 block 类型：维持原有降级行为，暂不重建。
                    _ => None,
                })
                .collect()
        } else {
            Vec::new()
        };

        if blocks.is_empty() {
            continue;
        }
        messages.push(ChatMessageItem { role: role.to_string(), blocks, timestamp: i as u64 });
    }

    messages
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

    // 回归：重启/切回会话后，历史里的工具调用（Bash/Edit 等）之前被整段丢弃，只剩
    // 纯文字——根因是旧实现只保留 content 数组里 type=="text" 的 block。这组测试
    // 验证 parse_transcript_lines 按原始顺序重建 text/tool_call 两种块，且正确把
    // 稍后一行 user 消息里的 tool_result 回填进对应的 tool_call。
    mod parse_transcript_lines_tests {
        use super::*;

        fn line(v: serde_json::Value) -> String {
            v.to_string()
        }

        #[test]
        fn plain_text_messages_still_work_unchanged() {
            let lines = vec![
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": "你好" },
                })),
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "text", "text": "你好，有什么可以帮你？" }] },
                })),
            ];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0].role, "user");
            assert!(matches!(&messages[0].blocks[..], [HistoryBlock::Text { text }] if text == "你好"));
            assert_eq!(messages[1].role, "claude");
            assert!(
                matches!(&messages[1].blocks[..], [HistoryBlock::Text { text }] if text == "你好，有什么可以帮你？")
            );
        }

        #[test]
        fn tool_use_is_reconstructed_and_filled_in_by_a_later_tool_result_line() {
            let lines = vec![
                line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [
                        { "type": "text", "text": "我看一下这个文件" },
                        { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.ts" } },
                    ] },
                })),
                // tool_result 落在稍后一行的 user 消息里，且这一行没有真人文字，
                // 不该单独变成一条用户气泡。
                line(serde_json::json!({
                    "type": "user",
                    "message": { "content": [
                        { "type": "tool_result", "tool_use_id": "t1", "content": "文件内容……", "is_error": false },
                    ] },
                })),
            ];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 1, "纯 tool_result 的 user 行不应该单独变成一条消息");
            assert_eq!(messages[0].blocks.len(), 2);
            assert!(matches!(&messages[0].blocks[0], HistoryBlock::Text { text } if text == "我看一下这个文件"));
            match &messages[0].blocks[1] {
                HistoryBlock::ToolCall { id, name, result, is_error, .. } => {
                    assert_eq!(id, "t1");
                    assert_eq!(name, "Read");
                    assert_eq!(result.as_deref(), Some("文件内容……"));
                    assert_eq!(*is_error, Some(false));
                }
                other => panic!("expected ToolCall block, got {other:?}"),
            }
        }

        #[test]
        fn tool_use_without_a_matching_tool_result_keeps_result_as_none() {
            // 会话在工具还没返回结果时就中断/崩溃——历史里应该显示"没有结果"，
            // 而不是凭空编一个，也不该因为找不到结果就整段丢弃。
            let lines = vec![line(serde_json::json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } },
                ] },
            }))];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 1);
            match &messages[0].blocks[0] {
                HistoryBlock::ToolCall { result, is_error, .. } => {
                    assert_eq!(*result, None);
                    assert_eq!(*is_error, None);
                }
                other => panic!("expected ToolCall block, got {other:?}"),
            }
        }

        #[test]
        fn subagent_tool_calls_are_dropped_not_reconstructed() {
            // 明确不在这次修复范围内：Agent/Task 子代理调用维持原有降级行为——
            // 整段跳过，不出现在历史里（分步进度 Claude CLI 从不落盘，做了也补不全）。
            for tool_name in ["Agent", "Task"] {
                let lines = vec![line(serde_json::json!({
                    "type": "assistant",
                    "message": { "content": [
                        { "type": "tool_use", "id": "a1", "name": tool_name, "input": { "subagent_type": "general-purpose" } },
                    ] },
                }))];
                let messages = parse_transcript_lines(&lines);
                assert!(messages.is_empty(), "{tool_name} 应该被整段丢弃");
            }
        }

        #[test]
        fn subagent_call_is_dropped_but_sibling_text_in_the_same_message_is_kept() {
            let lines = vec![line(serde_json::json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "text", "text": "我先看看情况" },
                    { "type": "tool_use", "id": "a1", "name": "Agent", "input": { "subagent_type": "general-purpose" } },
                ] },
            }))];
            let messages = parse_transcript_lines(&lines);
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0].blocks.len(), 1);
            assert!(matches!(&messages[0].blocks[0], HistoryBlock::Text { text } if text == "我先看看情况"));
        }

        #[test]
        fn synthetic_user_entries_are_still_skipped() {
            let lines = vec![line(serde_json::json!({
                "type": "user",
                "isMeta": true,
                "message": { "content": "这是 Skill 注入，不是人打的" },
            }))];
            assert!(parse_transcript_lines(&lines).is_empty());
        }
    }
}
