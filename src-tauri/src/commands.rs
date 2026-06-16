use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, State};

use crate::pty::PtyManager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub timestamp: u64,
    pub last_message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessageItem {
    pub role: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct WorkspaceInfo {
    pub key: String,   // encoded directory name (unambiguous)
    pub name: String,  // actual filesystem path
}

/// WorkspaceState stores the encoded key (for session lookup) and
/// resolved filesystem path (for file operations) of the active workspace.
pub struct WorkspaceState {
    pub key: Mutex<Option<String>>,
    pub path: Mutex<Option<PathBuf>>,
}

/// Resolve the active project root: explicit workspace path > auto-detect from CWD
fn project_root_for_commands(ws: &WorkspaceState) -> PathBuf {
    if let Ok(path_guard) = ws.path.lock() {
        if let Some(path) = path_guard.as_ref() {
            if path.exists() {
                return path.clone();
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    guess_project_root(&cwd)
}

// ── PTY Commands ──

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, session_id: String, data: String) -> Result<(), String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, PtyManager>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    manager.resize(&session_id, rows, cols)
}

#[tauri::command]
pub fn pty_spawn_claude(
    manager: State<'_, PtyManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: AppHandle,
    rows: u16,
    cols: u16,
    session_id: String,
) -> Result<(), String> {
    let project_root = project_root_for_commands(&workspace_state);

    let resume_id = if session_id.starts_with("new_") {
        None
    } else {
        find_claude_session_jsonl(&session_id, &project_root)
    };

    if let Some(ref id) = resume_id {
        manager.spawn_command(&session_id, "claude", &["--resume", id.as_str()], &project_root, rows, cols, app_handle)
    } else {
        manager.spawn_command(&session_id, "claude", &[], &project_root, rows, cols, app_handle)
    }
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    manager.kill_session(&session_id);
    Ok(())
}

#[tauri::command]
pub fn pty_has_session(manager: State<'_, PtyManager>, session_id: String) -> Result<bool, String> {
    Ok(manager.has_session(&session_id))
}

#[tauri::command]
pub fn pty_rename_session(manager: State<'_, PtyManager>, old_id: String, new_id: String) -> Result<(), String> {
    manager.rename_session(&old_id, &new_id);
    Ok(())
}

// ── Utility Commands ──

#[tauri::command]
pub fn get_project_info(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<ProjectInfo, String> {
    let root = project_root_for_commands(&workspace_state);

    Ok(ProjectInfo {
        root: root.to_string_lossy().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        branch: detect_git_branch(&root),
    })
}

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub branch: String,
}

fn guess_project_root(cwd: &PathBuf) -> PathBuf {
    let mut current = cwd.clone();
    let mut best = cwd.clone();
    loop {
        if current.join(".git").exists() || current.join("package.json").exists() {
            return current;
        }
        if best == cwd.clone() && current.join("Cargo.toml").exists() {
            best = current.clone();
        }
        if !current.pop() {
            return best;
        }
    }
}

fn detect_git_branch(root: &PathBuf) -> String {
    let head = root.join(".git").join("HEAD");
    if let Ok(content) = fs::read_to_string(&head) {
        if let Some(line) = content.lines().next() {
            if let Some(branch) = line.strip_prefix("ref: refs/heads/") {
                return branch.to_string();
            }
        }
    }
    String::new()
}

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;

    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }

        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        entries.push(FileEntry {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            children: if is_dir { Some(Vec::new()) } else { None },
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn write_file_content(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
pub fn create_file(parent_path: String, name: String) -> Result<(), String> {
    let file_path = PathBuf::from(&parent_path).join(&name);
    if file_path.exists() {
        return Err(format!("Already exists: {}", name));
    }
    fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
pub fn create_dir(parent_path: String, name: String) -> Result<(), String> {
    let dir_path = PathBuf::from(&parent_path).join(&name);
    if dir_path.exists() {
        return Err(format!("Already exists: {}", name));
    }
    fs::create_dir_all(&dir_path).map_err(|e| format!("Failed to create directory: {}", e))
}

// ── Git: diff, stage, revert ──

#[derive(Debug, Serialize, Clone)]
pub struct DiffEntry {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub fn git_diff_files(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<DiffEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    // Use --numstat for line counts, fall back to --porcelain for status
    let output = std::process::Command::new("git")
        .args(["diff", "--numstat"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<DiffEntry> = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let nums: Vec<&str> = parts[0].split_whitespace().collect();
        if nums.len() < 2 {
            continue;
        }
        let additions = if nums[0] == "-" { 0 } else { nums[0].parse().unwrap_or(0) };
        let deletions = if nums[1] == "-" { 0 } else { nums[1].parse().unwrap_or(0) };
        files.push(DiffEntry {
            path: parts[2].to_string(),
            status: "M".to_string(),
            additions,
            deletions,
        });
    }

    Ok(files)
}

#[tauri::command]
pub fn git_stage_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(());
    }
    std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to git add: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn git_revert_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    // git checkout -- <path> reverts to the staged (or HEAD) version
    std::process::Command::new("git")
        .args(["checkout", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to revert: {}", e))?;
    Ok(())
}

// ── Adapter: Claude Code Storage Helpers ──

fn user_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .ok()
}

fn claude_home() -> PathBuf {
    user_home().unwrap_or_else(|| PathBuf::from(".")).join(".claude")
}

fn claude_projects_dir() -> PathBuf {
    claude_home().join("projects")
}

fn claude_sessions_dir() -> PathBuf {
    claude_home().join("sessions")
}

fn our_config_dir() -> PathBuf {
    user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude-code-desktop")
}

fn our_sessions_dir() -> PathBuf {
    our_config_dir().join("sessions")
}

fn config_path() -> PathBuf {
    our_config_dir().join("config.json")
}

fn save_workspace_config(path: &str) -> Result<(), String> {
    let dir = our_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let json = serde_json::json!({ "workspace": path });
    fs::write(config_path(), serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write config: {}", e))
}

/// Returns the persisted workspace path, if any.
pub fn load_workspace_config() -> Option<String> {
    let path = config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                return v.get("workspace").and_then(|w| w.as_str()).map(|s| s.to_string());
            }
        }
    }
    None
}

/// Encode a filesystem path for Claude Code's directory naming:
/// `C:\document\owner\aide` → `C--document-owner-aide`
fn encode_project_path(path: &str) -> String {
    path.replace(':', "-").replace('\\', "-").replace('/', "-")
}

/// Find the .jsonl file for a session in the current project
fn find_claude_session_jsonl(session_id: &str, project_root: &PathBuf) -> Option<String> {
    let encoded = encode_project_path(&project_root.to_string_lossy());
    let jsonl_path = claude_projects_dir()
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));
    if jsonl_path.exists() {
        Some(session_id.to_string())
    } else {
        None
    }
}

/// Read metadata from Claude's sessions/<pid>.json that matches a sessionId
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

/// Read the last line of a .jsonl to extract a preview/last message
fn last_jsonl_message(jsonl_path: &PathBuf) -> String {
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

// ── Session Commands ──

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

    // Scan project dir for .jsonl files
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

            // Get metadata from Claude's session records
            let (name, started_at) = claude_session_meta(&session_id)
                .unwrap_or_else(|| (session_id.clone(), 0));

            // If timestamp is 0, fall back to file modification time (millis)
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

            // Check our own metadata for a custom display name
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
pub fn set_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    path: String,
) -> Result<(), String> {
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *p = Some(PathBuf::from(path));
    }
    // Best-effort persist — don't block workspace switch on config write
    let _ = save_workspace_config(&key);
    Ok(())
}

/// Resolve a real filesystem path from an encoded workspace key.
/// Uses DFS: try each dash as either separator or literal, check filesystem.
fn resolve_path_from_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let drive = chars.next()?;
    chars.next()?; // first -
    chars.next()?; // second -
    let rest: String = chars.collect();
    if rest.is_empty() {
        let path = format!("{}:\\", drive);
        return if PathBuf::from(&path).exists() { Some(path) } else { None };
    }
    try_decode(&format!("{}:\\", drive), &rest)
}

