//! 真机端到端（默认 ignore）：Windows 桌面进程 → wsl.exe → 目标发行版上的 `aide-host serve`。
//!
//! 走生产同一条链：套件安装（install）→ serve 握手（connection，首行 ServeInit）→ 前端会发的
//! 同一批 core 命令（fs / git / 监听 / 发消息 / LSP）原样发给 serve——即 Host 窗口里发生的事。
//!
//! 运行（Windows，先 `pnpm build:remote-kit`）：
//! ```text
//! set AIDE_E2E_WSL=Debian
//! set AIDE_E2E_REPO=/home/<you>/programs/aide        （目标机上的一个 git 仓库）
//! set AIDE_E2E_CLAUDE_CONFIG=/home/<you>/.claude     （目标机上已登录的 claude home，chat 轮次用）
//! cargo test --lib remote_workspace::e2e_tests -- --ignored --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aide_host::protocol::{Notification, ServeInit};
use serde_json::{json, Value};

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

/// 与生产 `RemoteWorkspaces::establish` 同一份 ServeInit（node 可显式给）。
async fn serve_init(host: &HostId, inst: &install::Installed, node: Option<String>) -> ServeInit {
    let host_env = install::host_env(host, inst).await;
    ServeInit {
        env: host_env.env,
        default_env: host_env.default_env,
        node: node.or_else(|| inst.node.clone()),
        claude_exe: Some(inst.claude_exe.clone()),
    }
}

fn serve_cmd(host: &HostId, inst: &install::Installed, home: Option<&str>) -> tokio::process::Command {
    let prefix = home.map(|h| format!("HOME={} ", launcher::sh_quote(h))).unwrap_or_default();
    launcher::command(host, &format!("{prefix}exec {} serve", launcher::sh_quote(&inst.host_bin))).unwrap()
}

#[tokio::test]
#[ignore = "真机：需要 WSL 发行版（AIDE_E2E_WSL）与 pnpm build:remote-kit"]
async fn wsl_install_connect_and_workspace_ops() {
    let distro = env("AIDE_E2E_WSL").expect("set AIDE_E2E_WSL=<distro>");
    let host = HostId::Wsl(distro);

    // ── 安装（幂等：第二次运行应只做探测）──
    let t = std::time::Instant::now();
    let inst = install::ensure_installed(kit(), &host).await.expect("install");
    println!("installed in {:?}: {inst:?}", t.elapsed());

    // ── serve 握手 ──
    let events: Arc<Mutex<Vec<Notification>>> = Arc::default();
    let sink = Arc::clone(&events);
    let conn = HostConnection::start(
        host.clone(),
        serve_cmd(&host, &inst, None),
        &serve_init(&host, &inst, None).await,
        Arc::new(move |_h: &HostId, n: Notification| sink.lock().unwrap().push(n)),
    )
    .await
    .expect("connect");
    println!("hello: {:?}", conn.info);
    assert_eq!(conn.info.os, "linux");

    // ── fs：在目标机家目录下建临时目录，写 / 读 / 列 ──
    let dir = format!("{}/.aide-e2e-{}", conn.info.home, std::process::id());
    conn.invoke("create_dir", json!({"parentPath": conn.info.home, "name": dir.rsplit('/').next().unwrap()}))
        .await
        .expect("create_dir");
    let file = format!("{dir}/hello.txt");
    conn.invoke("write_file_content", json!({"path": file, "content": "你好 remote"}))
        .await
        .expect("write");
    let text = conn.invoke("read_file_content", json!({"path": file})).await.expect("read");
    assert_eq!(text, json!("你好 remote"));
    let listing = conn.invoke("list_directory", json!({"path": dir})).await.expect("list");
    assert_eq!(listing[0]["name"], json!("hello.txt"));

    // ── 上传：GUI 机器上的文件进到 Host 暂存（粘贴 / 拖入走这条）──
    let staged = conn
        .invoke("stage_dropped_file", json!({"name": "shot.png", "base64": "aGk="}))
        .await
        .expect("stage");
    let staged = staged.as_str().unwrap();
    // 重名会追加 ` (n)`（重复跑 e2e 时 /tmp 里已有前几次的），只认「落在 Host 上的 shot*.png」
    let name = staged.rsplit('/').next().unwrap_or("");
    assert!(staged.starts_with('/') && name.starts_with("shot") && name.ends_with(".png"), "staged on the Host: {staged}");
    let back = conn.invoke("read_file_base64", json!({"path": staged})).await.expect("read staged");
    assert_eq!(back, json!("aGk="), "staged bytes round-trip");
    let _ = conn.invoke("delete_file", json!({"path": staged})).await;

    // ── 监听：改动应在防抖窗口后以通知回推 ──
    conn.invoke("file_tree_watch", json!({"root": dir})).await.expect("watch");
    conn.invoke("write_file_content", json!({"path": format!("{dir}/b.txt"), "content": "x"}))
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
    conn.invoke("file_tree_watch", json!({"root": ""})).await.unwrap();

    // ── git / 项目信息（可选：需要目标机上的仓库；与 Host 窗口一样按 cwd 传根）──
    if let Some(repo) = env("AIDE_E2E_REPO") {
        let st = conn.invoke("git_status", json!({"cwd": repo})).await.expect("git_status");
        println!("git_status entries: {}", st["entries"].as_array().map(|a| a.len()).unwrap_or(0));
        let log = conn.invoke("git_log", json!({"limit": 1, "cwd": repo})).await.expect("git_log");
        assert_eq!(log.as_array().map(|a| a.len()), Some(1));
        let info = conn.invoke("get_project_info", json!({"cwd": repo})).await.unwrap();
        println!("project: {info}");
    }

    conn.invoke("delete_file", json!({"path": dir})).await.expect("cleanup");
}

