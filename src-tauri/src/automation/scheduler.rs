//! AutomationService：常驻调度器 + headless 执行引擎。
//!
//! 执行模型：到点 → 组装 send 命令（prompt 注入手册、权限白名单、护栏）→
//! 共享 runtime 起一次性会话（sidecar 终态自毁）→ runtime stdout 泵挂钩
//! `observe_chat_event` 观测终态（message_stop/error/session_dead）→ 回写
//! runs.jsonl + task.json 缓存 + 通知。
//!
//! 网格点语义：scheduled/catchup 运行**开始时**就把 last_run_at 推进到该网格点
//! （消费掉它）——重启不重跑、tick 不重复触发。manual 运行不碰网格。

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{Local, NaiveDateTime};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::schedule;
use super::{
    AutomationTask, AutomationTaskInput, MissedPolicy, PermissionPreset, PlaybookState, RunMode,
    RunRecord, RunStats, RunStatus, RunTrigger, RunUsage,
};

/// 调度 tick 周期。30s 的粒度对「分钟级间隔任务」意味着最坏 30s 迟到，可接受；
/// 更密的 tick 只是空转。
const TICK_SECS: u64 = 30;

/// 启动 missed-run 扫描前的等待：给 setup 里并行的 runtime spawn 留时间，
/// 否则补跑的 send 会撞 "Runtime not spawned"。
const STARTUP_SCAN_DELAY_SECS: u64 = 5;

/// 运行历史统计条的窗口（近 30 天）。
const STATS_WINDOW_DAYS: i64 = 30;

/// 注入 prompt 的手册体积上限（防爆上下文）。
const PLAYBOOK_INJECT_CAP: usize = 8 * 1024;

/// 蒸馏轮的轮次上限：读过程 + 写手册/脚本，正常 3-6 轮，15 是宽松上限。
const DISTILL_MAX_TURNS: u32 = 15;

/// 运行本体的轮次上限（隐形护栏，不对用户暴露配置——2026-08-23 按用户决策
/// 从编辑器摘掉成本/轮次两个字段）：无人值守会话防跑飞的唯一断路器。
/// 50 轮对正常任务很宽裕，跑飞了也烧不穿配额。
const RUN_MAX_TURNS: u32 = 50;

/// 进行中的运行（active_runs 的值）：键存在 = 该任务忙（并发守卫 / 侧栏呼吸点）。
/// 值只留 session_init 坐实的 SDK 真实会话 id（转录文件名、resume 目标都是它）；
/// run_id 不在这儿——那是路由键，归下方 `SessionRoute` 持有。
#[derive(Clone, Debug)]
struct ActiveRun {
    sdk_session_id: Option<String>,
}

/// 事件路由表（by_session）的值：run_id 指向要回写的运行记录；
/// is_distill 区分「运行本体」与「蒸馏轮」（蒸馏轮的终态只回写蒸馏成本
/// 和手册状态，不改运行状态）。
#[derive(Clone, Debug)]
struct SessionRoute {
    task_id: String,
    run_id: String,
    is_distill: bool,
}

/// 运行终态的可选收尾数据（失败/跳过/中断路径几乎全 None，走 Default）。
/// 身份字段（task_id/run_id/status）留在 finalize_run 签名上：必填在前、可选在后。
#[derive(Default)]
struct RunFinalize {
    stop_reason: Option<String>,
    usage: Option<RunUsage>,
    rounds: Option<u64>,
    cost_usd: Option<f64>,
    error: Option<String>,
}

/// 外壳按 cwd 算好的路径政策快照（state 读属外壳，纯函数 builder 不碰）。
///
/// 运行轮与蒸馏轮**共用同一份**：这两个 builder 曾经各搓各的 payload，蒸馏轮
/// 因此漏了下发 `session_dir`，resume 落回全局配置根找不到会话——手册从未生成
/// （2026-09-24 实锤）。共用一个来源 + 同源断言才是防复发的结构性修法。
struct PathPolicy {
    cwd: String,
    trusted: bool,
    codegraph_enabled: bool,
}

pub struct AutomationService {
    /// 内存任务表（CRUD 命令维护；磁盘 task.json 是权威，启动时加载）
    tasks: Mutex<BTreeMap<String, AutomationTask>>,
    /// taskId -> 进行中的运行（并发跳过判定）
    active_runs: Mutex<HashMap<String, ActiveRun>>,
    /// sessionId -> 路由（runtime 事件挂钩的路由表；含蒸馏轮）
    by_session: Mutex<HashMap<String, SessionRoute>>,
    app: OnceLock<AppHandle>,
}

impl AutomationService {
    pub fn new() -> Self {
        let tasks = super::load_all_tasks()
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        Self {
            tasks: Mutex::new(tasks),
            active_runs: Mutex::new(HashMap::new()),
            by_session: Mutex::new(HashMap::new()),
            app: OnceLock::new(),
        }
    }

