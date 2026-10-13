//! 应用后端：一个 stdio MCP server，界面经 `tools.*` 调它的工具（agent 会话里的那一份由 SDK 自己拉起，
//! 见 [`super::store::mcp_entries`]）。这里是给界面用的那一份的进程管理 + 最小 MCP 客户端
//! （`initialize` / `tools/list` / `tools/call`，按行分隔的 JSON-RPC）。
//!
//! 同步实现：每个后端一把锁，调用串行；由调用方放进 blocking 线程。读 stdout 的线程**常驻分发**：
//! 带 id 的回应交给等它的那次调用（等待带超时，后端卡死不能把 Host 的线程一起拖死），
//! 不带 id 的 `notifications/aide/event` 随到随转给界面——后端的长任务靠它报进度，
//! 不必塞进一次调用里。
//!
//! 后端按「应用 × 工作区」各起一个（[`Spec::key`]）：工作区根在它一生中不变，用户切去看别的
//! 工程不重启、切回来还是那一个。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// 这么久既没人调、也没推过事件就收掉（下次调用时顺手检查，不另起定时器）。
const IDLE: Duration = Duration::from_secs(600);
const STDERR_TAIL: usize = 40;
/// 后端推事件用的通知方法。
const EVENT_METHOD: &str = "notifications/aide/event";
/// 单条事件的上限。事件经 Host 的事件总线走，总线的留底是对话断线续传的依据，不能被应用灌满；
/// 大块数据应该让界面用 `tools.call` 来取。
const MAX_EVENT_BYTES: usize = 16 * 1024;
/// 每秒最多转这么多条，超出的丢掉。
const MAX_EVENTS_PER_SEC: u32 = 20;
/// 这些频道是 Aide 自己发的，后端不能冒用。
const RESERVED_CHANNELS: &[&str] = &["theme", "session", "fs"];
const RESERVED_PREFIX: &str = "process:";

/// 后端推来的一条事件：`(频道, 载荷)`。
pub type Notify = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// 不关心后端事件的调用方用它。
pub fn silent() -> Notify {
    Arc::new(|_, _| {})
}

/// 怎么拉起一个应用的后端。
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub id: String,
    /// 这一个后端服务的工作区；`None` = 不属于任何工作区（只为问工具清单起的那一个）。
    pub workspace: Option<PathBuf>,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// 应用文件的版本；变了就重启（开发态改了后端代码）。
    pub revision: u64,
}

impl Spec {
    /// 池子里的键：应用 id + 工作区。换行不会出现在 id 里，拿它当分隔符。
    pub fn key(&self) -> String {
        pool_key(&self.id, self.workspace.as_deref())
    }
}

