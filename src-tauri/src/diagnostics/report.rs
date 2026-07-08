//! 诊断报告：schema 定义 + 组装落盘 + 保留策略 + 前端补交合并。
//!
//! 报告是黑匣子的最终产物——一份自包含 JSON，事后交给 Claude 分析。
//! 文件名 `freeze-<epoch_ms>.json`，目录只保留最新 `KEEP_REPORTS` 份。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 报告 schema 版本：字段有不兼容变化时 +1，分析端据此区分。
/// v2：`EventRateBucket` 增补 `bytes`/`maxBytes`/`maxBytesType`/`types`——
/// 旧版只记条数，抓不到「哪条巨型 payload 把渲染烧炸」，2026-07-08 第三次
/// 真实冻结（前端渲染风暴、stuck_command 全 null）后补上。
pub const SCHEMA_VERSION: u32 = 2;
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
///
/// count 只回答「多不多」；渲染风暴的真凶往往是**单条巨型 payload**（一大坨
/// tool_result、或流式尾块涨成的超大 text_delta），所以还记 wire 字节的总和 /
/// 单条峰值 / 峰值来自哪个 type，外加类型分布——冻结那一秒的桶直接点名是
/// 「文本增量洪峰」还是「巨型 tool_result」。字节取自 sidecar stdout 原始行长度
/// （provider-agnostic，不额外序列化，微秒级）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRateBucket {
    /// epoch 秒
    pub t_sec: u64,
    pub session_id: String,
    pub count: u32,
    /// 本秒本会话所有事件的 wire 字节总和
    pub bytes: u64,
    /// 本秒本会话单条最大事件字节数（点名巨型 payload）
    pub max_bytes: u64,
    /// 贡献 `max_bytes` 的事件类型
    pub max_bytes_type: String,
    /// 本秒本会话事件类型分布（type → 条数），BTreeMap 保证落盘顺序稳定
    pub types: BTreeMap<String, u32>,
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
    /// 当前卡在哪条同步命令上（`trace_command` 埋点，未埋点的命令测不到）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stuck_command: Option<String>,
    /// 该命令已经跑了多久（ms）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stuck_for_ms: Option<u64>,
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
    /// 最后一次心跳的 epoch ms（冻结起点的最佳近似，也用作报告文件名锚点）
    pub started: u64,
    /// 报告落盘时刻的 epoch ms。
    /// 永不恢复的卡死里这是「最后一次增量 flush」的时刻，不是真正的恢复时刻。
    pub ended: u64,
    pub duration_ms: u64,
    /// 判定时的心跳缺口（ms）
    pub detected_gap_ms: u64,
    /// watchdog 自身 tick 也被长时间挂起——报告可能是系统休眠误报
    pub suspected_sleep: bool,
    /// true = 心跳已恢复、一次完整收尾的瞬时冻结；
    /// false = 报告写于冻结进行中，进程很可能被强杀，ended 只是最后一次 flush 时刻。
    pub recovered: bool,
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

fn report_filename(started_epoch: u64) -> String {
    format!("freeze-{started_epoch}.json")
}

/// 落盘一份报告并执行保留策略，返回报告路径。
///
/// 文件名按 `started` 锚定（一次冻结一个稳定文件名），冻结进行中可增量重写同一文件。
/// 写入用「临时文件 + rename」原子替换，保证进程被强杀时不会留下半截 JSON。
pub fn write_report(dir: &Path, report: &FreezeReport) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join(report_filename(report.freeze.started));
    let json = serde_json::to_string_pretty(report)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = dir.join(format!(".freeze-{}.json.tmp", report.freeze.started));
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, &path)?;
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
/// 沿 parent 链上溯判断归属（链长上限防环）。node sidecar、git 子进程都是
/// aide 主进程的后代，靠这条规则能抓到。
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

