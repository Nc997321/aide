use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Request, header};
use serde_json::json;
use tauri::AppHandle;
use tokio::sync::Semaphore;

use crate::resource_server::Response;
use super::{error_response, json_response};
use super::super::feedback::{self, ReferenceInput};
use super::super::session::MediaSession;
use super::super::types::PageAction;

static ACTIONS: Semaphore = Semaphore::const_new(8);

pub(super) async fn response(app: &AppHandle, request: Request<Incoming>, session: Arc<MediaSession>) -> Result<Response, String> {
    let Ok(_permit) = ACTIONS.try_acquire() else { return Ok(error_response(429, "媒体操作过多，请稍后再试")) };
    let kind = request.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("");
    if kind.split(';').next() != Some("application/json") { return Ok(error_response(415, "媒体操作必须使用 JSON")); }
    let bytes = tokio::time::timeout(Duration::from_secs(10), Limited::new(request.into_body(), 6 * 1024 * 1024 + 64 * 1024).collect())
        .await.map_err(|_| "媒体操作传输超时")?.map_err(|_| "媒体引用过大或传输中断")?.to_bytes();
    let action: PageAction = serde_json::from_slice(&bytes).map_err(|_| "媒体操作内容无效")?;
    apply(app, session, action).await
}

async fn apply(app: &AppHandle, session: Arc<MediaSession>, action: PageAction) -> Result<Response, String> {
    session.check(app)?;
    let message = match action {
        PageAction::Select { file_id } => {
            session.select(app, &file_id).await?;
            return Ok(json_response(session.metadata(app).await?));
        }
        PageAction::Reference { selection, frame, revision } => feedback::reference(app, session, ReferenceInput { selection, frame, revision }).await?,
        PageAction::Save => super::super::save::to_local(app, session).await?,
        PageAction::OpenExternal => super::super::save::open_external(app, session).await?,
    };
    Ok(json_response(json!({ "ok": true, "message": message })))
}
