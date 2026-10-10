//! 侧栏应用的资源服务（设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md §4）。
//!
//! 应用界面是用户或 agent 写的网页，必须拿不到 Tauri IPC。所以它的文件**不能**经 Tauri 自定义
//! 协议投递（`Webview::is_local_url` 把注册过的自定义协议判成本地页面，IPC 全开），而是由这里
//! 一个只绑回环地址的小服务投递：来源是 `http://127.0.0.1:<端口>`，Tauri 视为远程，ACL 一律拒绝
//! （P0 实验已在 Windows 上证实，探针见 `app_probe.rs`）。
//!
//! 文件本身在 Host 上：收到请求后向**发起窗口所连的那台 Host** 取 `app_asset`。
//! 每个（窗口，应用）一个随机路径前缀——应用猜不到别的应用的前缀，也就读不到别人的文件。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;

const BRIDGE_JS: &str = include_str!("aide_app.js");
const BRIDGE_PATH: &str = "/aide-app.js";
const MAX_HEAD: usize = 16 * 1024;

/// 前缀 → 它代表哪个窗口的哪个应用。
#[derive(Default)]
struct Routes {
    by_prefix: HashMap<String, (String, String)>,
    by_target: HashMap<(String, String), String>,
}

struct Server {
    port: u16,
    routes: Arc<Mutex<Routes>>,
}

static SERVER: OnceCell<Server> = OnceCell::const_new();

async fn server(app: &AppHandle) -> Result<&'static Server, String> {
    SERVER
        .get_or_try_init(|| async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let routes = Arc::new(Mutex::new(Routes::default()));
            let (app, shared) = (app.clone(), routes.clone());
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else { continue };
                    let (app, routes) = (app.clone(), shared.clone());
                    tokio::spawn(async move {
                        let _ = serve(stream, &app, &routes, port).await;
                    });
                }
            });
            Ok(Server { port, routes })
        })
        .await
}

/// 本窗口里某个应用的资源根地址（以 `/` 结尾）；面板把清单的入口拼在后面当 iframe 的 src。
#[tauri::command]
pub async fn app_frame_base(window: Window, app_id: String) -> Result<String, String> {
    let server = server(window.app_handle()).await?;
    let target = (window.label().to_string(), app_id);
    let mut routes = server.routes.lock().unwrap_or_else(PoisonError::into_inner);
    let prefix = match routes.by_target.get(&target) {
        Some(prefix) => prefix.clone(),
        None => {
            let prefix: String = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
            routes.by_prefix.insert(prefix.clone(), target.clone());
            routes.by_target.insert(target, prefix.clone());
            prefix
        }
    };
    Ok(format!("http://127.0.0.1:{}/{prefix}/", server.port))
}

async fn serve(mut stream: TcpStream, app: &AppHandle, routes: &Mutex<Routes>, port: u16) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < MAX_HEAD {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let response = match parse_request(&String::from_utf8_lossy(&head)) {
        Some(Request::Bridge) => respond(200, "text/javascript; charset=utf-8", BRIDGE_JS.as_bytes(), port),
        Some(Request::Asset { prefix, path }) => {
            let target = routes.lock().unwrap_or_else(PoisonError::into_inner).by_prefix.get(&prefix).cloned();
            match target {
                Some((label, app_id)) => match fetch_asset(app, &label, &app_id, &path).await {
                    Ok(bytes) => respond(200, content_type(&path), &bytes, port),
                    Err(e) => respond(404, "text/plain; charset=utf-8", e.as_bytes(), port),
                },
                None => respond(404, "text/plain; charset=utf-8", b"not found", port),
            }
        }
        None => respond(404, "text/plain; charset=utf-8", b"not found", port),
    };
    stream.write_all(&response).await?;
    stream.shutdown().await
}

/// 向窗口所连的 Host 取文件：Host 窗口走它的连接，本机窗口进程内直调（同 `host_door`）。
async fn fetch_asset(app: &AppHandle, label: &str, app_id: &str, path: &str) -> Result<Vec<u8>, String> {
    let args = json!({ "appId": app_id, "path": path });
    if let Some(host) = app.state::<crate::host_window::HostWindows>().host_of(label) {
        let svc = app.state::<Arc<crate::remote_workspace::RemoteWorkspaces>>().inner().clone();
        let reply = svc.connection(&host).await?.invoke("app_asset", args).await?;
        let b64 = reply
            .get(aide_host::protocol::BYTES_KEY)
            .and_then(Value::as_str)
            .ok_or("app_asset：Host 没有返回字节")?;
        use base64::Engine;
        return base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string());
    }
    let run = aide_core::lookup("app_asset").ok_or("app_asset 不在命令表里")?;
    let core = app.state::<Arc<aide_core::Core>>().inner().clone();
    match run(core, args).await? {
        aide_core::Reply::Bytes(bytes) => Ok(bytes),
        aide_core::Reply::Json(_) => Err("app_asset：应当返回字节".into()),
    }
}

#[derive(Debug, PartialEq)]
enum Request {
    Bridge,
    Asset { prefix: String, path: String },
}

/// 请求头 → 要什么。只认 GET；路径做百分号解码，解不出合法 UTF-8 的不认。
/// 路径是否越界不在这里判——那是 Host 上 `app_asset` 的职责（唯一的一处）。
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
    let ext = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
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

/// 应用页面的 CSP：资源只许来自本服务与内联，**不许自行联网**（联网走桥，由 Host 发）。
/// 来源写成显式地址而不是 `'self'`：沙箱 iframe 的来源是不透明的，`'self'` 在各内核里行为不一。
fn csp(port: u16) -> String {
    let origin = format!("http://127.0.0.1:{port}");
    format!(
        "default-src {origin} 'unsafe-inline' data: blob:; script-src {origin} 'unsafe-inline' 'wasm-unsafe-eval' blob:; \
         connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

fn respond(status: u16, content_type: &str, body: &[u8], port: u16) -> Vec<u8> {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let mut out = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Content-Security-Policy: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        body.len(),
        csp(port)
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(parse_request("GET /ui/index.html HTTP/1.1\r\n\r\n"), None);
        assert_eq!(parse_request("GET /short/ui/index.html HTTP/1.1\r\n\r\n"), None);
        assert_eq!(parse_request(&format!("GET /{PREFIX}/ HTTP/1.1\r\n\r\n")), None);
        assert_eq!(parse_request(&format!("GET /{PREFIX}/%ff HTTP/1.1\r\n\r\n")), None);
        assert_eq!(parse_request(""), None);
    }

    #[test]
    fn every_response_carries_the_no_network_csp() {
        for status in [200, 404] {
            let text = String::from_utf8(respond(status, "text/plain", b"x", 4321)).unwrap();
            assert!(text.contains("connect-src 'none'"), "{text}");
            assert!(text.contains("default-src http://127.0.0.1:4321 "), "{text}");
            assert!(text.contains("X-Content-Type-Options: nosniff"));
            assert!(text.ends_with("\r\n\r\nx"));
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