/// LSP 跑在 Host 里（aide-core 的 LspManager，登录 PATH 解析服务器）：前端的同一批 LSP 命令
/// 原样发给 serve，路径全是 Host 原生路径。验证①服务器在目标机上被找到并跑起来 ②文档符号
/// 与跳定义答得上、结果路径是 Host 路径。
///
/// 用真实 HOME（语言服务器要在你的登录 PATH 上找，`rustup component add rust-analyzer`）：
/// 临时工程先 `trust_workspace`（LSP 的信任门），收尾 `untrust_workspace` 撤掉。
#[tokio::test]
#[ignore = "真机：需要 WSL 发行版（AIDE_E2E_WSL）、pnpm build:remote-kit 与目标机 rust-analyzer"]
async fn wsl_host_serve_runs_a_language_server() {
    let distro = env("AIDE_E2E_WSL").expect("set AIDE_E2E_WSL=<distro>");
    let host = HostId::Wsl(distro);
    let inst = install::ensure_installed(kit(), &host).await.expect("install");
    let conn = HostConnection::start(
        host.clone(),
        serve_cmd(&host, &inst, None),
        &serve_init(&host, &inst, None).await,
        Arc::new(|_h: &HostId, _n: Notification| {}),
    )
    .await
    .expect("connect");

    // 目标机上一个最小 cargo 工程
    let dir = format!("{}/.aide-e2e-lsp-{}", conn.info.home, std::process::id());
    let main_rs = format!("{dir}/src/main.rs");
    let main_text = "fn helper() -> u32 { 7 }\n\nfn main() {\n    let _ = helper();\n}\n";
    conn.invoke("create_dir", json!({"parentPath": conn.info.home, "name": dir.rsplit('/').next().unwrap()}))
        .await
        .expect("mkdir");
    conn.invoke("create_dir", json!({"parentPath": dir, "name": "src"})).await.expect("mkdir src");
    conn.invoke(
        "write_file_content",
        json!({"path": format!("{dir}/Cargo.toml"), "content": "[package]\nname = \"e2e\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"}),
    )
    .await
    .expect("write Cargo.toml");
    conn.invoke("write_file_content", json!({"path": main_rs, "content": main_text}))
        .await
        .expect("write main.rs");

    conn.invoke("trust_workspace", json!({"path": dir})).await.expect("trust");
    let outcome = async {
        let ensure = conn
            .invoke("lsp_ensure_server", json!({"workspaceRoot": dir, "lang": "rust"}))
            .await?;
        if ensure["ok"] != json!(true) {
            return Err(format!("server not started: {ensure}"));
        }
        conn.invoke(
            "lsp_did_open",
            json!({"workspaceRoot": dir, "filePath": main_rs, "lang": "rust", "text": main_text}),
        )
        .await?;

        // documentSymbol 是语法层（很快有）；definition 要等 RA 载入 crate 图
        let mut symbols = Value::Null;
        for _ in 0..60 {
            symbols = conn
                .invoke("lsp_document_symbol", json!({"workspaceRoot": dir, "filePath": main_rs}))
                .await?;
            if symbols.as_array().is_some_and(|a| !a.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        println!("symbols: {symbols}");
        if !symbols.to_string().contains("helper") {
            return Err(format!("no symbols from the Host's server: {symbols}"));
        }
        let mut def = Value::Null;
        for _ in 0..90 {
            // `helper()` 调用处：第 4 行第 14 列（1-based）
            def = conn
                .invoke(
                    "lsp_definition",
                    json!({"workspaceRoot": dir, "filePath": main_rs, "line": 4, "column": 14, "word": "helper"}),
                )
                .await?;
            if def["results"].as_array().is_some_and(|a| !a.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        println!("definition: {def}");
        let file = def["results"][0]["symbol"]["file"].as_str().unwrap_or("");
        if !file.ends_with("src/main.rs") || def["results"][0]["symbol"]["line"] != json!(1) {
            return Err(format!("definition not resolved on the Host: {def}"));
        }
        Ok(())
    }
    .await;
    let _ = conn.invoke("lsp_shutdown_workspace", json!({"workspaceRoot": dir})).await;
    let _ = conn.invoke("untrust_workspace", json!({"path": dir})).await;
    let _ = conn.invoke("delete_file", json!({"path": dir})).await;
    outcome.expect("language server on the Host");
}

/// Host 模型（P1）：`aide-host serve` 本身就是完整 Host——前端的 `send_message` 原样发给它，
/// agent runtime 跑在目标机上，chat-event 经通知帧回来。验证①Host 用自己的设置解析供应商、
/// 自己拉起 sidecar ②Bash 工具在目标机上、按会话 cwd 执行 ③事件原样回到连接这一侧。
///
/// 隔离：serve 跑在一个临时 `HOME` 里（设置 / 密钥 / claude 数据都不碰你真实的 Host 配置），
/// 登录态从 `AIDE_E2E_CLAUDE_CONFIG` 复制一份进去；node 按真实登录 shell 解析后经 ServeInit 给。
#[tokio::test]
#[ignore = "真机：需要 WSL 发行版（AIDE_E2E_WSL）、pnpm build:remote-kit、AIDE_E2E_CLAUDE_CONFIG"]
async fn wsl_host_serve_runs_a_chat_round() {
    let distro = env("AIDE_E2E_WSL").expect("set AIDE_E2E_WSL=<distro>");
    let cfg = env("AIDE_E2E_CLAUDE_CONFIG").expect("set AIDE_E2E_CLAUDE_CONFIG=<target claude home>");
    let host = HostId::Wsl(distro);
    let inst = install::ensure_installed(kit(), &host).await.expect("install");

    let home = format!("/tmp/aide-e2e-host-{}", std::process::id());
    let prep = format!(
        "rm -rf {h} && mkdir -p {h}/.aide/claude && cp {c}/.credentials.json {h}/.aide/claude/ && command -v node",
        h = launcher::sh_quote(&home),
        c = launcher::sh_quote(&cfg),
    );
    let out = launcher::command(&host, &format!("exec \"${{SHELL:-/bin/sh}}\" -lic {}", launcher::sh_quote(&prep)))
        .unwrap()
        .output()
        .await
        .expect("prepare host home");
    let node = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").trim().to_string();
    assert!(node.starts_with('/'), "node not found in login shell: {:?}", String::from_utf8_lossy(&out.stderr));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let conn = HostConnection::start(
        host.clone(),
        serve_cmd(&host, &inst, Some(&home)),
        &serve_init(&host, &inst, Some(node)).await,
        Arc::new(move |_h: &HostId, n: Notification| {
            if n.event == "chat-event" {
                let _ = tx.send(n.payload);
            }
        }),
    )
    .await
    .expect("connect");

    // Host 启动引导（aide_core::host，与桌面同一份）：全新 HOME 上日常目录也必须建好
    //（2026-09-30 真机：serve 漏了这步，日常会话 cwd 不存在，claude 起不来）。
    let daily = conn.invoke("daily_workspace", json!({})).await.expect("daily_workspace");
    let daily = daily["path"].as_str().unwrap().to_string();
    assert!(daily.starts_with(&home), "daily workspace under the Host's HOME: {daily}");
    conn.invoke("list_directory", json!({"path": daily}))
        .await
        .expect("daily workspace directory must exist on a fresh Host");

    let cwd = env("AIDE_E2E_REPO").unwrap_or_else(|| conn.info.home.clone());
    let sid = format!("e2e-host-{}", std::process::id());
    conn.invoke(
        "send_message",
        json!({
            "sessionId": sid,
            "prompt": "Use the Bash tool to run `uname -s && pwd`, then reply with just DONE.",
            "workspaceRoot": cwd,
            "permissionMode": "bypassPermissions",
        }),
    )
    .await
    .expect("send_message on the Host");

    let mut tool_output = String::new();
    let outcome = tokio::time::timeout(Duration::from_secs(240), async {
        while let Some(ev) = rx.recv().await {
            match ev["type"].as_str().unwrap_or("") {
                "tool_result" => tool_output.push_str(ev["content"].as_str().unwrap_or("")),
                "message_stop" => return Ok(()),
                "session_dead" | "runtime_dead" | "error" => return Err(ev.to_string()),
                _ => {}
            }
        }
        Err("host connection closed".to_string())
    })
    .await
    .expect("host chat turn timed out");
    let _ = launcher::command(&host, &format!("rm -rf {}", launcher::sh_quote(&home)))
        .unwrap()
        .output()
        .await;
    outcome.expect("host chat turn failed");
    println!("tool output: {tool_output}");
    assert!(tool_output.contains("Linux"), "Bash did not run on the Host: {tool_output}");
    assert!(tool_output.contains(&cwd), "cwd not honoured on the Host: {tool_output}");
}
