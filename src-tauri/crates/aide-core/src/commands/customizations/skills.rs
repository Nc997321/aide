// skills 子域：~/.aide/claude/skills/ 的插件技能清单与脚本子文件
// （read/write/delete script，文件名过 sanitize_script_filename 白名单）。
#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("list_skills", list_skills),
    command!("get_skill", get_skill),
    command!("get_skill_content", get_skill_content),
    command!("create_skill", create_skill),
    command!("update_skill", update_skill),
    command!("delete_skill", delete_skill),
    command!("toggle_skill", toggle_skill),
    command!("read_skill_script", read_skill_script),
    command!("write_skill_script", write_skill_script),
    command!("delete_skill_script", delete_skill_script),
];

use super::{extract_frontmatter_field, skills_dir, update_frontmatter_field, CustomizationItem};
use std::fs;
// ── Skill Commands ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillsArgs {
}

async fn list_skills(_core: Arc<Core>, a: ListSkillsArgs) -> Result<Vec<CustomizationItem>, String> {
    let _ = a;
    blocking(move || -> Result<Vec<CustomizationItem>, String> {
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
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSkillArgs {
    id: String,
}

async fn get_skill(_core: Arc<Core>, a: GetSkillArgs) -> Result<CustomizationItem, String> {
    let GetSkillArgs { id } = a;
    blocking(move || -> Result<CustomizationItem, String> {
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
}).await
}

/// 读取 skill 的 SKILL.md 全文（frontmatter + 正文）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSkillContentArgs {
    id: String,
}

async fn get_skill_content(_core: Arc<Core>, a: GetSkillContentArgs) -> Result<String, String> {
    let GetSkillContentArgs { id } = a;
    {
    let path = skills_dir().join(&id).join("SKILL.md");
    if !path.exists() {
        return Err(format!("Skill '{}' not found", id));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillArgs {
    data: serde_json::Value,
}

async fn create_skill(_core: Arc<Core>, a: CreateSkillArgs) -> Result<CustomizationItem, String> {
    let CreateSkillArgs { data } = a;
    blocking(move || -> Result<CustomizationItem, String> {
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
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSkillArgs {
    id: String,
    data: serde_json::Value,
}

async fn update_skill(_core: Arc<Core>, a: UpdateSkillArgs) -> Result<(), String> {
    let UpdateSkillArgs { id, data } = a;
    blocking(move || -> Result<(), String> {
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
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillArgs {
    id: String,
}

async fn delete_skill(_core: Arc<Core>, a: DeleteSkillArgs) -> Result<(), String> {
    let DeleteSkillArgs { id } = a;
    blocking(move || -> Result<(), String> {
    let dir = skills_dir().join(&id);
    if !dir.exists() {
        return Err(format!("Skill '{}' not found", id));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete skill: {}", e))
}).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleSkillArgs {
    id: String,
    enabled: bool,
}

async fn toggle_skill(_core: Arc<Core>, a: ToggleSkillArgs) -> Result<(), String> {
    let ToggleSkillArgs { id, enabled } = a;
    blocking(move || -> Result<(), String> {
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
}).await
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSkillScriptArgs {
    skill_id: String,
    filename: String,
}

async fn read_skill_script(_core: Arc<Core>, a: ReadSkillScriptArgs) -> Result<String, String> {
    let ReadSkillScriptArgs { skill_id, filename } = a;
    {
    let p = script_path(&skill_id, &filename)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}
}

/// 写入（或覆盖）skill 的脚本文件；scripts 目录不存在时自动创建。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillScriptArgs {
    skill_id: String,
    filename: String,
    content: String,
}

async fn write_skill_script(_core: Arc<Core>, a: WriteSkillScriptArgs) -> Result<(), String> {
    let WriteSkillScriptArgs { skill_id, filename, content } = a;
    {
    let p = script_path(&skill_id, &filename)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}
}

/// 删除 skill 的脚本文件；不存在视为成功。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillScriptArgs {
    skill_id: String,
    filename: String,
}

async fn delete_skill_script(_core: Arc<Core>, a: DeleteSkillScriptArgs) -> Result<(), String> {
    let DeleteSkillScriptArgs { skill_id, filename } = a;
    {
    let p = script_path(&skill_id, &filename)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}
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
