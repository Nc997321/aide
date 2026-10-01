//! 真二进制的守护进程集成测试：`aide-host serve`（桥）+ `aide-host daemon`，HOME 指向临时目录
//! （套接字 / 锁 / 数据都落在里面，绝不碰真实 `~/.aide` 与用户自己的守护进程）。
//!
//! 只在 Unix 上有意义（Host 本来就只在 Linux 目标机上跑）。

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use aide_host::protocol::{AttachInfo, HelloInfo, Resume};
use serde_json::{json, Value};

struct TempHome(PathBuf);
impl TempHome {
    fn new(tag: &str) -> Self {
        // 套接字路径有 ~100 字节上限：目录名要短
        let p = std::env::temp_dir().join(format!("ah-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempHome {
    fn drop(&mut self) {
        // 兜底：测试失败时别留下守护进程
        if let Ok(Some(pid)) = std::fs::read_to_string(self.0.join(".aide/host/daemon.pid")).map(Some) {
            let _ = Command::new("kill").arg(pid.trim()).status();
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 一条桥连接：写请求、按行读帧（后台线程读，测试里带超时取）。
struct Bridge {
    child: Child,
    stdin: ChildStdin,
    frames: Receiver<Value>,
    next_id: u64,
    last_seq: u64,
    /// 等应答途中收到、还没被 `wait_event` 取走的事件（不能丢：回放就夹在应答前后）。
    backlog: Vec<Value>,
}

impl Bridge {
    fn start(home: &TempHome, resume: Option<Resume>) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_aide-host"))
            .arg("serve")
            .env("HOME", home.path())
            .env("AIDE_HOST_IDLE_SECS", "3600")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let init = json!({ "resume": resume });
        writeln!(stdin, "{init}").unwrap();
        let (tx, frames) = channel();
        let out = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        Self { child, stdin, frames, next_id: 1, last_seq: 0, backlog: Vec::new() }
    }

    /// 取下一帧（任何帧），记下事件序号。
    fn next_frame(&mut self, within: Duration) -> Option<Value> {
        let f = self.frames.recv_timeout(within).ok()?;
        if let Some(s) = f.get("seq").and_then(Value::as_u64) {
            self.last_seq = s;
        }
        Some(f)
    }

    /// 发请求，等同 id 的应答；途中的事件帧收进 `events`。
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(self.stdin, "{}", json!({ "id": id, "method": method, "params": params })).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let Some(f) = self.next_frame(Duration::from_secs(1)) else { continue };
            if f.get("id").and_then(Value::as_u64) == Some(id) {
                return match f.get("err").and_then(Value::as_str) {
                    Some(e) => Err(e.to_string()),
                    None => Ok(f.get("ok").cloned().unwrap_or(Value::Null)),
                };
            }
            if f.get("event").is_some() {
                self.backlog.push(f);
            }
        }
        Err(format!("timeout waiting for `{method}`"))
    }

    fn hello(&mut self) -> HelloInfo {
        serde_json::from_value(self.call("hello", Value::Null).unwrap()).unwrap()
    }

    /// 等一条满足条件的事件（先看已收的，再等新来的）。
    fn wait_event(&mut self, within: Duration, pred: impl Fn(&Value) -> bool) -> Option<Value> {
        if let Some(i) = self.backlog.iter().position(&pred) {
            return Some(self.backlog.remove(i));
        }
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Some(f) = self.next_frame(Duration::from_millis(200)) {
                if f.get("event").is_some() {
                    if pred(&f) {
                        return Some(f);
                    }
                    self.backlog.push(f);
                }
            }
        }
        None
    }

    /// 桌面这头突然没了（进程被杀）——守护进程不该受影响。
    fn kill(mut self) -> u64 {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.last_seq
    }
}

fn attach_of(h: &HelloInfo) -> AttachInfo {
    h.attach.clone().expect("hello after attach carries AttachInfo")
}

fn watch_event(f: &Value) -> bool {
    f["event"] == "file-tree-changed"
}

/// 桥被杀、守护进程活着：重连凭 `resume` 补回断线期间发生的事件，且守护进程身份不变。
#[test]
fn reconnect_resumes_and_replays_events_missed_while_away() {
    let home = TempHome::new("resume");
    let proj = home.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();

    let mut a = Bridge::start(&home, None);
    let hello = a.hello();
    let first = attach_of(&hello);
    assert!(!first.resumed, "a fresh attach has nothing to resume");
    assert!(!hello.daemon_id.is_empty() && hello.daemon_id == first.daemon_id);
    a.call("invoke", json!({ "cmd": "file_tree_watch", "args": { "root": proj } })).unwrap();
    // 在线时的一次改动：证明监听通了，也让 last_seq 往前走
    std::fs::write(proj.join("one.txt"), "1").unwrap();
    assert!(a.wait_event(Duration::from_secs(10), watch_event).is_some(), "live event");
    let last_seq = a.last_seq;
    a.kill();

    // 桥不在的时候发生的改动
    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(proj.join("two.txt"), "2").unwrap();
    std::thread::sleep(Duration::from_millis(1500)); // 监听防抖，确保事件已进环

    let mut b = Bridge::start(&home, Some(Resume { daemon_id: first.daemon_id.clone(), seq: last_seq }));
    let hello = b.hello();
    let info = attach_of(&hello);
    assert_eq!(hello.daemon_id, first.daemon_id, "same daemon: the Host survived the bridge");
    assert!(info.resumed && !info.gap, "{info:?}");
    assert!(info.replayed >= 1, "missed events replayed: {info:?}");
    let replayed = b.wait_event(Duration::from_secs(5), watch_event).expect("replayed file-tree-changed");
    assert!(replayed["seq"].as_u64().unwrap() > last_seq);

    // 收尾：让守护进程退出，并确认它清理了套接字
    b.call("shutdown", json!({ "force": true })).unwrap();
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    b.kill();
}

/// 守护进程重启过（身份变了）：不谎称 resumed——客户端据此知道会话已经没了。
#[test]
fn reconnect_after_the_daemon_restarted_is_not_resumed() {
    let home = TempHome::new("fresh");
    let mut a = Bridge::start(&home, None);
    let old = attach_of(&{
        a.hello()
    });
    a.call("shutdown", json!({ "force": true })).unwrap();
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    a.kill();

    let mut b = Bridge::start(&home, Some(Resume { daemon_id: old.daemon_id.clone(), seq: 5 }));
    let hello = b.hello();
    assert_ne!(hello.daemon_id, old.daemon_id, "a new daemon was started");
    assert!(!attach_of(&hello).resumed);
    b.call("shutdown", json!({ "force": true })).unwrap();
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    b.kill();
}

/// 两个客户端同时连着：都能 invoke；还有别人连着时，非强制的 shutdown 被拒绝。
#[test]
fn shutdown_refuses_while_other_clients_are_attached() {
    let home = TempHome::new("multi");
    let mut a = Bridge::start(&home, None);
    let mut b = Bridge::start(&home, None);
    let (ha, hb) = (a.hello(), b.hello());
    assert_eq!(ha.daemon_id, hb.daemon_id, "one daemon serves both");

    let err = a.call("shutdown", json!({})).unwrap_err();
    assert!(err.contains("客户端"), "{err}");
    assert!(a.call("invoke", json!({ "cmd": "no_such_command", "args": {} })).is_err());

    b.kill();
    std::thread::sleep(Duration::from_millis(300));
    a.call("shutdown", json!({})).expect("sole client may shut the daemon down");
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    a.kill();
}

fn wait_gone(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!path.exists(), "daemon should remove its socket on exit");
}
