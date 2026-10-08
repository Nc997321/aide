//! `aide-host serve`：桌面一扇窗口（一台 Host 的一条连接）与**守护进程**之间的桥。
//!
//! 桌面 ↔ serve 的 stdio 协议不变（首行 [`ServeInit`]，随后 JSON-RPC）；serve 自己不持有
//! Host——它连到常驻的 `aide-host daemon`（没有就拉起一个），attach 之后把两端的字节
//! 原样对接。所以**这条桥断了不影响 Host**：桌面重连，凭首行里的 `resume` 把错过的事件
//! 补回来，会话还在。
//!
//! 接入前先探守护进程（`hello`）：版本与本桥不符且它空闲（没有别的客户端）就让它退场、
//! 拉起匹配的新版；它正忙就将就着接（协议一致即可），不打断别人的会话。

use std::path::Path;
use std::time::{Duration, Instant};

use aide_host::protocol::{
    HelloInfo, Request, Response, ServeInit, METHOD_ATTACH, METHOD_HELLO, METHOD_SHUTDOWN,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;

use crate::daemon;

/// 守护进程从无到能连上的最长等待（含首次启动：数据迁移 / 恢复工作区）。
const DAEMON_READY: Duration = Duration::from_secs(30);
/// 握手里单次应答的等待上限。
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

type Half = (BufReader<OwnedReadHalf>, OwnedWriteHalf);

enum Negotiated {
    Ready(Half),
    /// 旧版本守护进程已被要求退出：稍后重连新的。
    Retired,
}

pub async fn run() -> i32 {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut first = String::new();
    match stdin.read_line(&mut first).await {
        Ok(n) if n > 0 => {}
        _ => {
            eprintln!("[aide-host] no init line");
            return 2;
        }
    }
    let init: ServeInit = match serde_json::from_str(first.trim()) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[aide-host] bad init line: {e}");
            return 2;
        }
    };

    let (mut from_daemon, mut to_daemon) = match connect(&init).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[aide-host] {e}");
            return 3;
        }
    };

    // 对接两端；任何一边结束就收：桌面关了 stdin = 正常断开；守护进程那头没了 = 出错退出
    // （桌面看到 EOF 会走断线重连）。
    let up = async {
        let _ = tokio::io::copy(&mut stdin, &mut to_daemon).await;
        let _ = to_daemon.shutdown().await;
        0
    };
    let down = async {
        let _ = tokio::io::copy(&mut from_daemon, &mut tokio::io::stdout()).await;
        eprintln!("[aide-host] daemon closed the connection");
        4
    };
    tokio::select! { code = up => code, code = down => code }
}

/// 连上（必要时拉起）守护进程并完成 attach。
async fn connect(init: &ServeInit) -> Result<Half, String> {
    let sock = daemon::socket_path();
    let deadline = Instant::now() + DAEMON_READY;
    let mut spawned = false;
    loop {
        match UnixStream::connect(&sock).await {
            Ok(stream) => match negotiate(stream, init).await? {
                Negotiated::Ready(h) => return Ok(h),
                Negotiated::Retired => {
                    spawned = false;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            },
            Err(_) => {
                if !spawned {
                    spawn_daemon(init).await?;
                    spawned = true;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if Instant::now() > deadline {
            return Err(format!(
                "守护进程未能在 {}s 内就绪（日志：{}）",
                DAEMON_READY.as_secs(),
                daemon::log_path().display()
            ));
        }
    }
}

async fn call(
    r: &mut BufReader<OwnedReadHalf>,
    w: &mut OwnedWriteHalf,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut line = serde_json::to_string(&Request { id, method: method.into(), params }).map_err(|e| e.to_string())?;
    line.push('\n');
    w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut buf = String::new();
    tokio::time::timeout(REPLY_TIMEOUT, r.read_line(&mut buf))
        .await
        .map_err(|_| format!("守护进程对 `{method}` 无应答"))?
        .map_err(|e| e.to_string())?;
    if buf.is_empty() {
        return Err("守护进程在握手中途断开".into());
    }
    let resp: Response = serde_json::from_str(buf.trim()).map_err(|e| format!("守护进程应答无法解析：{e}"))?;
    match (resp.ok, resp.err) {
        (_, Some(e)) => Err(e),
        (ok, None) => Ok(ok.unwrap_or(Value::Null)),
    }
}

async fn negotiate(stream: UnixStream, init: &ServeInit) -> Result<Negotiated, String> {
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);
    let hello: HelloInfo =
        serde_json::from_value(call(&mut r, &mut w, 1, METHOD_HELLO, Value::Null).await?).map_err(|e| e.to_string())?;

    // 按构建身份比（不是包版本号）：开发期每次重构建版本号都不变，见 `crate::build_id`
    let build = crate::build_id();
    let current = hello.protocol == PROTOCOL_VERSION && hello.version == build;
    if !current {
        // 空闲的旧守护进程：让它退场，换匹配的新版。正忙的不打断——协议一致就将就着接。
        if hello.clients == 0 {
            match call(&mut r, &mut w, 2, METHOD_SHUTDOWN, json!({ "force": false })).await {
                Ok(_) => return Ok(Negotiated::Retired),
                Err(e) => eprintln!("[aide-host] old daemon refused to retire: {e}"),
            }
        }
        if hello.protocol != PROTOCOL_VERSION {
            return Err(format!(
                "Host 守护进程是旧协议（{}，本套件 {}）且仍有客户端连着；请先关掉那些窗口，或在目标机上结束 aide-host daemon",
                hello.protocol, PROTOCOL_VERSION
            ));
        }
        eprintln!(
            "[aide-host] daemon is {} (this kit is {build}); busy, attaching anyway",
            hello.version,
        );
    }
    let params = serde_json::to_value(init).map_err(|e| e.to_string())?;
    call(&mut r, &mut w, 3, METHOD_ATTACH, params).await?;
    Ok(Negotiated::Ready((r, w)))
}

/// 拉起守护进程：独立会话（`setsid`，ssh / 终端断开不带走它）、stdio 全脱钩（否则 ssh 通道
/// 会因它持有 fd 而收不了尾），日志进 `daemon.log`；首个客户端的 `ServeInit` 经 stdin 交给它。
async fn spawn_daemon(init: &ServeInit) -> Result<(), String> {
    use std::os::unix::process::CommandExt as _;
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let log = open_log(&daemon::log_path());
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("daemon")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(log.map(std::process::Stdio::from).unwrap_or_else(std::process::Stdio::null))
        .kill_on_drop(false);
    // SAFETY：pre_exec 在 fork 后、exec 前只调 async-signal-safe 的 setsid。
    unsafe {
        cmd.as_std_mut().pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法拉起守护进程：{e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let mut line = serde_json::to_string(init).map_err(|e| e.to_string())?;
        line.push('\n');
        let _ = stdin.write_all(line.as_bytes()).await;
    }
    // 不 wait：守护进程是孤儿，退出由它自己管
    Ok(())
}

/// 追加写的日志；超过 1MiB 就从头来（它只是排障线索，不值得无限长）。
fn open_log(path: &Path) -> Option<std::fs::File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).map(|m| m.len() > (1 << 20)).unwrap_or(false) {
        let _ = std::fs::remove_file(path);
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
}
