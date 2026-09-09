// 工作树 / 暂存区操作域：add（暂存）、restore --staged（取消暂存）、
// checkout -- <path>（撤回文件）、discard all、reset（取消全部暂存）、
// commit（含 amend 保留原信息）。变更面板的操作按钮走这组。
use super::runtime::{git_run, git_run_async, git_run_blocking};
use crate::commands::{project_root_for, project_root_for_commands, WorkspaceState};
use tauri::State;

#[tauri::command]
pub async fn git_stage_all(workspace_state: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(());
    }
    git_run_async(vec!["add".into(), "-A".into()], root).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    git_run_async(vec!["add".into(), "--".into(), path], root).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    git_run_async(
        vec!["restore".into(), "--staged".into(), "--".into(), path],
        root,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn git_revert_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    // 会话所属工作区；省略 = 当前活动工作区。撤回是唯一的破坏性操作，
    // 不传 cwd 会在用户当前所看的工作区里执行 `checkout --`，误回滚另一工作区的同名文件。
    cwd: Option<String>,
) -> Result<(), String> {
    let root = project_root_for(&workspace_state, cwd.as_deref());
    git_run_async(vec!["checkout".into(), "--".into(), path], root).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_discard_all(workspace_state: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let output = git_run_async(vec!["checkout".into(), "--".into(), ".".into()], root)
        .await
        .map_err(|e| format!("DISCARD_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DISCARD_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_all(workspace_state: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let output = git_run_async(vec!["reset".into(), "HEAD".into()], root)
        .await
        .map_err(|e| format!("Failed to run git reset: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("UNSTAGE_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(
    workspace_state: State<'_, WorkspaceState>,
    message: String,
    amend: Option<bool>,
) -> Result<String, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // status + commit + rev-parse in one blocking task
    git_run_blocking(move || {
        let amend = amend.unwrap_or(false);
        if !amend {
            let status_out = git_run(&["status", "--porcelain"], &root)
                .map_err(|e| format!("Failed to run git status: {}", e))?;
            let stdout = String::from_utf8_lossy(&status_out.stdout);
            if stdout.trim().is_empty() {
                return Err("Nothing to commit (working tree clean)".into());
            }
        }

        // amend 无 message 时保留原提交信息（--no-edit）；
        // amend 对工作区干净（纯改 message）也合法，故跳过上面的 precheck。
        let mut args: Vec<&str> = vec!["commit"];
        if amend {
            args.push("--amend");
            if message.trim().is_empty() {
                args.push("--no-edit");
            }
        }
        if !message.trim().is_empty() {
            args.push("-m");
            args.push(&message);
        }
        let output =
            git_run(&args, &root).map_err(|e| format!("Failed to run git commit: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Commit failed: {}", stderr.trim()));
        }

        let hash_out = git_run(&["rev-parse", "HEAD"], &root)
            .map_err(|e| format!("Failed to get commit hash: {}", e))?;
        Ok(String::from_utf8_lossy(&hash_out.stdout).trim().to_string())
    })
    .await
}
