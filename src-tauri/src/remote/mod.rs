pub mod auth;
pub mod protocol;
pub mod relay_client;
pub mod rpc;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri::async_runtime::JoinHandle;

use crate::commands::settings::{public_settings, RemoteSettings};
use crate::settings::SettingsService;

/// 锁毒化恢复：毒锁只说明「持锁期间有 task panic」，值守恒（Option<JoinHandle> /
/// 配对码都是整体赋值语义），取回守卫继续——比 unwrap 崩掉整个 relay 任务强。
pub(crate) fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 远程控制网关：出站连中继，桥接手机消息到 sidecar 命令面。
/// 组装层——只做生命周期 + 连接状态；认证逻辑在 auth::TokenStore，
/// 消息映射在 rpc，传输在 relay_client。
pub struct RemoteGateway {
    app_handle: AppHandle,
    /// 配对码状态（10 分钟轮换）
    pub pairing: Mutex<auth::PairingState>,
    /// 长期 token 签发/校验/吊销 + 设备身份
    pub tokens: auth::TokenStore,
    relay_task: Mutex<Option<JoinHandle<()>>>,
    connected: AtomicBool,
}

impl RemoteGateway {
    pub fn new(app_handle: AppHandle) -> Self {
        let service = app_handle.state::<Arc<SettingsService>>().inner().clone();
        Self {
            app_handle,
            pairing: Mutex::new(auth::PairingState::new()),
            tokens: auth::TokenStore::new(service),
            relay_task: Mutex::new(None),
            connected: AtomicBool::new(false),
        }
    }

    /// 启动中继客户端任务（幂等：已在跑则不动）。
    /// 必须走 tauri 的全局 async runtime 而非 tokio::spawn——setup 钩子跑在主线程
    /// （Tokio runtime 之外），tokio::spawn 会 panic "no reactor running"。
    pub fn start(self: &Arc<Self>) {
        if lock_recover(&self.relay_task).is_some() { return; }
        let gateway = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            relay_client::run(gateway).await;
        });
        *lock_recover(&self.relay_task) = Some(handle);
    }

    /// 停止中继客户端任务（abort 会打断重连退避 sleep）。
    pub fn stop(&self) {
        if let Some(h) = lock_recover(&self.relay_task).take() {
            h.abort();
        }
        self.connected.store(false, Ordering::Relaxed);
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn set_connected(&self, value: bool) {
        self.connected.store(value, Ordering::Relaxed);
    }
}

/// 读远程设置（spawn_blocking 包同步 IO）。bridge/relay_client 共用。
pub(crate) async fn read_remote_settings(app: &AppHandle) -> Result<RemoteSettings, String> {
    let service = app.state::<Arc<SettingsService>>();
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || public_settings(&service))
        .await.map_err(|e| e.to_string())?
        .map(|s| s.remote)
}
