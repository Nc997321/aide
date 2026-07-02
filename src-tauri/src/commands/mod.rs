pub mod shell;
pub mod filesystem;
pub mod git;
pub mod session;
pub mod workspace;
pub mod settings;
pub mod customizations;
pub mod detectors;
pub mod marketplace;
pub mod provider;
pub mod run_configs;
pub mod run_process;
pub mod clipboard;
pub mod file_assoc;
pub mod recent;
pub mod chat;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Shared Types ──

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
    pub key: String,
    pub name: String,
    pub missing: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub branch: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffEntry {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line: u32,
    pub content: String,
    pub match_type: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LastEventInfo {
    pub event_type: Option<String>,
    pub stop_reason: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangeFileData {
    pub path: String,
    #[serde(default = "default_status")]
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

fn default_status() -> String { "M".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangeRoundData {
    pub index: u32,
    pub time: String,
    pub files: Vec<ChangeFileData>,
    #[serde(default)]
    pub rewind_to: Option<u64>,
}

// ── WorkspaceState ──

pub struct WorkspaceState {
    pub key: Mutex<Option<String>>,
    pub path: Mutex<Option<PathBuf>>,
}

impl WorkspaceState {
    pub fn new() -> Self {
        Self {
            key: Mutex::new(None),
            path: Mutex::new(None),
        }
    }
}

// ── Shared Helpers ──

pub fn project_root_for_commands(ws: &WorkspaceState) -> PathBuf {
    if let Ok(path_guard) = ws.path.lock() {
        if let Some(path) = path_guard.as_ref() {
            if path.exists() {
                return path.clone();
            }
        }
    }
    // No workspace explicitly set — fall back to user's home directory.
    // Using the install directory (cwd) is never useful.
    user_home().unwrap_or_else(|| PathBuf::from("."))
}


pub fn detect_git_branch(root: &PathBuf) -> String {
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

// ── Path Helpers ──

pub fn user_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .ok()
}

pub fn claude_home() -> PathBuf {
    user_home().unwrap_or_else(|| PathBuf::from(".")).join(".claude")
}

pub fn claude_projects_dir() -> PathBuf {
    claude_home().join("projects")
}

pub fn claude_sessions_dir() -> PathBuf {
    claude_home().join("sessions")
}

pub fn our_config_dir() -> PathBuf {
    user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude-code-desktop")
}

pub fn our_sessions_dir() -> PathBuf {
    our_config_dir().join("sessions")
}

pub fn config_path() -> PathBuf {
    our_config_dir().join("config.json")
}

/// Locate a session's transcript(s) by globally-unique session id.
///
/// Claude stores transcripts at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
/// and `claude --resume <id>` finds them by scanning **every** project folder
/// for the id — the cwd encoding is irrelevant once you have the id. Aide must
/// do the same: the folder name Claude actually used can differ from the
/// cwd-encoding Aide would compute. Concretely observed: a Claude version
/// encoded `.` as `-` (`C--...-chennong4-0`) while Aide keeps the dot
/// (`C--...-chennong4.0`), so a cwd-based lookup pointed at the wrong folder
/// and `delete_session` silently no-op'd, leaving the transcript behind for
/// Claude to resume. Session ids are UUIDs and globally unique, so at most one
/// project folder ever matches.
///
/// `projects_dir` is a parameter so the lookup is unit-testable against a
/// temp dir; production callers pass `claude_projects_dir()`.
pub fn find_session_jsonl_in(projects_dir: &std::path::Path, id: &str) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let p = entry.path().join(format!("{}.jsonl", id));
                if p.is_file() {
                    hits.push(p);
                }
            }
        }
    }
    hits
}

/// `find_session_jsonl_in` scoped to Claude's real `~/.claude/projects/` dir.
pub fn find_session_jsonl_globally(id: &str) -> Vec<PathBuf> {
    find_session_jsonl_in(&claude_projects_dir(), id)
}

// Re-export from workspace module
pub use workspace::{load_workspace_config, resolve_path_from_key};

#[cfg(test)]
mod tests {
    use super::*;

    /// Aide's cwd→folder encoding: replace `:`, `\`, `/` with `-` (keeps `.`).
    /// Used here only to model the folder name Aide *would* compute, so the test
    /// can contrast it with a differently-encoded folder Claude created.
    fn aide_encode(path: &str) -> String {
        path.replace(':', "-").replace('\\', "-").replace('/', "-")
    }

    /// The lookup must find a transcript by id even when the folder name Claude
    /// used differs from the cwd-encoding Aide would compute. We model the
    /// observed divergence (a `.` in the cwd: Aide keeps it, an older Claude
    /// encoded it as `-`) with synthetic data — no real paths or ids in the test.
    #[test]
    fn finds_jsonl_when_folder_encoding_differs_from_aide_encode() {
        let root = std::env::temp_dir().join("aide_mod_test_encode_mismatch");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let cwd = r"C:\fake\proj\test4.0";
        // Folder Aide computes from the cwd (keeps the dot):
        let aide_folder = root.join(aide_encode(cwd));
        // Folder a Claude version that encodes '.' as '-' would have created:
        let claude_folder = root.join(aide_encode(cwd).replace('.', "-"));
        assert_ne!(aide_folder, claude_folder, "test setup must diverge");
        fs::create_dir_all(&aide_folder).unwrap();
        fs::create_dir_all(&claude_folder).unwrap();

        let id = "00000000-0000-0000-0000-000000000000";
        // Claude wrote the transcript into ITS folder, not Aide's:
        fs::write(claude_folder.join(format!("{id}.jsonl")), b"{}").unwrap();

        let hits = find_session_jsonl_in(&root, id);
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()),
            claude_folder.file_name().and_then(|n| n.to_str()),
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_empty_when_no_transcript() {
        let root = std::env::temp_dir().join("aide_mod_test_empty");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(find_session_jsonl_in(&root, "no-such-id").is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