/// WebView2 运行时进程名：渲染/GPU/浏览器进程都是它。
/// 这些进程**不可靠地挂在 aide.exe 的进程树下**（经 COM/broker 拉起，父进程
/// 往往不是宿主），family_of 抓不到它们——而它们恰恰是渲染卡死的肇事者。
/// 所以对它们用名字匹配兜底，不依赖父链。
#[cfg(target_os = "windows")]
const WEBVIEW_PROC_NAMES: &[&str] = &["msedgewebview2.exe"];
#[cfg(not(target_os = "windows"))]
const WEBVIEW_PROC_NAMES: &[&str] = &[];

/// 是否 WebView 运行时进程（按名匹配，大小写不敏感）。纯函数。
pub fn is_webview_runtime(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    WEBVIEW_PROC_NAMES.iter().any(|n| lower == *n)
}

/// 一个进程是否值得采样进诊断报告。
/// - 在 aide 进程家族内（自身 + 后代：node sidecar、git 等）；**或**
/// - 是 WebView 运行时进程（按名匹配，绕过不可靠的父链）。
///
/// 纯函数，便于单测。这只是「候选」判定——每帧再由 `select_frame_processes`
/// 按活跃度裁剪，避免把别的 app 的大量空闲 WebView 进程每帧都记一遍撑爆报告。
pub fn is_diagnostic_target(pid: u32, name: &str, family: &HashSet<u32>) -> bool {
    if family.contains(&pid) {
        return true;
    }
    is_webview_runtime(name)
}

/// 每帧最多保留的非家族 WebView 进程条数（兜底，防机器上大量微活跃 WebView 进程）。
pub const MAX_WEBVIEW_PER_FRAME: usize = 10;

