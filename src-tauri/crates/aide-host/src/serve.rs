//! `aide-host serve`：一个完整的 Host（aide-core），经 stdio JSON-RPC 连到一扇 GUI 窗口。
//!
//! 生命周期：首行 [`ServeInit`] → Host 起来（agent runtime / 自动化调度在后台拉起）→ 请求循环
//! → stdin EOF（窗口断开）→ 收掉 runtime 子进程树后退出。
//!
//! 并发模型：每条请求独立 spawn（慢的全树搜索不堵住文件树的 list_directory）；
//! 所有出站帧（响应 + 通知）经同一个 mpsc 串行写 stdout，保证一行一帧不交错；
//! 通知 = Host 核心（aide-core）经 `EventSink` 发出的事件。
//! stdin EOF = 桌面断开（wsl/ssh 管道关闭）→ 进程退出，监听线程随之消亡。

use std::sync::Arc;

use std::collections::HashMap;
use std::path::PathBuf;

use aide_core::resources::HostResources;
use aide_core::settings::{FileSecretStore, SettingsPaths, SettingsService};
use aide_core::{Core, EventSink};
use aide_host::protocol::{
    HelloInfo, InvokeParams, Notification, Request, Response, ServeInit, METHOD_HELLO,
    METHOD_INVOKE, PROTOCOL_VERSION,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::dispatch;

/// Host 核心的事件出口 = stdout 通知帧（与响应帧同一条串行写出通道）。
struct NotifySink(UnboundedSender<String>);

impl EventSink for NotifySink {
    fn emit(&self, event: &str, payload: Value) {
        let n = Notification {
            event: event.to_string(),
            payload,
        };
        match serde_json::to_string(&n) {
            // 发送失败 = 桌面已断开，进程即将随 stdin EOF 退出，无处可报
            Ok(s) => {
                let _ = self.0.send(s);
            }
            Err(e) => eprintln!("[aide-host] event {event} not serialisable: {e}"),
        }
    }
}

/// 目标机上 Host 的随包资源：套件安装目录里的 sidecar（runtime.js，node 跑）+ 套件带的
/// claude CLI。codegraph runner / 捆绑 LSP 还不随远程套件分发——如实报错 / 走登录 PATH。
struct HostKit {
    init: ServeInit,
    install_dir: PathBuf,
}

impl HostResources for HostKit {
    fn codegraph_runner(&self) -> Result<PathBuf, String> {
        Err("代码索引暂不随远程 Host 分发".into())
    }

    fn codegraph_model_dir(&self) -> Option<PathBuf> {
        None
    }

    fn lsp_dir(&self) -> Option<PathBuf> {
        None
    }

    fn agent_runtime(&self) -> Result<(String, PathBuf), String> {
        let runtime = self.install_dir.join("runtime").join("runtime.js");
        if !runtime.is_file() {
            return Err(format!("sidecar missing: {}", runtime.display()));
        }
        // 进程环境已是登录环境（main 里切过），`which` 看到的就是用户终端的 PATH。
        let node = self.init.node.clone().unwrap_or_else(|| "node".into());
        let node = crate::login::which(&node, None)
            .ok_or_else(|| format!("找不到 node（{node}）：请在目标机上安装 Node.js"))?;
        Ok((node, runtime))
    }

    fn claude_exe(&self) -> Option<PathBuf> {
        self.init.claude_exe.as_ref().map(PathBuf::from)
    }

    fn agent_env(&self) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = self
            .init
            .default_env
            .iter()
            .filter(|(k, _)| std::env::var_os(k).is_none())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        env.extend(self.init.env.clone());
        env
    }
}

pub async fn run() -> i32 {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let init: ServeInit = match lines.next_line().await {
        Ok(Some(first)) => match serde_json::from_str(first.trim()) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("[aide-host] bad init line: {e}");
                return 2;
            }
        },
        _ => {
            eprintln!("[aide-host] no init line");
            return 2;
        }
    };
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));

    let (tx, mut rx) = unbounded_channel::<String>();

    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
                break; // 桌面已断开
            }
        }
    });

    // Host 启动引导：与桌面本机 Host 同一份（aide_core::host）——数据迁移 / 日常目录 /
    // 恢复活动工作区，然后 provider 迁移 / agent runtime / 自动化 / 内置插件。
    let workspace = tokio::task::spawn_blocking(aide_core::host::prepare_workspace)
        .await
        .unwrap_or_default();
    let core = Core::new(
        Arc::new(workspace),
        Arc::new(host_settings()),
        Arc::new(NotifySink(tx.clone())),
        Arc::new(HostKit { init, install_dir }),
    );
    aide_core::host::start(&core);
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[aide-host] bad frame: {e}");
                continue;
            }
        };
        let tx = tx.clone();
        let core = Arc::clone(&core);
        tokio::spawn(async move {
            let resp = match handle(req.method.as_str(), req.params, core).await {
                Ok(v) => Response {
                    id: req.id,
                    ok: Some(v),
                    err: None,
                },
                Err(e) => Response {
                    id: req.id,
                    ok: None,
                    err: Some(e),
                },
            };
            if let Ok(s) = serde_json::to_string(&resp) {
                let _ = tx.send(s);
            }
        });
    }
    // 窗口断开：收掉 agent runtime 与语言服务器（子进程树不随 serve 退出自动消亡）
    core.runtime.kill_runtime().await;
    core.lsp.kill_all().await;
    // 停掉监听线程（它经 NotifySink 持有 tx 的克隆，不停表 writer 永远等不到通道关闭）
    let _ = tokio::task::spawn_blocking(move || aide_core::commands::watch::retarget(&core, None)).await;
    drop(tx);
    let _ = writer.await;
    0
}

async fn handle(method: &str, params: Value, core: Arc<Core>) -> Result<Value, String> {
    match method {
        METHOD_HELLO => serde_json::to_value(hello()).map_err(|e| e.to_string()),
        METHOD_INVOKE => {
            let p: InvokeParams =
                serde_json::from_value(params).map_err(|e| format!("invalid invoke: {e}"))?;
            dispatch::invoke(core, p).await
        }
        other => Err(format!("aide-host: unknown method `{other}`")),
    }
}

/// 目标机上的设置：文件落目标机 `~/.aide/`；密钥落 `~/.aide/secrets.json`（0600）——供应商
/// 按 Host 自持（2026-09-30 定），桌面可显式把本机供应商复制过来。初始化失败只留痕：设置类
/// 命令会如实报 NotInitialized，其余命令照常可用。
fn host_settings() -> SettingsService {
    let paths = SettingsPaths::new().unwrap_or_else(|e| {
        eprintln!("[aide-host] settings paths: {e}");
        SettingsPaths::for_test(aide_core::paths::our_config_dir())
    });
    let secrets = FileSecretStore::new(aide_core::paths::our_config_dir().join("secrets.json"));
    let service = SettingsService::new(paths, Arc::new(secrets));
    if let Err(e) = service.initialize_blocking() {
        eprintln!("[aide-host] settings initialise failed: {e}");
    }
    service
}

fn hello() -> HelloInfo {
    HelloInfo {
        protocol: PROTOCOL_VERSION,
        version: crate::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: std::env::var("HOME").unwrap_or_default(),
        user: std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_default(),
    }
}