fn pool_key(id: &str, workspace: Option<&std::path::Path>) -> String {
    format!("{id}\n{}", workspace.map(|w| w.to_string_lossy()).unwrap_or_default())
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Value>>>>;

struct Running {
    child: Child,
    stdin: ChildStdin,
    /// 等回应的调用：读线程按 id 把回应交过来；后端退出时读线程清空它，等的人立刻知道。
    pending: Pending,
    stderr: Arc<Mutex<VecDeque<String>>>,
    next_id: u64,
    revision: u64,
    /// 最近一次有动静（被调用 / 推了事件）。
    active: Arc<Mutex<Instant>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct ServerPool {
    servers: Mutex<HashMap<String, Arc<Mutex<Option<Running>>>>>,
}

impl ServerPool {
    /// 调后端的一个 MCP 方法（`tools/list`、`tools/call`）。没起就起，版本变了就重启；
    /// 出任何错都把进程收掉，下次调用重新来。`notify` 只在这次调用把后端拉起来时用上：
    /// 它接这个后端此后推的所有事件。
    pub fn request(&self, spec: &Spec, method: &str, params: Value, notify: &Notify) -> Result<Value, String> {
        let key = spec.key();
        self.reap_idle(&key);
        let slot = {
            let mut servers = self.servers.lock().unwrap_or_else(PoisonError::into_inner);
            servers.entry(key).or_default().clone()
        };
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().is_some_and(|r| r.revision != spec.revision) {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(start(spec, Arc::clone(notify))?);
        }
        let running = slot.as_mut().expect("just started");
        touch(&running.active);
        let result = rpc(running, method, params, CALL_TIMEOUT);
        if result.is_err() {
            *slot = None;
        }
        result
    }

    /// 应用被禁用 / 卸载 / 同意失效时收掉它的后端（它在每个工作区的那一份都收）。
    pub fn stop(&self, id: &str) {
        let prefix = format!("{id}\n");
        let slots: Vec<_> = {
            let mut servers = self.servers.lock().unwrap_or_else(PoisonError::into_inner);
            let keys: Vec<String> = servers.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
            keys.iter().filter_map(|k| servers.remove(k)).collect()
        };
        for slot in slots {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<_> = self.servers.lock().unwrap_or_else(PoisonError::into_inner).drain().collect();
        for (_, slot) in all {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }

    /// 取走某个后端最近的 stderr（开发日志用）。
    pub fn take_stderr(&self, spec: &Spec) -> Vec<String> {
        let slot = self.servers.lock().unwrap_or_else(PoisonError::into_inner).get(&spec.key()).cloned();
        let Some(slot) = slot else { return Vec::new() };
        let guard = slot.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(running) = guard.as_ref() else { return Vec::new() };
        let mut tail = running.stderr.lock().unwrap_or_else(PoisonError::into_inner);
        tail.drain(..).collect()
    }

    fn reap_idle(&self, except: &str) {
        let slots: Vec<_> = self
            .servers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(key, _)| key.as_str() != except)
            .map(|(_, slot)| slot.clone())
            .collect();
        for slot in slots {
            // 正在被调用的那个拿不到锁：跳过，它显然不闲
            if let Ok(mut guard) = slot.try_lock() {
                if guard.as_ref().is_some_and(|r| idle_for(&r.active) > IDLE) {
                    *guard = None;
                }
            }
        }
    }
}

fn touch(active: &Mutex<Instant>) {
    *active.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
}

fn idle_for(active: &Mutex<Instant>) -> Duration {
    active.lock().unwrap_or_else(PoisonError::into_inner).elapsed()
}

fn start(spec: &Spec, notify: Notify) -> Result<Running, String> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("后端启动失败（{}）：{e}", spec.program.display()))?;
    let stdin = child.stdin.take().ok_or("后端没有 stdin")?;
    let stdout = child.stdout.take().ok_or("后端没有 stdout")?;
    let stderr_pipe = child.stderr.take().ok_or("后端没有 stderr")?;

    let pending: Pending = Arc::default();
    let active = Arc::new(Mutex::new(Instant::now()));
    {
        let (pending, active) = (Arc::clone(&pending), Arc::clone(&active));
        std::thread::spawn(move || {
            let mut budget = EventBudget::default();
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // 不是 JSON 的行（后端往 stdout 打了日志）跳过，不因此判死
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    // 没人等的 id（已超时的调用）直接丢
                    if let Some(waiter) = pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id) {
                        let _ = waiter.send(message);
                    }
                } else if let Some((channel, payload)) = event_of(&message, line.len()) {
                    touch(&active);
                    if budget.allow() {
                        notify(channel, payload);
                    }
                }
            }
            // 后端退出：丢掉所有发送端，等回应的调用立刻收到「断了」
            pending.lock().unwrap_or_else(PoisonError::into_inner).clear();
        });
    }
    let stderr = Arc::new(Mutex::new(VecDeque::new()));
    let tail = stderr.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
            let mut tail = tail.lock().unwrap_or_else(PoisonError::into_inner);
            if tail.len() >= STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });

    let mut running = Running { child, stdin, pending, stderr, next_id: 1, revision: spec.revision, active };
    rpc(
        &mut running,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "aide", "version": env!("CARGO_PKG_VERSION") },
        }),
        START_TIMEOUT,
    )
    .map_err(|e| format!("后端握手失败：{e}"))?;
    send(&mut running, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
    Ok(running)
}

