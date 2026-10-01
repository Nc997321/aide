//! 守护进程集成测试的共用装置：临时 HOME（套接字 / 锁 / 数据都落在里面，绝不碰真实 `~/.aide` 与用户自己的
//! 守护进程）+ 一条桥连接（写请求、按行读帧）。

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use aide_host::protocol::{HelloInfo, Resume};
use serde_json::{json, Value};

pub struct TempHome(PathBuf);
impl TempHome {
    pub fn new(tag: &str) -> Self {
        // 套接字路径有 ~100 字节上限：目录名要短
        let p = std::env::temp_dir().join(format!("ah-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    pub fn path(&self) -> &Path {
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
pub struct Bridge {
    child: Child,
    stdin: ChildStdin,
    frames: Receiver<Value>,
    next_id: u64,
    pub last_seq: u64,
    /// 等应答途中收到、还没被 `wait_event` 取走的事件（不能丢：回放就夹在应答前后）。
    backlog: Vec<Value>,
}

impl Bridge {
    pub fn start(home: &TempHome, resume: Option<Resume>) -> Self {
        Self::start_with_env(home, resume, &[])
    }

    /// 同 `start`，可覆盖环境变量（如 `AIDE_HOST_IDLE_SECS`）——只在守护进程**首次拉起**时生效。
    pub fn start_with_env(home: &TempHome, resume: Option<Resume>, env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_aide-host"));
        cmd.arg("serve").env("HOME", home.path()).env("AIDE_HOST_IDLE_SECS", "3600");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd
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
    pub fn next_frame(&mut self, within: Duration) -> Option<Value> {
        let f = self.frames.recv_timeout(within).ok()?;
        if let Some(s) = f.get("seq").and_then(Value::as_u64) {
            self.last_seq = s;
        }
        Some(f)
    }

    /// 发请求，等同 id 的应答；途中的事件帧收进 `events`。
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
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

    pub fn hello(&mut self) -> HelloInfo {
        serde_json::from_value(self.call("hello", Value::Null).unwrap()).unwrap()
    }

    /// 等一条满足条件的事件（先看已收的，再等新来的）。
    pub fn wait_event(&mut self, within: Duration, pred: impl Fn(&Value) -> bool) -> Option<Value> {
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
    pub fn kill(mut self) -> u64 {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.last_seq
    }
}

