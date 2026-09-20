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
/// v3：`ring.trace` 常驻操作轨迹——2026-07-08 第四次真实冻结（低 CPU 主线程
/// park 在埋点命令之外，stuckCommand 全 null 定不到帧；另有一次同类卡 21.9min）
/// 后补上，记录撞墙前最后一串命令/emit/会话事件的时间线。
pub const SCHEMA_VERSION: u32 = 4;
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
    /// 本周期长动画帧（LoAF）汇总。桌面侧产出；环境不支持 LoAF（非 Chromium /
    /// 版本过老）时为默认值。Rust 不解释这些字段，只随环落盘供事后分析。
    #[serde(default)]
    pub frames: FrameSummary,
    /// 前端现场状态读数（行数 / 消息数 / DOM 节点数 / JS 堆 / 是否在落位…）。
    /// 每拍一份 → 报告里就是「挂载量怎么涨上去的」时间线（补交那份是终值快照，
    /// 两者合读才看得出增长曲线）。形状前端所有，Rust 同样不解释、只落盘。
    #[serde(default)]
    pub gauges: serde_json::Value,
}

/// 长动画帧汇总：条数 + 本周期最长那一帧的归因分解。
///
/// 为什么要有它（2026-09-14 取证复盘）：`longTaskMaxMs` 只回答「多贵」，回答不了
/// 「贵在哪」——真机一次 19.7 秒冻结里主线程 ~100% 忙，而所有计量表都指不到东西
/// （时间花在框架/引擎/GC 里）。LoAF 把一帧拆成脚本 / 样式布局 / 其余三段，并给出
/// 每个脚本的**强制同步布局**耗时与函数名，才第一次能回答「布局还是 JS」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSummary {
    /// 本周期长帧条数
    pub count: u32,
    /// 本周期最长的那一帧（None = 无长帧）
    #[serde(default)]
    pub worst: Option<LongFrame>,
    /// 本环境是否真的装上了 LoAF。false 时 `count` 恒 0 不代表渲染健康——
    /// 是探针根本没生效（Chromium 过老）。读报告必须先看这一位。
    #[serde(default)]
    pub supported: bool,
}

/// 一帧的归因分解。三段相加 = `duration_ms`：
/// `script_ms`（脚本）+ `style_layout_ms`（样式布局）+ `rest_ms`（既非脚本也非布局
/// ——GC / 空闲 / 光栅化的嫌疑区）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongFrame {
    /// 帧起点（performance.now 时间轴，ms）。此前漏了这个字段——多条帧进报告后
    /// 无法排序、无法和 longtask 对时，等于把「哪一帧在什么时候」这条线索丢了。
    #[serde(default)]
    pub t: u64,
    pub duration_ms: u32,
    pub script_ms: u32,
    pub style_layout_ms: u32,
    pub rest_ms: u32,
    /// 强制同步布局耗时之和（读写回环的度量）
    pub forced_layout_ms: u32,
    /// 阻塞时长（含排队任务）
    pub blocking_ms: u32,
    /// 耗时靠前的脚本（已按耗时降序截断）
    #[serde(default)]
    pub scripts: Vec<LongFrameScript>,
}

/// 帧内耗时靠前的脚本——用来**点名到函数**。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongFrameScript {
    /// 调用者类型：event-listener / user-callback / script / promise-then…
    pub invoker: String,
    /// 源文件末段（产出侧已剥目录与 query）
    pub source: String,
    /// 函数名（匿名/内联时为空串）
    pub func: String,
    pub duration_ms: u32,
    pub forced_layout_ms: u32,
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

/// 常驻操作轨迹里的一条：主线程命令 enter/exit、chat-event emit、会话生命周期。
/// 飞行记录仪时间线——冻结报告保留撞墙前最后一串事件，用来定位主线程 park 在
/// 埋点命令之外（stuckCommand 为空）时「最后发生了什么」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    /// epoch ms
    pub t: u64,
    /// "beat"（主线程存活脉冲）| "cmd_enter" | "cmd_exit" | "emit" | "session"
    pub kind: &'static str,
    /// 命令名 / 事件类型 / 详情
    pub name: String,
    /// 发生线程标签："main"（同步命令跑主线程）| "worker"（sidecar reader 等）
    pub thread: &'static str,
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
    /// 渲染进程线程采样——**渲染卡死的肇事现场**（`main_thread` 那个是 aide.exe
    /// 自己的主线程，冻结期几乎总是健康）。不依赖渲染进程配合，JS 侧探针全哑时
    /// 它是唯一还说话的数据源（见 threads.rs 模块注释）。抓不到为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renderer: Option<RendererProbe>,
    /// Windows IsHungAppWindow 判定；非 Windows 为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hung_window: Option<bool>,
}

