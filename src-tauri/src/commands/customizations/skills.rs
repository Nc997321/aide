// skills 子域：~/.aide/claude/skills/ 的插件技能清单与脚本子文件
// （read/write/delete script，文件名过 sanitize_script_filename 白名单）。
use super::{extract_frontmatter_field, skills_dir, update_frontmatter_field, CustomizationItem};
use std::fs;
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
                                    .filter_map(|e| {
                                        e.path()
                                            .file_name()
                                            .map(|n| n.to_string_lossy().to_string())
                                    })
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
                    .filter_map(|e| {
                        e.path()
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                    })
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

/// 读取 skill 的 SKILL.md 全文（frontmatter + 正文）。
#[tauri::command]
pub async fn get_skill_content(id: String) -> Result<String, String> {
    let path = skills_dir().join(&id).join("SKILL.md");
    if !path.exists() {
        return Err(format!("Skill '{}' not found", id));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
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
    fs::write(&skill_md_path, skill_md_content)
        .map_err(|e| format!("Failed to write skill: {}", e))?;

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

    // 正文 tab：data.content 存在时全文覆盖 SKILL.md（frontmatter + body 一起写）。
    if let Some(full) = data["content"].as_str() {
        fs::write(&skill_md, full).map_err(|e| format!("Failed to write skill: {}", e))?;
        return Ok(());
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
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
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

#[cfg(test)]
mod tests {
    use super::*;

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
