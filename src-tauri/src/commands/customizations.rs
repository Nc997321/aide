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
    let _trace = crate::diagnostics::trace_command("list_agents");
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
}

#[tauri::command]
pub fn get_agent(id: String) -> Result<CustomizationItem, String> {
    let _trace = crate::diagnostics::trace_command("get_agent");
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
    let _trace = crate::diagnostics::trace_command("create_agent");
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
    let _trace = crate::diagnostics::trace_command("update_agent");
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
    let _trace = crate::diagnostics::trace_command("delete_agent");
    let path = agents_dir().join(format!("{}.md", id));
    if !path.exists() {
        return Err(format!("Agent '{}' not found", id));
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete agent: {}", e))
}

#[tauri::command]
pub fn toggle_agent(id: String, enabled: bool) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("toggle_agent");
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
}

// ── Skill Commands ──

#[tauri::command]
pub fn list_skills() -> Result<Vec<CustomizationItem>, String> {
    let _trace = crate::diagnostics::trace_command("list_skills");
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
                let skill_md_disabled = path.join("SKILL.md.disabled");

                // Determine enabled status and which file to read
                let (content_path, enabled) = if skill_md.exists() {
                    (skill_md, true)
                } else if skill_md_disabled.exists() {
                    (skill_md_disabled, false)
                } else {
                    continue;
                };

                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    let content = fs::read_to_string(&content_path).unwrap_or_default();
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
                        enabled,
                        path: path.to_string_lossy().to_string(),
                        description,
                        metadata: Some(serde_json::json!({ "scripts": scripts })),
                    });
                }
            }
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn get_skill(id: String) -> Result<CustomizationItem, String> {
    let _trace = crate::diagnostics::trace_command("get_skill");
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
    let _trace = crate::diagnostics::trace_command("create_skill");
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
    let _trace = crate::diagnostics::trace_command("update_skill");
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
    let _trace = crate::diagnostics::trace_command("delete_skill");
    let dir = skills_dir().join(&id);
    if !dir.exists() {
        return Err(format!("Skill '{}' not found", id));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete skill: {}", e))
}

#[tauri::command]
pub fn toggle_skill(id: String, enabled: bool) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("toggle_skill");
    let dir = skills_dir().join(&id);
    let enabled_path = dir.join("SKILL.md");
    let disabled_path = dir.join("SKILL.md.disabled");

    if enabled {
        // Re-enable: rename SKILL.md.disabled -> SKILL.md
        if disabled_path.exists() {
            fs::rename(&disabled_path, &enabled_path)
                .map_err(|e| format!("Failed to enable skill '{}': {}", id, e))?;
        }
    } else {
        // Disable: rename SKILL.md -> SKILL.md.disabled
        if enabled_path.exists() {
            fs::rename(&enabled_path, &disabled_path)
                .map_err(|e| format!("Failed to disable skill '{}': {}", id, e))?;
        }
    }
    Ok(())
}

/// 校验脚本文件名：单段、非空、非隐藏、无路径分隔/越界，仅字母数字下划点连。
fn sanitize_script_filename(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid script filename".into());
    }
    if name.starts_with('.') {
        return Err("hidden file not allowed".into());
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-') {
        return Err("filename contains invalid chars".into());
    }
    Ok(name.to_string())
}

/// 拼接 <skill>/scripts/<filename>，校验文件名防越界，且结果须在 skills_dir 之下。
fn script_path(skill_id: &str, filename: &str) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_script_filename(filename)?;
    let p = skills_dir().join(skill_id).join("scripts").join(safe);
    if !p.starts_with(skills_dir()) {
        return Err("path escape".into());
    }
    Ok(p)
}

