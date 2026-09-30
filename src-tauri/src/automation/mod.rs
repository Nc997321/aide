//! 自动化任务（Automation）：定时/间隔/单次触发无人值守 SDK 会话。
//!
//! 竖切包结构（codegraph/lsp 范式）：
//! - `mod.rs`（本文件）：类型定义 + ~/.aide/automations/ 的 JSON 存储（recent.rs 范式）
//! - `schedule.rs`：next-fire / missed-run 判定的纯函数（墙钟语义，可单测）
//! - `scheduler.rs`：`AutomationService`——常驻 tick、发 run、终态处理、蒸馏触发
//! - `commands.rs`：Tauri 命令面（全 async）
//!
//! 数据布局（运行时产物，不进库）：
//! ```text
//! ~/.aide/automations/<task-id>/
//!   task.json     任务定义（唯一权威）
//!   runs.jsonl    每次运行追加一行
//!   playbook.md   执行手册（M4 蒸馏产物，用户可手改）
//!   scripts/      手册引用的确定性脚本
//! ```

pub mod commands;
pub mod schedule;
#[cfg(test)]
mod schedule_test;
pub mod scheduler;

pub use scheduler::AutomationService;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// ── 类型 ──

/// 权限预设。v1 定案只两档（用户拍板：只读/工作区写入的概念边界连开发者都
/// 说不清，不给用户出这道概念题）：
/// - `auto`（默认）：全量内建工具可见，CLI auto 模式裁决——安全操作自动放行，
///   高危操作由 canUseTool 兜底 deny（无人值守）。连接器始终显式预授权。
/// - `full`：bypassPermissions + hook 全 allow，不做任何拦截（UI danger 色）。
/// 旧档位的存量数据经 serde alias 归并到 auto（功能未发布，兼容是顺手人情）。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionPreset {
    #[serde(rename = "auto", alias = "readonly", alias = "workspace-write")]
    Auto,
    #[serde(rename = "full")]
    Full,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MissedPolicy {
    /// 下次启动客户端时补跑一次
    Catchup,
    /// 直接跳过，等下一个周期
    Skip,
    /// 推应用内通知中心，等用户决定
    Ask,
}

/// 执行手册蒸馏状态（服务端管理，前端只读）。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaybookState {
    /// 从未蒸馏——下次运行按 explore 模式跑，成功后蒸馏
    #[serde(rename = "none")]
    NotYet,
    /// 手册就绪——后续运行注入 playbook.md
    Ready,
    /// 用户点了「重新提炼」——下次运行重新走 explore + 蒸馏
    Stale,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IntervalUnit {
    Minutes,
    Hours,
    Days,
}

