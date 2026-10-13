//! `process.*`：应用在工作区里起的进程。归 Host 管，不归面板——面板关了、重载了、用户切去看别的
//! 工程，进程照跑；输出留在这里的环形缓冲里，面板回来按序号续上。
//!
//! 为什么不复用运行配置那条 PTY 路（`pty::spawn_run_command`）：那边的输出是「取走即清空」的轮询
//! 缓冲（续不上）、退出只报成败（没有退出码）、命令是一条 shell 字符串。这里要的正相反：
//! - **不经 shell**：`command + args` 原样交给系统，应用从工程文件里读出的名字拼不成注入；
//! - **管道**：干净的行输出，应用能按行解析报错位置，退出码是真的；
//! - **输出正文不走事件**：事件只报「有新输出」和最新序号（经 Host 的事件总线，载荷很小），
//!   正文由界面按序号来取。总线的留底是对话断线续传的依据，一次构建的日志不能把它挤掉。
//!
//! 进程记在（应用, 工作区）名下：应用只看得到、动得了自己在当前工作区起的那些。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

/// 一个应用同时在跑的进程数上限（所有工作区合计）。
const MAX_RUNNING_PER_APP: usize = 4;
const MAX_LINES: usize = 5000;
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// 没有换行的输出攒到这么长就切成一行（进度条、压成一行的 JSON）。
const MAX_LINE_BYTES: usize = 8 * 1024;
/// 一次 `attach` 最多给这么多行，剩下的下一次再取。
const MAX_ATTACH_LINES: usize = 2000;
const MAX_ARGS: usize = 256;
const MAX_ARG_BYTES: usize = 32 * 1024;
/// 多久看一次有没有新输出要通知。
const NOTIFY_EVERY: Duration = Duration::from_millis(150);
/// 跑完的进程留这么久，供面板回来看结果；之后忘掉。
const KEEP_FINISHED: Duration = Duration::from_secs(600);
/// 先礼后兵：礼貌地请它退出，这么久还在就强杀。
const KILL_GRACE: Duration = Duration::from_secs(3);

/// 进程池往外说话的口子（测试里换成记录器）。
pub trait Listener: Send + Sync {
    /// 给某个应用的面板发一条事件。
    /// `workspace` = 这条事件属于哪个工作区的面板；`None` = 应用不在任何工作区里。
    fn event(&self, app_id: &str, workspace: Option<&Path>, channel: &str, payload: Value);
    /// 「正在运行」的清单变了（起了一个 / 结束了一个）。
    fn changed(&self);
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Stream {
    Stdout,
    Stderr,
}

struct Line {
    seq: u64,
    stream: Stream,
    text: String,
}

#[derive(Default)]
struct State {
    lines: VecDeque<Line>,
    bytes: usize,
    /// 最新一行的序号（从 1 起；0 = 还没有输出）。
    head: u64,
    /// `Some` = 已结束；里面是退出码（被信号杀掉的没有退出码）。
    exit: Option<Option<i32>>,
    ended: Option<(Instant, u64)>,
    /// 是被我们结束的（用户点了结束 / 应用被停用），不是自己跑完的。
    killed: bool,
}

struct Proc {
    id: String,
    app_id: String,
    workspace: PathBuf,
    /// 给人看的命令行。
    command: String,
    cwd: String,
    started_at: u64,
    pid: u32,
    state: Mutex<State>,
}

impl Proc {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn running(&self) -> bool {
        self.state().exit.is_none()
    }

    fn push(&self, stream: Stream, text: String) {
        let mut st = self.state();
        st.head += 1;
        st.bytes += text.len();
        let seq = st.head;
        st.lines.push_back(Line { seq, stream, text });
        while st.lines.len() > MAX_LINES || (st.bytes > MAX_BYTES && st.lines.len() > 1) {
            if let Some(old) = st.lines.pop_front() {
                st.bytes -= old.text.len();
            }
        }
    }

