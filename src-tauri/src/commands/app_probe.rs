//! 应用隔离探针（侧栏应用 P0，设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md §4）。
//!
//! 侧栏应用的界面是用户或 agent 写的网页，必须拿不到 Tauri IPC。本模块给实验提供三样东西：
//! 一个只绑回环地址的资源服务（应用资源将来就这么投递）、一条无害的金丝雀命令（探针试着去调它）、
//! 一条把结果落盘的命令。**只在环境变量 `AIDE_APP_PROBE=1` 时生效**，平时不开端口。
//!
//! 资源刻意**不**经 Tauri 自定义协议投递：`Webview::is_local_url` 把注册过的自定义协议一律判成
//! 本地页面，IPC 全开（tauri 2.11 `webview/mod.rs`）。

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;

const ENV_FLAG: &str = "AIDE_APP_PROBE";
const FRAME_HTML: &str = include_str!("app_probe_frame.html");
/// 应用资源将来要带的 CSP：只许同源与内联，**不许自行联网**（联网走桥，由 Host 发）。
const STRICT_CSP: &str = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'";
const MAX_HEAD: usize = 8 * 1024;

#[derive(Clone, serde::Serialize)]
pub struct AppProbeInfo {
    port: u16,
    /// 路径前缀：本机别的进程不知道它就取不到资源。
    token: String,
    os: &'static str,
}

static SERVER: OnceCell<AppProbeInfo> = OnceCell::const_new();
/// 金丝雀被调到时带来的记号。**这才是判据**：frame 里「没收到回应」不等于「命令没执行」——
/// postMessage 那条 IPC 的回应是 eval 进主 frame 的，子 frame 永远等不到。
static CANARY_HITS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn ensure_enabled() -> Result<(), String> {
    match std::env::var(ENV_FLAG).as_deref() {
        Ok("1") => Ok(()),
        _ => Err(format!("app probe disabled (set {ENV_FLAG}=1)")),
    }
}

/// 起资源服务（幂等），返回端口与路径令牌。
#[tauri::command]
pub async fn app_probe_start() -> Result<AppProbeInfo, String> {
    ensure_enabled()?;
    SERVER
        .get_or_try_init(|| async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let token: String = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
            let prefix = format!("/{token}/");
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else { continue };
                    let prefix = prefix.clone();
                    tokio::spawn(async move {
                        let _ = serve(stream, &prefix).await;
                    });
                }
            });
            Ok(AppProbeInfo { port, token, os: std::env::consts::OS })
        })
        .await
        .cloned()
}

/// 金丝雀：探针从被测 frame 里调它，调通 = 隔离失败。纯内存，inline 命令安全。
#[tauri::command]
pub fn app_probe_canary(nonce: Option<String>) -> &'static str {
    if let (Some(nonce), Ok(mut hits)) = (nonce, CANARY_HITS.lock()) {
        hits.push(nonce);
    }
    "pong"
}

/// 取走到目前为止金丝雀收到的全部记号（只该由主页面调）。
#[tauri::command]
pub fn app_probe_hits() -> Result<Vec<String>, String> {
    ensure_enabled()?;
    Ok(CANARY_HITS.lock().map(|mut hits| std::mem::take(&mut *hits)).unwrap_or_default())
}

/// 把实验结果写到临时目录，返回路径。
#[tauri::command]
pub async fn app_probe_report(json: String) -> Result<String, String> {
    ensure_enabled()?;
    tokio::task::spawn_blocking(move || {
        let path = std::env::temp_dir().join(format!("aide-app-probe-{}.json", std::env::consts::OS));
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn serve(mut stream: TcpStream, prefix: &str) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < MAX_HEAD {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let response = respond(&String::from_utf8_lossy(&head), prefix);
    stream.write_all(&response).await?;
    stream.shutdown().await
}

/// 请求头 → 完整响应。纯函数，便于单测。
fn respond(head: &str, prefix: &str) -> Vec<u8> {
    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
    let (method, target) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let route = (method == "GET").then(|| path.strip_prefix(prefix)).flatten();

    let (status, content_type, body, csp) = match route {
        Some("frame.html") => {
            let strict = query.split('&').any(|kv| kv == "csp=1");
            ("200 OK", "text/html; charset=utf-8", FRAME_HTML, strict)
        }
        Some("ping") => ("200 OK", "text/plain", "pong", false),
        _ => ("404 Not Found", "text/plain", "not found", false),
    };

    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Access-Control-Allow-Origin: *\r\nConnection: close\r\n",
        body.len()
    );
    if csp {
        out.push_str(&format!("Content-Security-Policy: {STRICT_CSP}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(head: &str) -> String {
        String::from_utf8(respond(head, "/tok/")).unwrap()
    }

    #[test]
    fn serves_the_frame_only_under_the_token() {
        assert!(text("GET /tok/frame.html HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 200 OK"));
        assert!(text("GET /other/frame.html HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(text("GET /frame.html HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(text("POST /tok/frame.html HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 404"));
        assert!(text("").starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn strict_csp_is_sent_only_when_asked() {
        assert!(!text("GET /tok/frame.html HTTP/1.1\r\n\r\n").contains("Content-Security-Policy"));
        let strict = text("GET /tok/frame.html?csp=1 HTTP/1.1\r\n\r\n");
        assert!(strict.contains("Content-Security-Policy: default-src 'self'"));
        assert!(strict.contains("connect-src 'none'"));
    }

    #[test]
    fn content_length_matches_the_body() {
        let res = text("GET /tok/ping HTTP/1.1\r\n\r\n");
        let (head, body) = res.split_once("\r\n\r\n").unwrap();
        assert_eq!(body, "pong");
        assert!(head.contains("Content-Length: 4"));
    }
}
