use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use bytes::Bytes;
use futures_util::stream::unfold;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{header, Method, Request};
use tauri::AppHandle;
use tokio::sync::OwnedSemaphorePermit;

use crate::resource_server::{self, Response};
use super::error_response;
use super::super::reader::MediaReader;
use super::super::range::{self, ByteRange};
use super::super::session::{ActiveFile, MediaSession};

const CHUNK_BYTES: u64 = 512 * 1024;
#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;

pub(super) async fn response(app: &AppHandle, request: Request<Incoming>, session: Arc<MediaSession>) -> Result<Response, String> {
    let active = session.current().await;
    if !matches_generation(request.uri().query(), active.generation) {
        return Ok(error_response(409, "媒体源已变化，请重新打开当前文件"));
    }
    let header = if request.method() == Method::HEAD { None } else {
        request.headers().get(header::RANGE).and_then(|value| value.to_str().ok())
    };
    let Ok(slice) = range::select(header, active.info.size) else { return Ok(unsatisfied(active.info.size)) };
    if request.method() == Method::HEAD { return build(resource_server::full(200, &active.info.mime, ""), &active, slice); }
    let permit = session.streams.clone().try_acquire_owned().map_err(|_| "媒体读取正忙，请稍后再试")?;
    let cursor = Cursor { reader: guarded_reader(app.clone(), session, Arc::clone(&active)), position: slice.start, remaining: slice.length, _permit: permit };
    let body = StreamBody::new(unfold(cursor, next)).boxed_unsync();
    build(hyper::Response::new(body), &active, slice)
}

struct Cursor {
    reader: MediaReader,
    position: u64,
    remaining: u64,
    _permit: OwnedSemaphorePermit,
}

async fn next(mut cursor: Cursor) -> Option<(Result<Frame<Bytes>, io::Error>, Cursor)> {
    if cursor.remaining == 0 { return None; }
    let result = read_chunk(&cursor).await;
    match result {
        Ok(bytes) => {
            cursor.position += bytes.len() as u64;
            cursor.remaining -= bytes.len() as u64;
            Some((Ok(Frame::data(Bytes::from(bytes))), cursor))
        }
        Err(error) => {
            cursor.remaining = 0;
            Some((Err(io::Error::other(error)), cursor))
        }
    }
}

async fn read_chunk(cursor: &Cursor) -> Result<Vec<u8>, String> {
    let length = cursor.remaining.min(CHUNK_BYTES) as usize;
    cursor.reader.read((cursor.position, length)).await
}

fn guarded_reader(app: AppHandle, session: Arc<MediaSession>, active: Arc<ActiveFile>) -> MediaReader {
    let target = session.host.clone();
    let handle = active.info.handle.clone();
    MediaReader::new(target, handle, Arc::new(move || {
        session.check(&app)?;
        if active.revoked.load(Ordering::Acquire) { return Err("媒体源已切换或关闭".into()); }
        Ok(())
    }))
}

fn build(mut response: Response, active: &ActiveFile, slice: ByteRange) -> Result<Response, String> {
    *response.status_mut() = if slice.partial { hyper::StatusCode::PARTIAL_CONTENT } else { hyper::StatusCode::OK };
    let headers = response.headers_mut();
    insert(headers, (header::CONTENT_TYPE, active.info.mime.clone()))?;
    insert(headers, (header::CONTENT_LENGTH, slice.length.to_string()))?;
    headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    headers.insert("x-content-type-options", header::HeaderValue::from_static("nosniff"));
    if slice.partial {
        insert(headers, (header::CONTENT_RANGE, format!("bytes {}-{}/{}", slice.start, slice.start + slice.length - 1, active.info.size)))?;
    }
    Ok(response)
}

fn insert(headers: &mut header::HeaderMap, pair: (header::HeaderName, String)) -> Result<(), String> {
    headers.insert(pair.0, header::HeaderValue::from_str(&pair.1).map_err(|e| e.to_string())?);
    Ok(())
}

fn unsatisfied(size: u64) -> Response {
    let mut response = error_response(416, "请求的媒体字节范围不可用");
    if let Ok(value) = header::HeaderValue::from_str(&format!("bytes */{size}")) {
        response.headers_mut().insert(header::CONTENT_RANGE, value);
    }
    response
}

fn matches_generation(query: Option<&str>, generation: u64) -> bool {
    url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == "generation")
        .and_then(|(_, value)| value.parse::<u64>().ok()) == Some(generation)
}
