//! 只消费关闭／离开媒体页的事件，不观察 displayed/visibility，不改变普通标签切换行为。

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Listener, Manager};

use super::registry::MediaRegistry;

pub(super) fn install(app: &AppHandle) {
    let owner = app.clone();
    app.listen_any(crate::browser::facade::VIEW_EVENT, move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            on_view_event(&owner, &payload);
        }
    });
    let owner = app.clone();
    app.listen_any(crate::browser::facade::NAV_EVENT, move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            on_navigation(&owner, &payload);
        }
    });
}

fn on_view_event(app: &AppHandle, payload: &Value) {
    if payload.get("kind").and_then(Value::as_str) != Some("closed") { return; }
    let Some(view) = payload.get("id").and_then(Value::as_str) else { return };
    let state = app.state::<Arc<MediaRegistry>>();
    if let Some(session) = state.for_view(view) { state.remove(&session.token); }
}

fn on_navigation(app: &AppHandle, payload: &Value) {
    let Some(view) = payload.get("id").and_then(Value::as_str) else { return };
    let Some(url) = payload.get("url").and_then(Value::as_str) else { return };
    let state = app.state::<Arc<MediaRegistry>>();
    let Some(session) = state.for_view(view) else { return };
    // 同一固定页刷新仍有效；离开受控页面就撤销它持有的文件授权。
    if url.split('#').next() != Some(session.page_url.as_str()) { state.remove(&session.token); }
}