    fn info(&self) -> ProcessInfo {
        let st = self.state();
        ProcessInfo {
            run_id: self.id.clone(),
            app_id: self.app_id.clone(),
            workspace: self.workspace.to_string_lossy().into_owned(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at: self.started_at,
            running: st.exit.is_none(),
            code: st.exit.flatten(),
            killed: st.killed,
            ended_at: st.ended.map(|(_, at)| at),
        }
    }

    fn channel(&self) -> String {
        format!("process:{}", self.id)
    }
}

/// 一个进程给外面看的样子（面板的 `process.list`、Aide 自己的「正在运行」清单同形）。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub run_id: String,
    pub app_id: String,
    pub workspace: String,
    pub command: String,
    /// 相对工作区根；空串 = 根。
    pub cwd: String,
    /// 毫秒时间戳。
    pub started_at: u64,
    pub running: bool,
    pub code: Option<i32>,
    pub killed: bool,
    pub ended_at: Option<u64>,
}

/// `process.run` 的入参（已由桥从 JSON 里取出并校验过形状）。
pub struct RunRequest {
    pub command: String,
    pub args: Vec<String>,
    /// 已解析、确认在工作区内的真实目录。
    pub cwd: PathBuf,
    /// 上面那个目录相对工作区根的写法（给人看）。
    pub cwd_rel: String,
    pub env: BTreeMap<String, String>,
}

impl RunRequest {
    /// 从应用给的参数里取。`cwd` 由调用方解析好传进来（越界判断在 `wsfs`）。
    pub fn parse(params: &Value, cwd: PathBuf, cwd_rel: String) -> Result<Self, String> {
        let command = params.get("command").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if command.is_empty() || command.contains('\0') {
            return Err("process.run 需要 command（可执行文件的名字或路径，不是一整条命令行）".into());
        }
        let args = match params.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| v.as_str().map(str::to_string).ok_or("args 的每一项都必须是字符串"))
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err("args 必须是字符串数组".into()),
        };
        if args.len() > MAX_ARGS || args.iter().any(|a| a.len() > MAX_ARG_BYTES || a.contains('\0')) {
            return Err("args 太多或太长".into());
        }
        let mut env = BTreeMap::new();
        match params.get("env") {
            None | Some(Value::Null) => {}
            Some(Value::Object(map)) => {
                for (key, value) in map {
                    let value = value.as_str().ok_or("env 的值必须是字符串")?;
                    if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                        return Err(format!("env 里的「{key}」不合法"));
                    }
                    env.insert(key.clone(), value.to_string());
                }
            }
            Some(_) => return Err("env 必须是 { 名字: 值 } 的对象".into()),
        }
        Ok(Self { command, args, cwd, cwd_rel, env })
    }

    fn display(&self) -> String {
        std::iter::once(&self.command).chain(&self.args).cloned().collect::<Vec<_>>().join(" ")
    }
}

/// 把命令名解析成可执行文件。带路径分隔符的按路径算（相对的相对 `cwd`），否则在 PATH 里找
/// （应用给了 PATH 就用它的）。Windows 上 `.cmd` / `.bat` 垫片也在这里找到——交给
/// `Command` 之后由标准库负责包 `cmd /c` 和转义，转义不了的参数它会拒绝而不是硬拼。
fn resolve(req: &RunRequest) -> Result<PathBuf, String> {
    let path = req.env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok());
    which::which_in(&req.command, path, &req.cwd).map_err(|_| format!("找不到命令「{}」", req.command))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct ProcessPool {
    procs: Arc<Mutex<HashMap<String, Arc<Proc>>>>,
    next: AtomicU64,
}

impl Default for ProcessPool {
    fn default() -> Self {
        Self { procs: Arc::default(), next: AtomicU64::new(1) }
    }
}

impl Drop for ProcessPool {
    fn drop(&mut self) {
        self.kill_all_now();
    }
}

impl ProcessPool {
    fn all(&self) -> Vec<Arc<Proc>> {
        let mut procs = self.procs.lock().unwrap_or_else(PoisonError::into_inner);
        procs.retain(|_, p| p.state().ended.is_none_or(|(at, _)| at.elapsed() < KEEP_FINISHED));
        let mut list: Vec<_> = procs.values().cloned().collect();
        list.sort_by_key(|p| p.started_at);
        list
    }

