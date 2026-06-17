use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::{claude_home, project_root_for_commands, WorkspaceState};

// ── Common Types ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomizationItem {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub enabled: bool,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// ── Path Helpers ──

fn agents_dir() -> PathBuf {
    claude_home().join("agents")
}

fn skills_dir() -> PathBuf {
    claude_home().join("skills")
}

fn settings_path() -> PathBuf {
    claude_home().join("settings.json")
}

fn global_claude_md_path() -> PathBuf {
    claude_home().join("CLAUDE.md")
}

fn project_claude_md_path(ws: &WorkspaceState) -> PathBuf {
    project_root_for_commands(ws).join("CLAUDE.md")
}

// ── Settings File Helpers ──

fn load_settings() -> serde_json::Value {
    let path = settings_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                return v;
            }
        }
    }
    serde_json::json!({})
}

fn save_settings(v: &serde_json::Value) -> Result<(), String> {
    let path = settings_path();
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    fs::write(&path, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write settings: {}", e))
}

// ── Agent Commands ──

#[tauri::command]
pub fn list_agents() -> Result<Vec<CustomizationItem>, String> {
    let dir = agents_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(name) = path.file_stem().and_then(|n| n.to_str()) {
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
    }
    Ok(items)
}

#[tauri::command]
pub fn get_agent(id: String) -> Result<CustomizationItem, String> {
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
}

#[tauri::command]
pub fn create_agent(data: serde_json::Value) -> Result<CustomizationItem, String> {
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
}

#[tauri::command]
pub fn update_agent(id: String, data: serde_json::Value) -> Result<(), String> {
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
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
}

#[tauri::command]
pub fn delete_agent(id: String) -> Result<(), String> {
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete agent: {}", e))
}

#[tauri::command]
pub fn toggle_agent(_id: String, _enabled: bool) -> Result<(), String> {
    // For agents, toggling is not supported via file system
    Ok(())
}

// ── Skill Commands ──

#[tauri::command]
pub fn list_skills() -> Result<Vec<CustomizationItem>, String> {
    let dir = skills_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skill_md = path.join("SKILL.md");
                if skill_md.exists() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let content = fs::read_to_string(&skill_md).unwrap_or_default();
                        let description = extract_frontmatter_field(&content, "description");

                        let scripts_dir = path.join("scripts");
                        let scripts: Vec<String> = if scripts_dir.exists() {
                            fs::read_dir(&scripts_dir)
                                .map(|entries| {
                                    entries
                                        .flatten()
                                        .filter_map(|e| e.path().file_name().map(|n| n.to_string_lossy().to_string()))
                                        .collect()
                                })
                                .unwrap_or_default()
                        } else {
                            vec![]
                        };

                        items.push(CustomizationItem {
                            id: name.to_string(),
                            name: name.to_string(),
                            r#type: "skill".to_string(),
                            enabled: true,
                            path: path.to_string_lossy().to_string(),
                            description,
                            metadata: Some(serde_json::json!({ "scripts": scripts })),
                        });
                    }
                }
            }
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn get_skill(id: String) -> Result<CustomizationItem, String> {
    let path = skills_dir().join(&id);
    let skill_md = path.join("SKILL.md");
    if !skill_md.exists() {
        return Err(format!("Skill '{}' not found", id));
    }

    let content = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    let description = extract_frontmatter_field(&content, "description");

    let scripts_dir = path.join("scripts");
    let scripts: Vec<String> = if scripts_dir.exists() {
        fs::read_dir(&scripts_dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.path().file_name().map(|n| n.to_string_lossy().to_string()))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    Ok(CustomizationItem {
        id: id.clone(),
        name: id,
        r#type: "skill".to_string(),
        enabled: true,
        path: path.to_string_lossy().to_string(),
        description,
        metadata: Some(serde_json::json!({ "scripts": scripts })),
    })
}

#[tauri::command]
pub fn create_skill(data: serde_json::Value) -> Result<CustomizationItem, String> {
    let name = data["name"].as_str().unwrap_or("unnamed");
    let description = data["description"].as_str().unwrap_or("");

    let skill_md_content = format!(
        "---\nname: {}\ndescription: |\n  {}\ncontext: inline\n---\n\n# {}\n\n{}",
        name, description, name, description
    );

    let dir = skills_dir().join(name);
    let scripts_dir = dir.join("scripts");
    fs::create_dir_all(&scripts_dir).map_err(|e| format!("Failed to create directory: {}", e))?;

    let skill_md_path = dir.join("SKILL.md");
    fs::write(&skill_md_path, skill_md_content).map_err(|e| format!("Failed to write skill: {}", e))?;

    Ok(CustomizationItem {
        id: name.to_string(),
        name: name.to_string(),
        r#type: "skill".to_string(),
        enabled: true,
        path: dir.to_string_lossy().to_string(),
        description: Some(description.to_string()),
        metadata: Some(serde_json::json!({ "scripts": [] })),
    })
}

#[tauri::command]
pub fn update_skill(id: String, data: serde_json::Value) -> Result<(), String> {
    let dir = skills_dir().join(&id);
    let skill_md = dir.join("SKILL.md");
    if !skill_md.exists() {
        return Err(format!("Skill '{}' not found", id));
    }

    let mut content = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;

    if let Some(name) = data["name"].as_str() {
        content = update_frontmatter_field(&content, "name", name);
    }
    if let Some(description) = data["description"].as_str() {
        content = update_frontmatter_field(&content, "description", description);
    }

    fs::write(&skill_md, content).map_err(|e| format!("Failed to update skill: {}", e))
}

#[tauri::command]
pub fn delete_skill(id: String) -> Result<(), String> {
    let dir = skills_dir().join(&id);
    if !dir.exists() {
        return Err(format!("Skill '{}' not found", id));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete skill: {}", e))
}

#[tauri::command]
pub fn toggle_skill(_id: String, _enabled: bool) -> Result<(), String> {
    // For skills, toggling is not supported via file system
    Ok(())
}

// ── Instruction Commands ──

#[tauri::command]
pub fn get_global_instructions() -> Result<CustomizationItem, String> {
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
pub fn save_global_instructions(content: String) -> Result<(), String> {
    let path = global_claude_md_path();
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write global instructions: {}", e))
}

#[tauri::command]
pub fn get_project_instructions(ws: tauri::State<'_, WorkspaceState>) -> Result<CustomizationItem, String> {
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
pub fn save_project_instructions(content: String, ws: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let path = project_claude_md_path(&ws);
    fs::write(&path, content).map_err(|e| format!("Failed to write project instructions: {}", e))
}

// ── Hook Commands ──

#[tauri::command]
pub fn list_hooks() -> Result<Vec<CustomizationItem>, String> {
    let settings = load_settings();
    let hooks = settings.get("hooks").cloned().unwrap_or(serde_json::json!({}));

    let mut items = Vec::new();
    if let Some(obj) = hooks.as_object() {
        for (event, event_hooks) in obj {
            if let Some(hooks_array) = event_hooks.as_array() {
                for (index, hook) in hooks_array.iter().enumerate() {
                    let matcher = hook["matcher"].as_str().unwrap_or("");
                    let command = hook["hooks"][0]["command"].as_str().unwrap_or("");
                    let id = format!("{}_{}", event, index);

                    items.push(CustomizationItem {
                        id: id.clone(),
                        name: format!("{}: {}", event, matcher),
                        r#type: "hook".to_string(),
                        enabled: true,
                        path: settings_path().to_string_lossy().to_string(),
                        description: Some(command.to_string()),
                        metadata: Some(serde_json::json!({
                            "event": event,
                            "matcher": matcher,
                            "command": command,
                            "timeout": hook["hooks"][0]["timeout"],
                            "asyncRewake": hook["hooks"][0]["asyncRewake"]
                        })),
                    });
                }
            }
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn create_hook(data: serde_json::Value) -> Result<CustomizationItem, String> {
    let event = data["event"].as_str().unwrap_or("PostToolUse");
    let matcher = data["matcher"].as_str().unwrap_or("");
    let command = data["command"].as_str().unwrap_or("");
    let timeout = data["timeout"].as_u64().unwrap_or(60);
    let async_rewake = data["asyncRewake"].as_bool().unwrap_or(false);

    let mut settings = load_settings();
    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let event_hooks = hooks
        .as_object_mut()
        .unwrap()
        .entry(event)
        .or_insert_with(|| serde_json::json!([]));

    let new_hook = serde_json::json!({
        "matcher": matcher,
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": timeout,
            "asyncRewake": async_rewake
        }]
    });

    if let Some(arr) = event_hooks.as_array_mut() {
        arr.push(new_hook);
    }

    save_settings(&settings)?;

    let id = format!("{}_{}", event, 0); // Simplified ID
    Ok(CustomizationItem {
        id,
        name: format!("{}: {}", event, matcher),
        r#type: "hook".to_string(),
        enabled: true,
        path: settings_path().to_string_lossy().to_string(),
        description: Some(command.to_string()),
        metadata: Some(serde_json::json!({
            "event": event,
            "matcher": matcher,
            "command": command,
            "timeout": timeout,
            "asyncRewake": async_rewake
        })),
    })
}

#[tauri::command]
pub fn update_hook(id: String, data: serde_json::Value) -> Result<(), String> {
    // Parse event and index from id (format: "event_index")
    let parts: Vec<&str> = id.splitn(2, '_').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid hook id: {}", id));
    }
    let event = parts[0];
    let index: usize = parts[1].parse().map_err(|_| format!("Invalid hook index: {}", parts[1]))?;

    let mut settings = load_settings();
    if let Some(hooks) = settings.get_mut("hooks") {
        if let Some(event_hooks) = hooks.get_mut(event) {
            if let Some(arr) = event_hooks.as_array_mut() {
                if index < arr.len() {
                    if let Some(matcher) = data["matcher"].as_str() {
                        arr[index]["matcher"] = serde_json::json!(matcher);
                    }
                    if let Some(command) = data["command"].as_str() {
                        arr[index]["hooks"][0]["command"] = serde_json::json!(command);
                    }
                    if let Some(timeout) = data["timeout"].as_u64() {
                        arr[index]["hooks"][0]["timeout"] = serde_json::json!(timeout);
                    }
                    if let Some(async_rewake) = data["asyncRewake"].as_bool() {
                        arr[index]["hooks"][0]["asyncRewake"] = serde_json::json!(async_rewake);
                    }
                }
            }
        }
    }

    save_settings(&settings)
}

#[tauri::command]
pub fn delete_hook(id: String) -> Result<(), String> {
    let parts: Vec<&str> = id.splitn(2, '_').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid hook id: {}", id));
    }
    let event = parts[0];
    let index: usize = parts[1].parse().map_err(|_| format!("Invalid hook index: {}", parts[1]))?;

    let mut settings = load_settings();
    if let Some(hooks) = settings.get_mut("hooks") {
        if let Some(event_hooks) = hooks.get_mut(event) {
            if let Some(arr) = event_hooks.as_array_mut() {
                if index < arr.len() {
                    arr.remove(index);
                }
            }
        }
    }

    save_settings(&settings)
}

#[tauri::command]
pub fn toggle_hook(_id: String, _enabled: bool) -> Result<(), String> {
    // For hooks, toggling is not directly supported
    Ok(())
}

// ── MCP Server Commands ──

#[tauri::command]
pub fn list_mcp_servers() -> Result<Vec<CustomizationItem>, String> {
    let settings = load_settings();
    let mcp_servers = settings.get("mcpServers").cloned().unwrap_or(serde_json::json!({}));

    let mut items = Vec::new();
    if let Some(obj) = mcp_servers.as_object() {
        for (name, config) in obj {
            let command = config["command"].as_str().unwrap_or("");
            let args = config["args"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();

            items.push(CustomizationItem {
                id: name.clone(),
                name: name.clone(),
                r#type: "mcp_server".to_string(),
                enabled: true,
                path: settings_path().to_string_lossy().to_string(),
                description: Some(format!("{} {}", command, args)),
                metadata: Some(config.clone()),
            });
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn create_mcp_server(data: serde_json::Value) -> Result<CustomizationItem, String> {
    let name = data["name"].as_str().unwrap_or("unnamed");
    let command = data["command"].as_str().unwrap_or("");
    let args = data["args"].clone();
    let env = data["env"].clone();

    let mut settings = load_settings();
    let mcp_servers = settings
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));

    mcp_servers[name] = serde_json::json!({
        "command": command,
        "args": args,
        "env": env
    });

    save_settings(&settings)?;

    Ok(CustomizationItem {
        id: name.to_string(),
        name: name.to_string(),
        r#type: "mcp_server".to_string(),
        enabled: true,
        path: settings_path().to_string_lossy().to_string(),
        description: Some(format!("{} {}", command, args.as_str().unwrap_or(""))),
        metadata: Some(serde_json::json!({ "command": command, "args": args, "env": env })),
    })
}

#[tauri::command]
pub fn update_mcp_server(id: String, data: serde_json::Value) -> Result<(), String> {
    let mut settings = load_settings();
    let mcp_servers = settings
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));

    if let Some(config) = mcp_servers.get_mut(&id) {
        if let Some(command) = data["command"].as_str() {
            config["command"] = serde_json::json!(command);
        }
        if let Some(args) = data["args"].as_array() {
            config["args"] = serde_json::json!(args);
        }
        if let Some(env) = data["env"].as_object() {
            config["env"] = serde_json::json!(env);
        }
    }

    save_settings(&settings)
}

#[tauri::command]
pub fn delete_mcp_server(id: String) -> Result<(), String> {
    let mut settings = load_settings();
    if let Some(mcp_servers) = settings.get_mut("mcpServers") {
        if let Some(obj) = mcp_servers.as_object_mut() {
            obj.remove(&id);
        }
    }
    save_settings(&settings)
}

#[tauri::command]
pub fn toggle_mcp_server(_id: String, _enabled: bool) -> Result<(), String> {
    // For MCP servers, toggling is not directly supported
    Ok(())
}

// ── Frontmatter Helpers ──

fn extract_frontmatter_field(content: &str, field: &str) -> Option<String> {
    if let Some(start) = content.find("---") {
        if let Some(end) = content[start + 3..].find("---") {
            let frontmatter = &content[start + 3..start + 3 + end];
            for line in frontmatter.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    if key.trim() == field {
                        return Some(value.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

fn update_frontmatter_field(content: &str, field: &str, value: &str) -> String {
    if let Some(start) = content.find("---") {
        if let Some(end) = content[start + 3..].find("---") {
            let frontmatter = &content[start + 3..start + 3 + end];
            let mut new_frontmatter = String::new();
            let mut found = false;

            for line in frontmatter.lines() {
                if let Some((key, _)) = line.split_once(':') {
                    if key.trim() == field {
                        new_frontmatter.push_str(&format!("{}: {}\n", key, value));
                        found = true;
                    } else {
                        new_frontmatter.push_str(line);
                        new_frontmatter.push('\n');
                    }
                } else {
                    new_frontmatter.push_str(line);
                    new_frontmatter.push('\n');
                }
            }

            if !found {
                new_frontmatter.push_str(&format!("{}: {}\n", field, value));
            }

            let before = &content[..start + 3];
            let after = &content[start + 3 + end + 3..];
            return format!("{}{}{}", before, new_frontmatter, after);
        }
    }
    content.to_string()
}
