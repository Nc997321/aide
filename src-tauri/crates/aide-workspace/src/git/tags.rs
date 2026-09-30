//! 标签命令：列出所有标签，区分 annotated / lightweight，带相对日期与指向提交。
//!
//! 与 [`super::runtime`] 共享 spawn helper（`pub(super)` 暴露）。按 `creatordate`
//! 降序输出，前端再按主版本号分组。

use std::path::PathBuf;
use tracing::{error, info};

use super::runtime::{git_run, git_run_blocking};


/// 一个标签项。
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    /// 标签名（短名，如 `v3.1.0`）。
    pub name: String,
    /// 相对创建日期（`creatordate:relative`，如 "2 days ago"）。
    pub date: String,
    /// 指向的提交短 hash（前 7 位）。
    pub target: String,
    /// annotated 标签 = true（`objecttype == "tag"`），lightweight = false。
    pub is_annotated: bool,
    /// annotated 标签的说明（`subject`，注讯首行）；lightweight 为空。
    pub message: String,
}

/// 列出所有标签，按创建日期降序。annotated 标签取其指向的提交（`*objectname`），
/// lightweight 标签直接取 `objectname`。空仓库或无标签返回空列表。
pub async fn git_tags(root: PathBuf) -> Result<Vec<TagEntry>, String> {
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    info!("git_tags");

    git_run_blocking(move || {
        let out = git_run(
            &[
                "for-each-ref",
                "--sort=-creatordate",
                "--format=%(refname:short)|%(creatordate:relative)|%(objecttype)|%(*objectname)|%(objectname)|%(subject)",
                "refs/tags",
            ],
            &root,
        )?;
        // for-each-ref 对无标签仓库返回成功 + 空 stdout；仅在 git 本身失败时兜底空
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            error!(%stderr, "git_tags for-each-ref failed");
            return Ok(Vec::new());
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut tags: Vec<TagEntry> = Vec::new();
        for line in stdout.lines() {
            // name|date|objecttype|*objectname|objectname|subject
            let parts: Vec<&str> = line.splitn(6, '|').collect();
            if parts.len() < 5 {
                continue;
            }
            let name = parts[0].to_string();
            let date = parts[1].to_string();
            let is_annotated = parts[2] == "tag";
            // target：annotated 取 *objectname（deref 到提交），否则取 objectname
            let raw_target = if is_annotated && !parts[3].is_empty() {
                parts[3]
            } else {
                parts[4]
            };
            let target = raw_target.get(..7).unwrap_or(raw_target).to_string();
            let message = if is_annotated {
                parts.get(5).map(|s| s.to_string()).unwrap_or_default()
            } else {
                String::new()
            };
            tags.push(TagEntry {
                name,
                date,
                target,
                is_annotated,
                message,
            });
        }
        info!(count = tags.len(), "git_tags ok");
        Ok(tags)
    })
    .await
}