    /// 应用名下、这个工作区里的那一个；不是它的就当不存在（不泄露别人的进程在不在）。
    fn owned(&self, app_id: &str, workspace: &Path, run_id: &str) -> Result<Arc<Proc>, String> {
        self.all()
            .into_iter()
            .find(|p| p.id == run_id && p.app_id == app_id && p.workspace == workspace)
            .ok_or_else(|| format!("没有这个进程：{run_id}"))
    }

    pub fn run(
        &self,
        app_id: &str,
        workspace: &Path,
        req: RunRequest,
        listener: Arc<dyn Listener>,
    ) -> Result<ProcessInfo, String> {
        let running = self.all().iter().filter(|p| p.app_id == app_id && p.running()).count();
        if running >= MAX_RUNNING_PER_APP {
            return Err(format!("这个应用已经有 {running} 个进程在跑（上限 {MAX_RUNNING_PER_APP}），先结束一个"));
        }
        let program = resolve(&req)?;
        let mut cmd = Command::new(&program);
        cmd.args(&req.args)
            .current_dir(&req.cwd)
            .envs(&req.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        #[cfg(unix)]
        {
            // 自成一个进程组：结束时连它起的子孙一起结束（包装脚本后面才是真正干活的进程）
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("「{}」启动失败：{e}", req.command))?;
        let stdout = child.stdout.take().ok_or("进程没有 stdout")?;
        let stderr = child.stderr.take().ok_or("进程没有 stderr")?;

        let proc = Arc::new(Proc {
            id: format!("r{}", self.next.fetch_add(1, Ordering::Relaxed)),
            app_id: app_id.to_string(),
            workspace: workspace.to_path_buf(),
            command: req.display(),
            cwd: req.cwd_rel.clone(),
            started_at: now_ms(),
            pid: child.id(),
            state: Mutex::default(),
        });
        self.procs.lock().unwrap_or_else(PoisonError::into_inner).insert(proc.id.clone(), Arc::clone(&proc));

        let readers = [
            pump(Arc::clone(&proc), Stream::Stdout, stdout),
            pump(Arc::clone(&proc), Stream::Stderr, stderr),
        ];
        // 通知线程：有新输出就报一次最新序号（节流），直到进程结束
        {
            let (proc, listener) = (Arc::clone(&proc), Arc::clone(&listener));
            std::thread::spawn(move || {
                let mut told = 0;
                loop {
                    std::thread::sleep(NOTIFY_EVERY);
                    let (head, done) = {
                        let st = proc.state();
                        (st.head, st.exit.is_some())
                    };
                    if head != told {
                        told = head;
                        listener.event(&proc.app_id, Some(&proc.workspace), &proc.channel(), json!({ "type": "output", "head": head }));
                    }
                    if done {
                        return;
                    }
                }
            });
        }
        // 等它结束：先等两条管道读完（输出收齐了才算结束），再收退出码
        {
            let (proc, listener) = (Arc::clone(&proc), Arc::clone(&listener));
            std::thread::spawn(move || {
                for reader in readers {
                    let _ = reader.join();
                }
                let code = child.wait().ok().and_then(|status| status.code());
                let (head, killed) = {
                    let mut st = proc.state();
                    st.exit = Some(code);
                    st.ended = Some((Instant::now(), now_ms()));
                    (st.head, st.killed)
                };
                listener.event(
                    &proc.app_id,
                    Some(&proc.workspace),
                    &proc.channel(),
                    json!({ "type": "exit", "code": code, "killed": killed, "head": head }),
                );
                listener.changed();
            });
        }
        listener.changed();
        Ok(proc.info())
    }

    /// 应用自己在这个工作区里的进程（含刚结束不久的）。
    pub fn list(&self, app_id: &str, workspace: &Path) -> Vec<ProcessInfo> {
        self.all().iter().filter(|p| p.app_id == app_id && p.workspace == workspace).map(|p| p.info()).collect()
    }

    /// 所有应用、所有工作区的（Aide 自己的「正在运行」清单用）。
    pub fn list_all(&self) -> Vec<ProcessInfo> {
        self.all().iter().map(|p| p.info()).collect()
    }

    /// 序号大于 `since` 的输出。缓冲已经滚过去的部分取不到，`first` 告诉调用方现在最早是哪一行。
    pub fn attach(&self, app_id: &str, workspace: &Path, run_id: &str, since: u64) -> Result<Value, String> {
        let proc = self.owned(app_id, workspace, run_id)?;
        let st = proc.state();
        let lines: Vec<Value> = st
            .lines
            .iter()
            .filter(|l| l.seq > since)
            .take(MAX_ATTACH_LINES)
            .map(|l| json!({ "seq": l.seq, "stream": l.stream, "text": l.text }))
            .collect();
        Ok(json!({
            "lines": lines,
            "first": st.lines.front().map_or(st.head + 1, |l| l.seq),
            "head": st.head,
            "running": st.exit.is_none(),
            "code": st.exit.flatten(),
            "killed": st.killed,
        }))
    }

    pub fn kill(&self, app_id: &str, workspace: &Path, run_id: &str) -> Result<(), String> {
        end(&self.owned(app_id, workspace, run_id)?);
        Ok(())
    }

    /// 用户在 Aide 自己的清单里点了结束：不问是哪个应用的。
    pub fn kill_any(&self, run_id: &str) -> Result<(), String> {
        let proc = self.all().into_iter().find(|p| p.id == run_id).ok_or_else(|| format!("没有这个进程：{run_id}"))?;
        end(&proc);
        Ok(())
    }

    /// 应用被禁用 / 卸载：它起的进程一并结束。
    pub fn stop_app(&self, app_id: &str) {
        for proc in self.all().iter().filter(|p| p.app_id == app_id) {
            end(proc);
        }
    }

    /// 满足条件的应用进程一并结束（开发态应用随它的工作区卸载时用）。
    pub fn stop_where(&self, gone: &dyn Fn(&str, &Path) -> bool) {
        for proc in self.all().iter().filter(|p| gone(&p.app_id, &p.workspace)) {
            end(proc);
        }
    }

    pub fn stop_all(&self) {
        for proc in self.all() {
            end(&proc);
        }
    }

    /// Host 要退了：没有「等三秒再强杀」的余地（等的那条线程活不到那时候），直接强杀。
    pub fn kill_all_now(&self) {
        for proc in self.all() {
            let mut st = proc.state();
            if st.exit.is_none() {
                st.killed = true;
                drop(st);
                signal(proc.pid, true);
            }
        }
    }
}

/// 一条管道读到底，按行进缓冲。`\r` 也算换行（进度条靠它原地刷新，不切就是一行几 MB）。
fn pump(proc: Arc<Proc>, stream: Stream, mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut line: Vec<u8> = Vec::new();
        let flush = |line: &mut Vec<u8>| {
            if !line.is_empty() {
                proc.push(stream, decode(line));
                line.clear();
            }
        };
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &byte in &chunk[..n] {
                        if byte == b'\n' || byte == b'\r' {
                            flush(&mut line);
                        } else {
                            line.push(byte);
                            if line.len() >= MAX_LINE_BYTES {
                                flush(&mut line);
                            }
                        }
                    }
                }
            }
        }
        flush(&mut line);
    })
}

