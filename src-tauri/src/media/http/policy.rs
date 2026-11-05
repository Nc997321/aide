use hyper::{Method, Request};
use hyper::header::{HeaderValue, ORIGIN};

use crate::resource_server::{self, Response};

pub(super) fn authorize<B>(request: &Request<B>, port: u16) -> Result<Option<String>, String> {
    let origin = request.headers().get(ORIGIN).map(|value| value.to_str()).transpose()
        .map_err(|_| "媒体请求来源无效")?;
    let allowed = format!("http://127.0.0.1:{port}");
    if origin.is_some_and(|value| value != allowed) {
        return Err("媒体请求不来自受控预览页".into());
    }
    if matches!(*request.method(), Method::POST | Method::OPTIONS) && origin != Some(allowed.as_str()) {
        return Err("媒体操作缺少有效的预览页来源".into());
    }
    Ok(origin.map(str::to_string))
}

pub(super) fn decorate(mut response: Response, origin: Option<&str>) -> Response {
    let headers = response.headers_mut();
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    headers.insert("content-security-policy", HeaderValue::from_static(
        "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ));
    if let Some(value) = origin.and_then(|value| HeaderValue::from_str(value).ok()) {
        headers.insert("access-control-allow-origin", value);
        headers.insert("vary", HeaderValue::from_static("Origin"));
    }
    response
}

pub(super) fn preflight(origin: Option<&str>) -> Response {
    let mut response = resource_server::full(204, "text/plain", "");
    response.headers_mut().insert("access-control-allow-methods", HeaderValue::from_static("GET, HEAD, POST, OPTIONS"));
    response.headers_mut().insert("access-control-allow-headers", HeaderValue::from_static("Content-Type, Range"));
    decorate(response, origin)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sandbox_and_external_origins_cannot_read_or_act() {
        for origin in ["null", "https://example.test", "http://127.0.0.1:9999"] {
            let request = Request::builder().method("GET").header("origin", origin).body(()).unwrap();
            assert!(authorize(&request, 1234).is_err());
        }
        let request = Request::builder().method("POST").body(()).unwrap();
        assert!(authorize(&request, 1234).is_err());
        let request = Request::builder().method("POST").header("origin", "http://127.0.0.1:1234").body(()).unwrap();
        assert_eq!(authorize(&request, 1234).unwrap().as_deref(), Some("http://127.0.0.1:1234"));
        let request = Request::builder().method("GET").body(()).unwrap();
        assert!(authorize(&request, 1234).unwrap().is_none());
    }

    #[test]
    fn media_responses_never_inherit_wildcard_cors() {
        let response = decorate(resource_server::full(200, "text/plain", "x"), None);
        assert!(!response.headers().contains_key("access-control-allow-origin"));
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        assert!(!response.headers()["content-security-policy"].to_str().unwrap().contains("unsafe-inline"));
        let response = decorate(resource_server::full(200, "text/plain", "x"), Some("http://127.0.0.1:1234"));
        assert_eq!(response.headers()["access-control-allow-origin"], "http://127.0.0.1:1234");
    }
}
