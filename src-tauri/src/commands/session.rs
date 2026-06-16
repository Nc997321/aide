use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use tauri::State;

use super::{Session, ChatMessageItem, WorkspaceState, project_root_for_commands, encode_project_path, claude_projects_dir, claude_sessions_dir, our_sessions_dir};

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

    if !proj_dir.exists() {
        return Ok(sessions);
    }

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

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

#[tauri::command]
pub fn create_session(name: String) -> Result<Session, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let id = format!("new_{}", timestamp);

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
    workspace_state: State<'_, WorkspaceState>,
    id: String,
) -> Result<(), String> {
    let our_path = our_sessions_dir().join(format!("{}.json", id));
    if our_path.exists() {
        fs::remove_file(&our_path).map_err(|e| format!("Failed to delete metadata: {}", e))?;
    }

    let root = project_root_for_commands(&workspace_state);
    let encoded = encode_project_path(&root.to_string_lossy());
    let jsonl_path = claude_projects_dir().join(&encoded).join(format!("{}.jsonl", id));
    if jsonl_path.exists() {
        fs::remove_file(&jsonl_path).map_err(|e| format!("Failed to delete session file: {}", e))?;
    }

    let ses_dir = claude_sessions_dir();
    if ses_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&ses_dir) {
            for entry in read_dir {
                let Ok(entry) = entry else { continue; };
                let path = entry.path();
                if let Ok(content) = fs::read_to_string(&path) {
                    if content.contains(&format!("\"sessionId\":\"{}\"", id)) {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }

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
    workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<Vec<ChatMessageItem>, String> {
    let root = project_root_for_commands(&workspace_state);
    let encoded = encode_project_path(&root.to_string_lossy());
    let jsonl_path = claude_projects_dir()
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));

    if !jsonl_path.exists() {
        return Ok(Vec::new());
    }

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

#[tauri::command]
pub fn session_last_event(
    workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let root = project_root_for_commands(&workspace_state);
    let encoded = encode_project_path(&root.to_string_lossy());
    let jsonl_path = claude_projects_dir()
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));

    if !jsonl_path.exists() {
        return Ok(None);
    }

    let file = fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = BufReader::new(file);
    let last_line = reader.lines().filter_map(|l| l.ok()).last();

    match last_line {
        Some(line) => {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                Ok(v.get("type").and_then(|t| t.as_str()).map(|s| s.to_string()))
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
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
