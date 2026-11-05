use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::json;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tokio::sync::oneshot;

use super::registry::{token, MediaRegistry, PendingFeedback};
use super::session::MediaSession;
use super::types::{Frame, Selection};

pub(super) async fn reference(app: &AppHandle, session: Arc<MediaSession>, input: ReferenceInput) -> Result<String, String> {
    input.selection.validate()?;
    validate_frame(input.frame.as_ref())?;
    session.check(app)?;
    let active = session.current().await;
    if active.revoked.load(Ordering::Acquire) || active.info.revision != input.revision {
        return Err("预览源已变化，这次引用没有加入草稿，请重新选择位置".into());
    }
    let title = session.files.get(active.index).ok_or("媒体来源已失效")?.title.clone();
    let payload = json!({
        "draftKey": session.draft_key,
        "ref": { "source": { "path": active.info.path, "title": title, "revision": active.info.revision }, "selection": input.selection },
        "frame": input.frame
    });
    await_draft_ack(app, &session.owner, payload).await?;
    Ok("已加入原会话草稿，尚未发送".into())
}

pub(super) struct ReferenceInput {
    pub selection: Selection,
    pub frame: Option<Frame>,
    pub revision: String,
}

struct PendingGuard {
    state: Arc<MediaRegistry>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) { self.state.cancel_feedback(&self.id); }
}

async fn await_draft_ack(app: &AppHandle, owner: &str, mut payload: serde_json::Value) -> Result<(), String> {
    let state = app.state::<Arc<MediaRegistry>>().inner().clone();
    let id = token();
    let (sender, receiver) = oneshot::channel();
    state.begin_feedback((id.clone(), PendingFeedback { owner: owner.to_string(), sender }))?;
    let _guard = PendingGuard { state, id: id.clone() };
    payload["id"] = json!(id);
    app.emit_to(EventTarget::webview_window(owner), "media-feedback", payload).map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), receiver).await
        .map_err(|_| "原会话未确认收到引用，请检查草稿后再试".to_string())?
        .map_err(|_| "原会话已停止接收媒体引用".to_string())?
}

fn validate_frame(frame: Option<&Frame>) -> Result<(), String> {
    let Some(frame) = frame else { return Ok(()) };
    if frame.media_type != "image/png" || frame.data.len() > 6 * 1024 * 1024 {
        return Err("截图格式或大小不符合要求，请缩小后重试".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&frame.data).map_err(|_| "截图内容损坏")?;
    if bytes.get(..8) != Some(b"\x89PNG\r\n\x1a\n") || bytes.get(12..16) != Some(b"IHDR") {
        return Err("截图不是有效的 PNG 图片".into());
    }
    let width = png_dimension(&bytes, 16)?;
    let height = png_dimension(&bytes, 20)?;
    if width == 0 || height == 0 || width > 1280 || height > 1280 {
        return Err("截图尺寸超出预览限制".into());
    }
    Ok(())
}

fn png_dimension(bytes: &[u8], start: usize) -> Result<u32, String> {
    let raw: [u8; 4] = bytes.get(start..start + 4).ok_or("截图头不完整")?
        .try_into().map_err(|_| "截图头损坏")?;
    Ok(u32::from_be_bytes(raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screenshots_are_bounded_png_data_not_arbitrary_payloads() {
        assert!(validate_frame(None).is_ok());
        let frame = Frame { data: "AAAA".into(), media_type: "image/png".into() };
        assert!(validate_frame(Some(&frame)).is_err());
        let frame = Frame { data: String::new(), media_type: "image/svg+xml".into() };
        assert!(validate_frame(Some(&frame)).is_err());
    }
}
