// instructions 子域：全局 CLAUDE.md 与项目 CLAUDE.md 的读写。
use super::{global_claude_md_path, project_claude_md_path, CustomizationItem, WorkspaceState};
use std::fs;
// ── Instruction Commands ──

#[tauri::command]
pub fn get_global_instructions() -> Result<CustomizationItem, String> {
    let _trace = crate::diagnostics::trace_command("get_global_instructions");
    let path = global_claude_md_path();
    let content = if path.exists() {
        fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(CustomizationItem {
        id: "global".to_string(),
        name: "全局指令".to_string(),
        r#type: "instruction".to_string(),
        enabled: true,
        path: path.to_string_lossy().to_string(),
        description: Some("全局 CLAUDE.md 指令".to_string()),
        metadata: Some(serde_json::json!({ "content": content, "is_global": true })),
    })
}

#[tauri::command]
pub fn list_instructions(
    ws: tauri::State<'_, std::sync::Arc<WorkspaceState>>,
) -> Result<Vec<CustomizationItem>, String> {
    let _trace = crate::diagnostics::trace_command("list_instructions");
    let mut items = Vec::new();

    let global_path = global_claude_md_path();
    let global_content = if global_path.exists() {
        fs::read_to_string(&global_path).unwrap_or_default()
    } else {
        String::new()
    };
    items.push(CustomizationItem {
        id: "global".to_string(),
        name: "全局指令".to_string(),
        r#type: "instruction".to_string(),
        enabled: true,
        path: global_path.to_string_lossy().to_string(),
        description: Some("全局 CLAUDE.md 指令".to_string()),
        metadata: Some(serde_json::json!({ "content": global_content, "is_global": true })),
    });

    let project_path = project_claude_md_path(&ws);
    let project_content = if project_path.exists() {
        fs::read_to_string(&project_path).unwrap_or_default()
    } else {
        String::new()
    };
    items.push(CustomizationItem {
        id: "project".to_string(),
        name: "项目指令".to_string(),
        r#type: "instruction".to_string(),
        enabled: true,
        path: project_path.to_string_lossy().to_string(),
        description: Some("项目 CLAUDE.md 指令".to_string()),
        metadata: Some(serde_json::json!({ "content": project_content, "is_global": false })),
    });

    Ok(items)
}

#[tauri::command]
pub fn save_global_instructions(content: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("save_global_instructions");
    let path = global_claude_md_path();
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write global instructions: {}", e))
}

#[tauri::command]
pub fn get_project_instructions(
    ws: tauri::State<'_, std::sync::Arc<WorkspaceState>>,
) -> Result<CustomizationItem, String> {
    let _trace = crate::diagnostics::trace_command("get_project_instructions");
    let path = project_claude_md_path(&ws);
    let content = if path.exists() {
        fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(CustomizationItem {
        id: "project".to_string(),
        name: "项目指令".to_string(),
        r#type: "instruction".to_string(),
        enabled: true,
        path: path.to_string_lossy().to_string(),
        description: Some("项目 CLAUDE.md 指令".to_string()),
        metadata: Some(serde_json::json!({ "content": content, "is_global": false })),
    })
}

#[tauri::command]
pub fn save_project_instructions(
    content: String,
    ws: tauri::State<'_, std::sync::Arc<WorkspaceState>>,
) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("save_project_instructions");
    let path = project_claude_md_path(&ws);
    fs::write(&path, content).map_err(|e| format!("Failed to write project instructions: {}", e))
}
