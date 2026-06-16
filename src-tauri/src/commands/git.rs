use std::process::Command;
use tauri::State;

use super::{DiffEntry, WorkspaceState, project_root_for_commands};

#[tauri::command]
pub fn git_diff_files(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<DiffEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    // Modified / deleted files (working tree vs index)
    let output = Command::new("git")
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
        let additions = if parts[0] == "-" { 0 } else { parts[0].parse().unwrap_or(0) };
        let deletions = if parts[1] == "-" { 0 } else { parts[1].parse().unwrap_or(0) };
        files.push(DiffEntry {
            path: parts[2].to_string(),
            status: "M".to_string(),
            additions,
            deletions,
        });
    }

    // Untracked (new) files — git diff doesn't see them, so we scan separately
    if let Ok(untracked) = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&root)
        .output()
    {
        let untracked_stdout = String::from_utf8_lossy(&untracked.stdout);
        for path in untracked_stdout.lines() {
            let file_path = root.join(path);
            if !file_path.is_file() {
                continue;
            }
            let additions = std::fs::read_to_string(&file_path)
                .map(|c| c.lines().count() as u32)
                .unwrap_or(0);
            files.push(DiffEntry {
                path: path.to_string(),
                status: "A".to_string(),
                additions,
                deletions: 0,
            });
        }
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
    Command::new("git")
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
    Command::new("git")
        .args(["checkout", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to revert: {}", e))?;
    Ok(())
}
