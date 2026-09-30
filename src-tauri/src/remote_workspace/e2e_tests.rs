//! 真机端到端（默认 ignore）：Windows 桌面进程 → wsl.exe → 目标发行版。
//!
//! 走生产同一条链：套件安装（install）→ `aide-host serve` 握手（connection）→ 工作区命令
//! （fs / git / 搜索 / 监听）→ `aide-host agent` 车道跑一轮真实会话。
//!
//! 运行（Windows，先 `pnpm build:remote-kit`）：
//! ```text
//! set AIDE_E2E_WSL=Debian
//! set AIDE_E2E_REPO=/home/<you>/programs/aide        （目标机上的一个 git 仓库）
//! set AIDE_E2E_CLAUDE_CONFIG=/home/<you>/.claude     （目标机上已登录的 claude home，可选）
//! cargo test --lib remote_workspace::e2e_tests -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aide_host::protocol::{AgentInit, Notification, METHOD_WATCH};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::connection::HostConnection;
use super::path::HostId;
use super::{install, launcher};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn kit() -> Vec<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    vec![
        manifest.join("remote-kit"),
        manifest.join("..").join("agent-sidecar").join("dist"),
    ]
}

#[tokio::test]
#[ignore = "真机：需要 WSL 发行版（AIDE_E2E_WSL）与 pnpm build:remote-kit"]
async fn wsl_install_connect_workspace_ops_and_agent() {
    let distro = env("AIDE_E2E_WSL").expect("set AIDE_E2E_WSL=<distro>");
    let host = HostId::Wsl(distro);

    // ── 安装（幂等：第二次运行应只做探测）──
    let t = std::time::Instant::now();
    let inst = install::ensure_installed(kit(), &host).await.expect("install");
    println!("installed in {:?}: {inst:?}", t.elapsed());

    // ── serve 握手 ──
    let events: Arc<Mutex<Vec<Notification>>> = Arc::default();
    let sink = Arc::clone(&events);
    let cmd = launcher::command(&host, &format!("exec {} serve", launcher::sh_quote(&inst.host_bin)))
        .unwrap();
    let conn = HostConnection::start(
        host.clone(),
        cmd,
        Arc::new(move |_h: &HostId, n: Notification| sink.lock().unwrap().push(n)),
    )
    .await
    .expect("connect");
    println!("hello: {:?}", conn.info);
    assert_eq!(conn.info.os, "linux");

    // ── fs：在目标机家目录下建临时目录，写 / 读 / 列 ──
    let dir = format!("{}/.aide-e2e-{}", conn.info.home, std::process::id());
    conn.invoke("create_dir", json!({"parentPath": conn.info.home, "name": dir.rsplit('/').next().unwrap()}), None)
        .await
        .expect("create_dir");
    let file = format!("{dir}/hello.txt");
    conn.invoke("write_file_content", json!({"path": file, "content": "你好 remote"}), None)
        .await
        .expect("write");
    let text = conn.invoke("read_file_content", json!({"path": file}), None).await.expect("read");
    assert_eq!(text, json!("你好 remote"));
    let listing = conn.invoke("list_directory", json!({"path": dir}), None).await.expect("list");
    assert_eq!(listing[0]["name"], json!("hello.txt"));

    // ── 监听：改动应在防抖窗口后以通知回推 ──
    conn.call(METHOD_WATCH, json!({"root": dir})).await.expect("watch");
    conn.invoke("write_file_content", json!({"path": format!("{dir}/b.txt"), "content": "x"}), None)
        .await
        .unwrap();
    let mut got = false;
    for _ in 0..50 {
        if events.lock().unwrap().iter().any(|n| n.event == "file-tree-changed") {
            got = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got, "no file-tree-changed notification from target");
    conn.call(METHOD_WATCH, json!({"root": Value::Null})).await.unwrap();

    // ── git / 搜索（可选：需要目标机上的仓库）──
    if let Some(repo) = env("AIDE_E2E_REPO") {
        let st = conn.invoke("git_status", json!({}), Some(repo.clone())).await.expect("git_status");
        println!("git_status entries: {}", st["entries"].as_array().map(|a| a.len()).unwrap_or(0));
        let log = conn.invoke("git_log", json!({"limit": 1}), Some(repo.clone())).await.expect("git_log");
        assert_eq!(log.as_array().map(|a| a.len()), Some(1));
        let info = conn.invoke("get_project_info", Value::Null, Some(repo.clone())).await.unwrap();
        println!("project: {info}");
    }

    conn.invoke("delete_file", json!({"path": dir}), None).await.expect("cleanup");

    // ── agent 车道：一轮真实会话，Bash 工具必须跑在目标机上 ──
    let Some(cfg) = env("AIDE_E2E_CLAUDE_CONFIG") else {
        println!("AIDE_E2E_CLAUDE_CONFIG 未设置，跳过 agent 轮次");
        return;
    };
    let mut cmd = launcher::command(&host, &format!("exec {} agent", launcher::sh_quote(&inst.host_bin)))
        .unwrap();
    let mut child = cmd.spawn().expect("spawn agent");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut init_env = std::collections::HashMap::new();
    init_env.insert("AIDE_CLAUDE_EXE".to_string(), inst.claude_exe.clone());
    init_env.insert("CLAUDE_CONFIG_DIR".to_string(), cfg);
    // 代理兜底：与生产车道同一套解析（桌面探测 → 回环按目标机网络改写）
    let mut default_env = std::collections::HashMap::new();
    if let Some(url) = crate::commands::proxy::detect_proxy() {
        if let Some((h, port)) = install::proxy_host_port(&url) {
            let target = if install::is_loopback_host(&h) {
                install::loopback_host_for(&host, &inst, port)
                    .await
                    .map(|lh| install::replace_proxy_host(&url, &lh))
            } else {
                Some(url.clone())
            };
            println!("desktop proxy {url} -> target {target:?}");
            if let Some(u) = target {
                for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                    default_env.insert(k.to_string(), u.clone());
                }
            }
        }
    }
    let init = AgentInit { env: init_env, default_env, node: inst.node.clone(), runtime: None };
    let cwd = env("AIDE_E2E_REPO").unwrap_or_else(|| conn.info.home.clone());
    let send = json!({
        "cmd": "send",
        "session_id": format!("e2e-{}", std::process::id()),
        "prompt": "Use the Bash tool to run `uname -s && pwd`, then reply with just DONE.",
        "cwd": cwd,
        "env": {},
    });
    stdin.write_all(format!("{}\n{}\n", serde_json::to_string(&init).unwrap(), send).as_bytes()).await.unwrap();

    let mut lines = BufReader::new(stdout).lines();
    let mut tool_output = String::new();
    let outcome = tokio::time::timeout(Duration::from_secs(240), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
            match ev["type"].as_str().unwrap_or("") {
                "tool_result" => tool_output.push_str(ev["content"].as_str().unwrap_or("")),
                "message_stop" => return Ok(()),
                "session_dead" | "error" => return Err(ev.to_string()),
                _ => {}
            }
        }
        Err("agent stdout closed".to_string())
    })
    .await
    .expect("agent turn timed out");
    let _ = child.start_kill();
    outcome.expect("agent turn failed");
    println!("tool output: {tool_output}");
    assert!(tool_output.contains("Linux"), "Bash did not run on the WSL target: {tool_output}");
    assert!(tool_output.contains(&cwd), "cwd not honoured on target: {tool_output}");
}
