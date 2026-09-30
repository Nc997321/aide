// instructions 子域：全局 CLAUDE.md 与项目 CLAUDE.md 的读写。
#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("get_global_instructions", get_global_instructions),
    command!("list_instructions", list_instructions),
    command!("save_global_instructions", save_global_instructions),
    command!("get_project_instructions", get_project_instructions),
    command!("save_project_instructions", save_project_instructions),
];

use super::{global_claude_md_path, project_claude_md_path, CustomizationItem};
use std::fs;
// ── Instruction Commands ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetGlobalInstructionsArgs {
}

async fn get_global_instructions(_core: Arc<Core>, a: GetGlobalInstructionsArgs) -> Result<CustomizationItem, String> {
    let _ = a;
    blocking(move || -> Result<CustomizationItem, String> {
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
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInstructionsArgs {
}

async fn list_instructions(core: Arc<Core>, a: ListInstructionsArgs) -> Result<Vec<CustomizationItem>, String> {
    let _ = a;
    let ws = core.workspace.clone();
    blocking(move || -> Result<Vec<CustomizationItem>, String> {
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
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGlobalInstructionsArgs {
    content: String,
}

async fn save_global_instructions(_core: Arc<Core>, a: SaveGlobalInstructionsArgs) -> Result<(), String> {
    let SaveGlobalInstructionsArgs { content } = a;
    blocking(move || -> Result<(), String> {
    let path = global_claude_md_path();
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write global instructions: {}", e))
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProjectInstructionsArgs {
}

async fn get_project_instructions(core: Arc<Core>, a: GetProjectInstructionsArgs) -> Result<CustomizationItem, String> {
    let _ = a;
    let ws = core.workspace.clone();
    blocking(move || -> Result<CustomizationItem, String> {
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
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectInstructionsArgs {
    content: String,
}

async fn save_project_instructions(core: Arc<Core>, a: SaveProjectInstructionsArgs) -> Result<(), String> {
    let SaveProjectInstructionsArgs { content } = a;
    let ws = core.workspace.clone();
    blocking(move || -> Result<(), String> {
    let path = project_claude_md_path(&ws);
    fs::write(&path, content).map_err(|e| format!("Failed to write project instructions: {}", e))
}).await
}