/// 一条消息是不是该转给界面的事件：方法对、频道合法、不超限。`size` 是整行的字节数。
fn event_of(message: &Value, size: usize) -> Option<(&str, Value)> {
    if message.get("method").and_then(Value::as_str) != Some(EVENT_METHOD) || size > MAX_EVENT_BYTES {
        return None;
    }
    let params = message.get("params")?;
    let channel = params.get("channel").and_then(Value::as_str)?;
    let ok = !channel.is_empty()
        && channel.len() <= 64
        && !RESERVED_CHANNELS.contains(&channel)
        && !channel.starts_with(RESERVED_PREFIX);
    ok.then(|| (channel, params.get("payload").cloned().unwrap_or(Value::Null)))
}

/// 按秒计数的限流：一秒内超过 [`MAX_EVENTS_PER_SEC`] 的丢掉。
struct EventBudget {
    window: Instant,
    used: u32,
}

impl Default for EventBudget {
    fn default() -> Self {
        Self { window: Instant::now(), used: 0 }
    }
}

impl EventBudget {
    fn allow(&mut self) -> bool {
        if self.window.elapsed() >= Duration::from_secs(1) {
            *self = Self::default();
        }
        self.used += 1;
        self.used <= MAX_EVENTS_PER_SEC
    }
}

fn send(running: &mut Running, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    running.stdin.write_all(line.as_bytes()).and_then(|_| running.stdin.flush()).map_err(|e| format!("后端已退出：{e}"))
}

