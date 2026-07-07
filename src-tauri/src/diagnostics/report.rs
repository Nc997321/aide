//! 诊断报告：schema 定义 + 组装落盘 + 保留策略 + 前端补交合并。
//!
//! 报告是黑匣子的最终产物——一份自包含 JSON，事后交给 Claude 分析。
//! 文件名 `freeze-<epoch_ms>.json`，目录只保留最新 `KEEP_REPORTS` 份。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 报告 schema 版本：字段有不兼容变化时 +1，分析端据此区分。
pub const SCHEMA_VERSION: u32 = 1;
/// 目录里最多保留的报告份数（按文件名里的 epoch 排序，淘汰最旧）。
pub const KEEP_REPORTS: usize = 20;

// ── schema ──────────────────────────────────────────────────────────

/// 前端每 500ms 心跳携带的指标包（serde 直接反序列化 invoke payload）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    /// 本周期 event loop 最大延迟（ms）
    pub lag_max_ms: u32,
    /// 本周期 longtask 条数
    pub long_task_count: u32,
    /// 本周期最长 longtask（ms）
    pub long_task_max_ms: u32,
    /// 本周期新增用户操作面包屑
    #[serde(default)]
    pub crumbs: Vec<Crumb>,
    /// document.hidden——true 时浏览器节流定时器，watchdog 暂停判定
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    /// epoch ms
    pub t: u64,
    pub kind: String,
    pub detail: String,
}

/// 环形缓冲里的一条心跳记录（payload + Rust 侧接收时刻）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatEntry {
    /// Rust 收到心跳的 epoch ms
    pub t: u64,
    #[serde(flatten)]
    pub payload: HeartbeatPayload,
}

/// 每秒每会话的 chat-event 计数桶。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRateBucket {
    /// epoch 秒
    pub t_sec: u64,
    pub session_id: String,
    pub count: u32,
}