/// 一行输出的字节 → 文字。管道里没有「控制台代码页」这回事，程序各写各的：多数写 UTF-8，
/// 中文 Windows 上的老工具写 GBK。与读文件同一套判定（先 UTF-8，不是就按 GB18030）。
fn decode(line: &[u8]) -> String {
    aide_workspace::fs_ops::decode_text_bytes(line).unwrap_or_else(|_| String::from_utf8_lossy(line).into_owned())
}

/// 结束一个进程连同它的子孙。已经结束的不动（进程号可能已被系统分给别人）。
fn end(proc: &Arc<Proc>) {
    {
        let mut st = proc.state();
        if st.exit.is_some() || st.killed {
            return;
        }
        st.killed = true;
    }
    signal(proc.pid, false);
    let proc = Arc::clone(proc);
    std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        if proc.running() {
            signal(proc.pid, true);
        }
    });
}

/// Unix：给整个进程组发信号（先 TERM，`force` 时 KILL）。借系统的 `kill` 发，不为此引入 libc 绑定。
#[cfg(unix)]
fn signal(pid: u32, force: bool) {
    let _ = Command::new("kill")
        .args([if force { "-KILL" } else { "-TERM" }, "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Windows：没有进程组信号这回事，`taskkill /T` 按父子关系结束整棵树。
/// 不带 `/F` 对没有窗口的进程不起作用，所以两次都是强制结束。
#[cfg(windows)]
fn signal(pid: u32, _force: bool) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .status();
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;

    #[derive(Default)]
    pub(crate) struct Recorder {
        pub events: Mutex<Vec<(String, String, Value)>>,
        pub changes: AtomicU64,
    }

    impl Listener for Recorder {
        fn event(&self, app_id: &str, _workspace: Option<&Path>, channel: &str, payload: Value) {
            self.events.lock().unwrap().push((app_id.to_string(), channel.to_string(), payload));
        }
        fn changed(&self) {
            self.changes.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn sh(script: &str) -> RunRequest {
        let cwd = std::env::temp_dir();
        RunRequest::parse(&json!({ "command": "sh", "args": ["-c", script] }), cwd, String::new()).unwrap()
    }

    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    const WS: &str = "/ws/a";

    fn texts(attached: &Value) -> Vec<String> {
        attached["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn output_arrives_in_order_with_the_real_exit_code() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        let info = pool.run("tasks", Path::new(WS), sh("echo one; echo two >&2; printf 'three\\rfour\\n'; exit 7"), rec.clone()).unwrap();
        assert!(info.running);
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);

        let got = pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap();
        let mut lines = texts(&got);
        lines.sort();
        assert_eq!(lines, ["four", "one", "three", "two"]);
        assert_eq!((got["code"].clone(), got["running"].clone(), got["killed"].clone()), (json!(7), json!(false), json!(false)));
        assert!(got["lines"].as_array().unwrap().iter().any(|l| l["stream"] == "stderr" && l["text"] == "two"));

        // 事件只报序号，不带正文；最后一条是带退出码的 exit
        wait_until("exit event", || rec.events.lock().unwrap().iter().any(|(_, _, p)| p["type"] == "exit"));
        let events = rec.events.lock().unwrap();
        assert!(events.iter().all(|(app, channel, p)| app == "tasks" && *channel == format!("process:{}", info.run_id) && p.get("text").is_none()));
        assert_eq!(events.last().unwrap().2, json!({ "type": "exit", "code": 7, "killed": false, "head": 4 }));
        // 起、止各报一次清单变化
        assert_eq!(rec.changes.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn attach_resumes_after_the_last_seen_line_without_gaps_or_repeats() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        let info = pool.run("tasks", Path::new(WS), sh("for i in 1 2 3 4 5; do echo $i; done; sleep 30"), rec).unwrap();
        wait_until("five lines", || pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap()["head"] == 5);
        let first = pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap();
        assert_eq!(texts(&first), ["1", "2", "3", "4", "5"]);
        let rest = pool.attach("tasks", Path::new(WS), &info.run_id, 3).unwrap();
        assert_eq!(texts(&rest), ["4", "5"]);
        assert_eq!(rest["first"], 1);
        assert!(texts(&pool.attach("tasks", Path::new(WS), &info.run_id, 5).unwrap()).is_empty());
        pool.stop_all();
    }

    #[test]
    fn kill_takes_the_children_too_and_is_reported_as_killed() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        // 包装脚本再起一个真正干活的：两个都得结束
        let info = pool.run("tasks", Path::new(WS), sh("sh -c 'echo $$; sleep 300' & wait"), rec).unwrap();
        wait_until("child pid", || pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap()["head"] == 1);
        let child = texts(&pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap())[0].clone();
        let alive = |pid: &str| Command::new("kill").args(["-0", pid]).stderr(Stdio::null()).status().unwrap().success();
        assert!(alive(&child));

        pool.kill("tasks", Path::new(WS), &info.run_id).unwrap();
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);
        let after = &pool.list("tasks", Path::new(WS))[0];
        assert!(after.killed && after.ended_at.is_some());
        wait_until("child gone", || !alive(&child));
    }

    #[test]
    fn processes_belong_to_one_app_in_one_workspace() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        let info = pool.run("tasks", Path::new(WS), sh("sleep 300"), rec).unwrap();
        // 别的应用、同一应用在别的工作区：看不到、续不上、杀不掉
        for (app, ws) in [("other", WS), ("tasks", "/ws/b")] {
            assert!(pool.list(app, Path::new(ws)).is_empty());
            assert!(pool.attach(app, Path::new(ws), &info.run_id, 0).is_err());
            assert!(pool.kill(app, Path::new(ws), &info.run_id).is_err());
        }
        assert!(pool.list("tasks", Path::new(WS))[0].running);
        // Aide 自己的清单看得到全部，也结束得了
        assert_eq!(pool.list_all().len(), 1);
        pool.kill_any(&info.run_id).unwrap();
        wait_until("exit", || !pool.list_all()[0].running);
    }

    #[test]
    fn stopping_an_app_ends_its_processes_and_only_its() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        pool.run("tasks", Path::new(WS), sh("sleep 300"), rec.clone()).unwrap();
        pool.run("tasks", Path::new("/ws/b"), sh("sleep 300"), rec.clone()).unwrap();
        pool.run("logs", Path::new(WS), sh("sleep 300"), rec).unwrap();
        pool.stop_app("tasks");
        wait_until("tasks gone", || pool.list_all().iter().filter(|p| p.app_id == "tasks").all(|p| !p.running));
        assert!(pool.list("logs", Path::new(WS))[0].running);
        pool.stop_all();
    }

    #[test]
    fn an_app_cannot_run_more_than_the_limit_at_once() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        for _ in 0..MAX_RUNNING_PER_APP {
            pool.run("tasks", Path::new(WS), sh("sleep 300"), rec.clone()).unwrap();
        }
        assert!(pool.run("tasks", Path::new(WS), sh("sleep 300"), rec.clone()).unwrap_err().contains("上限"));
        // 别的应用不受影响
        assert!(pool.run("logs", Path::new(WS), sh("true"), rec).is_ok());
        pool.stop_all();
    }

    #[test]
    fn the_command_is_never_handed_to_a_shell() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        let cwd = std::env::temp_dir();
        // 一整条命令行当 command：找不到这个「可执行文件」，而不是被 shell 拆开执行
        let whole = RunRequest::parse(&json!({ "command": "echo hi; touch pwned" }), cwd.clone(), String::new()).unwrap();
        assert!(pool.run("tasks", Path::new(WS), whole, rec.clone()).unwrap_err().contains("找不到命令"));
        // 参数里的 shell 元字符原样到达
        let arg = "$(touch pwned); `id` && x";
        let req = RunRequest::parse(&json!({ "command": "printf", "args": ["%s\\n", arg] }), cwd, String::new()).unwrap();
        let info = pool.run("tasks", Path::new(WS), req, rec).unwrap();
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);
        assert_eq!(texts(&pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap()), [arg]);
    }

    #[test]
    fn output_that_is_not_utf8_is_read_as_gbk_not_garbled() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        // 「使用」的 GBK 字节，后面跟一行 UTF-8
        let info = pool.run("tasks", Path::new(WS), sh("printf '\\312\\271\\323\\303\\n'; echo 完成"), rec).unwrap();
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);
        assert_eq!(texts(&pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap()), ["使用", "完成"]);
    }

    #[test]
    fn bad_requests_are_refused_before_anything_starts() {
        let cwd = std::env::temp_dir();
        for params in [
            json!({}),
            json!({ "command": "  " }),
            json!({ "command": "ls", "args": "-la" }),
            json!({ "command": "ls", "args": [1] }),
            json!({ "command": "ls", "env": { "A=B": "x" } }),
            json!({ "command": "ls", "env": { "A": 1 } }),
        ] {
            assert!(RunRequest::parse(&params, cwd.clone(), String::new()).is_err(), "{params}");
        }
    }

    #[test]
    fn a_long_line_without_a_newline_is_split_and_the_buffer_stays_bounded() {
        let pool = ProcessPool::default();
        let rec = Arc::new(Recorder::default());
        let info = pool.run("tasks", Path::new(WS), sh("head -c 3000000 /dev/zero | tr '\\0' 'x'"), rec).unwrap();
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);
        let got = pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap();
        // 3 MB 进，缓冲里最多留 2 MB；最早那几行已经滚走，`first` 说明了这一点
        assert!(got["first"].as_u64().unwrap() > 1);
        assert!(texts(&got).iter().all(|t| t.len() <= MAX_LINE_BYTES));
        assert!(got["head"].as_u64().unwrap() >= (3_000_000 / MAX_LINE_BYTES) as u64);
    }
}