/// 渲染进程（最忙的 msedgewebview2）的线程快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererProbe {
    pub pid: u32,
    pub name: String,
    /// 按本帧 CPU 占用降序，最多 8 条
    pub threads: Vec<ThreadSample>,
}

/// 单个线程的 CPU 与（可选）顶帧。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSample {
    pub tid: u32,
    /// **累计** CPU 时间（自线程创建；首帧无基线时也是累计值）——跨帧相减即得
    /// 冻结期真实消耗量，所以两帧之间别当成增量读。
    pub user_ms: u64,
    pub kernel_ms: u64,
    /// 本帧占用速率（单核百分比，>100 = 多核）。**首帧恒 0**（没有基线），
    /// 判读要看第二帧起。
    pub cpu_pct: f32,
    /// 顶帧（模块名 + 偏移）：只给最烧的前几条抓，其余 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub park: Option<ParkFrameRecord>,
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
    /// 主线程 native 栈顶帧：跨线程 SuspendThread + GetThreadContext 抓 Rip → 解析
    /// 模块名 + 偏移。`stuckCommand` 看不到框架/未埋点路径（emit 投递、事件循环、
    /// 锁）时，这帧直接点名主线程 park 在哪——`module` 区分 webview2 运行时 DLL
    /// （ExecuteScript 卡）/ aide.exe（tao-wry-tauri 编译进宿主）/ ntdll|kernelbase
    /// （系统调用等待）。仅 Windows，非 Windows / 抓取失败为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub park: Option<ParkFrameRecord>,
}

/// 主线程 native 顶帧（冻结期跨线程抓）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkFrameRecord {
    /// 模块 basename（如 `msedgewebview2.dll`、`aide.exe`、`ntdll.dll`）；抓不到为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// 停在的指令地址（绝对）
    pub address: u64,
    /// 相对模块基址的偏移（module_base 为 0 时为 0）
    pub offset: u64,
    /// 完整调用链（顶帧在前，最多 32 帧）。仅冻结首帧 `walk_full=true` 时填充——
    /// park 期间栈静态，重复采同一栈没意义且让报告随帧数膨胀。空表示该帧只抓了顶帧。
    /// 读法：frames 自底（ntdll/kernelbase 系统调用等待）向顶（WebView2/aide 业务
    /// 代码）展示主线程被谁一路调到 park 的，区分 emit 投递 / 事件循环 / 锁 / IO。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<StackFrameRecord>,
}

/// 调用链中的一帧（冻结首帧 StackWalk64 走出的调用栈）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrameRecord {
    /// 模块 basename；抓不到为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// 指令地址（绝对）
    pub address: u64,
    /// 相对模块基址的偏移
    pub offset: u64,
}

/// 采集侧结构 → 报告 DTO：转换只此一处，两个调用方（宿主主线程顶帧 / 渲染进程
/// 线程顶帧）共用，避免各写一遍字段搬运（搬错了报告里看不出来）。
impl From<super::stackwalk::ParkFrame> for ParkFrameRecord {
    fn from(f: super::stackwalk::ParkFrame) -> Self {
        Self {
            module: f.module,
            address: f.address,
            offset: f.offset,
            frames: f
                .frames
                .into_iter()
                .map(|fr| StackFrameRecord {
                    module: fr.module,
                    address: fr.address,
                    offset: fr.offset,
                })
                .collect(),
        }
    }
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
            build: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
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
    /// 常驻操作轨迹（旧→新）：撞墙前最后一串命令/emit/会话事件。
    pub trace: Vec<TraceEvent>,
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
    prune_prefixed(dir, "freeze-", keep)
}

