use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as TokioMutex;
pub mod bg_registry;
pub mod env;
#[cfg(windows)]
pub mod job_object;
pub mod lsp_agent;
pub mod ports;
pub mod pump;
use crate::provider::connection_fingerprint;
use crate::settings::{SettingsScope, SettingsService};
use crate::Core;
use ports::AgentHooks;

/// Per-session routing info used to scope permission-policy broadcasts.
/// `workspace_root` decides which sessions a project/local policy change
/// affects; `last_policy_revision` tracks the most recent snapshot pushed to
/// the sidecar so a runtime restart can be detected and the next `send`
/// re-attaches a fresh snapshot.
struct ActiveSessionRoute {
    workspace_root: Option<PathBuf>,
    last_policy_revision: u64,
}

/// 持久 Agent Runtime 管理器（替代 SidecarManager）。
///
/// 单一 `aide-agent.exe` 进程，内部按 session_id 多路复用多个 SessionWorker。
/// Rust 不再管理"每个会话一个进程"——只持有 Runtime 的 stdin / Child 句柄。
pub struct AgentRuntimeManager {
    stdin: Mutex<Option<Arc<TokioMutex<ChildStdin>>>>,
    child: Mutex<Option<Arc<TokioMutex<Child>>>>,
    killed: Arc<AtomicBool>,
    /// 每个 session 首次 spawn 时的连接身份指纹（base_url/api_key/auth_token/代理
    /// 子集）。跨 Runtime 重启持久——`kill_runtime` 不删它：后续 send_message 时拿它
    /// 跟当前 provider 配置比对，判断要不要 fork 绕开 CLI session 文件里缓存的旧
    /// provider 配置。
    fingerprints: Mutex<HashMap<String, BTreeMap<String, String>>>,
    /// 串行化冷启动，避免 setup 和首次发送各自 spawn 一个 Runtime。
    spawn_lock: TokioMutex<()>,
    /// session_id → 工作区路由。`send_message` 注册/刷新；权限规则保存后
    /// `broadcast_policy_change` 据此决定哪些 session 收到 `update_permission_policy`。
    session_routes: Mutex<HashMap<String, ActiveSessionRoute>>,
    /// 会话进程存活表：`session_init` 登记、`session_dead` / `stop_chat_session` /
    /// `runtime_dead` 移除。
    ///
    /// **唯一权威来源**。此前没有它，Rust 侧无从回答"这条会话的进程还活着吗"：
    ///  - 前端的 `useSessionState` 是事件驱动的镜像，远程 RPC 跑在 Rust 侧拿不到；
    ///  - `session_routes` 只在 spawn 时登记、**从不移除**（连 stop 都不清），不能当判据。
    /// 手机端据此判断"该跟随全局供应商还是锁定会话自己的供应商"（对齐桌面第 3 笔
    /// 的语义：有活进程才锁定，没活进程就跟随全局）。
    session_alive: Mutex<HashSet<String>>,
    /// 测试缝合：true 时 `send_to_runtime` 把命令录进 `sent_commands` 而非写真实
    /// stdin（单测里 stdin 永远 None）。生产恒为 false，`sent_commands` 保持空。
    test_mode: bool,
    sent_commands: Arc<Mutex<Vec<Value>>>,
    /// Windows Job Object（`KILL_ON_JOB_CLOSE`）：sidecar 及其全部后代（claude.exe /
    /// rust-analyzer / tsserver）被收进这个作业，**句柄一关就由内核连根杀掉**——
    /// aide.exe 被强杀也收得干净。`kill_runtime` 显式 take 掉它，Runtime 重启不留旧树。
    /// 见 `runtime/job_object.rs`。
    #[cfg(windows)]
    job: Mutex<Option<job_object::KillOnCloseJob>>,
    /// 后台任务注册表：远程快照源（list_bg_tasks）。事件泵喂、Runtime 死亡清空。
    pub bg_tasks: bg_registry::BgTaskRegistry,
    /// GUI 侧能力（浏览器查询 / 诊断 / 自动化观测），挂 GUI 的前门注入。见 [`ports`]。
    hooks: OnceLock<Box<dyn AgentHooks>>,
}