/// Windows 上才有的两件事：`.cmd` 垫片起得来（`npm` 这类命令都是垫片）、结束时整棵树收干净。
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    struct Quiet;
    impl Listener for Quiet {
        fn event(&self, _: &str, _: Option<&Path>, _: &str, _: Value) {}
        fn changed(&self) {}
    }

    const WS: &str = "C:\\ws\\a";

    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn texts(attached: &Value) -> Vec<String> {
        attached["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_string()).collect()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aide_proc_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_cmd_shim_on_path_runs_by_its_bare_name_with_arguments_intact() {
        let dir = temp_dir("shim");
        std::fs::write(dir.join("hello.cmd"), "@echo off\r\necho \"%~1\"\r\necho \"%~2\"\r\nexit /b 5\r\n").unwrap();
        let path = format!("{};{}", dir.display(), std::env::var("PATH").unwrap_or_default());
        let req = RunRequest::parse(
            &json!({ "command": "hello", "args": ["one two", "a&b"], "env": { "PATH": path } }),
            dir.clone(),
            String::new(),
        )
        .unwrap();
        let pool = ProcessPool::default();
        let info = pool.run("tasks", Path::new(WS), req, Arc::new(Quiet)).unwrap();
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);
        let got = pool.attach("tasks", Path::new(WS), &info.run_id, 0).unwrap();
        // 带空格、带 & 的参数原样到达，没有被 cmd 拆开或当成第二条命令；退出码是脚本自己的。
        // （脚本里给参数加了引号再 echo：不加的话是脚本自己把 & 当成了命令分隔符，与我们无关）
        assert_eq!(texts(&got), ["\"one two\"", "\"a&b\""]);
        assert_eq!(got["code"], 5);
    }

    #[test]
    fn kill_ends_the_whole_tree() {
        let pings = || {
            let out = Command::new("tasklist").args(["/FI", "IMAGENAME eq PING.EXE", "/FO", "CSV", "/NH"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.to_ascii_lowercase().contains("ping.exe")).count()
        };
        let before = pings();
        let req = RunRequest::parse(
            &json!({ "command": "cmd", "args": ["/c", "ping -n 300 127.0.0.1 >nul"] }),
            std::env::temp_dir(),
            String::new(),
        )
        .unwrap();
        let pool = ProcessPool::default();
        let info = pool.run("tasks", Path::new(WS), req, Arc::new(Quiet)).unwrap();
        // 外面是 cmd，真正在跑的是它起的 ping
        wait_until("ping started", || pings() > before);
        pool.kill("tasks", Path::new(WS), &info.run_id).unwrap();
        wait_until("exit", || !pool.list("tasks", Path::new(WS))[0].running);
        assert!(pool.list("tasks", Path::new(WS))[0].killed);
        wait_until("ping gone", || pings() == before);
    }
}
