mod commands;
mod pty;

use commands::WorkspaceState;
use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = PtyManager::new();
    let saved_key = commands::load_workspace_config();
    let workspace_state = WorkspaceState::new();
    if let Some(key) = saved_key {
        *workspace_state.key.lock().unwrap() = Some(key);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager)
        .manage(workspace_state)
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_spawn_claude,
            commands::pty::pty_kill,
            commands::pty::pty_has_session,
            commands::pty::pty_rename_session,
            commands::filesystem::get_project_info,
            commands::filesystem::list_directory,
            commands::filesystem::file_open,
            commands::filesystem::read_file_content,
            commands::filesystem::write_file_content,
            commands::filesystem::delete_file,
            commands::filesystem::create_file,
            commands::filesystem::create_dir,
            commands::session::list_sessions,
            commands::session::create_session,
            commands::session::delete_session,
            commands::session::rename_session,
            commands::session::load_messages,
            commands::session::session_last_event,
            commands::workspace::list_workspaces,
            commands::workspace::set_workspace,
            commands::git::git_diff_files,
            commands::git::git_stage_all,
            commands::git::git_revert_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