/// 按文件名前缀清理 `<prefix><epoch>.json`，只保留最新 `keep` 份。
/// freeze 报告与滚动诊断环共用一套保留策略，前缀独立、互不淘汰。
fn prune_prefixed(dir: &Path, prefix: &str, keep: usize) -> std::io::Result<()> {
    let mut reports: Vec<(u64, PathBuf)> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let epoch: u64 = name
                .strip_prefix(prefix)?
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

// ── 现场完整性审计（自检装置用）───────────────────────────────────────
//
// 这一整段的唯一调用方是自检装置 `selfcheck.rs`，而它自己只在 dev / 诊断包编译
// （`diagnostics.rs` 的模块门）——本段跟着同一个开关：release 默认包里留着就是
// 死代码。`test` 也在开关里，`cargo test --release` 下这些用例仍要编得到。

/// 一项判定：`id` 是机器可读的检查名，`detail` 是给人看的原因/实测值。
#[cfg(any(test, debug_assertions, feature = "devtools"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditCheck {
    pub id: &'static str,
    pub ok: bool,
    pub detail: String,
}

/// 审计结论：`ok` = 全部检查通过（这份报告足以定案）。
#[cfg(any(test, debug_assertions, feature = "devtools"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditVerdict {
    pub ok: bool,
    pub report: String,
    pub checks: Vec<AuditCheck>,
}

