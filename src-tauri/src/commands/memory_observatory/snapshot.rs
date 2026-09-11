//! 快照台账：每次打开观测台写一份快照，与上一份 diff（+新增 / −消失 / ~修改）。
//! 只报告变化，不归因来源（谁写/谁删的不区分）。
//! 存 `~/.aide/observatory/snapshots/<key>.jsonl`，append-only，滚动保留 200 份。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::resolve;
use super::scan::ScanResult;

const KEEP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileSig {
    pub name: String,
    pub size: u64,
    pub mtime_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub ts: i64,
    pub files: Vec<FileSig>,
    pub index_lines: usize,
    pub index_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDiff {
    /// 上一份快照时间；首次观测为 None。
    pub previous_ts: Option<i64>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn snapshot_path_for(key: &str) -> PathBuf {
    // key 本身就是 projects 目录名（path_to_key 产物），文件系统安全
    resolve::snapshots_dir().join(format!("{key}.jsonl"))
}

fn sigs_of(scan: &ScanResult) -> Vec<FileSig> {
    let mut v: Vec<FileSig> = scan
        .topics
        .iter()
        .map(|t| FileSig {
            name: t.name.clone(),
            size: t.size,
            mtime_ms: t.modified_ms,
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

fn diff(prev: &Snapshot, cur: &[FileSig]) -> SnapshotDiff {
    let mut added = Vec::new();
    let mut modified = Vec::new();
    for f in cur {
        match prev.files.iter().find(|p| p.name == f.name) {
            None => added.push(f.name.clone()),
            Some(p) if p.size != f.size || p.mtime_ms != f.mtime_ms => {
                modified.push(f.name.clone())
            }
            _ => {}
        }
    }
    let removed: Vec<String> = prev
        .files
        .iter()
        .filter(|p| !cur.iter().any(|f| f.name == p.name))
        .map(|p| p.name.clone())
        .collect();
    SnapshotDiff {
        previous_ts: Some(prev.ts),
        added,
        removed,
        modified,
    }
}

/// 读最后一条快照 → diff → append 新快照 → 滚动截断。
/// 任何一步 IO 失败只报错不破坏台账（append 失败时旧文件原样保留）。
pub fn take_snapshot(scan: &ScanResult, path: &PathBuf) -> Result<SnapshotDiff, String> {
    let files = sigs_of(scan);
    let cur = Snapshot {
        ts: now_ms(),
        index_lines: scan.index.as_ref().map(|i| i.lines).unwrap_or(0),
        index_bytes: scan.index.as_ref().map(|i| i.bytes).unwrap_or(0),
        files,
    };

    let existing = fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();

    let result = lines
        .last()
        .and_then(|l| serde_json::from_str::<Snapshot>(l).ok())
        .map(|prev| diff(&prev, &cur.files))
        .unwrap_or(SnapshotDiff {
            previous_ts: None,
            added: vec![],
            removed: vec![],
            modified: vec![],
        });

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create snapshots dir: {e}"))?;
    }
    lines.push(serde_json::to_string(&cur).map_err(|e| e.to_string())?);
    let keep_from = lines.len().saturating_sub(KEEP);
    let mut out = lines[keep_from..].join("\n");
    out.push('\n');
    fs::write(path, out).map_err(|e| format!("write snapshot: {e}"))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::memory_observatory::scan::{Limits, ScanResult};

    fn scan_with(files: &[(&str, u64, i64)]) -> ScanResult {
        ScanResult {
            index: None,
            topics: files
                .iter()
                .map(
                    |(n, s, m)| crate::commands::memory_observatory::scan::TopicInfo {
                        name: n.to_string(),
                        path: String::new(),
                        size: *s,
                        created_ms: Some(*m),
                        modified_ms: Some(*m),
                        indexed: true,
                        within_window: true,
                        source_dir: String::new(),
                    },
                )
                .collect(),
            orphans: vec![],
            deadlinks: vec![],
            claude_md: None,
            limits: Limits {
                max_lines: 200,
                max_bytes: 25 * 1024,
            },
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aide_mo_snap_{}_{}.jsonl", std::process::id(), tag))
    }

    #[test]
    fn first_snapshot_has_no_previous() {
        let p = tmp("first");
        let _ = fs::remove_file(&p);
        let d = take_snapshot(&scan_with(&[("a.md", 1, 100)]), &p).unwrap();
        assert!(d.previous_ts.is_none());
        assert!(d.added.is_empty());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn second_snapshot_diffs() {
        let p = tmp("second");
        let _ = fs::remove_file(&p);
        take_snapshot(&scan_with(&[("a.md", 1, 100), ("b.md", 2, 200)]), &p).unwrap();
        let d = take_snapshot(&scan_with(&[("a.md", 5, 300), ("c.md", 1, 400)]), &p).unwrap();
        assert!(d.previous_ts.is_some());
        assert_eq!(d.added, vec!["c.md"]);
        assert_eq!(d.removed, vec!["b.md"]);
        assert_eq!(d.modified, vec!["a.md"]);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn prunes_to_keep_last_200() {
        let p = tmp("prune");
        let _ = fs::remove_file(&p);
        for i in 0..205 {
            take_snapshot(&scan_with(&[("a.md", i, i as i64)]), &p).unwrap();
        }
        let content = fs::read_to_string(&p).unwrap();
        assert_eq!(content.lines().count(), KEEP);
        let _ = fs::remove_file(&p);
    }
}