impl AgentRuntimeManager {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            killed: Arc::new(AtomicBool::new(false)),
            fingerprints: Mutex::new(HashMap::new()),
            spawn_lock: TokioMutex::new(()),
            session_routes: Mutex::new(HashMap::new()),
            session_alive: Mutex::new(HashSet::new()),
            test_mode: false,
            sent_commands: Arc::new(Mutex::new(Vec::new())),
            #[cfg(windows)]
            job: Mutex::new(None),
            bg_tasks: bg_registry::BgTaskRegistry::default(),
            hooks: OnceLock::new(),
        }
    }

    /// 注入 GUI 侧钩子（启动时一次；第二次被忽略）。
    pub fn set_hooks(&self, hooks: Box<dyn AgentHooks>) {
        let _ = self.hooks.set(hooks);
    }

    pub fn hooks(&self) -> Option<&dyn AgentHooks> {
        self.hooks.get().map(|h| h.as_ref())
    }


    /// 测试专用构造器：`send_to_runtime` 录制命令而非写 stdin。
    #[cfg(test)]
    pub fn new_for_test() -> Self {
        let mut mgr = Self::new();
        mgr.test_mode = true;
        mgr
    }

    /// 本机 Runtime 进程是否已拉起（stdin 在手）。
    pub fn is_running(&self) -> bool {
        self.stdin.lock().unwrap().is_some()
    }

    /// 幂等地启动 Runtime；应用冷启动与首个图片预检共享同一把启动锁。
    pub async fn ensure_runtime(
        &self,
        core: &Arc<Core>,
        env_vars: HashMap<String, String>,
    ) -> Result<(), String> {
        let _spawn_guard = self.spawn_lock.lock().await;
        if self.stdin.lock().unwrap().is_some() {
            return Ok(());
        }
        self.spawn_runtime(core, env_vars)
    }

    /// App 启动时调用一次：启动 persistent aide-agent.exe 进程。
    /// 通过 `&self` + 内部 Mutex 实现，Tauri State 可共享访问。
    pub fn spawn_runtime(
        &self,
        core: &Arc<Core>,
        env_vars: HashMap<String, String>,
    ) -> Result<(), String> {
        // dev：node runtime.js；release：aide-agent 独立可执行文件（arg 为空）。前门回答。
        let (bin, arg) = core.resources.agent_runtime()?;

        let mut cmd = tokio::process::Command::new(&bin);
        if !arg.as_os_str().is_empty() {
            cmd.arg(&arg);
        }

        cmd.current_dir(std::env::current_dir().unwrap_or_default())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Git Bash PATH（Windows）
        #[cfg(windows)]
        {
            if let Some(path) = windows_path_with_git_usr_bin() {
                cmd.env("PATH", path);
            }
        }

        // Host 给 sidecar 的进程级 env（远程 Host：桌面带过来的工具开关 / 代理兜底）；
        // 在 provider 参数之前写，provider 同名键以 provider 为准。
        for (k, v) in core.resources.agent_env() {
            cmd.env(k, v);
        }

        // 透传 provider 连接参数（由调用方 build_runtime_env_vars 组好传入）
        for (k, v) in &env_vars {
            cmd.env(k, v);
        }

        // CLAUDE_CONFIG_DIR：让 claude.exe 把所有自有数据（settings.json / CLAUDE.md /
        // agents/ / skills/ / projects/ / sessions/ / plugins/）写到 Aide 自管理目录
        // 下的 claude/ 子目录，而非回退到用户系统的 ~/.claude/。必须注在 env_vars 循环
        // 之后——build_runtime_env_vars 的 fallback 列表里也含 CLAUDE_CONFIG_DIR，若进程
        // env 有用户自定义值会被透传进 env_vars，这里显式覆盖以保证始终指向自管理目录。
        // 与 AIDE_ENABLED_PLUGINS_FILE 同属「Aide 自管理路径 env」，注在同一处。
        let claude_config_dir = crate::paths::our_config_dir().join("claude");
        cmd.env("CLAUDE_CONFIG_DIR", dunce::simplified(&claude_config_dir));

        // 插件桥接清单
        let manifest = crate::commands::marketplace::enabled_plugins_manifest_path();
        cmd.env("AIDE_ENABLED_PLUGINS_FILE", dunce::simplified(&manifest));

        // 知识库凭据文件的**路径**（凭据本体走文件、不走 env——env 会被 Bash 工具
        // 子进程继承，模型跑 `env` 即可外带，见 agent-sidecar/src/engine/sessionMetadata.ts）。
        let kb_config = crate::commands::knowledge::kb_config_path();
        cmd.env("AIDE_KB_CONFIG_FILE", dunce::simplified(&kb_config));

        // 原生 claude CLI：release 随 app 分发、dev 取 agent-sidecar 的 SDK 平台包（前门回答）。
        // 不设的话 SDK 会 `which claude` 回退到用户系统装的 CLI，违背「Aide 不依赖
        // 系统 Claude CLI」的目标。
        if let Some(claude_exe) = core.resources.claude_exe() {
            cmd.env("AIDE_CLAUDE_EXE", claude_exe);
        }

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 Agent Runtime（bin: {bin}）：{e}。"))?;
        #[cfg(windows)]
        self.attach_job_object(&child);
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        *self.stdin.lock().unwrap() = Some(Arc::new(TokioMutex::new(stdin)));
        *self.child.lock().unwrap() = Some(Arc::new(TokioMutex::new(child)));

        pump::start(pump::Pump {
            core: Arc::clone(core),
            stdout,
            stderr,
            stdin: self.stdin.lock().unwrap().as_ref().ok_or("stdin not set")?.clone(),
            child: self.child.lock().unwrap().as_ref().ok_or("child not set")?.clone(),
            killed: Arc::clone(&self.killed),
        });

        Ok(())
    }

    /// 命令按会话所在车道写入：绑定了远程车道的会话写那台主机的 sidecar，其余写本机
    /// Runtime（命令都带 session_id 字段，Runtime 内部再按会话路由）。
    pub async fn send_to_runtime(&self, cmd: &Value) -> Result<(), String> {
        if self.test_mode {
            self.sent_commands.lock().unwrap().push(cmd.clone());
            return Ok(());
        }
        let stdin = {
            let guard = self.stdin.lock().unwrap();
            guard.as_ref().ok_or("Runtime not spawned")?.clone()
        };
        let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut guard = stdin.lock().await;
        guard
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())
    }

    /// 把 sidecar 收进 `KILL_ON_JOB_CLOSE` 的 Job Object（见 `runtime/job_object.rs`）。
    /// 装配失败**不阻断启动**：降级为 sidecar 侧 `subprocessReaper` 的收尾兜底，只留警告。
    #[cfg(windows)]
    fn attach_job_object(&self, child: &Child) {
        use windows::Win32::Foundation::HANDLE;
        let Some(handle) = child.raw_handle() else {
            tracing::warn!("runtime: 拿不到 sidecar 进程句柄，Job Object 未装配（降级 sidecar 兜底）");
            return;
        };
        match job_object::KillOnCloseJob::assign(HANDLE(handle as _)) {
            Ok(job) => *self.job.lock().unwrap() = Some(job),
            Err(e) => {
                tracing::warn!(error = %e, "runtime: Job Object 装配失败（降级 sidecar 兜底）")
            }
        }
    }

    /// 杀死 Runtime 进程（全局 stop / app 退出）。
    ///
    /// 调用点：托盘菜单「退出 Aide」经 `commands::app::shutdown_children` 调到这里
    /// ——aide.exe 退出不会带走 node 子进程，必须显式收。
    pub async fn kill_runtime(&self) {
        self.killed.store(true, Ordering::Relaxed);
        // Job Object 先放：句柄一关，内核把 sidecar **及其全部后代**（claude.exe /
        // rust-analyzer / typescript-language-server）连根收掉。下面的 start_kill()
        // 只杀得掉 sidecar 自己，而且 TerminateProcess 不会执行它内部的收尾钩子。
        #[cfg(windows)]
        self.job.lock().unwrap().take();
        let child = { self.child.lock().unwrap().clone() };
        if let Some(child_arc) = child {
            let mut c = child_arc.lock().await;
            let _ = c.start_kill();
        }
    }

    /// 连接身份漂移检测：仅在新 session send 前调用。
    /// 持久化指纹存在且与当前 env 不一致 → true（需要 forkSession）。
    pub fn connection_drifted(&self, session_id: &str, env_vars: &HashMap<String, String>) -> bool {
        let fps = self.fingerprints.lock().unwrap();
        match fps.get(session_id) {
            None => false,
            Some(old) => *old != connection_fingerprint(env_vars),
        }
    }

    /// 记录/更新一个 session 的连接身份指纹（首次 send 时调用）。
    pub fn upsert_fingerprint(&self, session_id: &str, env_vars: &HashMap<String, String>) {
        self.fingerprints
            .lock()
            .unwrap()
            .insert(session_id.to_string(), connection_fingerprint(env_vars));
    }

    /// 记录/刷新一个 session 的工作区路由（`send_message` 在发出 send 前调用）。
    /// `cwd` 为 None 时不覆盖已有 workspace_root（保留首条 send 注册的值）。
    pub fn register_session_route(&self, session_id: &str, cwd: Option<&std::path::Path>) {
        let mut routes = self.session_routes.lock().unwrap();
        let entry = routes
            .entry(session_id.to_string())
            .or_insert(ActiveSessionRoute {
                workspace_root: None,
                last_policy_revision: 0,
            });
        if let Some(c) = cwd {
            entry.workspace_root = Some(c.to_path_buf());
        }
    }

    /// 查询会话注册的工作区根（`send_message` 时注册/刷新）。
    /// 桌面通知按 session 反查所属工作区用；未注册（从未 send）返回 None。
    // ── 会话进程存活表（远程端判断供应商口径的唯一权威来源）──

    /// 登记会话进程存活（`session_init` 到达时）。
    pub fn mark_session_alive(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        self.session_alive
            .lock()
            .unwrap()
            .insert(session_id.to_string());
    }

    /// 标记会话进程结束（`session_dead` 事件 / `stop_chat_session` 命令）。
    pub fn mark_session_dead(&self, session_id: &str) {
        self.session_alive.lock().unwrap().remove(session_id);
    }

    /// 会话进程是否存活。手机端据此判断：存活 → 锁定会话自己的供应商；
    /// 未存活 → 跟随全局激活供应商（与桌面「有活进程才锁定」同一语义）。
    pub fn is_session_alive(&self, session_id: &str) -> bool {
        self.session_alive.lock().unwrap().contains(session_id)
    }

    /// Runtime 进程整体死亡：所有会话一并标记结束（同 `bg_registry.clear_all`）。
    pub fn clear_all_session_alive(&self) {
        self.session_alive.lock().unwrap().clear();
    }

    pub fn session_workspace_root(&self, session_id: &str) -> Option<PathBuf> {
        self.session_routes
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|route| route.workspace_root.clone())
    }

    /// 权限规则保存成功后，向受影响的 session 推送新快照。
    /// user/managed/session 影响所有 session；project/local 只影响同 project root
    /// 的 session。每条发 `{cmd:"update_permission_policy", session_id, policy}`，
    /// 走既有 stdin 通道——不新建 stdout event、不动 delta coalescer。Runtime 不存在
    /// 或已重启时 send 失败静默：route 保留，下一条 send 自动补发新快照。
    pub async fn broadcast_policy_change(
        &self,
        affected_scope: SettingsScope,
        affected_root: Option<&std::path::Path>,
        service: &SettingsService,
    ) {
        let targets: Vec<(String, Option<PathBuf>)> = {
            let routes = self.session_routes.lock().unwrap();
            routes
                .iter()
                .filter_map(|(sid, route)| {
                    let affected = match affected_scope {
                        SettingsScope::Managed | SettingsScope::User | SettingsScope::Session => {
                            true
                        }
                        SettingsScope::Project | SettingsScope::Local => {
                            route.workspace_root.as_deref() == affected_root
                        }
                    };
                    if affected {
                        Some((sid.clone(), route.workspace_root.clone()))
                    } else {
                        None
                    }
                })
                .collect()
        };

        for (sid, workspace) in targets {
            let snapshot = match service.permission_snapshot_blocking(workspace.as_deref()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let revision = snapshot.revision;
            let cmd = serde_json::json!({
                "cmd": "update_permission_policy",
                "session_id": sid,
                "policy": snapshot,
            });
            if self.send_to_runtime(&cmd).await.is_ok() {
                if let Some(route) = self.session_routes.lock().unwrap().get_mut(&sid) {
                    route.last_policy_revision = revision;
                }
            }
        }
    }

    /// 测试缝合：读取已录制的命令（仅 `new_for_test()` 构造的实例会录制）。
    #[cfg(test)]
    pub fn sent_commands(&self) -> Vec<Value> {
        self.sent_commands.lock().unwrap().clone()
    }

    /// 测试缝合：清空已录制的命令。
    #[cfg(test)]
    pub fn clear_sent_commands(&self) {
        self.sent_commands.lock().unwrap().clear();
    }
}