/// 读取 skill 的脚本文件内容。
#[tauri::command]
pub async fn read_skill_script(skill_id: String, filename: String) -> Result<String, String> {
    let p = script_path(&skill_id, &filename)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// 写入（或覆盖）skill 的脚本文件；scripts 目录不存在时自动创建。
#[tauri::command]
pub async fn write_skill_script(
    skill_id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    let p = script_path(&skill_id, &filename)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// 删除 skill 的脚本文件；不存在视为成功。
#[tauri::command]
pub async fn delete_skill_script(skill_id: String, filename: String) -> Result<(), String> {
    let p = script_path(&skill_id, &filename)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

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
pub fn list_instructions(ws: tauri::State<'_, WorkspaceState>) -> Result<Vec<CustomizationItem>, String> {
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
pub fn get_project_instructions(ws: tauri::State<'_, WorkspaceState>) -> Result<CustomizationItem, String> {
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
pub fn save_project_instructions(content: String, ws: tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("save_project_instructions");
    let path = project_claude_md_path(&ws);
    fs::write(&path, content).map_err(|e| format!("Failed to write project instructions: {}", e))
}

// ── Hook Commands ──

#[tauri::command]
pub fn list_hooks() -> Result<Vec<CustomizationItem>, String> {
    let _trace = crate::diagnostics::trace_command("list_hooks");
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
                    let enabled = !hook.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);

                    items.push(CustomizationItem {
                        id: id.clone(),
                        name: format!("{}: {}", event, matcher),
                        r#type: "hook".to_string(),
                        enabled,
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
    let _trace = crate::diagnostics::trace_command("create_hook");
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
    let _trace = crate::diagnostics::trace_command("update_hook");
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
    let _trace = crate::diagnostics::trace_command("delete_hook");
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
pub fn toggle_hook(id: String, enabled: bool) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("toggle_hook");
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
                    if let Some(hook_obj) = arr[index].as_object_mut() {
                        if enabled {
                            hook_obj.remove("disabled");
                        } else {
                            hook_obj.insert("disabled".to_string(), serde_json::json!(true));
                        }
                    }
                } else {
                    return Err(format!("Hook index {} out of range for event '{}'", index, event));
                }
            }
        } else {
            return Err(format!("Hook event '{}' not found", event));
        }
    } else {
        return Err("No hooks found in settings".to_string());
    }

    save_settings(&settings)
}

// ── MCP Server Commands ──

#[tauri::command]
pub fn list_mcp_servers() -> Result<Vec<CustomizationItem>, String> {
    let _trace = crate::diagnostics::trace_command("list_mcp_servers");
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
            let enabled = !config.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);

            items.push(CustomizationItem {
                id: name.clone(),
                name: name.clone(),
                r#type: "mcp_server".to_string(),
                enabled,
                path: settings_path().to_string_lossy().to_string(),
                description: Some(format!("{} {}", command, args)),
                metadata: Some(config.clone()),
            });
        }
    }
    Ok(items)
}

/// 从前端 data 构造写入 settings.json 的 mcpServer config。
/// 剥离前端 UI 字段（transport/disabled/name），保留 SDK 认的传输字段
/// （stdio: command/args/env；sse/http: url/headers）。跳过 null 与空 env/args。
fn build_mcp_config(data: &serde_json::Value) -> serde_json::Value {
    let mut cfg = serde_json::Map::new();
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            if k == "name" || k == "transport" || k == "disabled" {
                continue;
            }
            if v.is_null() {
                continue;
            }
            if k == "env" {
                if let Some(e) = v.as_object() {
                    if e.is_empty() {
                        continue;
                    }
                }
            }
            if k == "args" {
                if let Some(a) = v.as_array() {
                    if a.is_empty() {
                        continue;
                    }
                }
            }
            cfg.insert(k.clone(), v.clone());
        }
    }
    serde_json::Value::Object(cfg)
}