/// 从一批候选进程里选出本帧要落盘的，控制报告体积。
///
/// 规则（已按 CPU 降序，输出的肇事者排前）：
/// - aide 家族内（含宿主、node sidecar、git 等）：**全保留**——它们数量少、
///   且即便瞬时 0% CPU 也 informative（宿主没忙是关键证据）；
/// - 非家族的 WebView 进程（别的 app 的渲染进程也按名混入）：仅当本帧
///   `cpu > 0` 且未超 `MAX_WEBVIEW_PER_FRAME` 才保留。
///
/// 丢掉的是别的 app 那些全程 0% CPU 的空闲 WebView 进程——它们不是肇事者。
/// 渲染层 0% CPU 的死锁型卡死仍由「心跳断流 + 前端 longtask」层捕获，不靠
/// 进程 CPU 区分（29 个空闲进程里哪个是我们的无法区分）。
pub fn select_frame_processes(
    mut candidates: Vec<ProcessSample>,
    family: &HashSet<u32>,
    max_webview: usize,
) -> Vec<ProcessSample> {
    candidates.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    let mut out = Vec::with_capacity(candidates.len());
    let mut webview_kept = 0usize;
    for p in candidates {
        if family.contains(&p.pid) {
            out.push(p);
        } else if p.cpu > 0.0 && webview_kept < max_webview {
            out.push(p);
            webview_kept += 1;
        }
        // 否则：别的 app 的空闲 WebView 进程，丢弃
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report(started: u64, ended: u64) -> FreezeReport {
        FreezeReport {
            meta: ReportMeta::current(),
            freeze: FreezeInfo {
                started,
                ended,
                duration_ms: ended.saturating_sub(started),
                detected_gap_ms: 2100,
                suspected_sleep: false,
                recovered: true,
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
    fn is_diagnostic_target_catches_family_and_webview_by_name() {
        // aide(1) 的家族 = {1,2}；进程 3(msedgewebview2.exe) 不在家族里
        // （WebView2 经 broker 拉起，父进程不是宿主），但必须按名抓到。
        let parents: HashMap<u32, u32> = [(2, 1)].into_iter().collect();
        let family = family_of(1, &parents);
        assert!(is_diagnostic_target(1, "aide.exe", &family)); // 自身
        assert!(is_diagnostic_target(2, "node.exe", &family)); // 后代
        #[cfg(target_os = "windows")]
        {
            assert!(is_diagnostic_target(3, "msedgewebview2.exe", &family)); // 按名，不在家族
            assert!(is_diagnostic_target(4, "MsEdgeWebView2.exe", &family)); // 大小写不敏感
        }
        assert!(!is_diagnostic_target(5, "explorer.exe", &family)); // 无关进程
        assert!(!is_diagnostic_target(6, "msedge.exe", &family)); // Edge 浏览器，不是 WebView2
    }

    fn ps(pid: u32, name: &str, cpu: f32, mem: u64) -> ProcessSample {
        ProcessSample { pid, name: name.into(), cpu, mem }
    }

    #[test]
    fn select_keeps_family_regardless_of_cpu() {
        // aide(1) 0% CPU 也保留（宿主没忙是关键证据）；node(2) 0% 保留
        let family: HashSet<u32> = [1, 2].into_iter().collect();
        let cands = vec![ps(1, "aide.exe", 0.0, 50_000_000), ps(2, "node.exe", 0.0, 30_000_000)];
        let out = select_frame_processes(cands, &family, 10);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn select_drops_idle_other_app_webview_keeps_busy_one() {
        // 家族只有 aide(1)；webview 3088 忙(98%)、其余 28 个 0% 是别的 app 的
        let family: HashSet<u32> = [1].into_iter().collect();
        let mut cands = vec![ps(1, "aide.exe", 5.0, 52_000_000), ps(3088, "msedgewebview2.exe", 98.0, 171_000_000)];
        for pid in [100u32, 101, 102, 103, 104, 105] {
            cands.push(ps(pid, "msedgewebview2.exe", 0.0, 10_000_000));
        }
        let out = select_frame_processes(cands, &family, 10);
        let pids: Vec<u32> = out.iter().map(|p| p.pid).collect();
        // 忙的渲染进程留下、aide 留下；6 个 0% 的别的 app 进程全丢
        assert!(pids.contains(&3088));
        assert!(pids.contains(&1));
        assert!(!pids.contains(&100));
        assert_eq!(out.len(), 2);
        // 按_cpu 降序：98 在前
        assert_eq!(out[0].pid, 3088);
    }

    #[test]
    fn select_caps_active_webview_at_max() {
        // 15 个 WebView 进程都微活跃(2%)，cap=10 时只留前 10 + aide
        let family: HashSet<u32> = [1].into_iter().collect();
        let mut cands = vec![ps(1, "aide.exe", 3.0, 50_000_000)];
        for pid in 200u32..215 {
            cands.push(ps(pid, "msedgewebview2.exe", 2.0, 40_000_000));
        }
        let out = select_frame_processes(cands, &family, 10);
        // aide(1) + 10 个 webview = 11
        assert_eq!(out.len(), 11);
        assert!(out.iter().any(|p| p.pid == 1));
        assert_eq!(out.iter().filter(|p| p.name == "msedgewebview2.exe").count(), 10);
    }

    #[test]
    fn write_and_prune_keeps_newest() {
        let dir = temp_dir("prune");
        // 每份报告 started 递增；文件名按 started 锚定
        for i in 0..5u64 {
            let started = 100_000 + i * 10;
            write_report(&dir, &sample_report(started, started + 5000)).unwrap();
        }
        prune_reports(&dir, 2).unwrap();
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        assert_eq!(names, vec!["freeze-100030.json", "freeze-100040.json"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_supplement_adds_frontend_field() {
        let dir = temp_dir("merge");
        let path = write_report(&dir, &sample_report(420_000, 425_000)).unwrap();
        merge_supplement(&path, serde_json::json!({ "gapMs": 3000 })).unwrap();
        let merged: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(merged["frontend"]["gapMs"], 3000);
        // 原有字段不受影响
        assert_eq!(merged["freeze"]["durationMs"], 5000);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_report_is_atomic_no_tmp_leftover() {
        let dir = temp_dir("atomic");
        let path = write_report(&dir, &sample_report(7, 12)).unwrap();
        assert_eq!(path.file_name().unwrap().to_string_lossy(), "freeze-7.json");
        // 不残留临时文件
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".freeze-"))
            .collect();
        assert!(leftovers.is_empty());
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
