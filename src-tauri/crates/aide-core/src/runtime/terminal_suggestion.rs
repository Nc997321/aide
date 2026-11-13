use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;

use super::AgentRuntimeManager;

type Suggestion = Result<String, String>;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(super) struct PendingSuggestions(Mutex<HashMap<String, oneshot::Sender<Suggestion>>>);

struct Pending<'a> {
    suggestions: &'a PendingSuggestions,
    id: String,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.suggestions.0.lock() {
            requests.remove(&self.id);
        }
    }
}

impl AgentRuntimeManager {
    pub(crate) async fn suggest_terminal_command(&self, mut command: Value) -> Suggestion {
        let id = format!("terminal-{}", NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        let pending = Pending {
            suggestions: &self.terminal_suggestions,
            id,
        };
        pending
            .suggestions
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(pending.id.clone(), tx);
        command["session_id"] = Value::String(pending.id.clone());
        self.send_to_runtime(&command).await?;
        tokio::time::timeout(Duration::from_secs(35), rx).await
            .map_err(|_| "终端命令生成超时".to_owned())?
            .map_err(|_| "模型连接已关闭".to_owned())?
    }

    pub(super) fn receive_terminal_suggestion(&self, event: &Value) -> bool {
        if event["type"].as_str() != Some("terminal_command_suggestion") {
            return false;
        }
        let tx = event["session_id"].as_str().and_then(|id| {
            self.terminal_suggestions.0.lock().ok()?.remove(id)
        });
        if let Some(tx) = tx {
            let result = event["command"].as_str().map(str::to_owned).ok_or_else(|| {
                event["error"].as_str().unwrap_or("模型未返回命令").to_owned()
            });
            let _ = tx.send(result);
        }
        true
    }
}
