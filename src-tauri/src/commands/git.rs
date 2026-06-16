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
