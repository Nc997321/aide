//! 按需媒体标签：资源固定到原 Host 与草稿，标签关闭才撤权；切换标签不做动作。

mod feedback;
mod host;
pub(crate) mod http;
mod lifecycle;
mod registry;
mod reader;
mod save;
mod session;
mod types;
mod range;
#[cfg(debug_assertions)]
pub(crate) mod probe;
#[cfg(test)]
mod tests;

pub(crate) use types::{FeedbackOutcome, OpenRequest};
pub(crate) use registry::MediaRegistry;

use std::sync::Arc;

use tauri::{AppHandle, Manager, Window};

pub(crate) fn manage(app: &AppHandle) {
    app.manage(Arc::new(MediaRegistry::default()));
    lifecycle::install(app);
}

pub(crate) async fn open(window: &Window, request: OpenRequest) -> Result<(), String> {
    types::validate_request(&request)?;
    session::open_page(window, request).await
}

pub(crate) fn release_window(app: &AppHandle, window: &str) {
    if let Some(state) = app.try_state::<Arc<MediaRegistry>>() {
        state.release_window(window);
    }
}

pub(crate) fn feedback_ack(window: &Window, id: &str, outcome: FeedbackOutcome) -> Result<(), String> {
    window.app_handle().state::<Arc<MediaRegistry>>().finish_feedback(window.label(), id, outcome)
}