/// 调度定义。serde tag=kind：`{"kind":"daily","time":"18:30"}`。
/// time 一律 "HH:MM" 本地墙钟；once 的 at 是本地 ISO（分或秒可选）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    #[serde(rename = "daily")]
    Daily { time: String },
    #[serde(rename = "weekly")]
    Weekly { time: String, weekdays: Vec<u8> }, // 1=周一 .. 7=周日（ISO）
    #[serde(rename = "monthly")]
    Monthly { time: String, day: u8 }, // 1..=31，超过当月天数钳到月末
    #[serde(rename = "interval")]
    Interval { every: u32, unit: IntervalUnit },
    #[serde(rename = "once")]
    Once { at: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTask {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub workspace_path: Option<String>,
    /// 任务会话目录（下发给子进程的 `CLAUDE_CONFIG_DIR`）：转录落在
    /// `<本目录>/projects/<cwd 编码>/`。None = 回落默认，见 [`session_dir`]。
    ///
    /// 为什么要能指定：默认配置根是 `~/.aide/claude/`，转录会落进
    /// `~/.aide/claude/projects/`——而该目录被 `list_workspaces()` 全量扫描当作
    /// 用户工作区，automation 的目录混进去就是侧栏污染（2026-09-07 bug）。
    /// 想让任务产物落在别处（或干脆复用某个已有配置根），显式指定本字段。
    #[serde(default)]
    pub session_dir: Option<String>,
    /// 显式按任务指定，不继承主会话（btw 踩过的坑）
    pub model: String,
    pub effort: String, // low|medium|high|xhigh|max
    pub permission_preset: PermissionPreset,
    /// 预授权 MCP server key 白名单（如 "aide-codegraph"）
    pub connectors: Vec<String>,
    pub schedule: Schedule,
    /// 生效区间（"YYYY-MM-DD"），None = 不限
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub missed_policy: MissedPolicy,
    pub playbook_enabled: bool,
    pub playbook_state: PlaybookState,
    pub notify_success: bool,
    pub notify_failure: bool,
    pub enabled: bool,
    /// 本地 ISO 字符串；也是 interval 调度的固定网格锚点（不随 lastRunAt 漂移）
    pub created_at: String,
    // ── 列表冗余缓存，权威在 runs.jsonl ──
    pub last_run_at: Option<String>,
    pub last_run_status: Option<RunStatus>,
}

/// create/update 的入参：id/createdAt/lastRun*/playbookState 由服务端管理。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTaskInput {
    pub name: String,
    pub prompt: String,
    pub workspace_path: Option<String>,
    /// 见 [`AutomationTask::session_dir`]；None = 回落默认。
    #[serde(default)]
    pub session_dir: Option<String>,
    pub model: String,
    pub effort: String,
    pub permission_preset: PermissionPreset,
    pub connectors: Vec<String>,
    pub schedule: Schedule,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub missed_policy: MissedPolicy,
    pub playbook_enabled: bool,
    pub notify_success: bool,
    pub notify_failure: bool,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunTrigger {
    Schedule,
    Manual,
    Catchup,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunMode {
    /// 无手册自由探索（首跑/重新提炼）
    Explore,
    /// 注入 playbook.md 按手册执行
    Playbook,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    /// 并发冲突 / missed-policy=skip / 手动停掉
    Skipped,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// runs.jsonl 的一行。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    pub session_id: String,
    pub trigger: RunTrigger,
    pub mode: RunMode,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: RunStatus,
    /// end_turn|max_turns|max_budget|error|interrupted（SDK 原始 stop_reason）
    pub stop_reason: Option<String>,
    pub usage: Option<RunUsage>,
    /// 本轮 API 调用数（message_stop 的 usage.apiCallCount）——手册/探索模式的
    /// 轮数对比（「手册 4 轮 vs 探索 16 轮」）靠它展示。
    #[serde(default)]
    pub rounds: Option<u64>,
    pub cost_usd: Option<f64>,
    /// 本次运行的结论摘要（转录尾行文本，≤80 字）——报告类任务在列表里一眼可读。
    /// serde default 兼容旧 runs.jsonl（无此字段的行按 None 读）。
    #[serde(default)]
    pub summary: Option<String>,
    /// 本次运行附带的蒸馏轮成本（首跑/重提炼才有）
    pub distill_cost_usd: Option<f64>,
    pub error: Option<String>,
    /// skipped 的原因说明（"overlap" / "missed-skip" …）
    pub note: Option<String>,
}

/// 运行历史顶部统计条（近 30 天）。
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStats {
    pub runs: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub success_rate: f64,
    pub total_cost_usd: f64,
    pub avg_duration_ms: Option<u64>,
    /// cache_read / (input + cache_read + cache_creation)，无用量数据为 None
    pub cache_read_ratio: Option<f64>,
}

// ── 纯函数 ──

/// 聚合 since（含）之后的运行记录为统计条数据。纯函数，单测覆盖。
pub fn aggregate_runs(runs: &[RunRecord], since: chrono::NaiveDateTime) -> RunStats {
    let mut st = RunStats::default();
    let mut total_dur_ms: u64 = 0;
    let mut dur_count: u64 = 0;
    let mut tok_total: u64 = 0;
    let mut tok_cache_read: u64 = 0;
    for r in runs {
        // 运行中/跳过的记录不进统计（没有成本与耗时语义）
        if r.status != RunStatus::Succeeded && r.status != RunStatus::Failed {
            continue;
        }
        let Ok(started) = schedule::parse_dt(&r.started_at) else {
            continue;
        };
        if started < since {
            continue;
        }
        st.runs += 1;
        match r.status {
            RunStatus::Succeeded => st.succeeded += 1,
            RunStatus::Failed => st.failed += 1,
            _ => {}
        }
        // 蒸馏成本也算进任务总账——它是这次运行真实烧掉的钱
        st.total_cost_usd += r.cost_usd.unwrap_or(0.0) + r.distill_cost_usd.unwrap_or(0.0);
        if let Some(finished) = r.finished_at.as_deref() {
            if let Ok(f) = schedule::parse_dt(finished) {
                let ms = (f - started).num_milliseconds();
                if ms >= 0 {
                    total_dur_ms += ms as u64;
                    dur_count += 1;
                }
            }
        }
        if let Some(u) = &r.usage {
            tok_total += u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens;
            tok_cache_read += u.cache_read_tokens;
        }
    }
    if st.runs > 0 {
        st.success_rate = st.succeeded as f64 / st.runs as f64;
    }
    if dur_count > 0 {
        st.avg_duration_ms = Some(total_dur_ms / dur_count);
    }
    if tok_total > 0 {
        st.cache_read_ratio = Some(tok_cache_read as f64 / tok_total as f64);
    }
    st
}

// ── 存储 ──

pub fn automations_dir() -> PathBuf {
    crate::commands::our_config_dir().join("automations")
}

pub fn task_dir(id: &str) -> PathBuf {
    automations_dir().join(id)
}

/// 任务的会话目录（转录 / 子进程配置根）。
///
/// 解析优先级：**任务显式指定 `session_dir`** > 默认（作用域隔离目录）。
///
/// 本模块**不自己拼路径**——「隔离目录怎么落」是基础设施职责，下沉在
/// [`crate::commands::scoped_claude_home`]，automation 只是它的上层调用方。
/// 调用方想指定目录就设 [`AutomationTask::session_dir`]。
pub fn session_dir(task: &AutomationTask) -> PathBuf {
    match task.session_dir.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => crate::commands::scoped_claude_home("automation", &task.id),
    }
}

pub fn task_json_path(id: &str) -> PathBuf {
    task_dir(id).join("task.json")
}

pub fn runs_jsonl_path(id: &str) -> PathBuf {
    task_dir(id).join("runs.jsonl")
}

/// M4 蒸馏写手册用（M2 接通执行链后点亮）。
#[allow(dead_code)]
pub fn playbook_path(id: &str) -> PathBuf {
    task_dir(id).join("playbook.md")
}

/// 原子写 task.json：先写 .tmp 再 rename（recent.rs 范式）。
pub fn save_task(task: &AutomationTask) -> Result<(), String> {
    let dir = task_dir(&task.id);
    fs::create_dir_all(&dir).map_err(|e| format!("create automation dir: {e}"))?;
    let p = task_json_path(&task.id);
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(task).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// 从磁盘读单个任务；损坏返回 Err（列表场景用 load_all_tasks 跳过坏文件）。
pub fn load_task(id: &str) -> Result<AutomationTask, String> {
    let p = task_json_path(id);
    let content = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", p.display()))
}

/// 扫描全部任务；损坏的 task.json 跳过并记日志（不拖死整个列表）。
pub fn load_all_tasks() -> Vec<AutomationTask> {
    let dir = automations_dir();
    let mut out = Vec::new();
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if !id.starts_with("aut_") {
            continue;
        }
        match load_task(&id) {
            Ok(t) => out.push(t),
            Err(e) => tracing::warn!("[automation] 跳过损坏的任务 {}: {}", id, e),
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    out
}

pub fn delete_task_dir(id: &str) -> Result<(), String> {
    let dir = task_dir(id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// 追加一行 runs.jsonl（M2 执行链接通后点亮）。
#[allow(dead_code)]
pub fn append_run(id: &str, run: &RunRecord) -> Result<(), String> {
    use std::io::Write;
    let dir = task_dir(id);
    fs::create_dir_all(&dir).map_err(|e| format!("create automation dir: {e}"))?;
    let p = runs_jsonl_path(id);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("open {}: {e}", p.display()))?;
    let line = serde_json::to_string(run).map_err(|e| e.to_string())?;
    writeln!(f, "{}", line).map_err(|e| format!("append run: {e}"))?;
    Ok(())
}

/// 覆盖更新 runs.jsonl 中同 runId 的行（运行结束回写终态用，M2 点亮）。
/// v1 全量读改写——单任务运行频率低（每天几次），文件体积可控，不做 seek 优化。
#[allow(dead_code)]
pub fn update_run(id: &str, run: &RunRecord) -> Result<(), String> {
    let p = runs_jsonl_path(id);
    let mut runs = read_all_runs(&p)?;
    if let Some(slot) = runs.iter_mut().find(|r| r.run_id == run.run_id) {
        *slot = run.clone();
    } else {
        runs.push(run.clone());
    }
    let mut body = String::new();
    for r in &runs {
        body.push_str(&serde_json::to_string(r).map_err(|e| e.to_string())?);
        body.push('\n');
    }
    let tmp = p.with_extension("jsonl.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

fn read_all_runs(p: &std::path::Path) -> Result<Vec<RunRecord>, String> {
    if !p.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let mut out = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<RunRecord>(line) {
            Ok(r) => out.push(r),
            Err(e) => tracing::warn!(
                "[automation] {} 第 {} 行损坏已跳过: {}",
                p.display(),
                i + 1,
                e
            ),
        }
    }
    Ok(out)
}

/// 读最近 limit 条运行记录，新的在前（历史视图倒序渲染）。
pub fn list_runs(id: &str, limit: usize) -> Result<Vec<RunRecord>, String> {
    let p = runs_jsonl_path(id);
    let mut runs = read_all_runs(&p)?;
    runs.reverse();
    runs.truncate(limit);
    Ok(runs)
}

/// 任务 id / 运行 id：`aut_<base36毫秒><4位十六进制随机>`。
/// 不引 uuid crate——本地应用时间戳+随机后缀足够唯一。
pub fn new_id(prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    let ms = crate::commands::recent::now_ms();
    let rand16 = BuildHasher::build_hasher(&std::collections::hash_map::RandomState::new())
        .finish()
        & 0xFFFF;
    format!("{}_{}{:04x}", prefix, to_base36(ms), rand16)
}

fn to_base36(mut v: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if v == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::new();
    while v > 0 {
        buf.push(DIGITS[(v % 36) as usize]);
        v /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_default()
}

// ── 测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        id: &str,
        status: RunStatus,
        started: &str,
        finished: Option<&str>,
        cost: Option<f64>,
    ) -> RunRecord {
        RunRecord {
            run_id: id.into(),
            session_id: format!("sess_{id}"),
            trigger: RunTrigger::Schedule,
            mode: RunMode::Playbook,
            started_at: started.into(),
            finished_at: finished.map(|s| s.to_string()),
            status,
            stop_reason: None,
            usage: None,
            rounds: None,
            cost_usd: cost,
            summary: None,
            distill_cost_usd: None,
            error: None,
            note: None,
        }
    }

    #[test]
    fn aggregate_counts_success_rate_and_cost() {
        let runs = vec![
            run(
                "a",
                RunStatus::Succeeded,
                "2026-08-20T18:30:00",
                Some("2026-08-20T18:32:00"),
                Some(0.04),
            ),
            run(
                "b",
                RunStatus::Failed,
                "2026-08-19T18:30:00",
                Some("2026-08-19T18:30:12"),
                Some(0.002),
            ),
            run("c", RunStatus::Skipped, "2026-08-18T18:30:00", None, None),
        ];
        let since = schedule::parse_dt("2026-07-22T00:00:00").unwrap();
        let st = aggregate_runs(&runs, since);
        assert_eq!(st.runs, 2); // skipped 不进统计
        assert_eq!(st.succeeded, 1);
        assert_eq!(st.failed, 1);
        assert!((st.success_rate - 0.5).abs() < 1e-9);
        assert!((st.total_cost_usd - 0.042).abs() < 1e-9);
        // (120s + 12s) / 2 = 66s
        assert_eq!(st.avg_duration_ms, Some(66_000));
        assert_eq!(st.cache_read_ratio, None); // 无用量数据
    }

    #[test]
    fn aggregate_filters_by_since_window() {
        let runs = vec![
            run(
                "old",
                RunStatus::Succeeded,
                "2026-07-01T10:00:00",
                Some("2026-07-01T10:01:00"),
                Some(1.0),
            ),
            run(
                "new",
                RunStatus::Succeeded,
                "2026-08-20T10:00:00",
                Some("2026-08-20T10:01:00"),
                Some(0.05),
            ),
        ];
        let since = schedule::parse_dt("2026-07-22T00:00:00").unwrap();
        let st = aggregate_runs(&runs, since);
        assert_eq!(st.runs, 1);
        assert!((st.total_cost_usd - 0.05).abs() < 1e-9);
    }

    #[test]
    fn aggregate_cache_ratio_and_distill_cost() {
        let mut r = run(
            "a",
            RunStatus::Succeeded,
            "2026-08-20T10:00:00",
            Some("2026-08-20T10:01:00"),
            Some(0.03),
        );
        r.distill_cost_usd = Some(0.01);
        r.usage = Some(RunUsage {
            input_tokens: 2_000,
            output_tokens: 500,
            cache_read_tokens: 28_000,
            cache_creation_tokens: 0,
        });
        let since = schedule::parse_dt("2026-07-22T00:00:00").unwrap();
        let st = aggregate_runs(&[r], since);
        // 蒸馏成本并入总账
        assert!((st.total_cost_usd - 0.04).abs() < 1e-9);
        // 28000 / (2000 + 28000 + 0) = 0.9333
        let ratio = st.cache_read_ratio.unwrap();
        assert!((ratio - 28.0 / 30.0).abs() < 1e-9);
    }

    #[test]
    fn new_id_has_prefix_and_uniqueness() {
        let a = new_id("aut");
        let b = new_id("aut");
        assert!(a.starts_with("aut_"));
        assert_ne!(a, b);
    }
}
