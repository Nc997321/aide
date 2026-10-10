//! 应用后端：一个 stdio MCP server，界面经 `tools.*` 调它的工具（agent 会话里的那一份由 SDK 自己拉起，
//! 见 [`super::store::mcp_entries`]）。这里是给界面用的那一份的进程管理 + 最小 MCP 客户端
//! （`initialize` / `tools/list` / `tools/call`，按行分隔的 JSON-RPC）。
//!
//! 同步实现：每个应用一把锁，调用串行；由调用方放进 blocking 线程。读 stdout 走独立线程 +
//! 通道，这样等回应可以带超时（后端卡死不能把 Host 的线程一起拖死）。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// 这么久没人调就收掉（下次调用时顺手检查，不另起定时器）。
const IDLE: Duration = Duration::from_secs(600);
const STDERR_TAIL: usize = 40;

/// 怎么拉起一个应用的后端。
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub id: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// 应用文件的版本；变了就重启（开发态改了后端代码）。
    pub revision: u64,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    next_id: u64,
    revision: u64,
    last_used: Instant,
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
    /// 出任何错都把进程收掉，下次调用重新来。
    pub fn request(&self, spec: &Spec, method: &str, params: Value) -> Result<Value, String> {
        self.reap_idle(&spec.id);
        let slot = {
            let mut servers = self.servers.lock().unwrap_or_else(PoisonError::into_inner);
            servers.entry(spec.id.clone()).or_default().clone()
        };
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().is_some_and(|r| r.revision != spec.revision) {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(start(spec)?);
        }
        let running = slot.as_mut().expect("just started");
        running.last_used = Instant::now();
        let result = rpc(running, method, params, CALL_TIMEOUT);
        if result.is_err() {
            *slot = None;
        }
        result
    }

    /// 应用被禁用 / 卸载 / 同意失效时收掉它的后端。
    pub fn stop(&self, id: &str) {
        let slot = self.servers.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        if let Some(slot) = slot {
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
    pub fn take_stderr(&self, id: &str) -> Vec<String> {
        let slot = self.servers.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned();
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
            .filter(|(id, _)| id.as_str() != except)
            .map(|(_, slot)| slot.clone())
            .collect();
        for slot in slots {
            // 正在被调用的那个拿不到锁：跳过，它显然不闲
            if let Ok(mut guard) = slot.try_lock() {
                if guard.as_ref().is_some_and(|r| r.last_used.elapsed() > IDLE) {
                    *guard = None;
                }
            }
        }
    }
}

fn start(spec: &Spec) -> Result<Running, String> {
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

    let (tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
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

    let mut running =
        Running { child, stdin, lines, stderr, next_id: 1, revision: spec.revision, last_used: Instant::now() };
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

fn send(running: &mut Running, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    running.stdin.write_all(line.as_bytes()).and_then(|_| running.stdin.flush()).map_err(|e| format!("后端已退出：{e}"))
}

/// 发一个请求，等同 id 的回应；途中的通知与别的 id 一律跳过。
fn rpc(running: &mut Running, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let id = running.next_id;
    running.next_id += 1;
    send(running, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.checked_duration_since(Instant::now()).ok_or_else(|| timed_out(running, timeout))?;
        let line = match running.lines.recv_timeout(left) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(timed_out(running, timeout)),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stderr 由另一个线程在读：给它一拍，把遗言带上
                std::thread::sleep(Duration::from_millis(80));
                return Err(with_stderr(running, "后端已退出"));
            }
        };
        // 不是 JSON 的行（后端往 stdout 打了日志）跳过，不因此判死
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            let text = error.get("message").and_then(Value::as_str).unwrap_or("未知错误");
            return Err(format!("后端报错：{text}"));
        }
        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn timed_out(running: &Running, timeout: Duration) -> String {
    with_stderr(running, &format!("后端 {} 秒没有回应", timeout.as_secs()))
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
        Spec { id: "db".into(), program: "sh".into(), args: vec!["server.sh".into()], cwd: dir, env: vec![], revision }
    }

    #[test]
    fn handshakes_then_serves_calls_on_one_process() {
        let pool = ServerPool::default();
        let spec = spec(1);
        assert_eq!(pool.request(&spec, "tools/list", json!({})).unwrap()["tools"][0]["name"], "echo");
        let first = pool.request(&spec, "tools/call", json!({ "name": "echo" })).unwrap()["pid"].clone();
        let second = pool.request(&spec, "tools/call", json!({ "name": "echo" })).unwrap()["pid"].clone();
        assert_eq!(first, second);
        pool.stop_all();
    }

    #[test]
    fn a_new_revision_restarts_the_backend() {
        let pool = ServerPool::default();
        let mut spec = spec(1);
        let first = pool.request(&spec, "tools/call", json!({})).unwrap()["pid"].clone();
        spec.revision = 2;
        let second = pool.request(&spec, "tools/call", json!({})).unwrap()["pid"].clone();
        assert_ne!(first, second);
        pool.stop_all();
    }

    #[test]
    fn a_backend_error_is_reported_and_the_backend_survives_a_restart() {
        let pool = ServerPool::default();
        let spec = spec(1);
        assert!(pool.request(&spec, "tools/call", json!({ "name": "boom" })).unwrap_err().contains("kaboom"));
        // 出错后进程被收掉，下一次调用重新拉起
        assert!(pool.request(&spec, "tools/call", json!({ "name": "echo" })).is_ok());
        pool.stop_all();
    }

    #[test]
    fn a_dead_backend_says_so_with_its_last_words() {
        let pool = ServerPool::default();
        let spec = spec(1);
        let err = pool.request(&spec, "tools/call", json!({ "name": "die" })).unwrap_err();
        assert!(err.contains("后端已退出"), "{err}");
        assert!(err.contains("out of luck"), "{err}");
    }

    #[test]
    fn a_program_that_cannot_start_is_an_error_not_a_hang() {
        let pool = ServerPool::default();
        let mut spec = spec(1);
        spec.program = "/nonexistent/aide-no-such-runtime".into();
        assert!(pool.request(&spec, "tools/list", json!({})).unwrap_err().contains("启动失败"));
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
        let tools = pool.request(&spec, "tools/list", json!({})).unwrap();
        let names: Vec<&str> = tools["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["send_request", "list_history"]);
        // 示例把查历史标成了只读：装上以后 agent 调它免确认，发请求仍然要确认
        assert_eq!(crate::apps::store::read_only_tools(crate::apps::store::Source::User, &tools), ["list_history"]);

        let sent = pool.request(&spec, "tools/call", json!({ "name": "send_request", "arguments": { "url": url } })).unwrap();
        let body: Value = serde_json::from_str(sent["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["status"], 201);
        assert_eq!(body["body"], "pong");

        // 历史落在 AIDE_APP_DATA 里：另一个进程（agent 会话那一份）也读得到
        pool.stop_all();
        let history = pool.request(&spec, "tools/call", json!({ "name": "list_history", "arguments": {} })).unwrap();
        let list: Value = serde_json::from_str(history["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(list[0]["status"], 201);

        let failed = pool.request(&spec, "tools/call", json!({ "name": "send_request", "arguments": { "url": "http://127.0.0.1:1/" } })).unwrap();
        assert_eq!(failed["isError"], true);
        pool.stop_all();
    }
}
