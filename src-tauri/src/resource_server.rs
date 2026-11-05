//! GUI 唯一回环资源前门：应用资源和媒体路由共用 listener，不暴露 Host 命令。

use std::convert::Infallible;
use std::io;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response as HttpResponse};
use hyper_util::rt::{TokioIo, TokioTimer};
use tauri::AppHandle;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OnceCell, Semaphore};

pub(crate) type Body = UnsyncBoxBody<Bytes, io::Error>;
pub(crate) type Response = HttpResponse<Body>;
static PORT: OnceCell<u16> = OnceCell::const_new();
static CONNECTIONS: Semaphore = Semaphore::const_new(64);

pub(crate) async fn port(app: &AppHandle) -> Result<u16, String> {
    PORT.get_or_try_init(|| start(app.clone())).await.copied()
}

async fn start(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(accept(listener, app, port));
    Ok(port)
}

async fn accept(listener: TcpListener, app: AppHandle, port: u16) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => launch(stream, app.clone(), port),
            Err(e) => {
                tracing::warn!("loopback resource accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

fn launch(stream: TcpStream, app: AppHandle, port: u16) {
    let Ok(permit) = CONNECTIONS.try_acquire() else { return };
    tokio::spawn(async move {
        let _permit = permit;
        let service = service_fn(move |request| {
            let app = app.clone();
            async move { Ok::<_, Infallible>(route(&app, request, port).await) }
        });
        let outcome = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(Duration::from_secs(10))
            .max_buf_size(16 * 1024)
            .serve_connection(TokioIo::new(stream), service)
            .await;
        if let Err(e) = outcome {
            // 客户端关闭标签会正常断流；这里只记 debug，不记录带凭据的 URL。
            tracing::debug!("loopback resource connection ended: {e}");
        }
    });
}

async fn route(app: &AppHandle, request: Request<Incoming>, port: u16) -> Response {
    if !valid_host(&request, port) {
        return full(403, "text/plain", "invalid resource host");
    }
    if request.uri().path().starts_with("/media/") {
        crate::media::http::serve(app, request, port).await
    } else {
        crate::commands::app_assets::serve(app, request, port).await
    }
}

fn valid_host<B>(request: &Request<B>, port: u16) -> bool {
    let expected = format!("127.0.0.1:{port}");
    request.headers().get(hyper::header::HOST)
        .and_then(|value| value.to_str().ok()) == Some(expected.as_str())
}

pub(crate) fn full(status: u16, mime: &str, bytes: impl Into<Bytes>) -> Response {
    let body = Full::new(bytes.into()).map_err(|never| match never {}).boxed_unsync();
    // status/MIME 只由静态内部路由提供，绝不使用用户文件名作为头。
    HttpResponse::builder().status(status)
        .header(hyper::header::CONTENT_TYPE, mime)
        .header(hyper::header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body).expect("internal resource response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_rejects_rebound_hostnames_and_foreign_ports() {
        for host in ["evil.test:1234", "127.0.0.1:9999", "localhost:1234"] {
            let request = Request::builder().header("host", host).body(()).unwrap();
            assert!(!valid_host(&request, 1234));
        }
        let request = Request::builder().header("host", "127.0.0.1:1234").body(()).unwrap();
        assert!(valid_host(&request, 1234));
    }

    #[tokio::test]
    async fn bounded_full_response_keeps_type_and_no_store() {
        let response = full(404, "text/plain", "not found");
        assert_eq!(response.status(), 404);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), "not found");
    }
}