/// 发一个请求，等读线程把同 id 的回应交过来。
fn rpc(running: &mut Running, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = running.next_id;
    running.next_id += 1;
    let (tx, rx) = mpsc::channel();
    // 先登记再发：回应不可能早于登记
    running.pending.lock().unwrap_or_else(PoisonError::into_inner).insert(id, tx);
    let sent = send(running, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    let message = match sent.map(|_| rx.recv_timeout(timeout)) {
        Ok(Ok(message)) => message,
        Ok(Err(mpsc::RecvTimeoutError::Timeout)) => {
            running.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
            return Err(with_stderr(running, &format!("后端 {} 秒没有回应", timeout.as_secs())));
        }
        Ok(Err(mpsc::RecvTimeoutError::Disconnected)) | Err(_) => {
            running.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
            // stderr 由另一个线程在读：给它一拍，把遗言带上
            std::thread::sleep(Duration::from_millis(80));
            return Err(with_stderr(running, "后端已退出"));
        }
    };
    if let Some(error) = message.get("error") {
        let text = error.get("message").and_then(Value::as_str).unwrap_or("未知错误");
        return Err(format!("后端报错：{text}"));
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

fn with_stderr(running: &Running, what: &str) -> String {
    let tail = running.stderr.lock().unwrap_or_else(PoisonError::into_inner);
    match tail.back() {
        Some(last) => format!("{what}（最后的输出：{last}）"),
        None => what.to_string(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// 一个用 sh 写的假 MCP 后端：按方法名回固定内容，`tools/call` 回它的进程号。
    const FAKE: &str = r#"
echo "booting" >&2
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) echo "not json, just a log line"; printf '{"jsonrpc":"2.0","id":%s,"result":{"capabilities":{}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","method":"notifications/x"}\n{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo"}]}}\n' "$id" ;;
    *'"later"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"; (sleep 0.3; printf '{"jsonrpc":"2.0","method":"notifications/aide/event","params":{"channel":"build","payload":{"n":1}}}\n{"jsonrpc":"2.0","method":"notifications/aide/event","params":{"channel":"process:1","payload":{}}}\n') & ;;
    *'"boom"'*) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-1,"message":"kaboom"}}\n' "$id" ;;
    *'"die"'*) echo "fatal: out of luck" >&2; exit 3 ;;
    *'"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"pid":%s}}\n' "$id" "$$" ;;
  esac
done
"#;

    fn spec(revision: u64) -> Spec {
        let dir = std::env::temp_dir().join(format!("aide_srv_{}_{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("server.sh"), FAKE).unwrap();
        Spec { id: "db".into(), workspace: None, program: "sh".into(), args: vec!["server.sh".into()], cwd: dir, env: vec![], revision }
    }

    #[test]
    fn handshakes_then_serves_calls_on_one_process() {
        let pool = ServerPool::default();
        let spec = spec(1);
        assert_eq!(pool.request(&spec, "tools/list", json!({}), &silent()).unwrap()["tools"][0]["name"], "echo");
        let first = pool.request(&spec, "tools/call", json!({ "name": "echo" }), &silent()).unwrap()["pid"].clone();
        let second = pool.request(&spec, "tools/call", json!({ "name": "echo" }), &silent()).unwrap()["pid"].clone();
        assert_eq!(first, second);
        pool.stop_all();
    }

    #[test]
    fn a_new_revision_restarts_the_backend() {
        let pool = ServerPool::default();
        let mut spec = spec(1);
        let first = pool.request(&spec, "tools/call", json!({}), &silent()).unwrap()["pid"].clone();
        spec.revision = 2;
        let second = pool.request(&spec, "tools/call", json!({}), &silent()).unwrap()["pid"].clone();
        assert_ne!(first, second);
        pool.stop_all();
    }

    #[test]
    fn a_backend_error_is_reported_and_the_backend_survives_a_restart() {
        let pool = ServerPool::default();
        let spec = spec(1);
        assert!(pool.request(&spec, "tools/call", json!({ "name": "boom" }), &silent()).unwrap_err().contains("kaboom"));
        // 出错后进程被收掉，下一次调用重新拉起
        assert!(pool.request(&spec, "tools/call", json!({ "name": "echo" }), &silent()).is_ok());
        pool.stop_all();
    }

    #[test]
    fn a_dead_backend_says_so_with_its_last_words() {
        let pool = ServerPool::default();
        let spec = spec(1);
        let err = pool.request(&spec, "tools/call", json!({ "name": "die" }), &silent()).unwrap_err();
        assert!(err.contains("后端已退出"), "{err}");
        assert!(err.contains("out of luck"), "{err}");
    }

    #[test]
    fn a_program_that_cannot_start_is_an_error_not_a_hang() {
        let pool = ServerPool::default();
        let mut spec = spec(1);
        spec.program = "/nonexistent/aide-no-such-runtime".into();
        assert!(pool.request(&spec, "tools/list", json!({}), &silent()).unwrap_err().contains("启动失败"));
    }

    /// 仓库里的示例应用（docs/examples/aide-apps/api-tester）的后端：用真的 Node 跑一遍。
    /// 机器上没有 Node 就跳过（CI 的 rust job 不保证有）。
    #[test]
    fn the_example_backend_speaks_mcp_under_real_node() {
        let Ok(node) = which::which("node") else {
            eprintln!("skipped: no node on PATH");
            return;
        };
        let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/examples/aide-apps/api-tester");
        let data = std::env::temp_dir().join(format!("aide_example_{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let spec = Spec {
            id: "api-tester".into(),
            workspace: None,
            program: node,
            args: vec![app.join("server/main.mjs").to_string_lossy().into_owned()],
            cwd: app,
            env: vec![("AIDE_APP_DATA".into(), data.to_string_lossy().into_owned())],
            revision: 1,
        };
        // 一个只答一次的本机 HTTP 服务，给示例后端去请求
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/ping", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::Read;
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 4\r\nConnection: close\r\n\r\npong").unwrap();
        });

        let pool = ServerPool::default();
        let tools = pool.request(&spec, "tools/list", json!({}), &silent()).unwrap();
        let names: Vec<&str> = tools["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["send_request", "list_history"]);
        // 示例把查历史标成了只读：装上以后 agent 调它免确认，发请求仍然要确认
        assert_eq!(crate::apps::store::read_only_tools(crate::apps::store::Source::User, &tools), ["list_history"]);

        let sent = pool.request(&spec, "tools/call", json!({ "name": "send_request", "arguments": { "url": url } }), &silent()).unwrap();
        let body: Value = serde_json::from_str(sent["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["status"], 201);
        assert_eq!(body["body"], "pong");

        // 历史落在 AIDE_APP_DATA 里：另一个进程（agent 会话那一份）也读得到
        pool.stop_all();
        let history = pool.request(&spec, "tools/call", json!({ "name": "list_history", "arguments": {} }), &silent()).unwrap();
        let list: Value = serde_json::from_str(history["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(list[0]["status"], 201);

        let failed = pool.request(&spec, "tools/call", json!({ "name": "send_request", "arguments": { "url": "http://127.0.0.1:1/" } }), &silent()).unwrap();
        assert_eq!(failed["isError"], true);
        pool.stop_all();
    }

    fn collecting() -> (Notify, Arc<Mutex<Vec<(String, Value)>>>) {
        let got: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let sink = Arc::clone(&got);
        (Arc::new(move |channel: &str, payload: Value| sink.lock().unwrap().push((channel.to_string(), payload))), got)
    }

    /// 调用返回之后后端才推的事件也到得了界面（以前会被下一次调用当成「不是我的回应」丢掉）；
    /// 冒用 Aide 自己频道的那条不转。
    #[test]
    fn events_pushed_between_calls_reach_the_listener() {
        let pool = ServerPool::default();
        let spec = spec(1);
        let (notify, got) = collecting();
        pool.request(&spec, "tools/call", json!({ "name": "later" }), &notify).unwrap();
        assert!(got.lock().unwrap().is_empty());
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(*got.lock().unwrap(), [("build".to_string(), json!({ "n": 1 }))]);
        // 事件之后调用照常
        assert!(pool.request(&spec, "tools/call", json!({ "name": "echo" }), &notify).is_ok());
        pool.stop_all();
    }

    #[test]
    fn each_workspace_gets_its_own_backend_and_stop_takes_them_all() {
        let pool = ServerPool::default();
        let a = Spec { workspace: Some("/ws/a".into()), ..spec(1) };
        let b = Spec { workspace: Some("/ws/b".into()), ..a.clone() };
        let pid = |s: &Spec| pool.request(s, "tools/call", json!({ "name": "echo" }), &silent()).unwrap()["pid"].clone();
        let (first_a, first_b) = (pid(&a), pid(&b));
        assert_ne!(first_a, first_b);
        // 切走再切回来：还是原来那一个
        assert_eq!(pid(&a), first_a);
        pool.stop("db");
        assert_ne!(pid(&a), first_a);
        assert_ne!(pid(&b), first_b);
        pool.stop_all();
    }

    #[test]
    fn a_backend_that_pushes_events_is_not_idle() {
        let active = Mutex::new(Instant::now() - IDLE - Duration::from_secs(1));
        assert!(idle_for(&active) > IDLE);
        touch(&active);
        assert!(idle_for(&active) < IDLE);
    }

    #[test]
    fn oversized_and_malformed_events_are_dropped() {
        let ok = json!({ "method": EVENT_METHOD, "params": { "channel": "c", "payload": 1 } });
        assert_eq!(event_of(&ok, 80), Some(("c", json!(1))));
        assert_eq!(event_of(&ok, MAX_EVENT_BYTES + 1), None);
        for channel in ["", "theme", "session", "fs", "process:7"] {
            assert_eq!(event_of(&json!({ "method": EVENT_METHOD, "params": { "channel": channel } }), 80), None, "{channel:?}");
        }
        assert_eq!(event_of(&json!({ "method": "notifications/other", "params": { "channel": "c" } }), 80), None);
        let mut budget = EventBudget::default();
        assert_eq!((0..MAX_EVENTS_PER_SEC + 5).filter(|_| budget.allow()).count() as u32, MAX_EVENTS_PER_SEC);
    }
}