fn try_decode(prefix: &str, remaining: &str) -> Option<String> {
    for (i, ch) in remaining.char_indices() {
        if ch == '-' {
            let component = &remaining[..i];
            let candidate = format!("{}{}", prefix, component);
            if !component.is_empty() && PathBuf::from(&candidate).exists() {
                let next_prefix = format!("{}{}\\", prefix, component);
                if let Some(result) = try_decode(&next_prefix, &remaining[i + 1..]) {
                    return Some(result);
                }
            }
        }
    }
    let final_path = format!("{}{}", prefix, remaining);
    if PathBuf::from(&final_path).exists() { Some(final_path) } else { None }
}

#[tauri::command]
pub fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    let dir = claude_projects_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut workspaces = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;
    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let key = entry.file_name().to_string_lossy().to_string();
            let name = resolve_path_from_key(&key).unwrap_or_else(|| key.clone());
            workspaces.push(WorkspaceInfo { key, name });
        }
    }
    Ok(workspaces)
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
                    // User messages: content is a plain string
                    s.to_string()
                } else if let Some(arr) = content_val.as_array() {
                    // Assistant messages: content is [{type: "text", text: "..."}]
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

/// Return the last event type ("user" / "assistant" / …) from the .jsonl for a session.
/// Returns None if the session file doesn't exist or has no events yet.
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

#[tauri::command]
pub fn create_session(name: String) -> Result<Session, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    // Use a temporary placeholder ID — real ID comes from Claude after first message
    let id = format!("new_{}", timestamp);

    // Save our metadata
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
    // Delete our metadata
    let our_path = our_sessions_dir().join(format!("{}.json", id));
    if our_path.exists() {
        fs::remove_file(&our_path).map_err(|e| format!("Failed to delete metadata: {}", e))?;
    }

    // Delete Claude's session files
    let root = project_root_for_commands(&workspace_state);
    let encoded = encode_project_path(&root.to_string_lossy());
    let jsonl_path = claude_projects_dir().join(&encoded).join(format!("{}.jsonl", id));
    if jsonl_path.exists() {
        fs::remove_file(&jsonl_path).map_err(|e| format!("Failed to delete session file: {}", e))?;
    }

    // Clean up matching pid entries in Claude sessions
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
