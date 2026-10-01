//! `aide-host daemon`：常驻的 Host。持有 Core（agent runtime / 自动化 / LSP / 终端…），监听
//! `~/.aide/host/daemon.sock`，任意多个客户端（桌面的桥、将来的手机网关）来来去去——**客户端
//! 断开不收掉 Host**，会话在它下次连上时还在，错过的事件凭序号回放（见 `hub.rs`）。
//!
//! 一个用户一个守护进程：`daemon.lock`（`flock`）保证单例，套接字路径固定（`daemon.pid` 只是
//! 给人 / 排障脚本看的）。
//!
//! 退出：没有任何客户端、且静默超过宽限（`AIDE_HOST_IDLE_SECS`，默认 30 分钟；chat 事件算
//! 动静，所以长时间的 agent 一轮不会被收掉）→ 收掉 runtime / 语言服务器后退出；`shutdown`
//! 请求（桌面发现版本不符、将来的「重启 Host」）与 SIGTERM 同样走这条收尾。

use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aide_core::settings::{FileSecretStore, SettingsPaths, SettingsService};
use aide_core::{Core, EventSink};
use aide_host::protocol::ServeInit;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixListener;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::Notify;

use crate::hub::Hub;
use crate::kit::HostKit;
use crate::session::{serve_client, Daemon};

const DEFAULT_IDLE_SECS: u64 = 1800;
const IDLE_CHECK: Duration = Duration::from_secs(30);

/// 守护进程的落地目录（与按版本的安装目录同级）。
fn host_dir() -> PathBuf {
    aide_core::paths::our_config_dir().join("host")
}

pub fn socket_path() -> PathBuf {
    host_dir().join("daemon.sock")
}

pub fn log_path() -> PathBuf {
    host_dir().join("daemon.log")
}

fn lock_path() -> PathBuf {
    host_dir().join("daemon.lock")
}

/// 守护进程的 stdin 只用一次：桥把首个客户端的 [`ServeInit`] 写进来（那是它拉起 runtime 用的
/// 进程级设定）；手动启动、没有输入就用默认值。
async fn read_init() -> ServeInit {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    match lines.next_line().await {
        Ok(Some(l)) if !l.trim().is_empty() => serde_json::from_str(l.trim()).unwrap_or_else(|e| {
            eprintln!("[aide-host] bad init line: {e}");
            ServeInit::default()
        }),
        _ => ServeInit::default(),
    }
}

fn idle_grace() -> Duration {
    let secs = std::env::var("AIDE_HOST_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_SECS);
    Duration::from_secs(secs)
}

/// 每次启动随机的身份：客户端据此分辨「还是原来那个 Host」还是「重启过」。
fn new_daemon_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    h.write_u32(std::process::id());
    format!("{:016x}", h.finish())
}

pub async fn run() -> i32 {
    let init = read_init().await;

    // 单例：拿不到锁 = 已有一个守护进程在（桥并发拉起时输的那个安静退出）。
    let dir = host_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[aide-host] cannot create {}: {e}", dir.display());
        return 2;
    }
    let _ = restrict(&dir, 0o700);
    let lock = match OpenOptions::new().create(true).truncate(false).write(true).open(lock_path()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[aide-host] lock file: {e}");
            return 2;
        }
    };
    if lock.try_lock().is_err() {
        eprintln!("[aide-host] another daemon holds the lock; exiting");
        return 0;
    }

    let pid_file = dir.join("daemon.pid");
    let _ = std::fs::write(&pid_file, std::process::id().to_string());

    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let hub = Arc::new(Hub::new(new_daemon_id()));
    let kit = Arc::new(HostKit::new(init, install_dir));

    // Host 启动引导：与桌面本机 Host 同一份（aide_core::host）——数据迁移 / 日常目录 /
    // 恢复活动工作区，然后 provider 迁移 / agent runtime / 自动化 / 内置插件。
    let workspace = tokio::task::spawn_blocking(aide_core::host::prepare_workspace)
        .await
        .unwrap_or_default();
    let core = Core::new(
        Arc::new(workspace),
        Arc::new(host_settings()),
        Arc::clone(&hub) as Arc<dyn EventSink>,
        Arc::clone(&kit) as Arc<dyn aide_core::resources::HostResources>,
    );
    aide_core::host::start(&core);

    let sock = socket_path();
    let _ = std::fs::remove_file(&sock); // 持锁者独占，残留的套接字文件必是上一任留下的
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[aide-host] bind {}: {e}", sock.display());
            return 2;
        }
    };
    let _ = restrict(&sock, 0o600);
    eprintln!("[aide-host] daemon {} listening on {}", hub.daemon_id(), sock.display());

    let daemon = Arc::new(Daemon { core: Arc::clone(&core), hub: Arc::clone(&hub), kit, shutdown: Notify::new() });

    // 断开终端 / ssh 会话不能带走守护进程；SIGTERM 走正常收尾
    if let Ok(mut hup) = signal(SignalKind::hangup()) {
        tokio::spawn(async move { while hup.recv().await.is_some() {} });
    }
    let mut term = signal(SignalKind::terminate()).ok();
    let grace = idle_grace();
    let mut tick = tokio::time::interval(IDLE_CHECK);

    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let (r, w) = stream.into_split();
                    tokio::spawn(serve_client(Arc::clone(&daemon), r, w));
                }
                Err(e) => eprintln!("[aide-host] accept: {e}"),
            },
            _ = daemon.shutdown.notified() => break,
            _ = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending().await } } => break,
            _ = tick.tick() => {
                if hub.client_count() == 0 && hub.idle_for() >= grace {
                    eprintln!("[aide-host] idle for {}s with no clients; exiting", grace.as_secs());
                    break;
                }
            }
        }
    }

    // 收尾：runtime 与语言服务器是子进程树，不会随本进程退出自动消亡
    let _ = std::fs::remove_file(&sock);
    let _ = std::fs::remove_file(&pid_file);
    core.runtime.kill_runtime().await;
    core.lsp.kill_all().await;
    let _ = tokio::task::spawn_blocking(move || aide_core::commands::watch::retarget(&core, None)).await;
    drop(lock);
    0
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

fn restrict(path: &std::path::Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}
