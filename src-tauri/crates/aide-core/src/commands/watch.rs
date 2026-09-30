//! 文件树监听：外部改动（资源管理器 / 其他编辑器 / agent 的 git 操作）自动刷新文件树。
//! 归集 / 防抖 / 生命周期全在 [`aide_workspace::watch`]；这里把事件出口接到 Host 的
//! [`crate::EventSink`]——本机 = Tauri 广播，远程 = aide-host 通知帧，前端都收
//! `file-tree-changed`（payload = 受影响父目录，空数组 = 全量刷新）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use aide_workspace::watch::{WatchSink, EVENT_NAME};
use serde::Deserialize;
use serde_json::json;

use crate::registry::{blocking, Command};
use crate::{command, Core};

pub static COMMANDS: &[Command] = &[command!("file_tree_watch", file_tree_watch)];

#[derive(Deserialize)]
pub struct WatchArgs {
    /// 空串 = 停表。
    #[serde(default)]
    root: String,
}

/// 前端 FileTree 在 loadRoot 成功后调用：把监控指向当前工作区根（或空串停表）。
/// 重活（Linux 全树 inotify_add_watch）在 retarget 的锁内，故离开异步线程。
async fn file_tree_watch(core: Arc<Core>, a: WatchArgs) -> Result<(), String> {
    let root = (!a.root.is_empty()).then(|| PathBuf::from(a.root));
    blocking(move || retarget(&core, root.as_deref())).await
}

/// 监听重定向（`None` = 停表）。阻塞：调用方负责离开异步线程。
pub fn retarget(core: &Core, root: Option<&Path>) -> Result<(), String> {
    let events = core.events();
    let sink: WatchSink = Arc::new(move |dirs: Vec<String>| {
        events.emit(EVENT_NAME, json!(dirs));
        Ok(())
    });
    core.watch.retarget(root, &sink)
}

#[cfg(test)]
mod tests {
    use crate::registry::lookup;
    use crate::{Core, EventSink, WorkspaceState};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, Value)>>);

    impl EventSink for Recorder {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    #[tokio::test]
    async fn changes_reach_the_event_sink() {
        let dir = std::env::temp_dir().join(format!("aide-core-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rec = Arc::new(Recorder::default());
        let core = Core::new(Arc::new(WorkspaceState::new()), rec.clone());
        let run = lookup("file_tree_watch").unwrap();
        run(core.clone(), json!({ "root": dir })).await.unwrap();
        std::fs::write(dir.join("x.txt"), "x").unwrap();
        let mut got = false;
        for _ in 0..50 {
            if rec.0.lock().unwrap().iter().any(|(e, _)| e == "file-tree-changed") {
                got = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        run(core, json!({ "root": "" })).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(got, "no file-tree-changed event");
    }
}
