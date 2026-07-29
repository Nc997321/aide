use std::fs;
use std::path::PathBuf;
use tauri::State;

use super::{WorkspaceInfo, WorkspaceState, claude_projects_dir};

/// 路径 → 编码 key：把 : \ / 替换为 -，与 Claude CLI
/// `~/.aide/claude/projects/` 目录命名一致。
pub fn path_to_key(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

/// 按编码 key 解析实际的项目目录（可能命中多个）。
///
/// 新版 Agent SDK / claude.exe 编码 cwd 时把 `.` 也替换为 `-`
/// （`C--...-chennong4-0`），而 `path_to_key` 保留点号（`C--...-chennong4.0`），
/// 同一工作区因此可能分裂成两个目录（2026-07-24 实锤：chennong4.0 的新会话
/// 全部写进 `chennong4-0`，按 `path_to_key` 算出的目录去列会话自然读不到；
/// 同一案例此前已在 `find_session_jsonl_in` 的注释中记载）。这里按
/// 「`.` 归一成 `-` 后相等」匹配所有候选目录，调用方合并扫描。
pub fn resolve_project_dirs(projects_dir: &std::path::Path, key: &str) -> Vec<PathBuf> {
    let normalized = key.replace('.', "-");
    let mut dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.file_name().to_string_lossy().replace('.', "-") == normalized {
                dirs.push(entry.path());
            }
        }
    }
    dirs
}

/// 从工作区列表里滤掉黑名单中的 key（隐藏语义）。
pub fn filter_hidden(infos: Vec<WorkspaceInfo>, hidden: &[String]) -> Vec<WorkspaceInfo> {
    infos.into_iter().filter(|w| !hidden.contains(&w.key)).collect()
}

/// 读 config 里的 hiddenWorkspaces 黑名单。
pub fn hidden_keys(config: &serde_json::Value) -> Vec<String> {
    config
        .get("hiddenWorkspaces")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 把 key 加入黑名单（幂等）。config 缺字段时自动创建。
pub fn hide_in_config(config: &mut serde_json::Value, key: &str) {
    if !config.is_object() {
        // null or corrupted (string/array/etc.) — normalize to an empty object
        *config = serde_json::json!({});
    }
    if let Some(map) = config.as_object_mut() {
        let arr = map
            .entry("hiddenWorkspaces".to_string())
            .or_insert_with(|| serde_json::json!([]));
        if let serde_json::Value::Array(a) = arr {
            if !a.iter().any(|v| v.as_str() == Some(key)) {
                a.push(serde_json::json!(key));
            }
        }
    }
}

/// 把 key 从黑名单移除（不存在则 noop）。
pub fn unhide_in_config(config: &mut serde_json::Value, key: &str) {
    if let Some(serde_json::Value::Array(a)) = config.get_mut("hiddenWorkspaces") {
        a.retain(|v| v.as_str() != Some(key));
    }
}

/// 清掉 config 的 workspace（激活）字段。
pub fn clear_active_in_config(config: &mut serde_json::Value) {
    if let Some(obj) = config.as_object_mut() {
        obj.remove("workspace");
    }
}

#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let dir = claude_projects_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut workspaces = Vec::new();
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;
        for entry in read_dir {
            let Ok(entry) = entry else { continue; };
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let key = entry.file_name().to_string_lossy().to_string();
                let resolved = resolve_path_from_key(&key);
                let missing = resolved.is_none();
                let name = resolved.unwrap_or_else(|| key.clone());
                workspaces.push(WorkspaceInfo { key, name, missing });
            }
        }
        let hidden = hidden_keys(&super::settings::load_config());
        Ok(filter_hidden(workspaces, &hidden))
    })
    .await
    .map_err(|e| format!("list_workspaces panicked: {}", e))?
}

#[tauri::command]
pub fn set_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    path: String,
) -> Result<(), String> {
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *p = Some(PathBuf::from(path));
    }
    let _ = save_workspace_config(&key);
    Ok(())
}