/// 生成列表展示用的描述文本：stdio 显 command+args，sse/http 显 type+url。
fn describe_mcp(cfg: &serde_json::Value) -> String {
    if let Some(c) = cfg.get("command").and_then(|v| v.as_str()) {
        let args = cfg
            .get("args")
            .and_then(|a| a.as_array())
            .map(|v| {
                v.iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        format!("{} {}", c, args)
    } else if let Some(u) = cfg.get("url").and_then(|v| v.as_str()) {
        let t = if cfg.get("headers").is_some() { "http" } else { "sse" };
        format!("{} {}", t, u)
    } else {
        String::new()
    }
}

#[tauri::command]
pub async fn create_mcp_server(data: serde_json::Value) -> Result<CustomizationItem, String> {
    let name = data["name"].as_str().unwrap_or("unnamed").to_string();
    let cfg = build_mcp_config(&data);
    let mut settings = load_settings();
    settings
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    settings["mcpServers"][name.as_str()] = cfg.clone();
    save_settings(&settings)?;

    Ok(CustomizationItem {
        id: name.clone(),
        name,
        r#type: "mcp_server".to_string(),
        enabled: true,
        path: settings_path().to_string_lossy().to_string(),
        description: Some(describe_mcp(&cfg)),
        metadata: Some(cfg),
    })
}

#[tauri::command]
pub async fn update_mcp_server(id: String, data: serde_json::Value) -> Result<(), String> {
    let cfg = build_mcp_config(&data);
    let mut settings = load_settings();
    if let Some(servers) = settings.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        // 保留原 disabled 状态（toggle 单独管），其余整体替换为前端透传的 config。
        let disabled = servers.get(&id).and_then(|c| c.get("disabled")).cloned();
        let mut new_cfg = cfg;
        if let Some(d) = disabled {
            if let Some(obj) = new_cfg.as_object_mut() {
                obj.insert("disabled".into(), d);
            }
        }
        servers.insert(id, new_cfg);
    }
    save_settings(&settings)
}

#[tauri::command]
pub fn delete_mcp_server(id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("delete_mcp_server");
    let mut settings = load_settings();
    if let Some(mcp_servers) = settings.get_mut("mcpServers") {
        if let Some(obj) = mcp_servers.as_object_mut() {
            obj.remove(&id);
        }
    }
    save_settings(&settings)
}

#[tauri::command]
pub fn toggle_mcp_server(id: String, enabled: bool) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("toggle_mcp_server");
    let mut settings = load_settings();
    if let Some(mcp_servers) = settings.get_mut("mcpServers") {
        if let Some(config) = mcp_servers.get_mut(&id) {
            if let Some(obj) = config.as_object_mut() {
                if enabled {
                    obj.remove("disabled");
                } else {
                    obj.insert("disabled".to_string(), serde_json::json!(true));
                }
            }
        } else {
            return Err(format!("MCP server '{}' not found", id));
        }
    } else {
        return Err(format!("MCP server '{}' not found", id));
    }

    save_settings(&settings)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_mcp_config_stdio() {
        let data = serde_json::json!({ "transport": "stdio", "command": "npx", "args": ["-y", "srv"], "env": {} });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["command"], "npx");
        assert!(cfg["args"].is_array());
        assert!(!cfg.as_object().unwrap().contains_key("disabled"));
        assert!(!cfg.as_object().unwrap().contains_key("transport"));
        assert!(!cfg.as_object().unwrap().contains_key("env")); // 空 env 跳过
    }

    #[test]
    fn build_mcp_config_sse_strips_transport() {
        let data = serde_json::json!({ "transport": "sse", "url": "http://x/sse" });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["url"], "http://x/sse");
        assert!(!cfg.as_object().unwrap().contains_key("transport"));
    }

    #[test]
    fn build_mcp_config_http() {
        let data = serde_json::json!({ "transport": "http", "url": "http://x/mcp", "headers": { "Authorization": "Bearer k" } });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["url"], "http://x/mcp");
        assert_eq!(cfg["headers"]["Authorization"], "Bearer k");
    }

    #[test]
    fn build_mcp_config_strips_name_and_disabled() {
        let data = serde_json::json!({ "name": "x", "disabled": true, "command": "npx", "args": ["a"] });
        let cfg = build_mcp_config(&data);
        assert!(!cfg.as_object().unwrap().contains_key("name"));
        assert!(!cfg.as_object().unwrap().contains_key("disabled"));
        assert_eq!(cfg["command"], "npx");
    }

    #[test]
    fn describe_mcp_stdio_and_url() {
        let stdio = serde_json::json!({ "command": "npx", "args": ["-y", "srv"] });
        assert_eq!(describe_mcp(&stdio), "npx -y srv");
        let sse = serde_json::json!({ "type": "sse", "url": "http://x/sse" });
        assert_eq!(describe_mcp(&sse), "sse http://x/sse");
        let http = serde_json::json!({ "url": "http://x/mcp", "headers": { "Authorization": "k" } });
        assert_eq!(describe_mcp(&http), "http http://x/mcp");
        assert_eq!(describe_mcp(&serde_json::json!({})), "");
    }

    #[test]
    fn sanitize_script_filename_rejects_traversal() {
        assert!(sanitize_script_filename("build.sh").is_ok());
        assert!(sanitize_script_filename("../evil").is_err());
        assert!(sanitize_script_filename("a/b").is_err());
        assert!(sanitize_script_filename("").is_err());
        assert!(sanitize_script_filename(".gitignore").is_err());
    }

    #[test]
    fn sanitize_script_filename_rejects_invalid_chars() {
        assert!(sanitize_script_filename("a b").is_err()); // 空格
        assert!(sanitize_script_filename("a*b").is_err());
        assert!(sanitize_script_filename("a:b").is_err());
        assert!(sanitize_script_filename("build.sh").is_ok());
        assert!(sanitize_script_filename("check_1.py").is_ok());
        assert!(sanitize_script_filename("verify-v2.js").is_ok());
    }
}