/// Host 启动时拉起 Runtime：按当前激活供应商 + 代理设置组好进程 env（幂等，已在跑则不动）。
/// 桌面 setup 与 `aide-host serve` 共用。
pub async fn start_with_active_provider(core: &Arc<Core>) -> Result<(), String> {
    let settings = core.settings.clone();
    let (active, proxy) = crate::registry::blocking(move || {
        let active = settings
            .resolve_active_runtime_provider()
            .map_err(|error| error.to_string())?;
        let proxy = crate::app_settings::public_settings(&settings)?.proxy;
        Ok((active, proxy))
    })
    .await
    .map_err(|e| format!("unable to resolve initial provider settings: {e}"))?;
    let env_vars = env::build_runtime_env_vars(&active, &proxy);
    core.runtime.ensure_runtime(core, env_vars).await
}

fn emit_runtime_dead(core: &Core, tail_handle: &Arc<Mutex<VecDeque<String>>>, reason: &str) {
    let tail: Vec<String> = tail_handle.lock().unwrap().iter().cloned().collect();
    let detail = if tail.is_empty() {
        None
    } else {
        Some(tail.join("\n"))
    };
    if let Some(hooks) = core.runtime.hooks() {
        hooks.runtime_dead(reason);
    }
    // Runtime 进程整体死亡：所有会话的后台任务随之覆灭，注册表全清
    // （sidecar 没机会发终态事件，不清会让快照里的任务永卡 running）。
    core.runtime.bg_tasks.clear_all();
    // 同理：存活表全清（没有 session_dead 会来，不清会让手机端一直以为会话还活着
    // → 一直锁定旧供应商、切不动）。
    core.runtime.clear_all_session_alive();
    let event = serde_json::json!({
        "type": "runtime_dead",
        "reason": reason,
        "detail": detail,
    });
    core.emit("chat-event", event);
}

