pub mod auth;
pub mod protocol;
pub mod relay_client;
pub mod rpc;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::commands::settings::{public_settings, RemoteSettings};
use crate::settings::SettingsService;

/// 锁毒化恢复：毒锁只说明「持锁期间有 task panic」，值守恒（Option<JoinHandle> /
/// 配对码都是整体赋值语义），取回守卫继续——比 unwrap 崩掉整个 relay 任务强。
pub(crate) fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 连接中途的配对码宣告（update_code 帧）暂存槽：latest-wins + Notify 唤醒。
/// 修的是「刷新配对码不上报 relay」：旧实装码只活在本地 PairingState，relay 的
/// 码路由里还是旧码，新码对手机永远 unknown device。
/// - 无门控：宣告落在「register 读码 → set_connected」窗口内也必须上线，
///   加连接态门控会把本 bug 以竞态形式 reintroduce；
/// - 防陈旧：connect_once 在读码前 clear_pending——断连期积压的旧码若在新连接
///   register 之后发出，会把刚注册的新码清掉；
/// - 断连无消费方时 announce 只积压一条（覆盖式），下次连接即被 clear 丢弃。
pub struct CodeAnnouncer {
    pending: Mutex<Option<String>>,
    notify: Notify,
}

impl CodeAnnouncer {
    fn new() -> Self {
        Self {
            pending: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    /// 命令侧：记最新码并唤醒 relay 任务（覆盖旧待宣值 = latest-wins）。
    pub fn announce(&self, code: String) {
        *lock_recover(&self.pending) = Some(code);
        self.notify.notify_one();
    }

    /// relay 任务侧（connect_once 入口）：清掉断连期积压的待宣值。
    pub fn clear_pending(&self) -> Option<String> {
        lock_recover(&self.pending).take()
    }

    /// relay 任务侧：等并取走最新宣告（select 臂用；无宣告时永久 pending）。
    pub async fn take(&self) -> String {
        loop {
            self.notify.notified().await;
            if let Some(code) = lock_recover(&self.pending).take() {
                return code;
            }
        }
    }
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
    /// 中途换码宣告通道（refresh → relay update_code 帧）
    pub codes: CodeAnnouncer,
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
            codes: CodeAnnouncer::new(),
            relay_task: Mutex::new(None),
            connected: AtomicBool::new(false),
        }
    }

    /// 换码宣告入口（设置面板「刷新」）：relay 在线即发 update_code 帧，
    /// 不在线则积压一条、下次连接入口清除（register 会带当前码）。
    pub fn announce_code(&self, code: String) {
        self.codes.announce(code);
    }

    /// 启动中继客户端任务（幂等：已在跑则不动）。
    /// 必须走 tauri 的全局 async runtime 而非 tokio::spawn——setup 钩子跑在主线程
    /// （Tokio runtime 之外），tokio::spawn 会 panic "no reactor running"。
    pub fn start(self: &Arc<Self>) {
        if lock_recover(&self.relay_task).is_some() {
            return;
        }
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

/// 读远程设置（spawn_blocking 包同步 IO）。rpc/relay_client 共用。
pub(crate) async fn read_remote_settings(app: &AppHandle) -> Result<RemoteSettings, String> {
    let service = app.state::<Arc<SettingsService>>();
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || public_settings(&service))
        .await
        .map_err(|e| e.to_string())?
        .map(|s| s.remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn code_announcer_latest_wins() {
        let a = CodeAnnouncer::new();
        // 连宣两次：消费方只应看到最新值（bounded 覆盖语义）
        a.announce("111111".into());
        a.announce("222222".into());
        assert_eq!(a.take().await, "222222");
    }

    #[tokio::test]
    async fn code_announcer_take_waits_for_late_announce() {
        let a = Arc::new(CodeAnnouncer::new());
        let a2 = a.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            a2.announce("late".into());
        });
        assert_eq!(a.take().await, "late");
    }

    #[tokio::test]
    async fn code_announcer_clear_pending_drops_stale() {
        let a = CodeAnnouncer::new();
        // 断连期积压 → connect_once 入口清除 → 不会在 register 之后误发旧码
        a.announce("old".into());
        assert_eq!(a.clear_pending().as_deref(), Some("old"));
        a.announce("new".into());
        assert_eq!(a.take().await, "new");
    }

    #[test]
    fn lock_recover_survives_poisoned_mutex() {
        let m = Mutex::new(1);
        // 人为毒化：持锁期间 panic（AssertUnwindSafe：毒化正是本测试的目的）
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("boom");
        }));
        assert!(m.is_poisoned());
        // 恢复路径：拿得到守卫、值完好、可写
        *lock_recover(&m) = 2;
        assert_eq!(*lock_recover(&m), 2);
    }
}
