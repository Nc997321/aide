//! 纯核心单测：url_guard + nav_decision。独立测试文件（policy/evaluate_test.rs 风格）。
//! 覆盖带值路径（允许 scheme / 可后退前进）+ 非法路径（危险 scheme / 解析失败 / 游标越界）。

use url::Url;

use crate::browser::core::nav_decision::{back_cursor, forward_cursor};
use crate::browser::core::url_guard::{guard, UrlGuardError};

// ── url_guard：scheme allowlist ──

#[test]
fn guard_allows_https() {
    let url = guard("https://example.com/path?q=1").expect("https 应放行");
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("example.com"));
}

#[test]
fn guard_allows_http() {
    assert_eq!(
        guard("http://localhost:1420")
            .expect("http 应放行")
            .scheme(),
        "http"
    );
}

#[test]
fn guard_allows_file() {
    // 本地预览用途放行 file scheme（根目录白名单由上层命令管，本函数只放行 scheme）。
    assert_eq!(
        guard("file:///C:/foo/bar.html")
            .expect("file 应放行")
            .scheme(),
        "file"
    );
}

#[test]
fn guard_rejects_javascript_scheme() {
    // javascript: 可注入脚本、绕过同源——必拒。
    assert_eq!(
        guard("javascript:alert(1)"),
        Err(UrlGuardError::SchemeNotAllowed {
            scheme: "javascript".into()
        })
    );
}

#[test]
fn guard_rejects_data_scheme() {
    assert!(matches!(
        guard("data:text/html,<script>alert(1)</script>"),
        Err(UrlGuardError::SchemeNotAllowed { scheme }) if scheme == "data"
    ));
}

#[test]
fn guard_rejects_blob_scheme() {
    assert!(matches!(
        guard("blob:https://example.com/uuid"),
        Err(UrlGuardError::SchemeNotAllowed { .. })
    ));
}

#[test]
fn guard_rejects_bare_domain_as_parse_error() {
    // 无 scheme 的裸域名：Url::parse 拒（相对地址）。守门刻意不猜意图、不自动补 https。
    assert!(matches!(guard("example.com"), Err(UrlGuardError::Parse(_))));
}

#[test]
fn guard_rejects_empty() {
    assert!(matches!(guard(""), Err(UrlGuardError::Parse(_))));
    assert!(matches!(guard("   "), Err(UrlGuardError::Parse(_))));
}

#[test]
fn guard_trims_surrounding_whitespace() {
    let url = guard("  https://example.com  ").expect("首尾空白应被 trim");
    assert_eq!(url, Url::parse("https://example.com").unwrap());
}

#[test]
fn guard_normalizes_scheme_to_lowercase() {
    // url::Url 把 scheme 小写归一，故大写 HTTPS 仍命中 allowlist。
    assert_eq!(
        guard("HTTPS://Example.COM")
            .expect("大写 scheme 应放行")
            .scheme(),
        "https"
    );
}

// ── nav_decision：游标纯算术 ──

#[test]
fn back_cursor_at_front_is_none() {
    assert_eq!(back_cursor(0), None);
}

#[test]
fn back_cursor_decrements() {
    assert_eq!(back_cursor(1), Some(0));
    assert_eq!(back_cursor(5), Some(4));
}

#[test]
fn forward_cursor_empty_history_is_none() {
    assert_eq!(forward_cursor(0, 0), None);
}

#[test]
fn forward_cursor_at_end_is_none() {
    // cursor 指向最后一项（index 2，len 3）→ 无可前进。
    assert_eq!(forward_cursor(2, 3), None);
}

#[test]
fn forward_cursor_advances_within_history() {
    assert_eq!(forward_cursor(0, 3), Some(1));
    assert_eq!(forward_cursor(1, 3), Some(2));
}

#[test]
fn forward_cursor_guards_overflow() {
    // checked_add 防 usize::MAX 溢出——返回 None 而非 panic/回绕。
    assert_eq!(forward_cursor(usize::MAX, usize::MAX), None);
}
