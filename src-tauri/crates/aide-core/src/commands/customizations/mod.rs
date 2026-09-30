//! Claude 自定义配置域：agents / skills / instructions / hooks / mcp 五个子域 + 共享底座
//! （CustomizationItem、目录与 settings.json 读写助手、frontmatter 编辑助手）。全部落在
//! Host 的 claude home（`~/.aide/claude`）与项目根——Host 能力。子文件经 `super::{helpers}`
//! 取共享项；各子模块导出自己的 `COMMANDS` 分表。

pub mod agents;
pub mod hooks;
pub mod instructions;
pub mod mcp;
pub mod skills;


use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::paths::claude_home;
use crate::WorkspaceState;
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
    ws.root_for(None).join("CLAUDE.md")
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
    fs::write(
        &path,
        serde_json::to_string_pretty(v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write settings: {}", e))
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
