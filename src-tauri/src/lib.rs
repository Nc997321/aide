mod commands;
mod pty;

use commands::WorkspaceState;
use pty::PtyManager;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = PtyManager::new();
    let saved_key = commands::load_workspace_config();
    let workspace_state = WorkspaceState {
        key: Mutex::new(saved_key.clone()),
        path: Mutex::new(None), // resolved on first set_workspace call
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager)
        .manage(workspace_state)
        .invoke_handler(tauri::generate_handler![
            commands::pty_write,
            commands::pty_resize,
            commands::pty_spawn_claude,
            commands::pty_kill,
            commands::pty_has_session,
            commands::pty_rename_session,
            commands::get_project_info,
            commands::list_directory,
            commands::file_open,
            commands::read_file_content,
            commands::write_file_content,
            commands::delete_file,
            commands::create_file,
            commands::create_dir,
            commands::list_sessions,
            commands::create_session,
            commands::delete_session,
            commands::rename_session,
            commands::load_messages,
            commands::session_last_event,
            commands::list_workspaces,
            commands::set_workspace,
            commands::git_diff_files,
            commands::git_stage_all,
            commands::git_revert_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
