//! `net.fetch`：由 Host 替应用发 HTTP 请求（应用页面自己不许联网，见桌面侧的 CSP）。
//! 同步实现（ureq），由调用方放进 blocking 线程。

use std::io::Read;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::manifest::Manifest;

/// 响应体上限：再大就该让后端去做，而不是塞进一条消息。
const MAX_BODY: u64 = 10 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// 清单许不许去这台主机：`net` = 任意；`net:<主机>` = 只这一台（精确匹配，不含子域）。
pub fn host_allowed(manifest: &Manifest, host: &str) -> bool {
    manifest.has_permission("net") || manifest.has_permission(&format!("net:{}", host.to_ascii_lowercase()))
}

pub fn fetch(manifest: &Manifest, params: &Value) -> Result<Value, String> {
    let url = params.get("url").and_then(Value::as_str).ok_or("net.fetch 需要 url")?;
    let method = params.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(format!("不支持的请求方法：{method}"));
    }

    // 只按主机名放行的应用不许跟随重定向：否则一跳就出了白名单
    let unrestricted = manifest.has_permission("net");
    let mut builder = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(if unrestricted { 5 } else { 0 });
    let probe = ureq::agent().request(&method, url);
    let parsed = probe.request_url().map_err(|e| format!("地址不合法：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 http / https".into());
    }
    let host = parsed.host().to_string();
    if !host_allowed(manifest, &host) {
        return Err(format!("应用「{}」没有申请访问 {host} 的权限", manifest.id));
    }
    // 回环地址不走代理（本机服务经代理是到不了的）
    if !is_loopback(&host) {
        if let Some(p) = crate::proxy::detect_proxy().and_then(|u| ureq::Proxy::new(&u).ok()) {
            builder = builder.proxy(p);
        }
    }

    let mut request = builder.build().request(&method, url);
    if let Some(headers) = params.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                request = request.set(name, value);
            }
        }
    }
    let sent = match (params.get("bodyBase64").and_then(Value::as_str), params.get("body").and_then(Value::as_str)) {
        (Some(b64), _) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("bodyBase64 不合法：{e}"))?;
            request.send_bytes(&bytes)
        }
        (None, Some(text)) => request.send_string(text),
        (None, None) => request.call(),
    };
    // 4xx / 5xx 也是一次成功的请求：把响应原样交给应用，由它自己判断
    let response = match sent {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(t)) => return Err(format!("请求失败：{t}")),
    };

    let status = response.status();
    let status_text = response.status_text().to_string();
    let mut headers = Map::new();
    for name in response.headers_names() {
        if let Some(value) = response.header(&name) {
            headers.insert(name, json!(value));
        }
    }
    let mut body = Vec::new();
    response.into_reader().take(MAX_BODY + 1).read_to_end(&mut body).map_err(|e| format!("读取响应失败：{e}"))?;
    if body.len() as u64 > MAX_BODY {
        return Err(format!("响应超过 {} MB 上限", MAX_BODY / 1024 / 1024));
    }
    Ok(json!({
        "status": status,
        "statusText": status_text,
        "headers": headers,
        // 文本响应给 body；二进制只有 bodyBase64
        "body": String::from_utf8(body.clone()).ok(),
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(&body),
    }))
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.starts_with("127.") || host == "::1" || host == "[::1]"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::manifest;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    fn app(permissions: &str) -> Manifest {
        manifest::parse(
            &format!(r#"{{"id":"a","name":"A","version":"1","panel":{{"entry":"i.html"}},"permissions":[{permissions}]}}"#),
            "a",
        )
        .unwrap()
    }

    /// 起一个只答一次的本机 HTTP 服务，返回它的地址。
    fn serve_once(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok() && line != "\r\n" && !line.is_empty() {
                line.clear();
            }
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://{addr}/x")
    }

    #[test]
    fn fetches_and_returns_status_headers_and_text() {
        let url = serve_once("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
        let got = fetch(&app(r#""net""#), &json!({ "url": url })).unwrap();
        assert_eq!(got["status"], 200);
        assert_eq!(got["body"], "hello");
        assert_eq!(got["headers"]["content-type"], "text/plain");
    }

    #[test]
    fn an_error_status_is_still_a_response() {
        let url = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope");
        let got = fetch(&app(r#""net""#), &json!({ "url": url })).unwrap();
        assert_eq!(got["status"], 404);
        assert_eq!(got["body"], "nope");
    }

    #[test]
    fn a_host_scoped_app_reaches_only_that_host() {
        let scoped = app(r#""net:api.example.com""#);
        assert!(host_allowed(&scoped, "api.example.com"));
        assert!(host_allowed(&scoped, "API.Example.com"));
        assert!(!host_allowed(&scoped, "example.com"));
        assert!(!host_allowed(&scoped, "evil.api.example.com"));
        let err = fetch(&scoped, &json!({ "url": "http://127.0.0.1:9/x" })).unwrap_err();
        assert!(err.contains("127.0.0.1"), "{err}");
    }

    #[test]
    fn refuses_other_schemes_and_methods() {
        let any = app(r#""net""#);
        assert!(fetch(&any, &json!({ "url": "file:///etc/passwd" })).is_err());
        assert!(fetch(&any, &json!({ "url": "http://127.0.0.1:9/", "method": "CONNECT" })).unwrap_err().contains("请求方法"));
        assert!(fetch(&any, &json!({})).is_err());
    }
}