/// 逐项审一份冻结报告的**现场完整性**——判据全部落在「读报告的人需要什么」上，
/// 而不是实现细节；缺任一项都等于这次白留。
///
/// 为什么要有它（2026-09-17）：上一轮「LoAF 必能抓到」是**没验投递链就许的愿**
/// ——补交落在 `frontend` 字段，而该字段在 20/20 份历史报告里都是空的（收尾重写
/// 把它抹了）。把「仪器真的产出完整现场」变成可复跑的命令，就不再靠承诺。
///
/// `block_ms` = 自检注入的渲染阻塞时长（用来判断「抓到的帧确实是那一下肇事帧，
/// 而不是旁边的杂鱼」）。
#[cfg(any(test, debug_assertions, feature = "devtools"))]
pub fn audit(path: &Path, block_ms: u64) -> AuditVerdict {
    let mut checks = Vec::new();
    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) => {
            checks.push(AuditCheck {
                id: "report_readable",
                ok: false,
                detail: format!("读不出报告 {}: {e}", path.display()),
            });
            return AuditVerdict {
                ok: false,
                report: path.display().to_string(),
                checks,
            };
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            checks.push(AuditCheck {
                id: "report_parses",
                ok: false,
                detail: format!("JSON 解析失败: {e}"),
            });
            return AuditVerdict {
                ok: false,
                report: path.display().to_string(),
                checks,
            };
        }
    };

    let num = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let float = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);

    // ① 冻结本身被正确判定（注入 8s 阻塞，报告的时长应与之同量级）
    let fz = v.get("freeze").cloned().unwrap_or(serde_json::Value::Null);
    let dur = num(&fz, "durationMs");
    let recovered = fz
        .get("recovered")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    checks.push(AuditCheck {
        id: "freeze_detected",
        ok: recovered && dur >= block_ms / 2,
        detail: format!("durationMs={dur} recovered={recovered}（注入阻塞 {block_ms}ms）"),
    });

    // ② 前端补交到了（这一位是历史事故点：收尾重写会把它抹掉）
    let frontend = v.get("frontend").filter(|x| !x.is_null());
    checks.push(AuditCheck {
        id: "frontend_present",
        ok: frontend.is_some(),
        detail: match frontend {
            Some(_) => "frontend 字段在（收尾重写没抹掉补交）".to_string(),
            None => "frontend 缺失——补交没落盘或被收尾重写覆盖".to_string(),
        },
    });
    // 前端补交缺失时**不提前返回**：后面的项照查照报红。提前返回会把「渲染进程栈
    // 其实拿到了」这类好消息一起吞掉——2026-09-17 自检首跑就吃了这个亏（只报两项，
    // 而那一帧的渲染线程表恰是全场最有价值的产出）。
    //
    // ③ 长帧全量在，且每条带时间戳（无 t 就没法排序/对时）
    let frames = frontend
        .and_then(|f| f.get("longFrames"))
        .and_then(|x| x.as_array());
    let frame_n = frames.map(|a| a.len()).unwrap_or(0);
    let all_have_t = frames.is_some_and(|a| a.iter().all(|f| f.get("t").and_then(|x| x.as_u64()).is_some()));
    checks.push(AuditCheck {
        id: "long_frames_captured",
        ok: frame_n > 0 && all_have_t,
        detail: format!("longFrames={frame_n} 条，全部带 t={all_have_t}"),
    });

    // ④ 抓到的是**肇事那一下**：注入的阻塞必须在**至少一条通道**上现形。
    //
    // 为什么是「至少一条」而不是死盯长帧（2026-09-17 自检实测）：注入 8s 单块忙等，
    // LoAF 只给了 6 条 ~120ms 的帧、longtask 只给了两条 50/60ms——**单块长时间阻塞
    // 对两个 JS 侧采集器都是隐形的**（它们的时长按「帧/任务」记账，一整块卡住既不
    // 产生新帧也不产生新的任务边界）。真正抓到它的是跨进程的线程采样：渲染主线程
    // tid=1284 冻结期 96~102% 占用、累计 CPU 4203ms→9265ms。
    // 所以判据是：长帧路径 **或** 线程 CPU 路径命中，二者取或。
    let culprit = frames.and_then(|a| {
        a.iter()
            .map(|f| num(f, "durationMs"))
            .max()
            .filter(|d| *d >= block_ms / 2)
    });
    // 归因段 = 脚本段 + 样式布局段。2026-09-17 修掉 `styleAndLayoutStart` 的绝对时间戳
    // 语义后，「纯布局型肇事帧」（脚本 0、布局几千 ms）是真实形态——只认脚本段会误红。
    let culprit_attributed = frames
        .and_then(|a| {
            a.iter()
                .max_by_key(|f| num(f, "durationMs"))
                .map(|f| num(f, "scriptMs") + num(f, "styleLayoutMs"))
        })
        .unwrap_or(0);

    // 线程侧读数：把全部样本的线程表摊平成 (tid, user_ms, kernel_ms, cpu_pct) 行。
    // **必须在全部样本上取**——首帧恒 cpuPct=0（还没有基线），只看第一帧会把
    // 「差分生效」误判成「没烧 CPU」（自检第二跑就这么误红过一次）。
    let samples = v.get("samples").and_then(|x| x.as_array());
    let thread_rows: Vec<(u64, u64, u64, f64)> = samples
        .map(|a| {
            a.iter()
                .filter_map(|s| s.get("renderer").filter(|r| !r.is_null()))
                .filter_map(|r| r.get("threads"))
                .filter_map(|t| t.as_array())
                .flat_map(|ts| {
                    ts.iter().map(|t| {
                        (
                            num(t, "tid"),
                            num(t, "userMs"),
                            num(t, "kernelMs"),
                            float(t, "cpuPct"),
                        )
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let thread_max_pct = thread_rows.iter().map(|r| r.3).fold(0.0_f64, f64::max);
    // 最忙线程（累计 CPU 最大）的首尾差 = 这次冻结实际烧掉的 CPU 时间
    let thread_burn_ms = match thread_rows.iter().max_by_key(|r| r.1 + r.2) {
        None => 0,
        Some((tid, _, _, _)) => {
            let tid = *tid;
            let mut first: Option<u64> = None;
            let mut last = 0u64;
            for r in thread_rows.iter().filter(|r| r.0 == tid) {
                if first.is_none() {
                    first = Some(r.1 + r.2);
                }
                last = r.1 + r.2;
            }
            last.saturating_sub(first.unwrap_or(last))
        }
    };
    let frame_hit = culprit.is_some() && culprit_attributed > 0;
    let thread_hit = thread_burn_ms >= block_ms / 2 && thread_max_pct >= 50.0;
    checks.push(AuditCheck {
        id: "culprit_visible",
        ok: frame_hit || thread_hit,
        detail: format!(
            "长帧路：最长帧={culprit:?}ms（其中脚本+样式布局={culprit_attributed}ms）；\
             线程路：最忙线程冻结期 CPU 增量={thread_burn_ms}ms、峰值占用={thread_max_pct:.0}%\
             （期望 ≥{}ms 且两路至少一路命中）",
            block_ms / 2
        ),
    });

    // ⑤ 采集来源自述（区分「没有长帧」与「探针没生效」）
    let src = frontend
        .and_then(|f| f.get("longFramesSource"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    checks.push(AuditCheck {
        id: "capture_provenance",
        ok: !src.is_empty() && src != "none",
        detail: format!("longFramesSource=\"{src}\"（none/空 = 两条采集路径都没拿到）"),
    });

    // ⑤b 长任务明细（与长帧互补：帧可能因「主线程压根没提交帧」而缺席，长任务不必；
    // 实测 Chromium 的 longtask **不进 timeline 缓冲**，来源只可能是 observer ring）
    let tasks_n = frontend
        .and_then(|f| f.get("longTasks"))
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let tasks_src = frontend
        .and_then(|f| f.get("longTasksSource"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    checks.push(AuditCheck {
        id: "long_tasks_captured",
        ok: tasks_n > 0 && !tasks_src.is_empty() && tasks_src != "none",
        detail: format!("longTasks={tasks_n} 条 source=\"{tasks_src}\""),
    });

    // ⑥ 现场状态（挂载了多少东西——没有它，「8 秒在渲染什么」只能靠推理）
    let gauges = frontend.and_then(|f| f.get("gauges"));
    let dom_nodes = gauges.map(|g| num(g, "domNodes")).unwrap_or(0);
    let rows = gauges.map(|g| num(g, "rows")).unwrap_or(0);
    checks.push(AuditCheck {
        id: "gauges_present",
        ok: gauges.is_some() && dom_nodes > 0,
        detail: format!("gauges.domNodes={dom_nodes} gauges.rows={rows}"),
    });

    // ⑦ 渲染进程线程采样（JS 侧全哑时唯一还说话的通道）
    let probe = samples.and_then(|a| a.iter().find_map(|s| s.get("renderer").filter(|r| !r.is_null())));
    let thread_n = probe
        .and_then(|p| p.get("threads"))
        .and_then(|x| x.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    checks.push(AuditCheck {
        id: "renderer_threads",
        ok: thread_n > 0,
        detail: format!("renderer.threads={thread_n} 条（进程 pid={:?}）", probe.and_then(|p| p.get("pid"))),
    });
    let parked = probe
        .and_then(|p| p.get("threads"))
        .and_then(|x| x.as_array())
        .is_some_and(|a| {
            a.iter().any(|t| {
                t.get("park")
                    .and_then(|p| p.get("module"))
                    .and_then(|m| m.as_str())
                    .is_some_and(|m| !m.is_empty())
            })
        });
    checks.push(AuditCheck {
        id: "renderer_park_resolved",
        ok: parked,
        detail: format!("有线程顶帧解析出模块名={parked}"),
    });
    checks.push(AuditCheck {
        id: "renderer_cpu_delta",
        ok: thread_max_pct > 0.0,
        detail: format!(
            "全部样本里的线程最大 cpuPct={thread_max_pct:.1}（>0 = 跨帧基线差分生效；\
             只看首帧会恒 0——它没有基线）"
        ),
    });

    // ⑧ schema 版本（报告形状变了必须能一眼看出来）
    let schema = v
        .get("meta")
        .map(|m| num(m, "schemaVersion"))
        .unwrap_or(0);
    checks.push(AuditCheck {
        id: "schema_version",
        ok: schema == SCHEMA_VERSION as u64,
        detail: format!("meta.schemaVersion={schema}（当前 {SCHEMA_VERSION}）"),
    });

    AuditVerdict {
        ok: checks.iter().all(|c| c.ok),
        report: path.display().to_string(),
        checks,
    }
}

/// 自检结论落盘：`selfcheck-<epoch>.json`——与冻结报告同目录、同款「临时文件 +
/// rename」原子写与保留策略（自检文件独立前缀，不会被 freeze- 的保留策略挤掉）。
#[cfg(any(test, debug_assertions, feature = "devtools"))]
pub fn write_selfcheck(dir: &Path, verdict: &AuditVerdict) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let epoch = epoch_ms();
    let path = dir.join(format!("selfcheck-{epoch}.json"));
    let tmp = dir.join(format!(".selfcheck-{epoch}.json.tmp"));
    fs::write(&tmp, serde_json::to_string_pretty(verdict)?)?;
    fs::rename(&tmp, &path)?;
    prune_prefixed(dir, "selfcheck-", KEEP_REPORTS)?;
    Ok(path)
}

/// 这份报告是不是「那场冻结」的：按冻结起点比对（±`tolerance_ms`）。
///
/// 补交第二趟延迟 2.5s 发出，可能在新一场冻结已判定之后才到——30s 的挂靠窗口
/// 拦不住，于是上一场的现场被写进新报告（张冠李戴比缺失更坏：读报告的人会拿
/// 上一场的帧当这一场的证据）。读不动/缺字段一律判不匹配。
pub fn report_matches_freeze(path: &Path, started_epoch_ms: u64, tolerance_ms: u64) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(actual) = v
        .get("freeze")
        .and_then(|f| f.get("started"))
        .and_then(|x| x.as_u64())
    else {
        return false;
    };
    actual.abs_diff(started_epoch_ms) <= tolerance_ms
}

/// 把前端补交合并进已落盘的报告（读-改-写，报告文件很小）。
/// 写入走「临时文件 + rename」原子替换：用户常在冻结未恢复时强杀进程再取报告，
/// 半截 JSON 等于这次现场白留（与 write_report 同一理由）。
pub fn merge_supplement(path: &Path, supplement: serde_json::Value) -> std::io::Result<()> {
    let raw = fs::read_to_string(path)?;
    let mut report: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if let Some(obj) = report.as_object_mut() {
        obj.insert("frontend".to_string(), supplement);
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&report)?)?;
    fs::rename(&tmp, path)
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
            ring: RingSnapshot {
                heartbeats: vec![],
                event_rates: vec![],
                trace: vec![],
            },
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
        let parents: HashMap<u32, u32> = [(2, 1), (3, 2), (4, 1), (5, 99)].into_iter().collect();
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
        ProcessSample {
            pid,
            name: name.into(),
            cpu,
            mem,
        }
    }

    #[test]
    fn select_keeps_family_regardless_of_cpu() {
        // aide(1) 0% CPU 也保留（宿主没忙是关键证据）；node(2) 0% 保留
        let family: HashSet<u32> = [1, 2].into_iter().collect();
        let cands = vec![
            ps(1, "aide.exe", 0.0, 50_000_000),
            ps(2, "node.exe", 0.0, 30_000_000),
        ];
        let out = select_frame_processes(cands, &family, 10);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn select_drops_idle_other_app_webview_keeps_busy_one() {
        // 家族只有 aide(1)；webview 3088 忙(98%)、其余 28 个 0% 是别的 app 的
        let family: HashSet<u32> = [1].into_iter().collect();
        let mut cands = vec![
            ps(1, "aide.exe", 5.0, 52_000_000),
            ps(3088, "msedgewebview2.exe", 98.0, 171_000_000),
        ];
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
        assert_eq!(
            out.iter()
                .filter(|p| p.name == "msedgewebview2.exe")
                .count(),
            10
        );
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

    /// 一份「现场拿全」的报告样本：每个审计项都恰好满足，供审计器正反两向自测。
    fn full_report_json() -> serde_json::Value {
        serde_json::json!({
            "meta": { "schemaVersion": SCHEMA_VERSION },
            "freeze": { "started": 1, "ended": 2, "durationMs": 8000, "recovered": true },
            "samples": [{
                "renderer": {
                    "pid": 5,
                    "name": "msedgewebview2.exe",
                    "threads": [{
                        "tid": 7, "userMs": 7000, "kernelMs": 10, "cpuPct": 99.5,
                        "park": { "module": "msedge.dll", "address": 4096, "offset": 64 }
                    }]
                }
            }],
            "ring": {},
            "frontend": {
                "gapMs": 8076,
                "pass": 1,
                "longFrames": [{ "t": 100, "durationMs": 8000, "scriptMs": 7900 }],
                "longFramesSource": "timeline",
                "longTasks": [{ "start": 100, "duration": 8000 }],
                "longTasksSource": "ring",
                "gauges": { "domNodes": 12345, "rows": 40 }
            }
        })
    }

    /// **缺前端补交时后面的检查必须照跑**：只该让 frontend 相关的项红，渲染进程栈
    /// 那几项拿到了就得报绿。2026-09-17 自检首跑就是提前 return 只报了两项，把
    /// 「渲染线程表拿到了」这个全场最有价值的产出吞了——审计器的价值有一半在
    /// 「红的旁边告诉你哪些是绿的」。
    #[test]
    fn audit_without_frontend_still_reports_other_channels() {
        let dir = std::env::temp_dir().join(format!(
            "diag-audit-nofe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("freeze-1.json");
        let mut j = full_report_json();
        j.as_object_mut().unwrap().remove("frontend");
        std::fs::write(&path, j.to_string()).unwrap();

        let v = audit(&path, 8000);
        assert!(!v.ok, "缺前端补交必须整体不绿");
        assert!(
            v.checks.iter().any(|c| c.id == "renderer_threads" && c.ok),
            "渲染线程通道应仍被评估并报绿，实际：{:?}",
            v.checks.iter().map(|c| (c.id, c.ok)).collect::<Vec<_>>()
        );
        assert!(
            v.checks.len() >= 10,
            "不该提前返回——应给出全部检查项，实际 {} 项",
            v.checks.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 冻结身份闸：同一场的报告匹配、另一场的不匹配（±容差）。
    #[test]
    fn report_matches_freeze_by_started_with_tolerance() {
        let dir = std::env::temp_dir().join(format!(
            "diag-freezeid-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("freeze-1000000.json");
        fs::write(
            &path,
            serde_json::json!({ "freeze": { "started": 1_000_000_u64 } }).to_string(),
        )
        .unwrap();
        assert!(report_matches_freeze(&path, 1_000_000, 5_000), "同一场应匹配");
        assert!(
            report_matches_freeze(&path, 1_003_000, 5_000),
            "前端按断档反推的起点有几百 ms 偏差，5s 容差内应匹配"
        );
        assert!(
            !report_matches_freeze(&path, 1_010_000, 5_000),
            "差 10s = 另一场冻结，必须拒收（否则上一场的现场会写进新报告）"
        );
        assert!(
            !report_matches_freeze(&dir.join("missing.json"), 1_000_000, 5_000),
            "读不到/解析失败一律判不匹配"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// **单块长阻塞只在线程路现形**：实测（2026-09-17 自检）注入 8s 忙等，LoAF 只给
    /// 了 6 条 ~120ms 的帧、longtask 给了两条 50/60ms——JS 侧两个采集器对「一整块卡住」
    /// 都是隐形的。真正抓到它的是跨进程线程采样（渲染主线程 96~102%、累计 CPU
    /// 4203→9265ms）。这条用例锁住：帧全是杂鱼时，判据仍必须靠线程路成立。
    #[test]
    fn audit_culprit_via_renderer_cpu_when_no_long_frame() {
        let dir = std::env::temp_dir().join(format!(
            "diag-audit-cpu-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("freeze-1.json");
        let mut j = full_report_json();
        // 帧全是杂鱼（120ms），但线程累计 CPU 在涨
        j["frontend"]["longFrames"] = serde_json::json!([
            { "t": 100, "durationMs": 120, "scriptMs": 100, "styleLayoutMs": 0 }
        ]);
        j["samples"] = serde_json::json!([
            { "renderer": { "pid": 5, "name": "msedgewebview2.exe", "threads": [
                { "tid": 1284, "userMs": 300, "kernelMs": 0, "cpuPct": 0.0,
                  "park": { "module": "msedge.dll", "address": 1, "offset": 2 } }] } },
            { "renderer": { "pid": 5, "name": "msedgewebview2.exe", "threads": [
                { "tid": 1284, "userMs": 8300, "kernelMs": 0, "cpuPct": 99.4,
                  "park": { "module": "msedge.dll", "address": 1, "offset": 2 } }] } }
        ]);
        std::fs::write(&path, j.to_string()).unwrap();

        let v = audit(&path, 8000);
        let culprit = v.checks.iter().find(|c| c.id == "culprit_visible");
        assert!(
            culprit.is_some_and(|c| c.ok),
            "帧全是 120ms 杂鱼时，线程路（8s 增量 + 99% 占用）必须让判据成立：{:?}",
            culprit.map(|c| c.detail.clone())
        );
        assert!(v.ok, "其余项都合规，整体应全绿：{:?}", v.checks.iter().filter(|c| !c.ok).map(|c| (c.id, c.detail.clone())).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 审计器自测：合规报告必须全绿；**逐个抽掉关键格子必须各自变红**——
    /// 一个永远说 PASS 的审计器等于没有审计器，而这套自检的全部意义就在这条。
    #[test]
    fn audit_flags_each_missing_piece() {
        // 目录带纳秒后缀：同名测试若被并发注册（曾因重复 #[test] 属性发生），
        // 共享同一份临时文件会互相读到对方的写入，断言随机飘。
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("diag-audit-test-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("freeze-1.json");

        let full = full_report_json;

        std::fs::write(&path, full().to_string()).unwrap();
        let green = audit(&path, 8000);
        assert!(
            green.ok,
            "合规报告必须全绿，实际报红：{:?}",
            green.checks.iter().filter(|c| !c.ok).collect::<Vec<_>>()
        );

        // (检查名, 把关键格子打坏的闭包)
        type Broken = (&'static str, fn(&mut serde_json::Value));
        let cases: Vec<Broken> = vec![
            ("frontend_present", |j| {
                j.as_object_mut().unwrap().remove("frontend");
            }),
            ("freeze_detected", |j| {
                j["freeze"]["recovered"] = serde_json::json!(false);
            }),
            ("long_frames_captured", |j| {
                j["frontend"]["longFrames"] = serde_json::json!([]);
            }),
            ("culprit_visible", |j| {
                // 两路都打掉：长帧降成杂鱼 + 线程既没增量也没占用
                j["frontend"]["longFrames"][0]["durationMs"] = serde_json::json!(120);
                j["frontend"]["longFrames"][0]["scriptMs"] = serde_json::json!(0);
                j["frontend"]["longFrames"][0]["styleLayoutMs"] = serde_json::json!(0);
                j["samples"][0]["renderer"]["threads"][0]["userMs"] = serde_json::json!(0);
                j["samples"][0]["renderer"]["threads"][0]["cpuPct"] = serde_json::json!(0.0);
            }),
            ("capture_provenance", |j| {
                j["frontend"]["longFramesSource"] = serde_json::json!("none");
            }),
            ("gauges_present", |j| {
                j["frontend"]["gauges"]["domNodes"] = serde_json::json!(0);
            }),
            ("renderer_threads", |j| {
                j["samples"] = serde_json::json!([]);
            }),
            ("renderer_park_resolved", |j| {
                j["samples"][0]["renderer"]["threads"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("park");
            }),
            ("renderer_cpu_delta", |j| {
                j["samples"][0]["renderer"]["threads"][0]["cpuPct"] = serde_json::json!(0.0);
            }),
            ("schema_version", |j| {
                j["meta"]["schemaVersion"] = serde_json::json!(SCHEMA_VERSION - 1);
            }),
        ];
        for (id, break_it) in cases {
            let mut j = full();
            break_it(&mut j);
            std::fs::write(&path, j.to_string()).unwrap();
            let v = audit(&path, 8000);
            assert!(!v.ok, "打坏 {id} 之后审计仍说 PASS");
            assert!(
                v.checks.iter().any(|c| c.id == id && !c.ok),
                "{id} 应报红，实际：{:?}",
                v.checks.iter().map(|c| (c.id, c.ok)).collect::<Vec<_>>()
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn prune_prefixed_按前缀隔离() {
        let dir = temp_dir("prune-prefix");
        // 同目录放一份 freeze 报告：两套保留策略按前缀隔离，清 selfcheck 不波及 freeze
        write_report(&dir, &sample_report(7, 12)).unwrap();
        for i in 0..5u64 {
            fs::write(dir.join(format!("selfcheck-{}.json", 100_000 + i * 10)), "[]").unwrap();
        }
        prune_prefixed(&dir, "selfcheck-", 2).unwrap();
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        assert!(names.contains(&"selfcheck-100030.json".to_string()));
        assert!(names.contains(&"selfcheck-100040.json".to_string()));
        assert_eq!(
            names.iter().filter(|n| n.starts_with("selfcheck-")).count(),
            2
        );
        assert!(names.contains(&"freeze-7.json".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