/// 冻结期间 watchdog 主动采的一帧。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreezeSample {
    /// epoch ms
    pub t: u64,
    /// aide 主进程 + 全部后代进程（WebView2 渲染进程、node sidecar…）
    pub processes: Vec<ProcessSample>,
    pub main_thread: MainThreadProbe,
    /// Windows IsHungAppWindow 判定；非 Windows 为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hung_window: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    pub name: String,
    /// 单核百分比（多核机器上可 >100）
    pub cpu: f32,
    /// 字节
    pub mem: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainThreadProbe {
    /// 已投递未返回的 no-op 探针数——持续增长 = Tauri 主线程卡死
    pub pending: u32,
    /// 最近一次探针往返延迟（ms）
    pub last_latency_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreezeReport {
    pub meta: ReportMeta,
    pub freeze: FreezeInfo,
    pub samples: Vec<FreezeSample>,
    pub ring: RingSnapshot,
    /// 前端恢复后补交（longtask 明细 + 面包屑快照）；
    /// None = 尚未补交（前端可能没恢复过来）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontend: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMeta {
    pub schema_version: u32,
    pub app_version: String,
    pub build: &'static str,
    pub os: &'static str,
}

impl ReportMeta {
    pub fn current() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            build: if cfg!(debug_assertions) { "debug" } else { "release" },
            os: std::env::consts::OS,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreezeInfo {
    /// 最后一次心跳的 epoch ms（冻结起点的最佳近似）
    pub started: u64,
    /// 心跳恢复的 epoch ms
    pub ended: u64,
    pub duration_ms: u64,
    /// 判定时的心跳缺口（ms）
    pub detected_gap_ms: u64,
    /// watchdog 自身 tick 也被长时间挂起——报告可能是系统休眠误报
    pub suspected_sleep: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RingSnapshot {
    pub heartbeats: Vec<HeartbeatEntry>,
    pub event_rates: Vec<EventRateBucket>,
}

// ── 落盘 / 保留 / 合并 ───────────────────────────────────────────────

pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn report_filename(epoch_ms: u64) -> String {
    format!("freeze-{epoch_ms}.json")
}

/// 落盘一份报告并执行保留策略，返回报告路径。
pub fn write_report(dir: &Path, report: &FreezeReport) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join(report_filename(report.freeze.ended));
    let json = serde_json::to_string_pretty(report)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(&path, json)?;
    prune_reports(dir, KEEP_REPORTS)?;
    Ok(path)
}

/// 只保留最新 `keep` 份 `freeze-*.json`（按文件名 epoch 排序）。
pub fn prune_reports(dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut reports: Vec<(u64, PathBuf)> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let epoch: u64 = name
                .strip_prefix("freeze-")?
                .strip_suffix(".json")?
                .parse()
                .ok()?;
            Some((epoch, e.path()))
        })
        .collect();
    if reports.len() <= keep {
        return Ok(());
    }
    reports.sort_by_key(|(epoch, _)| *epoch);
    let excess = reports.len() - keep;
    for (_, path) in reports.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

/// 把前端补交合并进已落盘的报告（读-改-写，报告文件很小）。
pub fn merge_supplement(path: &Path, supplement: serde_json::Value) -> std::io::Result<()> {
    let raw = fs::read_to_string(path)?;
    let mut report: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if let Some(obj) = report.as_object_mut() {
        obj.insert("frontend".to_string(), supplement);
    }
    fs::write(path, serde_json::to_string_pretty(&report)?)
}

// ── 进程过滤（纯函数，watchdog 采样用） ─────────────────────────────

/// 从 pid→parent 表中筛出 `root` 自身 + 全部后代。
///
/// 沿 parent 链上溯判断归属（链长上限防环）。WebView2 渲染进程、
/// node sidecar、git 子进程都是 aide 主进程的后代。
pub fn family_of(root: u32, parents: &HashMap<u32, u32>) -> HashSet<u32> {
    let mut family = HashSet::new();
    family.insert(root);
    for &pid in parents.keys() {
        let mut cur = pid;
        for _ in 0..64 {
            if family.contains(&cur) || cur == root {
                family.insert(pid);
                break;
            }
            match parents.get(&cur) {
                Some(&p) if p != cur => cur = p,
                _ => break,
            }
        }
    }
    family
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report(ended: u64) -> FreezeReport {
        FreezeReport {
            meta: ReportMeta::current(),
            freeze: FreezeInfo {
                started: ended.saturating_sub(5000),
                ended,
                duration_ms: 5000,
                detected_gap_ms: 2100,
                suspected_sleep: false,
            },
            samples: vec![],
            ring: RingSnapshot { heartbeats: vec![], event_rates: vec![] },
            frontend: None,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aide-diag-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn family_of_includes_descendants_only() {
        // 1 → 2 → 3，1 → 4；99 独立；5 → 99（无关分支）
        let parents: HashMap<u32, u32> =
            [(2, 1), (3, 2), (4, 1), (5, 99)].into_iter().collect();
        let family = family_of(1, &parents);
        assert_eq!(family, [1, 2, 3, 4].into_iter().collect());
    }

    #[test]
    fn family_of_survives_parent_cycle() {
        // 病态数据：2 ⇄ 3 成环，不能死循环
        let parents: HashMap<u32, u32> = [(2, 3), (3, 2)].into_iter().collect();
        let family = family_of(1, &parents);
        assert_eq!(family, [1].into_iter().collect());
    }

    #[test]
    fn write_and_prune_keeps_newest() {
        let dir = temp_dir("prune");
        for i in 0..5u64 {
            write_report(&dir, &sample_report(1000 + i)).unwrap();
        }
        prune_reports(&dir, 2).unwrap();
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["freeze-1003.json", "freeze-1004.json"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_supplement_adds_frontend_field() {
        let dir = temp_dir("merge");
        let path = write_report(&dir, &sample_report(42)).unwrap();
        merge_supplement(&path, serde_json::json!({ "gapMs": 3000 })).unwrap();
        let merged: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(merged["frontend"]["gapMs"], 3000);
        // 原有字段不受影响
        assert_eq!(merged["freeze"]["durationMs"], 5000);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn heartbeat_payload_accepts_camel_case_json() {
        let payload: HeartbeatPayload = serde_json::from_str(
            r#"{ "lagMaxMs": 12, "longTaskCount": 1, "longTaskMaxMs": 80,
                 "crumbs": [{ "t": 1, "kind": "click", "detail": "发送" }],
                 "hidden": false }"#,
        )
        .unwrap();
        assert_eq!(payload.lag_max_ms, 12);
        assert_eq!(payload.crumbs.len(), 1);
    }
}