#[cfg(windows)]
fn windows_path_with_git_usr_bin() -> Option<String> {
    let git_exe = which::which("git").ok()?;
    let usr_bin = git_install_usr_bin(git_exe.parent()?)?;
    if !usr_bin.is_dir() {
        return None;
    }
    let current_path = std::env::var("PATH").unwrap_or_default();
    Some(prepend_path_entry(
        &crate::runtime::env::strip_cargo_target_segments(&current_path),
        &usr_bin.to_string_lossy(),
    ))
}

/// 从 git.exe 所在目录向上找 Git 安装根下的 `usr\bin`。
/// which 可能解析到 `Git\cmd\git.exe`（cmd 前置时）或 `Git\usr\bin\git.exe`
/// （usr\bin 前置时，如 MSYS shell 启动的进程）——旧的「固定上溯两层」算法
/// 在后者会算出 `Git\usr\usr\bin`（不存在）→ None → 整个 PATH 重建被静默
/// 跳过，子进程链原样继承脏 PATH（2026-09-09 实锤：dev 从 MSYS bash 启动时
/// LSP 报 "rust-analyzer not found" 的第二处根因）。
#[cfg(windows)]
fn git_install_usr_bin(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..4 {
        let candidate = dir.join("usr").join("bin");
        if candidate.is_dir() {
            return Some(candidate);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

#[cfg(windows)]
fn prepend_path_entry(path: &str, extra: &str) -> String {
    if extra.is_empty() {
        return path.to_string();
    }
    let already_present = path.split(';').any(|p| p.eq_ignore_ascii_case(extra));
    if already_present {
        path.to_string()
    } else if path.is_empty() {
        extra.to_string()
    } else {
        format!("{extra};{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_adds_when_missing() {
        let result = prepend_path_entry("C:\\Windows;C:\\Windows\\System32", "C:\\Git\\usr\\bin");
        assert_eq!(
            result,
            "C:\\Git\\usr\\bin;C:\\Windows;C:\\Windows\\System32"
        );
    }

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_skips_when_already_present() {
        let path = "C:\\Git\\usr\\bin;C:\\Windows";
        let result = prepend_path_entry(path, "C:\\Git\\usr\\bin");
        assert_eq!(result, path);
    }

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_is_case_insensitive() {
        let path = "c:\\git\\usr\\bin;C:\\Windows";
        let result = prepend_path_entry(path, "C:\\Git\\usr\\bin");
        assert_eq!(result, path);
    }

    #[test]
    #[cfg(windows)]
    fn git_install_usr_bin_finds_root_from_cmd_layout() {
        // git 解析自 Git\cmd\git.exe（cmd 前置的标准安装）
        let root = std::env::temp_dir().join("aide-test-gitroot-cmd");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Git").join("cmd")).unwrap();
        std::fs::create_dir_all(root.join("Git").join("usr").join("bin")).unwrap();
        let found = git_install_usr_bin(&root.join("Git").join("cmd"));
        assert_eq!(found, Some(root.join("Git").join("usr").join("bin")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(windows)]
    fn git_install_usr_bin_finds_root_from_usr_bin_layout() {
        // which 解析到 Git\usr\bin\git.exe（usr\bin 前置，MSYS shell 启动的进程）——
        // 旧的固定两层算法在这里算出 Git\usr\usr\bin 而失败
        let root = std::env::temp_dir().join("aide-test-gitroot-usrbin");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Git").join("usr").join("bin")).unwrap();
        let found = git_install_usr_bin(&root.join("Git").join("usr").join("bin"));
        assert_eq!(found, Some(root.join("Git").join("usr").join("bin")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(windows)]
    fn git_install_usr_bin_returns_none_without_usr_bin() {
        let root = std::env::temp_dir().join("aide-test-gitroot-none");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Git").join("cmd")).unwrap();
        assert_eq!(git_install_usr_bin(&root.join("Git").join("cmd")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_handles_empty_path() {
        let result = prepend_path_entry("", "C:\\Git\\usr\\bin");
        assert_eq!(result, "C:\\Git\\usr\\bin");
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn connection_drifted_false_for_brand_new_session() {
        let mgr = AgentRuntimeManager::new();
        let env_vars = env(&[("ANTHROPIC_BASE_URL", "https://api.anthropic.com")]);
        assert!(!mgr.connection_drifted("no-such-session", &env_vars));
    }

    #[test]
    fn connection_drifted_false_when_same_provider_resume() {
        let mgr = AgentRuntimeManager::new();
        let fp = connection_fingerprint(&env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
        ]));
        mgr.fingerprints
            .lock()
            .unwrap()
            .insert("s1".to_string(), fp);
        let desired = env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
            ("ANTHROPIC_MODEL", "claude-sonnet-5"),
        ]);
        assert!(!mgr.connection_drifted("s1", &desired));
    }

    #[test]
    fn connection_drifted_true_when_provider_switched() {
        let mgr = AgentRuntimeManager::new();
        let fp = connection_fingerprint(&env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
        ]));
        mgr.fingerprints
            .lock()
            .unwrap()
            .insert("s1".to_string(), fp);
        let desired = env(&[
            ("ANTHROPIC_BASE_URL", "https://provider-b.example.com"),
            ("ANTHROPIC_API_KEY", "key-b"),
        ]);
        assert!(mgr.connection_drifted("s1", &desired));
    }

    #[test]
    fn fingerprints_survive_runtime_kill() {
        let mgr = AgentRuntimeManager::new();
        let fp =
            connection_fingerprint(&env(&[("ANTHROPIC_BASE_URL", "https://api.anthropic.com")]));
        mgr.fingerprints
            .lock()
            .unwrap()
            .insert("s1".to_string(), fp.clone());
        assert!(mgr.fingerprints.lock().unwrap().contains_key("s1"));
        let desired = env(&[("ANTHROPIC_BASE_URL", "https://provider-b.example.com")]);
        assert!(mgr.connection_drifted("s1", &desired));
    }

    #[test]
    fn session_alive_lifecycle() {
        let mgr = AgentRuntimeManager::new();
        // 初始为空
        assert!(!mgr.is_session_alive("s1"));
        // session_init 登记
        mgr.mark_session_alive("s1");
        assert!(mgr.is_session_alive("s1"));
        // session_dead / stop 移除
        mgr.mark_session_dead("s1");
        assert!(!mgr.is_session_alive("s1"));
        // 未登记过的 sid 移除不崩、仍为 false
        mgr.mark_session_dead("never-existed");
        assert!(!mgr.is_session_alive("never-existed"));
        // 空 id 不登记（防事件缺 session_id 时污染成 "" 键）
        mgr.mark_session_alive("");
        assert!(!mgr.is_session_alive(""));
    }

    #[test]
    fn runtime_dead_clears_all_session_alive() {
        // 回归：进程整体死亡时没有 session_dead 会来，不清会让远程端一直以为
        // 会话还活着 → 一直锁定旧供应商、切不动。
        let mgr = AgentRuntimeManager::new();
        mgr.mark_session_alive("s1");
        mgr.mark_session_alive("s2");
        mgr.clear_all_session_alive();
        assert!(!mgr.is_session_alive("s1"));
        assert!(!mgr.is_session_alive("s2"));
    }
}
