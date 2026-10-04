//! URL 守门：scheme allowlist。纯函数，拒绝可绕过同源/注入脚本的危险 scheme。
//! 设计见 docs/superpowers/plans/2026-09-10-embedded-browser.md §5/§8。

use url::Url;

/// 允许加载的 scheme。
/// - `http`/`https`：通用浏览任意外站。
/// - `file`：本地内容预览。本函数只放行 scheme，**没有**根目录白名单（用户地址栏本就是用户自己的
///   动作；agent 侧本来就有 `eval` / `call_cdp`，给导航单加一道路径白名单拦不住任何东西）。
///   引擎对 `file:` 须走原生导航，见 `adapter/webview2` 的 `needs_native_navigation`。
///
/// 刻意拒绝 `javascript:`/`data:`/`blob:`/`about:`——它们可绕过同源策略或注入脚本。
/// 需要时在此显式扩充并补测试，不在调用点散落判断。
const ALLOWED_SCHEMES: &[&str] = &["http", "https", "file"];

/// 守门失败原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlGuardError {
    /// 非法 URL 语法（含无 scheme 的裸域名，如 `example.com`——`Url::parse` 拒绝相对地址）。
    Parse(String),
    /// scheme 不在 [`ALLOWED_SCHEMES`] 内。
    SchemeNotAllowed { scheme: String },
}

impl std::fmt::Display for UrlGuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UrlGuardError::Parse(detail) => write!(f, "invalid url: {detail}"),
            UrlGuardError::SchemeNotAllowed { scheme } => {
                write!(f, "url scheme not allowed: {scheme}")
            }
        }
    }
}

impl std::error::Error for UrlGuardError {}

/// 校验并规范化一个待加载的 URL。
///
/// 纯函数：先 `trim` 去首尾空白，再 `Url::parse`（语法 + scheme 小写归一），
/// 最后过 scheme allowlist。成功返回校验过的 [`Url`]（引擎可直接喂 `WebviewUrl::External`）。
///
/// 注：用户地址栏常输无 scheme 的裸域名（`example.com`）。本守门**刻意拒绝**它（更安全、
/// 纯函数不猜意图）；「自动补 `https://`」是 UX 便利，由上层命令在调用 `guard` 前决定。
pub fn guard(raw: &str) -> Result<Url, UrlGuardError> {
    let url = Url::parse(raw.trim()).map_err(|e| UrlGuardError::Parse(e.to_string()))?;
    // url::Url::scheme() 已小写归一（"HTTPS://x" → "https"）。
    let scheme = url.scheme();
    if !ALLOWED_SCHEMES.contains(&scheme) {
        return Err(UrlGuardError::SchemeNotAllowed {
            scheme: scheme.to_string(),
        });
    }
    Ok(url)
}