    /// lib.rs setup 里调用：登记 AppHandle + 启动常驻 tick
    /// （`tauri::async_runtime::spawn` 范式，与启动 Agent Runtime 同处）。
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app);
        let svc = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            svc.run_loop().await;
        });
    }

    async fn run_loop(self: Arc<Self>) {
        tokio::time::sleep(std::time::Duration::from_secs(STARTUP_SCAN_DELAY_SECS)).await;
        self.startup_scan().await;
        let mut iv = tokio::time::interval(std::time::Duration::from_secs(TICK_SECS));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            iv.tick().await;
            self.tick().await;
        }
    }

    fn now_naive() -> NaiveDateTime {
        Local::now().naive_local()
    }

    /// 该任务当前待处理的触发网格点（None = 没到点）。
    fn pending_fire(task: &AutomationTask, now: NaiveDateTime) -> Option<NaiveDateTime> {
        let anchor = schedule::parse_dt(&task.created_at).unwrap_or(now);
        let fire = schedule::last_scheduled_fire(&task.schedule, anchor, now)?;
        let last_run = task
            .last_run_at
            .as_deref()
            .and_then(|s| schedule::parse_dt(s).ok());
        match last_run {
            Some(lr) if fire <= lr => None,
            _ => Some(fire),
        }
    }

    /// 每 tick：收齐到点任务 id 后逐个发起（锁只覆盖收集段，不跨 await）。
    async fn tick(self: &Arc<Self>) {
        let now = Self::now_naive();
        let due: Vec<String> = {
            let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            tasks
                .values()
                .filter(|t| t.enabled)
                .filter(|t| {
                    schedule::in_valid_range(
                        t.valid_from.as_deref(),
                        t.valid_to.as_deref(),
                        now.date(),
                    )
                })
                .filter(|t| Self::pending_fire(t, now).is_some())
                .map(|t| t.id.clone())
                .collect()
        };
        for id in due {
            if let Err(e) = self.start_run(&id, RunTrigger::Schedule).await {
                tracing::warn!("[automation] 定时触发失败 {}: {}", id, e);
            }
        }
    }

    /// 启动扫描：① 上次进程退出时留下的 running 记录标记为失败（中断自愈）；
    /// ② 客户端未运行时跨过的网格点按任务策略处理。
    async fn startup_scan(self: &Arc<Self>) {
        let now = Self::now_naive();
        // ①覆盖全部任务（含已停用）——once 任务触发即停用，崩溃留下的 running
        // 若按 enabled 过滤就永远无人收尸；②的 missed 策略才只看启用中的任务。
        let ids: Vec<String> = {
            let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            tasks.values().map(|t| t.id.clone()).collect()
        };
        for id in ids {
            // ① 中断自愈：扫描最近 50 条而不是只看最新一条——overlap-skip 这类后补
            // 记录会把卡住的 running 压在下面漏收（2026-08-22 实锤：手动运行卡住后
            // tick 补了条 skipped 在最上面，重启自愈看最新一条=skipped 直接跳过）。
            // 若此刻该任务已有活跃运行（启动后 5s 内用户点了「立即运行」），不能误收。
            if self
                .active_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&id)
            {
                continue;
            }
            let mut healed = false;
            if let Ok(recent) = super::list_runs(&id, 50) {
                for r in recent
                    .into_iter()
                    .filter(|r| r.status == RunStatus::Running)
                {
                    let mut fixed = r;
                    fixed.status = RunStatus::Failed;
                    fixed.finished_at = Some(schedule::fmt_dt(now));
                    fixed.error = Some("客户端重启，运行被中断".into());
                    match super::update_run(&id, &fixed) {
                        Ok(()) => healed = true,
                        Err(e) => tracing::warn!("[automation] 中断自愈写回失败 {}: {}", id, e),
                    }
                }
            }
            if healed {
                // 被自愈的 running 就是最近一次真实运行事件——任务缓存同步收掉，
                // 否则侧栏呼吸点（lastRunStatus=running）永不熄灭
                if let Ok(mut task) = self.get_task(&id) {
                    task.last_run_status = Some(RunStatus::Failed);
                    if let Err(e) = self.persist_task(&task) {
                        tracing::warn!("{}", e);
                    }
                }
                // 通知前端刷新（面板开着时立刻反映，否则等下次打开拉取）
                if let Some(app) = self.app.get() {
                    let _ = app.emit(
                        "chat-event",
                        serde_json::json!({
                            "type": "automation_run_finished",
                            "automation_task_id": id,
                            "phase": "orphan-heal",
                        }),
                    );
                }
            }
            // ② missed-run 策略
            let Ok(task) = self.get_task(&id) else {
                continue;
            };
            if !task.enabled {
                continue;
            }
            if !schedule::in_valid_range(
                task.valid_from.as_deref(),
                task.valid_to.as_deref(),
                now.date(),
            ) {
                continue;
            }
            let Some(fire) = Self::pending_fire(&task, now) else {
                continue;
            };
            match task.missed_policy {
                MissedPolicy::Catchup => {
                    tracing::info!(
                        "[automation] 启动补跑:「{}」错过的网格点 {}",
                        task.name,
                        schedule::fmt_dt(fire)
                    );
                    if let Err(e) = self.start_run(&id, RunTrigger::Catchup).await {
                        tracing::warn!("[automation] 补跑失败 {}: {}", id, e);
                    }
                }
                MissedPolicy::Skip => {
                    self.record_missed_skip(&id, fire, "missed-skip");
                }
                MissedPolicy::Ask => {
                    // 应用内通知中心（warning，可落盘）：启动时 app 开着，通知中心
                    // 比 OS 通知更可行动（打开面板手动补跑）。前端 useAutomation 转推。
                    self.record_missed_skip(&id, fire, "missed-ask");
                    if let Some(app) = self.app.get() {
                        let _ = app.emit(
                            "chat-event",
                            serde_json::json!({
                                "type": "automation_missed",
                                "automation_task_id": id,
                                "task_name": task.name,
                                "fire": schedule::fmt_dt(fire),
                            }),
                        );
                    }
                }
            }
        }
    }

    /// missed skip/ask 的公共收尾：写 skipped 记录 + 推进网格点（消费掉这个触发点）。
    fn record_missed_skip(&self, id: &str, fire: NaiveDateTime, note: &str) {
        let run = RunRecord {
            run_id: super::new_id("run"),
            session_id: String::new(), // 没有会话
            trigger: RunTrigger::Schedule,
            mode: RunMode::Explore,
            started_at: schedule::fmt_dt(fire),
            finished_at: Some(schedule::fmt_dt(fire)),
            status: RunStatus::Skipped,
            stop_reason: None,
            usage: None,
            rounds: None,
            cost_usd: None,
            summary: None,
            distill_cost_usd: None,
            error: None,
            note: Some(note.into()),
        };
        if let Err(e) = super::append_run(id, &run) {
            tracing::warn!("[automation] 写 skipped 记录失败 {}: {}", id, e);
        }
        if let Ok(mut task) = self.get_task(id) {
            task.last_run_at = Some(schedule::fmt_dt(fire));
            // 有本体在跑时（overlap 场景）别把状态盖成 skipped——侧栏呼吸点会被
            // 误熄，本体的终态由它自己的 finalize 写
            let has_active = self
                .active_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(id);
            if !has_active {
                task.last_run_status = Some(RunStatus::Skipped);
            }
            if let Err(e) = self.persist_task(&task) {
                tracing::warn!("{}", e);
            }
        }
    }

    // ── 执行引擎 ──

    /// 内建工具可见性：两档预设都是全量（auto 的安全收口在 CLI auto 裁决 +
    /// canUseTool 兜底 + policy hook，不靠砍可见性——砍掉 Bash 可见性曾让
    /// 「受限」语义变成「模型根本看不到」，那不是用户要的 auto）。
    fn preset_tools(_preset: PermissionPreset) -> Vec<String> {
        vec!["*".to_string()]
    }

    /// 预设 → 权限模式：auto 走 CLI 自动裁决（安全放行/高危询问→兜底 deny）；
    /// full 诚实 bypass（policy hook 仍会全量 allow，两道语义一致）。
    fn preset_permission_mode(preset: PermissionPreset) -> &'static str {
        match preset {
            PermissionPreset::Auto => "auto",
            PermissionPreset::Full => "bypassPermissions",
        }
    }

    /// 外壳的路径政策读：cwd → (trusted, codegraph_enabled)。state 读属外壳，
    /// 纯函数 builder 只消费结果——两个 builder 共用，保证对同一 cwd 判断一致。
    fn path_policy(cwd: &str) -> PathPolicy {
        PathPolicy {
            cwd: cwd.to_string(),
            trusted: crate::commands::workspace::is_path_trusted(cwd),
            codegraph_enabled: crate::commands::workspace::is_codegraph_enabled_for_path(cwd),
        }
    }

    /// 构造发给 runtime 的 send 命令（纯函数，单测锁定协议形状）。
    /// 模型/effort 与普通会话同形走 env 通道（worker 读作初始值 → options.model/effort）；
    /// model 空 = 跟随提供商默认（自定义 provider 的正确兜底）。
    fn build_send_command(
        task: &AutomationTask,
        run_id: &str,
        prompt: &str,
        policy: &PathPolicy,
    ) -> Value {
        let mut env = serde_json::Map::new();
        if !task.model.is_empty() {
            env.insert("ANTHROPIC_MODEL".into(), Value::String(task.model.clone()));
        }
        if !task.effort.is_empty() {
            env.insert(
                "CLAUDE_CODE_EFFORT_LEVEL".into(),
                Value::String(task.effort.clone()),
            );
        }
        serde_json::json!({
            "cmd": "send",
            "session_id": run_id, // 运行与会话 1:1，run_id 即 session_id
            "prompt": prompt,
            "cwd": policy.cwd.as_str(),
            "env": env,
            "permission_mode": Self::preset_permission_mode(task.permission_preset),
            "auto_title": false,
            "trusted": policy.trusted,
            // 工作区级代码索引开关：未开启的工作区不挂载 aide-codegraph MCP
            // （与 chat.rs 的下发同语义；调用方按 cwd 查 state.json 注入）。
            "codegraph_enabled": policy.codegraph_enabled,
            // 自动化运行**刻意不发** LSP 语言：queryOptions 对 automation 的既有立场是
            // 「全关：每次都是全新会话，精简基座 = 省钱 + 行为确定」，而挂 LSP 工具既加
            // 工具 schema（每轮重发）又可能为一个无人值守的运行拉起 GB 级语言服务器。
            "lsp_languages": Vec::<String>::new(),
            "automation": {
                "task_id": task.id,
                "run_id": run_id,
                "preset": task.permission_preset,
                "tools": Self::preset_tools(task.permission_preset),
                "mcp_allowlist": task.connectors,
                // 任务目录写例外（手册自愈合写回/蒸馏产物都在 cwd 之外）
                "task_dir": super::task_dir(&task.id).to_string_lossy(),
                // 会话目录（子进程 CLAUDE_CONFIG_DIR）：显式字段下发，**不塞进 env**
                // ——env 的语义是 provider 连接参数（见 session-worker.ts 注释），
                // 混进去就是影子参数。默认取作用域隔离目录，任务可显式指定。
                "session_dir": super::session_dir(task).to_string_lossy(),
                "max_turns": RUN_MAX_TURNS,
            }
        })
    }

    /// 蒸馏轮会话 id 约定（`<runId>-d`）：路由键与命令 session_id 必须同源。
    fn distill_session_id(run_id: &str) -> String {
        format!("{}-d", run_id)
    }

    /// 构造蒸馏轮的 send 命令（纯函数，单测锁定协议形状）。
    ///
    /// resume 的是**运行会话**，因此 `session_dir` 必须与运行轮同源——拿全局配置根
    /// 就找不到那份转录（见 [`PathPolicy`] 文档里的事故）。两个 builder 消费同一个
    /// [`PathPolicy`] 是防这类字段漂移的结构性约束，只靠人眼比对不可靠。
    fn build_distill_command(task: &AutomationTask, run: &RunRecord, policy: &PathPolicy) -> Value {
        let distill_sid = Self::distill_session_id(&run.run_id);
        serde_json::json!({
            "cmd": "send",
            "session_id": distill_sid,
            "prompt": Self::distill_prompt(task),
            "cwd": policy.cwd.as_str(),
            "trusted": policy.trusted,
            "codegraph_enabled": policy.codegraph_enabled,
            // 同上（distill 支线同属自动化）：不发 LSP 语言。
            "lsp_languages": Vec::<String>::new(),
            "permission_mode": Self::preset_permission_mode(task.permission_preset),
            "auto_title": false,
            "resume_session_id": run.session_id,
            "automation": {
                "task_id": task.id,
                "run_id": distill_sid,
                "preset": task.permission_preset,
                // 蒸馏轮要写 playbook.md / scripts/，工具面恒全量（不分预设收窄）
                "tools": ["*"],
                "mcp_allowlist": task.connectors,
                "task_dir": super::task_dir(&task.id).to_string_lossy(),
                // 与运行轮同源：resume 的目标会话就在这个配置根下
                "session_dir": super::session_dir(task).to_string_lossy(),
                "max_turns": DISTILL_MAX_TURNS,
                "fork": true,
            }
        })
    }

    /// 组装最终 prompt：原提示词 + 手册就绪时注入 playbook.md + 自愈合兜底。
    fn assemble_prompt(task: &AutomationTask) -> (String, RunMode) {
        if task.playbook_state != PlaybookState::Ready {
            return (task.prompt.clone(), RunMode::Explore);
        }
        let Ok(content) = std::fs::read_to_string(super::playbook_path(&task.id)) else {
            return (task.prompt.clone(), RunMode::Explore);
        };
        let capped: String = content.chars().take(PLAYBOOK_INJECT_CAP).collect();
        let playbook_file = super::playbook_path(&task.id);
        let prompt = format!(
            "{}\n\n# 执行手册（务必遵循）\n{}\n\n# 兜底\n若手册任一步骤失败（目录结构变化/脚本报错/命令不存在），自由发挥完成任务；若你的权限预设允许写文件，结束时把改进写回 {}。",
            task.prompt,
            capped,
            playbook_file.display()
        );
        (prompt, RunMode::Playbook)
    }

    /// 发起一次运行。manual 触发时正在运行 → Err；定时触发撞运行 → 记 skipped(overlap)。
    pub async fn start_run(
        self: &Arc<Self>,
        task_id: &str,
        trigger: RunTrigger,
    ) -> Result<RunRecord, String> {
        let now = Self::now_naive();
        let task = self.get_task(task_id)?;

        // 并发守卫：运行本体或蒸馏轮在跑都算忙（蒸馏 resume 的是上次会话，
        // 新运行与之并发会让同一份转录两个写者）
        let busy = {
            let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
            let routes = self.by_session.lock().unwrap_or_else(|e| e.into_inner());
            active.contains_key(task_id) || routes.values().any(|r| r.task_id == task_id)
        };
        if busy {
            if trigger == RunTrigger::Manual {
                return Err(format!("「{}」正在运行中", task.name));
            }
            let fire = Self::pending_fire(&task, now).unwrap_or(now);
            self.record_missed_skip(task_id, fire, "overlap");
            return super::list_runs(task_id, 1)?
                .into_iter()
                .next()
                .ok_or_else(|| "skipped 记录写入后读取失败".to_string());
        }

        // 网格点消费：scheduled/catchup 在开始时推进 last_run_at（重启不重跑）
        let fire = if trigger == RunTrigger::Manual {
            None
        } else {
            Some(Self::pending_fire(&task, now).unwrap_or(now))
        };

        let run_id = super::new_id("run");
        let session_id = run_id.clone(); // 1:1 映射，调试友好
        let (prompt, mode) = Self::assemble_prompt(&task);
        let cwd = task
            .workspace_path
            .clone()
            .unwrap_or_else(|| super::task_dir(&task.id).to_string_lossy().to_string());
        // 政策读在这里（外壳）算好，纯函数 builder 只管拼装。
        let policy = Self::path_policy(&cwd);

        let run = RunRecord {
            run_id: run_id.clone(),
            session_id: session_id.clone(),
            trigger,
            mode,
            started_at: schedule::fmt_dt(now),
            finished_at: None,
            status: RunStatus::Running,
            stop_reason: None,
            usage: None,
            rounds: None,
            cost_usd: None,
            summary: None,
            distill_cost_usd: None,
            error: None,
            note: None,
        };

        // 落盘：运行记录 + 会话元数据（tags 标 automation，隔离出正常会话列表）+ 任务缓存
        {
            let task_for_write = task.clone();
            let run_for_write = run.clone();
            let cwd_for_dir = cwd.clone();
            let sid = session_id.clone();
            let task_id_owned = task.id.clone();
            let fire_for_write = fire;
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                super::append_run(&task_id_owned, &run_for_write)?;
                // 无工作空间的任务以任务目录为 cwd（scratch home），先确保存在
                std::fs::create_dir_all(&cwd_for_dir).map_err(|e| format!("create cwd dir: {e}"))?;
                // 会话目录（隔离配置根）也先建好：SDK 会自建，但显式建可保证后续
                // 按路径读转录时目录已存在，少一类竞态。
                std::fs::create_dir_all(super::session_dir(&task_for_write))
                    .map_err(|e| format!("create session dir: {e}"))?;
                let meta = serde_json::json!({
                    "id": sid,
                    "name": format!("{} · {}", task_for_write.name, run_for_write.started_at[5..16].replace('T', " ")),
                    "createdAt": crate::commands::recent::now_ms(),
                    "nameSource": "automation",
                    "tags": ["automation", task_id_owned],
                    "model": task_for_write.model,
                    "effort": task_for_write.effort,
                });
                let dir = crate::commands::our_sessions_dir();
                std::fs::create_dir_all(&dir).map_err(|e| format!("create sessions dir: {e}"))?;
                std::fs::write(
                    dir.join(format!("{}.json", sid)),
                    serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
                )
                .map_err(|e| format!("write session meta: {e}"))?;
                let _ = fire_for_write; // 网格推进在下方内存态里做
                Ok(())
            })
            .await
            .map_err(|e| format!("start_run 落盘 panicked: {e}"))??;
        }

        // 内存态：任务缓存推进 + 活跃表登记（先发记录再登记，send 失败时按失败收尾）
        {
            let mut task_mut = task.clone();
            if let Some(f) = fire {
                task_mut.last_run_at = Some(schedule::fmt_dt(f));
            }
            task_mut.last_run_status = Some(RunStatus::Running);
            self.persist_task(&task_mut)?;
        }

        let cmd = Self::build_send_command(&task, &run_id, &prompt, &policy);

        let app = self
            .app
            .get()
            .ok_or("AutomationService 未启动（无 AppHandle）")?;
        let runtime = app
            .try_state::<crate::runtime::AgentRuntimeManager>()
            .ok_or("AgentRuntimeManager 未注册")?;
        if let Err(e) = runtime.send_to_runtime(&cmd).await {
            // 发送失败 = 运行从未开始：清掉预写的会话元数据（按 run_id 命名的那份），
            // 再按失败收尾
            let _ = std::fs::remove_file(
                crate::commands::our_sessions_dir().join(format!("{}.json", session_id)),
            );
            self.finalize_run(
                &task.id,
                &run_id,
                RunStatus::Failed,
                RunFinalize {
                    error: Some(format!("发送运行命令失败: {e}")),
                    ..Default::default()
                },
            );
            return Err(e);
        }

        self.active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                task.id.clone(),
                ActiveRun {
                    sdk_session_id: None,
                },
            );
        self.by_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                session_id,
                SessionRoute {
                    task_id: task.id.clone(),
                    run_id: run_id.clone(),
                    is_distill: false,
                },
            );

        // 单次任务：触发即停用（保留历史）。此刻 last_run_at 已消费掉唯一
        // 网格点，enabled=false 是双保险，也让侧栏/详情立刻显示「已暂停」。
        if matches!(task.schedule, super::Schedule::Once { .. }) {
            if let Err(e) = self.set_enabled(&task.id, false) {
                tracing::warn!("[automation] 单次任务停用失败 {}: {}", task.id, e);
            }
        }
        Ok(run)
    }

    /// runtime stdout 泵的挂钩（runtime/mod.rs 在每个 chat-event 上调用）。
    /// 必须轻量非阻塞：终态识别后 spawn 出去做落盘。
    pub fn observe_chat_event(self: &Arc<Self>, event: &Value) {
        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match event_type {
            "session_init" => {
                // 坐实 SDK 真实会话 id（转录文件名/resume 目标都是它，run_id 只是
                // 路由键）：更新运行记录的 session_id + 元数据文件改名。
                let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) else {
                    return;
                };
                let Some(sdk_sid) = event.get("sdk_session_id").and_then(|s| s.as_str()) else {
                    return;
                };
                let route = {
                    self.by_session
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(sid)
                        .cloned()
                };
                let Some(route) = route else { return };
                // SessionManager 在 session_init 后把 worker 原子 re-key 成 SDK 真实 id
                // （getOrCreate 的 emit 闭包读 worker.routingKey）——之后所有事件（含
                // 终态 message_stop/error）的 session_id 都是真实 id，不再是路由键。
                // 路由表必须跟着过户，否则终态事件查不到路由，运行永远卡在 running
                // （2026-08-22 实锤：记录有 sdk sessionId 却永远不收尾）。
                if sdk_sid != sid {
                    let mut routes = self.by_session.lock().unwrap_or_else(|e| e.into_inner());
                    routes.remove(sid);
                    routes.insert(sdk_sid.to_string(), route.clone());
                }
                if route.is_distill {
                    // 蒸馏轮 fork 成全新 SDK id：补写自动化元数据（tags），否则活体
                    // 会话会被 list_sessions 的 pid 通道扫成侧栏幽灵空会话
                    let svc = Arc::clone(self);
                    let sdk = sdk_sid.to_string();
                    tokio::spawn(async move {
                        svc.write_automation_session_meta(&route.task_id, &sdk, "蒸馏");
                    });
                    return;
                }
                {
                    let mut active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(ar) = active.get_mut(&route.task_id) {
                        ar.sdk_session_id = Some(sdk_sid.to_string());
                    }
                }
                let svc = Arc::clone(self);
                let sdk = sdk_sid.to_string();
                tokio::spawn(async move {
                    svc.adopt_sdk_session_id(&route.task_id, &route.run_id, &sdk);
                });
            }
            "message_stop" | "error" => {
                let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) else {
                    return;
                };
                let route = {
                    self.by_session
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(sid)
                        .cloned()
                };
                let Some(route) = route else { return };
                let (status, stop_reason, usage, rounds, cost, error) = if event_type
                    == "message_stop"
                {
                    let sr = event
                        .get("stop_reason")
                        .and_then(|s| s.as_str())
                        .unwrap_or("unknown");
                    let usage = event.get("usage").map(|u| RunUsage {
                        input_tokens: u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        output_tokens: u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        cache_read_tokens: u
                            .get("cacheReadInputTokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_creation_tokens: u
                            .get("cacheCreationInputTokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                    });
                    let rounds = event
                        .pointer("/usage/apiCallCount")
                        .and_then(|v| v.as_u64());
                    let cost = event
                        .get("total_cost_usd")
                        .and_then(|v| v.as_f64())
                        .or_else(|| event.pointer("/usage/costUsd").and_then(|v| v.as_f64()));
                    if sr == "end_turn" {
                        (
                            RunStatus::Succeeded,
                            Some(sr.to_string()),
                            usage,
                            rounds,
                            cost,
                            None,
                        )
                    } else {
                        (
                            RunStatus::Failed,
                            Some(sr.to_string()),
                            usage,
                            rounds,
                            cost,
                            Some(format!("运行中断（stop_reason={sr}）")),
                        )
                    }
                } else {
                    let msg = event
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("未知错误")
                        .to_string();
                    (RunStatus::Failed, None, None, None, None, Some(msg))
                };
                let svc = Arc::clone(self);
                if route.is_distill {
                    // 蒸馏轮终态：只回写蒸馏成本与手册状态（运行本体早已收尾）
                    let succeeded = status == RunStatus::Succeeded;
                    tokio::spawn(async move {
                        svc.finalize_distill(&route.task_id, &route.run_id, succeeded, cost);
                    });
                    return;
                }
                let run_id = route.run_id;
                let task_id = route.task_id;
                tokio::spawn(async move {
                    svc.finalize_run(
                        &task_id,
                        &run_id,
                        status,
                        RunFinalize {
                            stop_reason,
                            usage,
                            rounds,
                            cost_usd: cost,
                            error,
                        },
                    );
                });
            }
            "session_dead" => {
                // runtime 进程死了：活跃运行按失败收尾；蒸馏轮只摘路由（其运行早已收尾）
                let reason = event
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let routes: Vec<SessionRoute> = {
                    self.by_session
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .values()
                        .cloned()
                        .collect()
                };
                if routes.is_empty() {
                    return;
                }
                let svc = Arc::clone(self);
                tokio::spawn(async move {
                    for route in routes {
                        if route.is_distill {
                            svc.finalize_distill(&route.task_id, &route.run_id, false, None);
                        } else {
                            svc.finalize_run(
                                &route.task_id,
                                &route.run_id,
                                RunStatus::Failed,
                                RunFinalize {
                                    error: Some(format!("runtime 进程退出（{reason}）")),
                                    ..Default::default()
                                },
                            );
                        }
                    }
                });
            }
            _ => {}
        }
    }

    /// session_init 坐实：把运行记录与会话元数据从路由键（run_id）过户到
    /// SDK 真实会话 id——转录 jsonl 以它命名，前端点运行行按它找转录。
    fn adopt_sdk_session_id(&self, task_id: &str, run_id: &str, sdk_sid: &str) {
        if let Some(mut run) = super::list_runs(task_id, 50)
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.run_id == run_id)
        {
            if run.session_id != sdk_sid {
                run.session_id = sdk_sid.to_string();
                if let Err(e) = super::update_run(task_id, &run) {
                    tracing::warn!(
                        "[automation] 过户运行记录 sessionId 失败 {}: {}",
                        task_id,
                        e
                    );
                }
            }
        }
        // 元数据文件改名：run_id.json → <sdk>.json（id 字段同步）
        let dir = crate::commands::our_sessions_dir();
        let old = dir.join(format!("{}.json", run_id));
        let new = dir.join(format!("{}.json", sdk_sid));
        if !old.exists() {
            return;
        }
        if let Ok(content) = std::fs::read_to_string(&old) {
            let mut v: Value =
                serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));
            v["id"] = Value::String(sdk_sid.to_string());
            if let Ok(body) = serde_json::to_string_pretty(&v) {
                if std::fs::write(&new, body).is_ok() {
                    let _ = std::fs::remove_file(&old);
                }
            }
        }
    }

    /// 给自动化会话补写元数据（tags 标 automation，list_sessions 两路扫描据此过滤）。
    /// 运行本体的元数据在 start_run 里预写（这份是同一形状的孪生）；fork 蒸馏轮的
    /// SDK id 要到 session_init 才知道，只能在这里补。
    fn write_automation_session_meta(&self, task_id: &str, sdk_sid: &str, suffix: &str) {
        let Ok(task) = self.get_task(task_id) else {
            return;
        };
        let meta = serde_json::json!({
            "id": sdk_sid,
            "name": format!("{} · {}", task.name, suffix),
            "createdAt": crate::commands::recent::now_ms(),
            "nameSource": "automation",
            "tags": ["automation", task_id],
            "model": task.model,
            "effort": task.effort,
        });
        let dir = crate::commands::our_sessions_dir();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!("[automation] 创建会话元数据目录失败: {}", e);
            return;
        }
        if let Ok(body) = serde_json::to_string_pretty(&meta) {
            if let Err(e) = std::fs::write(dir.join(format!("{}.json", sdk_sid)), body) {
                tracing::warn!("[automation] 写蒸馏会话元数据失败: {}", e);
            }
        }
    }

    /// 运行终态收尾（幂等：活跃表移除后再到的事件找不到 runId，自然忽略）。
    /// 回写 runs.jsonl + task.json 缓存，发通知，并（M4）按需要触发蒸馏。
    fn finalize_run(
        self: &Arc<Self>,
        task_id: &str,
        run_id: &str,
        status: RunStatus,
        outcome: RunFinalize,
    ) {
        self.detach_routes(task_id);
        let Ok(task) = self.get_task(task_id) else {
            return;
        };
        let Some(run) = Self::load_run(task_id, run_id) else {
            return;
        };
        let run = self.apply_outcome(task_id, &task, run, status, &outcome);
        Self::notify_if_needed(&task, &run, status, &outcome);
        self.emit_finished(task_id, run_id, status);
        Self::maybe_distill(self, task, run, status);
    }

    /// 活跃表摘除（幂等关键）；路由只摘运行本体的（蒸馏路由独立生命周期）。
    fn detach_routes(&self, task_id: &str) {
        self.active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(task_id);
        let mut guard = self.by_session.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|_, r| !(r.task_id == task_id && !r.is_distill));
    }

    /// 找本次运行记录；找不到 = 事件来晚了（已收尾/记录被删），幂等忽略。
    fn load_run(task_id: &str, run_id: &str) -> Option<RunRecord> {
        super::list_runs(task_id, 50)
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.run_id == run_id)
    }

    /// 回写运行终态 + 任务缓存（last_run_status），返回更新后的记录供通知/蒸馏用。
    fn apply_outcome(
        &self,
        task_id: &str,
        task: &AutomationTask,
        run: RunRecord,
        status: RunStatus,
        outcome: &RunFinalize,
    ) -> RunRecord {
        let mut run = run;
        run.status = status;
        run.finished_at = Some(schedule::fmt_dt(Self::now_naive()));
        run.stop_reason = outcome.stop_reason.clone();
        run.usage = outcome.usage;
        run.rounds = outcome.rounds;
        run.cost_usd = outcome.cost_usd;
        run.error = outcome.error.clone();
        // 结论摘要：转录尾行文本——报告类任务在运行列表里一眼可读，通知正文也带
        run.summary = Self::extract_summary(&run.session_id);
        if let Err(e) = super::update_run(task_id, &run) {
            tracing::warn!("[automation] 回写运行记录失败 {}: {}", task_id, e);
        }
        let mut task = task.clone();
        task.last_run_status = Some(status);
        if let Err(e) = self.persist_task(&task) {
            tracing::warn!("{}", e);
        }
        run
    }

    /// 成功/失败按任务开关发系统通知。
    fn notify_if_needed(
        task: &AutomationTask,
        run: &RunRecord,
        status: RunStatus,
        outcome: &RunFinalize,
    ) {
        let should_notify = match status {
            RunStatus::Succeeded => task.notify_success,
            RunStatus::Failed => task.notify_failure,
            _ => false,
        };
        if !should_notify {
            return;
        }
        let title = format!(
            "自动化「{}」{}",
            task.name,
            if status == RunStatus::Succeeded {
                "已完成"
            } else {
                "失败"
            }
        );
        let body = match status {
            RunStatus::Succeeded => {
                let base = format!("成本 ${:.3}", outcome.cost_usd.unwrap_or(0.0));
                match &run.summary {
                    Some(s) if !s.is_empty() => {
                        format!("{} · {}", base, s.chars().take(60).collect::<String>())
                    }
                    _ => base,
                }
            }
            _ => outcome.error.clone().unwrap_or_else(|| "未知错误".into()),
        };
        Self::notify(&title, &body);
    }

    /// 向前端广播终态（M3 面板刷新用；chat-event 通道，无 session_id 路由语义）。
    fn emit_finished(&self, task_id: &str, run_id: &str, status: RunStatus) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                "chat-event",
                serde_json::json!({
                    "type": "automation_run_finished",
                    "automation_task_id": task_id,
                    "automation_run_id": run_id,
                    "status": format!("{:?}", status).to_lowercase(),
                }),
            );
        }
    }

    /// M4 蒸馏：成功的探索轮（手册未就绪且开了开关）→ resume 本会话补一轮蒸馏。
    /// 路由/落盘都在 start_distill 里；spawn 出去做（send 是 async）。
    fn maybe_distill(svc: &Arc<Self>, task: AutomationTask, run: RunRecord, status: RunStatus) {
        if !Self::should_distill(&task, status) {
            return;
        }
        let svc = Arc::clone(svc);
        let task_c = task.clone();
        let run_c = run.clone();
        tokio::spawn(async move {
            if let Err(e) = svc.start_distill(task_c, run_c).await {
                tracing::warn!("[automation] 蒸馏轮发起失败: {}", e);
            }
        });
    }

    /// 蒸馏条件：运行成功 + 开了手册开关 + 手册未就绪（NotYet 首跑 / Stale 重提炼）。
    fn should_distill(task: &AutomationTask, status: RunStatus) -> bool {
        status == RunStatus::Succeeded
            && task.playbook_enabled
            && task.playbook_state != PlaybookState::Ready
    }

    /// 蒸馏轮 prompt（纯函数，文案契约有单测）。核心约束：只文档化不执行；
    /// 脚本只做取数/格式化；面向无记忆的下一个会话。
    fn distill_prompt(task: &AutomationTask) -> String {
        let dir = super::task_dir(&task.id);
        let playbook = dir.join("playbook.md");
        let scripts = dir.join("scripts");
        format!(
            "[自动化系统] 你刚才完成了一次自动化任务运行。现在不要继续执行任务本身，而是做「执行手册蒸馏」。\n\n\
            回顾你刚才完成这个任务的过程，把可复用的执行步骤提炼出来：\n\
            1. 用 Write 把手册写到 {}——面向一个完全没有本次记忆的会话写（它下次只能拿到任务提示词 + 这份手册）：步骤化（先做什么、再做什么、产出什么格式），写明常见失败点与应对\n\
            2. 能确定性完成的步骤（取数/格式化/扫描）写成脚本放进 {}，手册里用绝对路径引用它们——脚本完成的步骤下次零 token\n\
            3. 脚本只做取数与格式化；判断、总结、成文留给模型\n\
            4. 手册控制在 200 行以内\n\n\
            完成后回复一句话说明写了哪些文件。",
            playbook.display(),
            scripts.display()
        )
    }

    /// 发起蒸馏轮：resume 本次运行的会话（上下文还在、缓存还热），但 fork 成
    /// 新 SDK 会话 id——若与运行会话同 id，worker re-key 后「关运行 tab 的
    /// session_stop / ESC interrupt」等命令会误杀蒸馏轮（2026-08-23 实锤）。
    /// 代价是蒸馏转录写到新 jsonl，不再与运行同文件。
    async fn start_distill(
        self: &Arc<Self>,
        task: AutomationTask,
        run: RunRecord,
    ) -> Result<(), String> {
        let distill_sid = Self::distill_session_id(&run.run_id);
        let cwd = task
            .workspace_path
            .clone()
            .unwrap_or_else(|| super::task_dir(&task.id).to_string_lossy().to_string());
        let cmd = Self::build_distill_command(&task, &run, &Self::path_policy(&cwd));

        let app = self.app.get().ok_or("AutomationService 未启动")?;
        let runtime = app
            .try_state::<crate::runtime::AgentRuntimeManager>()
            .ok_or("AgentRuntimeManager 未注册")?;
        // 先注册路由再发（send 返回后事件才可能到达，顺序安全）
        self.by_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                distill_sid.clone(),
                SessionRoute {
                    task_id: task.id.clone(),
                    run_id: run.run_id.clone(),
                    is_distill: true,
                },
            );
        if let Err(e) = runtime.send_to_runtime(&cmd).await {
            self.by_session
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&distill_sid);
            return Err(format!("发送蒸馏命令失败: {e}"));
        }
        tracing::info!(
            "[automation] 蒸馏轮已发起：「{}」← resume {}",
            task.name,
            run.session_id
        );
        Ok(())
    }

    /// 蒸馏轮终态收尾：回写蒸馏成本；成功且手册真的生成了 → playbook_state=Ready。
    /// 失败/没产出 → 状态不动（下次成功运行会重试）。
    fn finalize_distill(
        self: &Arc<Self>,
        task_id: &str,
        run_id: &str,
        succeeded: bool,
        cost: Option<f64>,
    ) {
        self.by_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, r| !(r.task_id == task_id && r.is_distill));

        if let Some(mut run) = super::list_runs(task_id, 50)
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.run_id == run_id)
        {
            if let Some(c) = cost {
                run.distill_cost_usd = Some(c);
                if let Err(e) = super::update_run(task_id, &run) {
                    tracing::warn!("[automation] 回写蒸馏成本失败 {}: {}", task_id, e);
                }
            }
        }

        if succeeded {
            let playbook = super::playbook_path(task_id);
            let produced = playbook
                .exists()
                .then(|| {
                    std::fs::metadata(&playbook)
                        .map(|m| m.len() > 0)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if produced {
                match self.set_playbook_state(task_id, PlaybookState::Ready) {
                    Ok(_) => tracing::info!("[automation] 手册已就绪（{}）", task_id),
                    Err(e) => tracing::warn!("[automation] 手册状态写回失败: {}", e),
                }
            } else {
                tracing::warn!(
                    "[automation] 蒸馏轮结束但未产出 {}，保持现状下轮重试",
                    playbook.display()
                );
            }
        }

        // 前端刷新（playbookState/蒸馏成本变化）
        if let Some(app) = self.app.get() {
            let _ = app.emit(
                "chat-event",
                serde_json::json!({
                    "type": "automation_run_finished",
                    "automation_task_id": task_id,
                    "automation_run_id": run_id,
                    "phase": "distill",
                }),
            );
        }
    }

    fn notify(title: &str, body: &str) {
        let mut n = notify_rust::Notification::new();
        n.app_id("com.aide.app");
        n.auto_icon();
        n.summary(title);
        n.body(body);
        tauri::async_runtime::spawn(async move {
            let _ = n.show();
        });
    }

    /// 取运行结论摘要：转录（按 SDK 会话 id 全局定位）尾行文本，折叠空白。
    /// 在运行终态调用（蒸馏轮还没开始写，尾行就是本次运行的最终回答）。
    fn extract_summary(session_id: &str) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        let path = crate::commands::find_session_jsonl_globally(session_id)
            .into_iter()
            .next()?;
        let text = crate::commands::session::last_jsonl_message(&path);
        let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            None
        } else {
            Some(collapsed)
        }
    }

    // ── CRUD 内核（commands.rs 薄壳；磁盘 IO 由命令侧 spawn_blocking 包裹） ──

    fn persist_task(&self, task: &AutomationTask) -> Result<(), String> {
        super::save_task(task)?;
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(task.id.clone(), task.clone());
        Ok(())
    }

    pub fn list_tasks(&self) -> Vec<AutomationTask> {
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    pub fn get_task(&self, id: &str) -> Result<AutomationTask, String> {
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| format!("自动化任务不存在: {id}"))
    }

    pub fn create_task(&self, input: AutomationTaskInput) -> Result<AutomationTask, String> {
        schedule::validate_input(&input)?;
        let task = AutomationTask {
            id: super::new_id("aut"),
            name: input.name,
            prompt: input.prompt,
            workspace_path: input.workspace_path,
            session_dir: input.session_dir,
            model: input.model,
            effort: input.effort,
            permission_preset: input.permission_preset,
            connectors: input.connectors,
            schedule: input.schedule,
            valid_from: input.valid_from,
            valid_to: input.valid_to,
            missed_policy: input.missed_policy,
            playbook_enabled: input.playbook_enabled,
            playbook_state: PlaybookState::NotYet,
            notify_success: input.notify_success,
            notify_failure: input.notify_failure,
            enabled: input.enabled,
            created_at: schedule::fmt_dt(Self::now_naive()),
            last_run_at: None,
            last_run_status: None,
        };
        self.persist_task(&task)?;
        Ok(task)
    }

    pub fn update_task(
        &self,
        id: &str,
        input: AutomationTaskInput,
    ) -> Result<AutomationTask, String> {
        schedule::validate_input(&input)?;
        let existing = self.get_task(id)?;
        // 服务端管理字段保留：id/createdAt/playbookState/lastRun*
        let task = AutomationTask {
            id: existing.id.clone(),
            created_at: existing.created_at.clone(),
            playbook_state: existing.playbook_state,
            last_run_at: existing.last_run_at.clone(),
            last_run_status: existing.last_run_status,
            name: input.name,
            prompt: input.prompt,
            workspace_path: input.workspace_path,
            session_dir: input.session_dir,
            model: input.model,
            effort: input.effort,
            permission_preset: input.permission_preset,
            connectors: input.connectors,
            schedule: input.schedule,
            valid_from: input.valid_from,
            valid_to: input.valid_to,
            missed_policy: input.missed_policy,
            playbook_enabled: input.playbook_enabled,
            notify_success: input.notify_success,
            notify_failure: input.notify_failure,
            enabled: input.enabled,
        };
        self.persist_task(&task)?;
        Ok(task)
    }

    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        super::delete_task_dir(id)?;
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<AutomationTask, String> {
        let mut guard = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let task = guard
            .get_mut(id)
            .ok_or_else(|| format!("自动化任务不存在: {id}"))?;
        task.enabled = enabled;
        let snapshot = task.clone();
        drop(guard);
        self.persist_task(&snapshot)?;
        Ok(snapshot)
    }

    /// 重新提炼手册：置 stale，下次运行按探索模式跑完后重新蒸馏（M4 接蒸馏轮）。
    pub fn set_playbook_state(
        &self,
        id: &str,
        state: PlaybookState,
    ) -> Result<AutomationTask, String> {
        let mut guard = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let task = guard
            .get_mut(id)
            .ok_or_else(|| format!("自动化任务不存在: {id}"))?;
        task.playbook_state = state;
        let snapshot = task.clone();
        drop(guard);
        self.persist_task(&snapshot)?;
        Ok(snapshot)
    }

    /// 读手册内容（None = 尚未生成）。
    pub fn read_playbook(&self, id: &str) -> Result<Option<String>, String> {
        self.get_task(id)?; // 存在性检查
        let p = super::playbook_path(id);
        if !p.exists() {
            return Ok(None);
        }
        std::fs::read_to_string(&p)
            .map(Some)
            .map_err(|e| format!("read playbook: {e}"))
    }

    pub fn list_runs(&self, id: &str, limit: usize) -> Result<Vec<RunRecord>, String> {
        // 任务存在性检查，给前端一个明确的 404 语义
        self.get_task(id)?;
        super::list_runs(id, limit)
    }

    pub fn run_stats(&self, id: &str) -> Result<RunStats, String> {
        self.get_task(id)?;
        let runs = super::list_runs(id, usize::MAX)?;
        let since = Self::now_naive() - chrono::Duration::days(STATS_WINDOW_DAYS);
        Ok(super::aggregate_runs(&runs, since))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::{IntervalUnit, MissedPolicy, Schedule};

    /// 路径政策快照的测试替身：builder 是纯函数，政策读由调用方注入，
    /// 单测因此不碰 state.json。
    fn policy(cwd: &str, trusted: bool, codegraph_enabled: bool) -> PathPolicy {
        PathPolicy {
            cwd: cwd.into(),
            trusted,
            codegraph_enabled,
        }
    }

    /// 一条成功的运行记录。蒸馏轮 builder 只消费 run_id / session_id 两项，
    /// 但按真实形状造，免得字段增删时测试替身先失真。
    fn run_record(run_id: &str, sdk_sid: &str) -> RunRecord {
        RunRecord {
            run_id: run_id.into(),
            session_id: sdk_sid.into(),
            trigger: RunTrigger::Manual,
            mode: RunMode::Explore,
            started_at: "2026-09-24T19:27:57".into(),
            finished_at: Some("2026-09-24T19:28:19".into()),
            status: RunStatus::Succeeded,
            stop_reason: Some("end_turn".into()),
            usage: None,
            rounds: Some(8),
            cost_usd: Some(0.34),
            summary: None,
            distill_cost_usd: None,
            error: None,
            note: None,
        }
    }

    fn task(preset: PermissionPreset) -> AutomationTask {
        AutomationTask {
            id: "aut_test".into(),
            name: "测试任务".into(),
            prompt: "做点事".into(),
            workspace_path: Some("C:/ws".into()),
            session_dir: None,
            model: "claude-sonnet-5".into(),
            effort: "medium".into(),
            permission_preset: preset,
            connectors: vec!["aide-codegraph".into()],
            schedule: Schedule::Interval {
                every: 2,
                unit: IntervalUnit::Hours,
            },
            valid_from: None,
            valid_to: None,
            missed_policy: MissedPolicy::Catchup,
            playbook_enabled: true,
            playbook_state: PlaybookState::NotYet,
            notify_success: true,
            notify_failure: true,
            enabled: true,
            created_at: "2026-08-21T09:00:00".into(),
            last_run_at: None,
            last_run_status: None,
        }
    }

    #[test]
    fn preset_tools_mapping() {
        // 两档预设都是全量可见——收口在行为层（CLI auto 裁决 / hook allow），不在可见性
        assert_eq!(
            AutomationService::preset_tools(PermissionPreset::Auto),
            vec!["*"]
        );
        assert_eq!(
            AutomationService::preset_tools(PermissionPreset::Full),
            vec!["*"]
        );
    }

    #[test]
    fn send_command_shape_locks_protocol() {
        let cmd = AutomationService::build_send_command(
            &task(PermissionPreset::Auto),
            "run_1",
            "提示词",
            &policy("C:/ws", true, false),
        );
        // run_id 即 session_id（1:1 映射契约）
        assert_eq!(cmd["session_id"], "run_1");
        assert_eq!(cmd["permission_mode"], "auto");
        assert_eq!(cmd["auto_title"], false);
        assert_eq!(cmd["trusted"], true);
        // 工作区级索引开关随 cmd 下发（未开 → false，sidecar 不挂 codegraph MCP）
        assert_eq!(cmd["codegraph_enabled"], false);
        // 模型/effort 走 env 通道（worker 读作初始值）
        assert_eq!(cmd["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5");
        assert_eq!(cmd["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "medium");
        assert_eq!(cmd["automation"]["task_id"], "aut_test");
        assert_eq!(cmd["automation"]["run_id"], "run_1");
        assert_eq!(cmd["automation"]["preset"], "auto");
        assert_eq!(cmd["automation"]["tools"][0], "*");
        assert_eq!(cmd["automation"]["mcp_allowlist"][0], "aide-codegraph");
        // 护栏是隐形常量（用户面不收配置）：轮次恒 RUN_MAX_TURNS，不带成本上限
        assert_eq!(cmd["automation"]["max_turns"], 50);
        assert!(cmd["automation"].get("max_budget_usd").is_none());
    }

    /// 下发的带值路径（true 侧）：开关开 → cmd 带 codegraph_enabled == true，
    /// sidecar 按此挂载 aide-codegraph MCP。
    #[test]
    fn send_command_codegraph_enabled_true_side() {
        let cmd = AutomationService::build_send_command(
            &task(PermissionPreset::Auto),
            "run_3",
            "p",
            &policy("C:/ws", true, true),
        );
        assert_eq!(cmd["codegraph_enabled"], true);
    }

    #[test]
    fn send_command_full_preset_bypasses() {
        let cmd = AutomationService::build_send_command(
            &task(PermissionPreset::Full),
            "run_2",
            "p",
            &policy("C:/ws", false, false),
        );
        assert_eq!(cmd["permission_mode"], "bypassPermissions");
        assert_eq!(cmd["automation"]["preset"], "full");
    }

    #[test]
    fn send_command_empty_model_omits_env_key() {
        // 空模型 = 跟随提供商默认：env 里不出这个 key（worker 回落 provider env）
        let mut t = task(PermissionPreset::Full);
        t.model = String::new();
        let cmd =
            AutomationService::build_send_command(&t, "run_2", "p", &policy("C:/ws", false, false));
        assert!(cmd["env"].get("ANTHROPIC_MODEL").is_none());
        assert_eq!(cmd["automation"]["tools"][0], "*");
    }

    /// 「指定目录」能力契约之一：不指定时回落**基础设施**的作用域隔离目录，
    /// 而不是 automation 自己拼的路径、也不是全局 `~/.aide/claude`。
    /// 后者被 `list_workspaces()` 全量扫描，落进去就是侧栏污染（2026-09-07 bug）。
    #[test]
    fn session_dir_default_delegates_to_scoped_home() {
        let t = task(PermissionPreset::Auto);
        let dir = super::super::session_dir(&t);
        assert_eq!(
            dir,
            crate::commands::scoped_claude_home("automation", "aut_test")
        );
        // 隔离性硬断言：绝不能落在被扫描的用户工作区根下
        assert!(
            !dir.starts_with(crate::commands::claude_home()),
            "会话目录落进了全局 claude home，会被 list_workspaces 扫到：{}",
            dir.display()
        );
    }

    /// 契约之二：任务显式指定 `session_dir` 时**显式值优先**。
    #[test]
    fn session_dir_explicit_wins() {
        let mut t = task(PermissionPreset::Auto);
        t.session_dir = Some("D:/custom/cfg".into());
        assert_eq!(
            super::super::session_dir(&t),
            std::path::Path::new("D:/custom/cfg")
        );
        // 空串/空白视为未指定（前端表单清空后不应指向根路径）
        t.session_dir = Some("   ".into());
        assert_eq!(
            super::super::session_dir(&t),
            crate::commands::scoped_claude_home("automation", "aut_test")
        );
    }

    /// 契约之三：`session_dir` 是**协议里的一等字段**，不是塞在 env 里的影子参数。
    /// env 的语义是 provider 连接参数（见 session-worker.ts），混进去会让调用方
    /// 以为改 env 能改产物位置。
    #[test]
    fn send_command_session_dir_is_explicit_field_not_env() {
        let mut t = task(PermissionPreset::Auto);
        t.session_dir = Some("D:/custom/cfg".into());
        let cmd =
            AutomationService::build_send_command(&t, "run_1", "p", &policy("C:/ws", true, false));
        assert_eq!(cmd["automation"]["session_dir"], "D:/custom/cfg");
        assert!(
            cmd["env"].get("CLAUDE_CONFIG_DIR").is_none(),
            "CLAUDE_CONFIG_DIR 不该藏在 env 里（影子参数）"
        );
    }

    /// 蒸馏轮命令形状：resume 运行会话、fork 成新 id、**并带上 session_dir**。
    ///
    /// `session_dir` 是 2026-09-24 事故的回归锁：漏下发的后果是 sidecar 回落全局
    /// 配置根（`automation.ts` 的 `sessionDir ?? ""`），resume 找不到运行会话的转录，
    /// 蒸馏无声失败——执行手册一次都没生成过（runs.jsonl 的 distillCostUsd 恒 null、
    /// playbookState 恒 none、任务目录里没有 playbook.md）。
    #[test]
    fn distill_command_shape_locks_protocol() {
        let t = task(PermissionPreset::Auto);
        let run = run_record("run_1", "7576831f-d39a-4dc0-baeb-961ef8401efd");
        let pol = policy("C:/ws", true, false);
        let cmd = AutomationService::build_distill_command(&t, &run, &pol);

        // 会话 id 约定：路由键与命令 session_id 同源（<runId>-d）
        assert_eq!(cmd["session_id"], "run_1-d");
        assert_eq!(cmd["automation"]["run_id"], "run_1-d");
        // resume 运行会话本体、fork 成新 id（同 id 会让关运行 tab 的 session_stop 误杀蒸馏轮）
        assert_eq!(
            cmd["resume_session_id"],
            "7576831f-d39a-4dc0-baeb-961ef8401efd"
        );
        assert_eq!(cmd["automation"]["fork"], true);
        // 关键回归点：会话目录必须与运行轮逐字相同，否则 resume 找不到转录
        let send = AutomationService::build_send_command(&t, "run_1", "p", &pol);
        assert_eq!(cmd["automation"]["session_dir"], send["automation"]["session_dir"]);
        assert_eq!(cmd["automation"]["max_turns"], DISTILL_MAX_TURNS);
        assert!(cmd["automation"].get("max_budget_usd").is_none());
    }

    /// 防漂移锚点：两个 builder 消费**同一份** [`PathPolicy`]，共用字段必须逐字相同。
    ///
    /// 蒸馏轮漏字段是「两份 payload 各搓各的」的直接后果——只补一个字段治标，
    /// 这条同源断言才治本（字段名清单与新 payload 同步扩）。
    #[test]
    fn both_builders_agree_on_shared_fields() {
        let mut t = task(PermissionPreset::Auto);
        t.session_dir = Some("D:/custom/cfg".into());
        let run = run_record("run_9", "sdk-sid-9");
        let pol = policy("D:/ws", true, true);

        let send = AutomationService::build_send_command(&t, "run_9", "p", &pol);
        let distill = AutomationService::build_distill_command(&t, &run, &pol);

        for key in ["task_id", "preset", "task_dir", "session_dir", "mcp_allowlist"] {
            assert_eq!(
                send["automation"][key], distill["automation"][key],
                "运行轮与蒸馏轮的 automation.{key} 漂移了"
            );
        }
        // 路径政策三件套同理（同一份快照注入，不是各查各的 state）
        for key in ["cwd", "trusted", "codegraph_enabled"] {
            assert_eq!(send[key], distill[key], "{key} 漂移了");
        }
    }

    #[test]
    fn should_distill_gate() {
        let mut t = task(PermissionPreset::Auto); // playbookState = NotYet, enabled = true
        assert!(AutomationService::should_distill(&t, RunStatus::Succeeded));
        assert!(!AutomationService::should_distill(&t, RunStatus::Failed));
        t.playbook_state = PlaybookState::Ready;
        assert!(!AutomationService::should_distill(&t, RunStatus::Succeeded));
        t.playbook_state = PlaybookState::Stale; // 重提炼要蒸馏
        assert!(AutomationService::should_distill(&t, RunStatus::Succeeded));
        t.playbook_enabled = false;
        assert!(!AutomationService::should_distill(&t, RunStatus::Succeeded));
    }

    #[test]
    fn distill_prompt_contract() {
        let p = AutomationService::distill_prompt(&task(PermissionPreset::Auto));
        assert!(p.contains("playbook.md"));
        assert!(p.contains("scripts"));
        assert!(p.contains("不要继续执行任务本身"));
    }

    /// 不碰磁盘/AppHandle 的裸服务实例（绕开 new() 的 load_all_tasks）。
    fn bare_service() -> Arc<AutomationService> {
        Arc::new(AutomationService {
            tasks: Mutex::new(BTreeMap::new()),
            active_runs: Mutex::new(HashMap::new()),
            by_session: Mutex::new(HashMap::new()),
            app: OnceLock::new(),
        })
    }

    fn route(task_id: &str, run_id: &str, is_distill: bool) -> SessionRoute {
        SessionRoute {
            task_id: task_id.into(),
            run_id: run_id.into(),
            is_distill,
        }
    }

    /// 2026-08-22 回归：SessionManager 在 session_init 后把 worker re-key 成 SDK
    /// 真实 id，后续事件（message_stop/error）的 session_id 全是真实 id——路由表
    /// 必须在 session_init 时跟着过户，否则终态事件永远查不到路由，运行卡 running。
    /// 蒸馏轮变体（需要 tokio 运行时：蒸馏分支会 spawn 补写会话元数据——
    /// 任务不存在时直接早退，不落盘）。
    #[tokio::test(flavor = "current_thread")]
    async fn session_init_rekeys_route_to_sdk_id() {
        let svc = bare_service();
        svc.by_session
            .lock()
            .unwrap()
            .insert("run_1-d".to_string(), route("aut_1", "run_1", true));
        svc.observe_chat_event(&serde_json::json!({
            "type": "session_init",
            "session_id": "run_1-d",
            "sdk_session_id": "sdk-uuid-1",
        }));
        let routes = svc.by_session.lock().unwrap();
        assert!(routes.get("run_1-d").is_none(), "旧路由键应摘除");
        let r = routes.get("sdk-uuid-1").expect("路由应过户到 SDK 真实 id");
        assert_eq!(r.run_id, "run_1");
        assert!(r.is_distill);
    }

    /// 运行本体变体：过户 + active_runs 盖 sdk id。adopt 落盘走 tokio::spawn，
    /// 需要运行时；落盘目标是不存在的任务目录，读空即返回，无污染。
    #[tokio::test(flavor = "current_thread")]
    async fn session_init_rekeys_and_stamps_active_run() {
        let svc = bare_service();
        svc.by_session
            .lock()
            .unwrap()
            .insert("run_1".to_string(), route("aut_1", "run_1", false));
        svc.active_runs.lock().unwrap().insert(
            "aut_1".to_string(),
            ActiveRun {
                sdk_session_id: None,
            },
        );
        svc.observe_chat_event(&serde_json::json!({
            "type": "session_init",
            "session_id": "run_1",
            "sdk_session_id": "sdk-uuid-1",
        }));
        assert!(svc.by_session.lock().unwrap().contains_key("sdk-uuid-1"));
        let active = svc.active_runs.lock().unwrap();
        assert_eq!(
            active.get("aut_1").unwrap().sdk_session_id.as_deref(),
            Some("sdk-uuid-1")
        );
    }

    /// finalize_run 前置：活跃表 + 路由摘除（幂等关键）。运行本体路由摘除、
    /// 蒸馏路由独立生命周期保留、他人任务路由不受影响。
    #[test]
    fn finalize_detaches_active_and_routes() {
        let svc = bare_service();
        svc.active_runs.lock().unwrap().insert(
            "aut_1".to_string(),
            ActiveRun {
                sdk_session_id: None,
            },
        );
        svc.by_session
            .lock()
            .unwrap()
            .insert("run_1".to_string(), route("aut_1", "run_1", false));
        svc.by_session
            .lock()
            .unwrap()
            .insert("run_1-d".to_string(), route("aut_1", "run_1", true));
        svc.by_session
            .lock()
            .unwrap()
            .insert("run_2".to_string(), route("aut_2", "run_2", false));

        svc.detach_routes("aut_1");

        assert!(svc.active_runs.lock().unwrap().is_empty(), "活跃表应摘除");
        let routes = svc.by_session.lock().unwrap();
        assert!(routes.get("run_1").is_none(), "运行本体路由应摘除");
        assert!(routes.get("run_1-d").is_some(), "蒸馏路由独立生命周期保留");
        assert!(routes.get("run_2").is_some(), "他人任务路由不受影响");
    }

    /// 终态事件按 SDK 真实 id 命中路由的端到端锁（2026-08-22 卡 running 回归）：
    /// session_init 过户路由后，带真实 id 的 message_stop 必须找到路由并走完
    /// finalize_distill——路由摘除 + 终态事件广播断言在 tokio 任务里做。
    #[tokio::test(flavor = "current_thread")]
    async fn message_stop_after_rekey_finalizes_distill() {
        let svc = bare_service();
        svc.by_session
            .lock()
            .unwrap()
            .insert("run_1-d".to_string(), route("aut_nonexist", "run_1", true));
        svc.observe_chat_event(&serde_json::json!({
            "type": "session_init",
            "session_id": "run_1-d",
            "sdk_session_id": "sdk-uuid-1",
        }));
        svc.observe_chat_event(&serde_json::json!({
            "type": "message_stop",
            "session_id": "sdk-uuid-1",
            "stop_reason": "end_turn",
            "total_cost_usd": 0.05,
            "usage": null,
        }));
        // finalize 在 tokio::spawn 里：让出执行权等它跑完
        tokio::task::yield_now().await;
        assert!(
            svc.by_session.lock().unwrap().get("sdk-uuid-1").is_none(),
            "finalize_distill 后蒸馏路由应摘除"
        );
    }
}
