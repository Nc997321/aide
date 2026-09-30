//! `aide-host agent`：在目标机上拉起 sidecar，然后把 stdio 原样透传。
//!
//! 为什么不把 agent 塞进 serve 的 RPC：sidecar 协议是现成的一行一帧 JSON，桌面的
//! stdout 泵（心跳看门狗 / 事件分发 / codegraph·lsp·browser 桥）整套可复用——
//! 只要让桌面拿到一条「对面就是 sidecar」的管道。多路复用进 RPC 反而要在两端各
//! 再造一层拆包。
//!
//! 首行是 [`AgentInit`]（env 走 stdin 而非命令行：命令行在目标机 `ps` 里全员可见，
//! 而 env 里有 provider 凭据）。

use std::path::PathBuf;
use std::process::Stdio;

use aide_host::protocol::AgentInit;
use tokio::io::{AsyncBufReadExt, BufReader};

pub async fn run() -> i32 {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut first = String::new();
    if stdin.read_line(&mut first).await.unwrap_or(0) == 0 {
        eprintln!("[aide-host agent] no init line");
        return 2;
    }
    let init: AgentInit = match serde_json::from_str(first.trim()) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[aide-host agent] bad init line: {e}");
            return 2;
        }
    };

    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let runtime = init
        .runtime
        .map(PathBuf::from)
        .unwrap_or_else(|| install_dir.join("runtime").join("runtime.js"));
    let node = init.node.clone().unwrap_or_else(|| "node".to_string());

    // 用户登录环境（PATH 里的 nvm / cargo / pyenv…）：agent 的 Bash 工具要看到与用户
    // 自己终端一致的工具链。拿不到就沿用当前环境（wsl/ssh 的非登录环境），只留痕。
    let login = crate::login::login_env().await;
    if login.is_none() {
        eprintln!("[aide-host agent] login shell env unavailable; using inherited env");
    }
    let node = crate::login::which(&node, login.as_ref()).unwrap_or(node);

    let mut cmd = tokio::process::Command::new(&node);
    if let Some(env) = &login {
        cmd.env_clear().envs(env);
    }
    cmd.arg(&runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // 工作目录：家目录（每条 send 自带 cwd，进程级 cwd 只影响 sidecar 自身的相对路径）。
    if let Ok(home) = std::env::var("HOME") {
        cmd.current_dir(&home);
        // claude 数据落目标机的 ~/.aide/claude（与桌面同构）；桌面显式给了就用桌面的。
        if !init.env.contains_key("CLAUDE_CONFIG_DIR") {
            cmd.env(
                "CLAUDE_CONFIG_DIR",
                PathBuf::from(&home).join(".aide").join("claude"),
            );
        }
    }
    for (k, v) in &init.default_env {
        let present = match &login {
            Some(env) => env.contains_key(k),
            None => std::env::var_os(k).is_some(),
        };
        if !present {
            cmd.env(k, v);
        }
    }
    for (k, v) in &init.env {
        cmd.env(k, v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[aide-host agent] failed to start `{node} {}`: {e}",
                runtime.display()
            );
            return 127;
        }
    };
    let mut child_in = child.stdin.take().expect("piped");
    let mut child_out = child.stdout.take().expect("piped");

    // 桌面 → sidecar：BufReader 里首行之后已缓冲的字节会先被 copy 吐出，不丢帧。
    // 桌面断开（EOF）时关掉 sidecar 的 stdin，sidecar 按桌面协议自行退出。
    let upstream = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stdin, &mut child_in).await;
    });
    let downstream = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        let _ = tokio::io::copy(&mut child_out, &mut out).await;
    });

    let status = child.wait().await;
    let _ = downstream.await;
    upstream.abort();
    status.ok().and_then(|s| s.code()).unwrap_or(1)
}
