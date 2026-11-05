//! 私有媒体路由：只交付受控播放器资源与已授权文件，无任意路径/命令转发。

mod actions;
mod assets;
mod policy;
mod stream;

use std::sync::Arc;

use hyper::body::Incoming;
use hyper::{Method, Request};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::resource_server::{self, Response};
use super::registry::MediaRegistry;
use super::session::MediaSession;

pub(crate) async fn serve(app: &AppHandle, request: Request<Incoming>, port: u16) -> Response {
    let result = dispatch(app, request, port).await;
    match result { Ok(response) => response, Err(error) => error_response(409, &error) }
}

async fn dispatch(app: &AppHandle, request: Request<Incoming>, port: u16) -> Result<Response, String> {
    let Some((token, route)) = parse_route(request.uri().path()) else { return Ok(error_response(404, "媒体地址无效")) };
    let route = route.to_string();
    let state = app.state::<Arc<MediaRegistry>>();
    let Some(session) = state.get(token) else { return Ok(error_response(410, "媒体标签已关闭或失效，请从会话重新打开")) };
    session.check(app)?;
    let origin = policy::authorize(&request, port)?;
    let response = if request.method() == Method::OPTIONS {
        policy::preflight(origin.as_deref())
    } else {
        route_request(app, request, (&route, session)).await?
    };
    Ok(policy::decorate(response, origin.as_deref()))
}

async fn route_request(app: &AppHandle, request: Request<Incoming>, target: (&str, Arc<MediaSession>)) -> Result<Response, String> {
    let (route, session) = target;
    match (request.method(), route) {
        (&Method::GET, "player" | "player.js" | "player.css") => Ok(assets::response(route)),
        (&Method::GET, "meta") => Ok(json_response(session.metadata(app).await?)),
        (&Method::GET | &Method::HEAD, "stream") => stream::response(app, request, session).await,
        (&Method::POST, "action") => actions::response(app, request, session).await,
        _ => Ok(error_response(405, "媒体页不支持此请求")),
    }
}

fn parse_route(path: &str) -> Option<(&str, &str)> {
    let (token, route) = path.strip_prefix("/media/")?.split_once('/')?;
    if token.len() != 48 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    Some((token, route))
}

pub(super) fn json_response(value: serde_json::Value) -> Response {
    resource_server::full(200, "application/json; charset=utf-8", value.to_string())
}

pub(super) fn error_response(status: u16, error: &str) -> Response {
    resource_server::full(status, "application/json; charset=utf-8", json!({ "error": error, "code": "media_unavailable" }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capability_routes_cannot_be_file_paths() {
        let token = "a".repeat(48);
        assert_eq!(parse_route(&format!("/media/{token}/stream")), Some((token.as_str(), "stream")));
        assert!(parse_route("/media/../../secret/player").is_none());
        assert!(parse_route("/media/short/player").is_none());
    }
}
