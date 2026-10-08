// stash 域：push / pop / list / apply / drop（错误码人话化 STASH_*）。
use super::runtime::git_run_async;

use std::path::PathBuf;
pub async fn git_stash(
    root: PathBuf,
    message: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if let Some(m) = message {
        let m = m.trim().to_string();
        if !m.is_empty() {
            args.push("-m".to_string());
            args.push(m);
        }
    }
    let output = git_run_async(args, root)
        .await
        .map_err(|e| format!("STASH_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

pub async fn git_stash_pop(
    root: PathBuf,
    index: Option<u32>,
) -> Result<(), String> {
    let mut args = vec!["stash".to_string(), "pop".to_string()];
    if let Some(i) = index {
        args.push(format!("stash@{{{}}}", i));
    }
    let output = git_run_async(args, root)
        .await
        .map_err(|e| format!("STASH_POP_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_POP_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct StashEntry {
    pub index: u32,
    pub name: String,
    pub message: String,
    pub date: String,
}

pub async fn git_stash_list(
    root: PathBuf,
) -> Result<Vec<StashEntry>, String> {
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    let output = git_run_async(
        vec!["stash".into(), "list".into(), "--format=%gd|%gs|%cr".into()],
        root,
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].to_string();
        // stash@{N} → N；解析不出的行跳过（防御性格式变化）
        let index = name
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse::<u32>();
        let Ok(index) = index else {
            continue;
        };
        entries.push(StashEntry {
            index,
            name,
            message: parts[1].to_string(),
            date: parts[2].to_string(),
        });
    }
    Ok(entries)
}

pub async fn git_stash_apply(
    root: PathBuf,
    index: u32,
) -> Result<(), String> {
    let output = git_run_async(
        vec![
            "stash".into(),
            "apply".into(),
            format!("stash@{{{}}}", index),
        ],
        root,
    )
    .await
    .map_err(|e| format!("STASH_APPLY_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_APPLY_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

pub async fn git_stash_drop(
    root: PathBuf,
    index: u32,
) -> Result<(), String> {
    let output = git_run_async(
        vec![
            "stash".into(),
            "drop".into(),
            format!("stash@{{{}}}", index),
        ],
        root,
    )
    .await
    .map_err(|e| format!("STASH_DROP_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_DROP_FAILED: {}", stderr.trim()));
    }
    Ok(())
}
