use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use super::{filesystem::detect_command_for_path, our_config_dir};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunTarget {
    pub name: String,
    pub cwd: String,
    pub command: String,
}

// Encode a workspace path to a safe filename component.
// Mirrors encode_project_path() in mod.rs.
fn encode_key(ws_key: &str) -> String {
    ws_key.replace([':', '\\', '/'], "-")
}

fn configs_path(ws_key: &str) -> std::path::PathBuf {
    our_config_dir()
        .join("run_configs")
        .join(format!("{}.json", encode_key(ws_key)))
}

#[tauri::command]
pub fn list_run_configs(ws_key: String) -> Result<Vec<RunConfig>, String> {
    let path = configs_path(&ws_key);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_run_configs(ws_key: String, configs: Vec<RunConfig>) -> Result<(), String> {
    let path = configs_path(&ws_key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

// ── Detection helpers ────────────────────────────────────────────────────────

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "target" | "build" | "dist"
            | ".idea" | "__pycache__" | ".gradle" | "out" | "vendor"
            | ".next" | ".nuxt" | "coverage" | ".vscode"
    ) || name.starts_with('.')
}

fn extract_maven_modules(content: &str) -> Vec<String> {
    let re = Regex::new(r"<module>([^<]+)</module>").unwrap();
    re.captures_iter(content)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_gradle_includes(content: &str) -> Vec<String> {
    let mut modules = Vec::new();
    let re = Regex::new(r#"['"](?::)?([a-zA-Z0-9_\-]+)['"]"#).unwrap();
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("include") {
            continue;
        }
        for cap in re.captures_iter(trimmed) {
            if let Some(m) = cap.get(1) {
                modules.push(m.as_str().to_string());
            }
        }
    }
    modules
}

fn detect_maven_multi_module(root: &Path) -> Option<Vec<RunTarget>> {
    let pom_path = root.join("pom.xml");
    if !pom_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&pom_path).unwrap_or_default();
    if !content.contains("<modules>") {
        return None;
    }
    let modules = extract_maven_modules(&content);
    if modules.is_empty() {
        return None;
    }
    let targets: Vec<RunTarget> = modules
        .iter()
        .filter_map(|module| {
            let sub = root.join(module);
            if !sub.is_dir() {
                return None;
            }
            detect_command_for_path(&sub).map(|cmd| RunTarget {
                name: module.clone(),
                cwd: sub.to_string_lossy().to_string(),
                command: cmd,
            })
        })
        .collect();
    if targets.is_empty() { None } else { Some(targets) }
}

fn detect_gradle_multi_project(root: &Path) -> Option<Vec<RunTarget>> {
    let settings = root.join("settings.gradle");
    let settings_kts = root.join("settings.gradle.kts");
    let content = if settings.exists() {
        fs::read_to_string(&settings).unwrap_or_default()
    } else if settings_kts.exists() {
        fs::read_to_string(&settings_kts).unwrap_or_default()
    } else {
        return None;
    };
    if !content.contains("include") {
        return None;
    }
    let modules = extract_gradle_includes(&content);
    if modules.is_empty() {
        return None;
    }
    let targets: Vec<RunTarget> = modules
        .iter()
        .filter_map(|module| {
            let sub = root.join(module);
            if !sub.is_dir() {
                return None;
            }
            detect_command_for_path(&sub).map(|cmd| RunTarget {
                name: module.clone(),
                cwd: sub.to_string_lossy().to_string(),
                command: cmd,
            })
        })
        .collect();
    if targets.is_empty() { None } else { Some(targets) }
}

fn scan_subdirs(root: &Path) -> Vec<RunTarget> {
    let mut targets = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return targets;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_dir(&name) {
            continue;
        }
        if let Some(cmd) = detect_command_for_path(&path) {
            targets.push(RunTarget {
                name,
                cwd: path.to_string_lossy().to_string(),
                command: cmd,
            });
        }
    }
    targets
}

#[tauri::command]
pub fn detect_run_targets(cwd: String) -> Result<Vec<RunTarget>, String> {
    let root = Path::new(&cwd);

    // 1. Maven multi-module parent pom
    if let Some(targets) = detect_maven_multi_module(root) {
        return Ok(targets);
    }
    // 2. Gradle multi-project settings
    if let Some(targets) = detect_gradle_multi_project(root) {
        return Ok(targets);
    }
    // 3. Root-level single project
    if let Some(cmd) = detect_command_for_path(root) {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| cwd.clone());
        return Ok(vec![RunTarget { name, cwd, command: cmd }]);
    }
    // 4. Scan immediate subdirectories as fallback
    Ok(scan_subdirs(root))
}
