//! 沙箱应用资源：沿用随机前缀/CSP，不与媒体 capability 共享授权或 CORS 策略。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

use aide_core::Reply;
use hyper::body::Incoming;
use hyper::Request as HttpRequest;
use serde_json::json;
use tauri::{AppHandle, Manager, Window};

use crate::host_door::target::HostTarget;
use crate::resource_server::{self, Response};

const BRIDGE_JS: &str = include_str!("aide_app.js");
const BRIDGE_PATH: &str = "/aide-app.js";

#[derive(Default)]
struct Routes {
    by_prefix: HashMap<String, (String, String)>,
    by_target: HashMap<(String, String), String>,
}

static ROUTES: LazyLock<Mutex<Routes>> = LazyLock::new(|| Mutex::new(Routes::default()));

/// 资源 listener 与媒体共用；应用文件仍由 Host 的 app_asset 唯一权限入口校验。
#[tauri::command]
pub async fn app_frame_base(window: Window, app_id: String) -> Result<String, String> {
    let port = resource_server::port(window.app_handle()).await?;
    let target = (window.label().to_string(), app_id);
    let prefix = route_prefix(target);
    Ok(format!("http://127.0.0.1:{port}/{prefix}/"))
}

fn route_prefix(target: (String, String)) -> String {
    let mut routes = ROUTES.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(prefix) = routes.by_target.get(&target) {
        return prefix.clone();
    }
    let prefix: String = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
    routes.by_prefix.insert(prefix.clone(), target.clone());
    routes.by_target.insert(target, prefix.clone());
    prefix
}

pub(crate) async fn serve(app: &AppHandle, request: HttpRequest<Incoming>, port: u16) -> Response {
    let head = format!("{} {} HTTP/1.1\r\n", request.method(), request.uri());
    match parse_request(&head) {
        Some(Request::Bridge) => respond(200, "text/javascript; charset=utf-8", BRIDGE_JS.as_bytes(), port),
        Some(Request::Asset { prefix, path }) => asset_response(app, (prefix, path), port).await,
        None => respond(404, "text/plain; charset=utf-8", b"not found", port),
    }
}

async fn asset_response(app: &AppHandle, asset: (String, String), port: u16) -> Response {
    let (prefix, path) = asset;
    let target = ROUTES.lock().unwrap_or_else(PoisonError::into_inner).by_prefix.get(&prefix).cloned();
    match target {
        Some((label, app_id)) => match fetch_asset(app, &label, &app_id, &path).await {
            Ok(bytes) => respond(200, content_type(&path), &bytes, port),
            Err(e) => respond(404, "text/plain; charset=utf-8", e.as_bytes(), port),
        },
        None => respond(404, "text/plain; charset=utf-8", b"not found", port),
    }
}

async fn fetch_asset(app: &AppHandle, label: &str, app_id: &str, path: &str) -> Result<Vec<u8>, String> {
    let target = HostTarget::capture(app, label).await?;
    match target.invoke("app_asset", json!({ "appId": app_id, "path": path })).await? {
        Reply::Bytes(bytes) => Ok(bytes),
        Reply::Json(_) => Err("app_asset：应当返回字节".into()),
    }
}

#[derive(Debug, PartialEq)]
enum Request {
    Bridge,
    Asset { prefix: String, path: String },
}

fn parse_request(head: &str) -> Option<Request> {
    let mut parts = head.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let raw = target.split(['?', '#']).next()?;
    if raw == BRIDGE_PATH {
        return Some(Request::Bridge);
    }
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().ok()?;
    let (prefix, path) = decoded.strip_prefix('/')?.split_once('/')?;
    if prefix.len() != 32 || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) || path.is_empty() {
        return None;
    }
    Some(Request::Asset { prefix: prefix.to_string(), path: path.to_string() })
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn csp(port: u16) -> String {
    let origin = format!("http://127.0.0.1:{port}");
    format!(
        "default-src {origin} 'unsafe-inline' data: blob:; script-src {origin} 'unsafe-inline' 'wasm-unsafe-eval' blob:; \
         connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

fn respond(status: u16, mime: &str, body: &[u8], port: u16) -> Response {
    let mut response = resource_server::full(status, mime, body.to_vec());
    // 仅沙箱应用允许 null 来源跨源读资源；媒体路由绝不经过此响应器。
    response.headers_mut().insert("access-control-allow-origin", hyper::header::HeaderValue::from_static("*"));
    // CSP 只含常量 ASCII 与 u16 端口，不能因构造问题静默漏掉安全策略。
    let value = hyper::header::HeaderValue::from_str(&csp(port)).expect("static CSP and numeric port form a valid header");
    response.headers_mut().insert("content-security-policy", value);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    const PREFIX: &str = "0123456789abcdef0123456789abcdef";
    fn asset(path: &str) -> Option<Request> {
        parse_request(&format!("GET /{PREFIX}/{path} HTTP/1.1\r\nHost: x\r\n\r\n"))
    }
    #[test]
    fn routes_assets_by_prefix_and_decodes_the_path() {
        assert_eq!(asset("ui/index.html?r=3"), Some(Request::Asset { prefix: PREFIX.into(), path: "ui/index.html".into() }));
        assert_eq!(asset("ui/a%20b.png"), Some(Request::Asset { prefix: PREFIX.into(), path: "ui/a b.png".into() }));
        assert_eq!(parse_request("GET /aide-app.js HTTP/1.1\r\n\r\n"), Some(Request::Bridge));
    }
    #[test]
    fn refuses_what_is_not_a_prefixed_get() {
        assert_eq!(parse_request(&format!("POST /{PREFIX}/ui/index.html HTTP/1.1\r\n\r\n")), None);
        for path in ["/ui/index.html", "/short/ui/index.html", "/"] {
            assert_eq!(parse_request(&format!("GET {path} HTTP/1.1\r\n\r\n")), None);
        }
        assert_eq!(asset("%ff"), None);
        assert_eq!(asset(""), None);
    }
    #[tokio::test]
    async fn every_response_carries_the_sandbox_policy() {
        for status in [200, 404] {
            let response = respond(status, "text/plain", b"x", 4321);
            assert!(response.headers()["content-security-policy"].to_str().unwrap().contains("connect-src 'none'"));
            assert_eq!(response.headers()["access-control-allow-origin"], "*");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), "x");
        }
    }
    #[test]
    fn content_type_follows_the_extension() {
        assert_eq!(content_type("ui/index.HTML"), "text/html; charset=utf-8");
        assert_eq!(content_type("ui/app.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("ui/icon.svg"), "image/svg+xml");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }
}
