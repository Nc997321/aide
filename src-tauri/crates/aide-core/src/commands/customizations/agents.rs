// agents 子域：~/.aide/claude/agents/*.md 的列表 / 读取 / 增删改 / 启停，
// 与 settings.json 的 disabled 清单联动。
#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("list_agents", list_agents),
    command!("get_agent", get_agent),
    command!("get_agent_content", get_agent_content),
    command!("create_agent", create_agent),
    command!("update_agent", update_agent),
    command!("delete_agent", delete_agent),
    command!("toggle_agent", toggle_agent),
];

use super::{agents_dir, extract_frontmatter_field, update_frontmatter_field, CustomizationItem};
use std::fs;
// ── Agent Commands ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentsArgs {
}

async fn list_agents(_core: Arc<Core>, a: ListAgentsArgs) -> Result<Vec<CustomizationItem>, String> {
    let _ = a;
    blocking(move || -> Result<Vec<CustomizationItem>, String> {
    let dir = agents_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            // Match both "foo.md" (enabled) and "foo.md.disabled" (disabled)
            if file_name.ends_with(".md.disabled") {
                let name = &file_name[..file_name.len() - ".md.disabled".len()];
                let content = fs::read_to_string(&path).unwrap_or_default();
                let description = extract_frontmatter_field(&content, "description");
                items.push(CustomizationItem {
                    id: name.to_string(),
                    name: name.to_string(),
                    r#type: "agent".to_string(),
                    enabled: false,
                    path: path.to_string_lossy().to_string(),
                    description,
                    metadata: None,
                });
            } else if file_name.ends_with(".md") {
                let name = &file_name[..file_name.len() - ".md".len()];
                let content = fs::read_to_string(&path).unwrap_or_default();
                let description = extract_frontmatter_field(&content, "description");
                items.push(CustomizationItem {
                    id: name.to_string(),
                    name: name.to_string(),
                    r#type: "agent".to_string(),
                    enabled: true,
                    path: path.to_string_lossy().to_string(),
                    description,
                    metadata: None,
                });
            }
        }
    }
    Ok(items)
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentArgs {
    id: String,
}

async fn get_agent(_core: Arc<Core>, a: GetAgentArgs) -> Result<CustomizationItem, String> {
    let GetAgentArgs { id } = a;
    blocking(move || -> Result<CustomizationItem, String> {
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
    }

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let description = extract_frontmatter_field(&content, "description");

    Ok(CustomizationItem {
        id: id.clone(),
        name: id,
        r#type: "agent".to_string(),
        enabled: true,
        path: path.to_string_lossy().to_string(),
        description,
        metadata: None,
    })
}).await
}

/// 读取 agent 的 .md 全文（frontmatter + 正文）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAgentContentArgs {
    id: String,
}

async fn get_agent_content(_core: Arc<Core>, a: GetAgentContentArgs) -> Result<String, String> {
    let GetAgentContentArgs { id } = a;
    {
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentArgs {
    data: serde_json::Value,
}

async fn create_agent(_core: Arc<Core>, a: CreateAgentArgs) -> Result<CustomizationItem, String> {
    let CreateAgentArgs { data } = a;
    blocking(move || -> Result<CustomizationItem, String> {
    let name = data["name"].as_str().unwrap_or("unnamed");
    let description = data["description"].as_str().unwrap_or("");
    let model = data["model"].as_str().unwrap_or("haiku");
    let tools = data["tools"].as_str().unwrap_or("Bash, Read, Write");

    let content = format!(
        "---\nname: {}\ndescription: {}\nmodel: {}\ntools: {}\n---\n\n# {}\n\n{}",
        name, description, model, tools, name, description
    );

    let dir = agents_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    let path = dir.join(format!("{}.md", name));
    fs::write(&path, content).map_err(|e| format!("Failed to write agent: {}", e))?;

    Ok(CustomizationItem {
        id: name.to_string(),
        name: name.to_string(),
        r#type: "agent".to_string(),
        enabled: true,
        path: path.to_string_lossy().to_string(),
        description: Some(description.to_string()),
        metadata: None,
    })
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentArgs {
    id: String,
    data: serde_json::Value,
}

async fn update_agent(_core: Arc<Core>, a: UpdateAgentArgs) -> Result<(), String> {
    let UpdateAgentArgs { id, data } = a;
    blocking(move || -> Result<(), String> {
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
    }

    // 正文 tab：data.content 存在时全文覆盖 agent.md。
    if let Some(full) = data["content"].as_str() {
        fs::write(&path, full).map_err(|e| format!("Failed to update agent: {}", e))?;
        return Ok(());
    }

    let mut content = fs::read_to_string(&path).map_err(|e| e.to_string())?;

    if let Some(name) = data["name"].as_str() {
        content = update_frontmatter_field(&content, "name", name);
    }
    if let Some(description) = data["description"].as_str() {
        content = update_frontmatter_field(&content, "description", description);
    }
    if let Some(model) = data["model"].as_str() {
        content = update_frontmatter_field(&content, "model", model);
    }
    if let Some(tools) = data["tools"].as_str() {
        content = update_frontmatter_field(&content, "tools", tools);
    }

    fs::write(&path, content).map_err(|e| format!("Failed to update agent: {}", e))
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentArgs {
    id: String,
}

async fn delete_agent(_core: Arc<Core>, a: DeleteAgentArgs) -> Result<(), String> {
    let DeleteAgentArgs { id } = a;
    blocking(move || -> Result<(), String> {
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete agent: {}", e))
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleAgentArgs {
    id: String,
    enabled: bool,
}

async fn toggle_agent(_core: Arc<Core>, a: ToggleAgentArgs) -> Result<(), String> {
    let ToggleAgentArgs { id, enabled } = a;
    blocking(move || -> Result<(), String> {
    let dir = agents_dir();
    let enabled_path = dir.join(format!("{}.md", id));
    let disabled_path = dir.join(format!("{}.md.disabled", id));

    if enabled {
        // Re-enable: rename .md.disabled -> .md
        if disabled_path.exists() {
            fs::rename(&disabled_path, &enabled_path)
                .map_err(|e| format!("Failed to enable agent '{}': {}", id, e))?;
        }
    } else {
        // Disable: rename .md -> .md.disabled
        if enabled_path.exists() {
            fs::rename(&enabled_path, &disabled_path)
                .map_err(|e| format!("Failed to disable agent '{}': {}", id, e))?;
        }
    }
    Ok(())
}).await
}
