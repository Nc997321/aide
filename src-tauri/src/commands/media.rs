//! 桌面媒体前门：固定播放器页与草稿反馈是 GUI 能力；文件读取仍在 core。

use tauri::Window;

use crate::media::{FeedbackOutcome, OpenRequest};

#[tauri::command]
pub(crate) async fn media_preview_open(window: Window, request: OpenRequest) -> Result<(), String> {
    crate::media::open(&window, request).await
}

#[tauri::command]
pub(crate) async fn media_feedback_ack(window: Window, id: String, outcome: FeedbackOutcome) -> Result<(), String> {
    crate::media::feedback_ack(&window, &id, outcome)
}
