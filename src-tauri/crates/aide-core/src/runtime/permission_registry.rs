//! 待处理交互请求的 Host 投影：只认 sidecar 生命周期事件，不从聊天历史猜测。
//! 请求保留到 permission_cancelled 或会话/运行时死亡，与总线回放容量无关。
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct PermissionRegistry {
    sessions: Mutex<HashMap<String, Vec<Value>>>,
}

impl PermissionRegistry {
    pub fn feed(&self, event: &Value) {
        let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(ty, "permission_request" | "permission_cancelled") {
            return;
        }
        let Some(sid) = event
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let Some(id) = event
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let mut sessions = self.sessions.lock().unwrap();
        if ty == "permission_request" {
            let requests = sessions.entry(sid.to_string()).or_default();
            if let Some(old) = requests.iter_mut().find(|p| p["id"].as_str() == Some(id)) {
                *old = event.clone();
            } else {
                requests.push(event.clone());
            }
        } else if let Some(requests) = sessions.get_mut(sid) {
            requests.retain(|p| p["id"].as_str() != Some(id));
            if requests.is_empty() {
                sessions.remove(sid);
            }
        }
    }

    pub fn list(&self, sid: &str) -> Vec<Value> {
        self.sessions
            .lock()
            .unwrap()
            .get(sid)
            .cloned()
            .unwrap_or_default()
    }

    pub fn clear(&self, sid: &str) {
        self.sessions.lock().unwrap().remove(sid);
    }

    pub fn clear_all(&self) {
        self.sessions.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(sid: &str, id: &str) -> Value {
        json!({"type":"permission_request", "session_id":sid, "id":id,
            "name":"AskUserQuestion", "input":{"questions":[{"question":"继续吗？"}]},
            "fromSubagent":{"id":"child", "agentName":"reviewer"}})
    }

    #[test]
    fn late_clients_get_only_unresolved_requests_in_order_and_for_their_session() {
        let registry = PermissionRegistry::default();
        let first = request("s1", "p1");
        let second = request("s1", "p2");
        registry.feed(&first);
        registry.feed(&second);
        registry.feed(&request("s2", "p3"));
        registry.feed(&first); // 重复广播不重复入队、不改变顺序，保留完整载荷
        assert_eq!(registry.list("s1"), vec![first, second.clone()]);
        registry.feed(&json!({"type":"permission_cancelled", "session_id":"s1", "id":"p1"}));
        assert_eq!(registry.list("s1"), vec![second]);
        registry.feed(&json!({"type":"permission_cancelled", "session_id":"s1", "id":"p2"}));
        assert!(registry.list("s1").is_empty());
        assert_eq!(registry.list("s2").len(), 1);
    }

    #[test]
    fn death_clears_requests_and_new_sessions_do_not_inherit_them() {
        let registry = PermissionRegistry::default();
        registry.feed(&request("s1", "p1"));
        registry.feed(&request("s2", "p2"));
        registry.clear("s1");
        assert!(registry.list("s1").is_empty());
        assert_eq!(registry.list("s2").len(), 1);
        registry.clear_all();
        assert!(registry.list("s2").is_empty());
        registry.feed(&request("s1", "new"));
        assert_eq!(registry.list("s1"), vec![request("s1", "new")]);
    }
}
