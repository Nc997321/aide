//! Link 的 Host 端口实现：命令走 Host 命令表（与桌面前端 `invoke` 同一张表、零包装），事件走 Host 的
//! 事件总线（`Core::bus`，按会话订阅 + 续传）。**不认识任何传输**。

use std::sync::{Arc, Weak};

use aide_link::catalog::LinkPolicy;
use aide_link::frame::{HostFrame, HostInfo, Since, Subscribed};
use aide_link::{Backend, BoxFuture, Catalog, Subscription};
use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::bus::{Attach, Bus, ClientId, Consumer, Event, Resume};
use crate::{Core, Reply};

pub struct CoreBackend {
    /// 弱引用：Core 持有 LinkService、LinkService 持有后端，强引用会成环。
    core: Weak<Core>,
    device_id: String,
}

impl CoreBackend {
    pub fn new(core: &Arc<Core>, device_id: String) -> Self {
        Self { core: Arc::downgrade(core), device_id }
    }
}

/// 这台机器叫什么（手机上显示 Host 名）。
pub fn host_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "Aide Host".to_string())
}

impl Backend for CoreBackend {
    fn host(&self) -> HostInfo {
        HostInfo {
            id: self.device_id.clone(),
            name: host_name(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    fn policy(&self) -> LinkPolicy {
        let mode = self
            .core
            .upgrade()
            .and_then(|c| crate::app_settings::public_settings(&c.settings).ok())
            .map(|s| s.remote.permission_mode)
            .filter(|m| !m.is_empty());
        mode.map(|permission_mode| LinkPolicy { permission_mode }).unwrap_or_default()
    }

    fn call(&self, method: &str, params: Value) -> BoxFuture<Result<Value, String>> {
        let core = self.core.upgrade();
        let method = method.to_string();
        Box::pin(async move {
            let core = core.ok_or("Host is shutting down")?;
            let run = crate::lookup(&method).ok_or_else(|| format!("unknown host command `{method}`"))?;
            match run(core, params).await? {
                Reply::Json(v) => Ok(v),
                Reply::Bytes(b) => Ok(json!({ "$bytes": base64::engine::general_purpose::STANDARD.encode(b) })),
            }
        })
    }

    fn attach_events(
        &self,
        sink: UnboundedSender<HostFrame>,
        sessions: Option<Vec<String>>,
        since: Option<Since>,
    ) -> Box<dyn Subscription> {
        let Some(core) = self.core.upgrade() else {
            return Box::new(NoSub);
        };
        let bus = Arc::clone(&core.bus);
        let ack_sink = sink.clone();
        let req = Attach {
            resume: since.map(|s| Resume { epoch: s.epoch, seq: s.seq }),
            sessions,
            allow: Some(Catalog::is_event_exposed),
        };
        let (id, _) = bus.attach(Arc::new(LinkConsumer(sink)), req, |info| {
            let _ = ack_sink.send(HostFrame::Subscribed(Subscribed {
                epoch: info.epoch.clone(),
                seq: info.seq,
                resumed: info.resumed,
                gap: info.gap,
                replayed: info.replayed,
            }));
        });
        Box::new(BusSub { bus, id })
    }
}

/// 把总线事件变成 Link 的 `event` 帧。
struct LinkConsumer(UnboundedSender<HostFrame>);

impl Consumer for LinkConsumer {
    fn deliver(&self, ev: &Arc<Event>) -> bool {
        self.0.send(HostFrame::Event { seq: ev.seq, name: ev.name.clone(), payload: ev.payload.clone() }).is_ok()
    }
}

/// 订阅句柄：drop = 从总线退订。
struct BusSub {
    bus: Arc<Bus>,
    id: ClientId,
}

impl Subscription for BusSub {}

impl Drop for BusSub {
    fn drop(&mut self) {
        self.bus.detach(self.id);
    }
}

struct NoSub;
impl Subscription for NoSub {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NullSink;

    /// 目录里列的每个方法都必须真在 Host 命令表里——否则手机调用即「未知命令」（静默回归）。
    #[test]
    fn every_catalog_method_exists_in_the_host_command_table() {
        for (group, method) in Catalog::methods() {
            assert!(crate::lookup(method).is_some(), "catalog method `{method}` ({group}) is not a host command");
        }
    }

    /// 目录里没有的东西手机绝不能碰：桌面专属的写文件 / git / 终端 / 供应商密钥写入都不在目录里。
    #[test]
    fn desktop_only_capabilities_are_not_exposed() {
        for m in ["write_file_content", "pty_spawn_shell", "git_status", "git_commit", "delete_file", "install_plugin", "run_process_start"] {
            assert!(Catalog::group_of(m).is_none(), "`{m}` must not be reachable from a phone");
        }
    }

    #[tokio::test]
    async fn calls_go_through_the_host_command_table() {
        let core = crate::test_core(Arc::new(NullSink));
        let backend = CoreBackend::new(&core, "dev".into());
        // get_active_workspace：未设置工作区 → null
        assert_eq!(backend.call("get_active_workspace", json!({})).await.unwrap(), Value::Null);
        assert!(backend.call("no_such_command", json!({})).await.is_err());
        assert_eq!(backend.host().id, "dev");
    }

    /// 总线事件经 Link 帧送出：先 subscribed，再回放，再实时；只送目录里公开的事件。
    #[tokio::test]
    async fn events_flow_from_the_bus_as_link_frames_with_resume() {
        let core = crate::test_core(Arc::new(NullSink));
        let backend = CoreBackend::new(&core, "dev".into());
        core.emit("file-tree-changed", json!([])); // 不在目录里：手机收不到
        core.emit("system-notification", json!({"title":"t"})); // seq 2
        let epoch = core.bus.epoch().to_string();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let _sub = backend.attach_events(tx, None, Some(Since { epoch, seq: 0 }));
        match rx.recv().await {
            Some(HostFrame::Subscribed(s)) => assert!(s.resumed && !s.gap && s.replayed == 1, "{s:?}"),
            other => panic!("expected subscribed first, got {other:?}"),
        }
        match rx.recv().await {
            Some(HostFrame::Event { seq, name, .. }) => assert_eq!((seq, name.as_str()), (2, "system-notification")),
            other => panic!("expected the replayed event, got {other:?}"),
        }
        core.emit("chat-event", json!({"type":"x","session_id":"s1"}));
        assert!(matches!(rx.recv().await, Some(HostFrame::Event { seq: 3, .. })));
        drop(_sub);
        assert_eq!(core.bus.client_count(), 0, "dropping the subscription detaches from the bus");
    }
}
