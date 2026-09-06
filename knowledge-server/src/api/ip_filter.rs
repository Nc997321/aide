//! IP 白名单（网络层准入）。
//!
//! ⚠️ 定位：这是**准入**，不是**身份识别**。
//! 它回答"这个来源能不能访问本服务"，不回答"来的是谁"——后者由会话令牌负责
//! （见 extract.rs / auth.rs）。把 IP 当身份用在 NAT、DHCP、VPN 下都会错乱。
//!
//! 私有化部署的典型用法是 `KB_ALLOWED_CIDR=192.168.1.0/24`：
//! 服务即使在客户内网被扫到，外网也进不来。留空 = 不限制。

use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// 一个 CIDR 网段。v4 / v6 分开存，避免 v6 地址硬塞进 u32。
#[derive(Debug, Clone, Copy)]
pub enum Net {
    V4 { addr: u32, mask: u32 },
    V6 { addr: u128, mask: u128 },
}

impl Net {
    /// 解析 `192.168.1.0/24` 或 `2001:db8::/32`。不带 `/` 视为单地址（/32、/128）。
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (addr_s, prefix_s) = match s.split_once('/') {
            Some((a, p)) => (a, p.trim()),
            None => (s, if s.contains(':') { "128" } else { "32" }),
        };

        match addr_s.parse::<Ipv4Addr>() {
            Ok(a) => {
                let prefix: u32 = prefix_s
                    .parse()
                    .map_err(|_| format!("{s}: 前缀长度不是数字"))?;
                if prefix > 32 {
                    return Err(format!("{s}: IPv4 前缀不能超过 32"));
                }
                // prefix=0 时 32-prefix=32，u32 移位 32 会 panic，单独处理
                let mask = if prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - prefix)
                };
                Ok(Net::V4 {
                    addr: u32::from(a) & mask,
                    mask,
                })
            }
            Err(_) => {
                let a: Ipv6Addr = addr_s
                    .parse()
                    .map_err(|_| format!("{s}: 不是合法的 IP 地址"))?;
                let prefix: u32 = prefix_s
                    .parse()
                    .map_err(|_| format!("{s}: 前缀长度不是数字"))?;
                if prefix > 128 {
                    return Err(format!("{s}: IPv6 前缀不能超过 128"));
                }
                let mask = if prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - prefix)
                };
                Ok(Net::V6 {
                    addr: u128::from(a) & mask,
                    mask,
                })
            }
        }
    }

    pub fn contains(self, ip: IpAddr) -> bool {
        match (self, ip) {
            (Net::V4 { addr, mask }, IpAddr::V4(a)) => u32::from(a) & mask == addr,
            (Net::V6 { addr, mask }, IpAddr::V6(a)) => u128::from(a) & mask == addr,
            // IPv4-mapped IPv6（::ffff:192.168.1.5）在内网双栈环境很常见，
            // 当成它映射的 v4 地址来判，否则配了 v4 网段却把双栈客户端全挡了。
            (Net::V4 { addr, mask }, IpAddr::V6(a)) => match a.to_ipv4_mapped() {
                Some(v4) => u32::from(v4) & mask == addr,
                None => false,
            },
            (Net::V6 { .. }, IpAddr::V4(_)) => false,
        }
    }
}

/// 拒绝时的响应。刻意不带任何业务信息：被挡的人不需要知道库里有什么。
fn denied(ip: Option<IpAddr>) -> Response {
    let who = ip.map(|i| i.to_string()).unwrap_or_else(|| "未知来源".into());
    tracing::warn!(%who, "请求来源不在 KB_ALLOWED_CIDR 内，已拒绝");
    (
        StatusCode::FORBIDDEN,
        axum::Json(serde_json::json!({
            "error": "ip_denied",
            "message": "来源地址不在允许范围内",
        })),
    )
        .into_response()
}

pub async fn ip_allowlist(nets: Vec<Net>, req: Request<axum::body::Body>, next: Next) -> Response {
    if nets.is_empty() {
        return next.run(req).await;
    }

    // 从 ConnectInfo 拿对端地址，而不是 X-Forwarded-For：
    // 那个头是客户端能随便伪造的，拿它做准入等于没做。
    // 真要挂在反向代理后面，请在**代理**上做访问控制。
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());

    match ip {
        Some(ip) if nets.iter().any(|n| n.contains(ip)) => next.run(req).await,
        other => denied(other),
    }
}

#[cfg(test)]
mod tests {
    use super::Net;
    use std::net::IpAddr;

    #[test]
    fn parses_and_matches_v4() {
        let n = Net::parse("192.168.1.0/24").unwrap();
        assert!(n.contains("192.168.1.5".parse::<IpAddr>().unwrap()));
        assert!(n.contains("192.168.1.255".parse::<IpAddr>().unwrap()));
        assert!(!n.contains("192.168.2.1".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn bare_address_is_single_host() {
        let n = Net::parse("10.0.0.7").unwrap();
        assert!(n.contains("10.0.0.7".parse::<IpAddr>().unwrap()));
        assert!(!n.contains("10.0.0.8".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn prefix_zero_allows_all() {
        let n = Net::parse("0.0.0.0/0").unwrap();
        assert!(n.contains("8.8.8.8".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn ipv4_mapped_ipv6_matches_v4_net() {
        let n = Net::parse("192.168.1.0/24").unwrap();
        assert!(n.contains("::ffff:192.168.1.9".parse::<IpAddr>().unwrap()));
        assert!(!n.contains("::ffff:10.0.0.9".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn rejects_malformed() {
        assert!(Net::parse("300.1.1.1/24").is_err());
        assert!(Net::parse("192.168.1.0/33").is_err());
        assert!(Net::parse("192.168.1.0/abc").is_err());
    }
}