#[tauri::command]
pub fn create_workspace(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    let key = path_to_key(&path);
    // 建编码目录（幂等：已存在不报错）
    let dir = claude_projects_dir().join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作区目录失败: {}", e))?;
    // 重新登记 = 自动从黑名单移除
    super::settings::with_config_mut(|config| {
        unhide_in_config(config, &key);
        Ok(())
    })?;
    // 激活（与 set_workspace 等价）
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut pp = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *pp = Some(PathBuf::from(path.clone()));
    }
    let _ = save_workspace_config(&key);
    Ok(WorkspaceInfo { key, name: path, missing: false })
}

pub fn load_workspace_config() -> Option<String> {
    let config = super::settings::load_config();
    config.get("workspace").and_then(|w| w.as_str()).map(|s| s.to_string())
}

fn save_workspace_config(path: &str) -> Result<(), String> {
    super::settings::with_config_mut(|config| {
        config["workspace"] = serde_json::Value::String(path.to_string());
        Ok(())
    })
}

#[tauri::command]
pub async fn remove_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    mode: String,
) -> Result<(), String> {
    match mode.as_str() {
        "hide" => {
            super::settings::with_config_mut(|config| {
                hide_in_config(config, &key);
                Ok(())
            })?;
        }
        "delete" => {
            let key_clone = key.clone();
            tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let dir = claude_projects_dir().join(&key_clone);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("删除目录失败: {}", e))?;
            // 已删，从黑名单移除（若曾被隐藏）
            super::settings::with_config_mut(|config| {
                unhide_in_config(config, &key);
                Ok(())
            })?;
        }
        _ => return Err(format!("invalid mode: {}", mode)),
    }
    // 若移除的是当前激活工作区，清空激活
    let is_active = workspace_state
        .key
        .lock()
        .map_err(|e| e.to_string())?
        .as_deref() == Some(&key);
    if is_active {
        {
            let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
            *k = None;
        }
        {
            let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
            *p = None;
        }
        super::settings::with_config_mut(|config| {
            clear_active_in_config(config);
            Ok(())
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn unhide_workspace(key: String) -> Result<(), String> {
    super::settings::with_config_mut(|config| {
        unhide_in_config(config, &key);
        Ok(())
    })
}

pub fn resolve_path_from_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let drive = chars.next()?;
    chars.next()?;
    chars.next()?;
    let rest: String = chars.collect();
    if rest.is_empty() {
        let path = format!("{}:\\", drive);
        return if PathBuf::from(&path).exists() { Some(path) } else { None };
    }
    try_decode(&format!("{}:\\", drive), &rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::WorkspaceInfo;

    #[test]
    fn path_to_key_windows_path() {
        assert_eq!(path_to_key(r"C:\Users\yangx\proj"), "C--Users-yangx-proj");
    }

    #[test]
    fn path_to_key_unix_path() {
        assert_eq!(path_to_key("/Users/x/proj"), "-Users-x-proj");
    }

    #[test]
    fn path_to_key_preserves_other_chars() {
        // 空格、中文、点不替换
        assert_eq!(path_to_key(r"C:\my project\文档.git"), "C--my project-文档.git");
    }

    // ── resolve_project_dirs：dot 归一匹配 ──

    #[test]
    fn resolve_project_dirs_matches_dot_normalized_variants() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_project_dirs");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 同一工作区的两种编码：Aide 保留点号 / SDK 把点编码成横杠（chennong4.0 实锤案例）
        fs::create_dir_all(root.join("C--proj-chennong4.0")).unwrap();
        fs::create_dir_all(root.join("C--proj-chennong4-0")).unwrap();
        fs::create_dir_all(root.join("C--proj-other")).unwrap();

        let mut dirs = resolve_project_dirs(&root, "C--proj-chennong4.0");
        dirs.sort();
        assert_eq!(dirs, vec![root.join("C--proj-chennong4-0"), root.join("C--proj-chennong4.0")]);

        // 反向 key（横杠版）同样命中两个目录
        assert_eq!(resolve_project_dirs(&root, "C--proj-chennong4-0").len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_dirs_missing_projects_dir_returns_empty() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_missing");
        let _ = fs::remove_dir_all(&root);
        assert!(resolve_project_dirs(&root, "whatever").is_empty());
    }

    #[test]
    fn resolve_project_dirs_ignores_files() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_files");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("C--proj-x.0"), b"not a dir").unwrap();

        assert!(resolve_project_dirs(&root, "C--proj-x.0").is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn filter_hidden_empty_passthrough() {
        let infos = vec![sample("k1"), sample("k2")];
        let hidden: Vec<String> = vec![];
        assert_eq!(filter_hidden(infos, &hidden).len(), 2);
    }

    #[test]
    fn filter_hidden_filters_matching() {
        let infos = vec![sample("k1"), sample("k2"), sample("k3")];
        let hidden = vec!["k2".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.iter().map(|w| w.key.clone()).collect::<Vec<_>>(), vec!["k1", "k3"]);
    }

    #[test]
    fn filter_hidden_multiple() {
        let infos = vec![sample("a"), sample("b"), sample("c")];
        let hidden = vec!["a".to_string(), "c".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, "b");
    }

    // ── Task 2: hiddenWorkspaces config 纯函数 ──

    #[test]
    fn hidden_keys_missing_field_returns_empty() {
        let cfg = serde_json::json!({});
        assert!(hidden_keys(&cfg).is_empty());
    }

    #[test]
    fn hidden_keys_reads_array() {
        let cfg = serde_json::json!({ "hiddenWorkspaces": ["a", "b"] });
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn hide_in_config_adds_key() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        hide_in_config(&mut cfg, "b");
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn hide_in_config_idempotent() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        hide_in_config(&mut cfg, "a");
        assert_eq!(hidden_keys(&cfg).len(), 1);
    }

    #[test]
    fn hide_in_config_creates_field_if_absent() {
        let mut cfg = serde_json::json!({});
        hide_in_config(&mut cfg, "x");
        assert_eq!(hidden_keys(&cfg), vec!["x".to_string()]);
    }

    #[test]
    fn unhide_in_config_removes_key() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a", "b"] });
        unhide_in_config(&mut cfg, "a");
        assert_eq!(hidden_keys(&cfg), vec!["b".to_string()]);
    }

    #[test]
    fn unhide_in_config_missing_key_noop() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        unhide_in_config(&mut cfg, "zzz");
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string()]);
    }

    #[test]
    fn clear_active_in_config_removes_workspace_field() {
        let mut cfg = serde_json::json!({ "workspace": "k1", "other": 1 });
        clear_active_in_config(&mut cfg);
        assert!(cfg.get("workspace").is_none());
        assert_eq!(cfg.get("other").and_then(|v| v.as_i64()), Some(1));
    }

    fn sample(key: &str) -> WorkspaceInfo {
        WorkspaceInfo { key: key.to_string(), name: key.to_string(), missing: false }
    }
}

fn try_decode(prefix: &str, remaining: &str) -> Option<String> {
    for (i, ch) in remaining.char_indices() {
        if ch == '-' {
            let component = &remaining[..i];
            let candidate = format!("{}{}", prefix, component);
            if !component.is_empty() && PathBuf::from(&candidate).exists() {
                let next_prefix = format!("{}{}\\", prefix, component);
                if let Some(result) = try_decode(&next_prefix, &remaining[i + 1..]) {
                    return Some(result);
                }
            }
        }
    }
    let final_path = format!("{}{}", prefix, remaining);
    if PathBuf::from(&final_path).exists() { Some(final_path) } else { None }
}
