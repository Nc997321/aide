//! 发布渠道端口的 registry 实现：按 Docker Registry HTTP API v2 读标签列表。
//!
//! 只读元数据（一次标签列表），不下载镜像。公开仓库要先匿名换一个拉取令牌：
//! 第一次请求回 401 + `WWW-Authenticate: Bearer realm=…,service=…,scope=…`，
//! 照着去 realm 取令牌再重试——阿里云 ACR 与 Docker Hub 都是这套。

use std::time::Duration;

use serde::Deserialize;

use crate::port::release_channel::{BoxFut, ReleaseChannel};

pub struct RegistryChannel {
    /// `host/namespace/name`
    repo: String,
    client: reqwest::Client,
}

impl RegistryChannel {
    pub fn new(repo: &str) -> Self {
        // reqwest 用的是不带加密后端的 rustls，进程里装一次 ring（重复安装返回 Err，忽略）
        let _ = rustls::crypto::ring::default_provider().install_default();
        Self {
            repo: repo.trim().trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                // 内网离线部署连不上外网时要快速失败，别拖住用户打开面板
                .timeout(Duration::from_secs(10))
                .build()
                .expect("构造 HTTP 客户端失败"),
        }
    }

    async fn fetch_tags(&self) -> Result<Vec<String>, String> {
        let (host, path) = self
            .repo
            .split_once('/')
            .ok_or_else(|| format!("镜像仓库地址不完整：{}", self.repo))?;
        let url = format!("https://{host}/v2/{path}/tags/list");

        let first = self.client.get(&url).send().await.map_err(|e| format!("连不上镜像仓库：{e}"))?;
        let res = if first.status() == reqwest::StatusCode::UNAUTHORIZED {
            let challenge = first
                .headers()
                .get(reqwest::header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .ok_or("镜像仓库要求鉴权，但没给出取令牌的方式")?
                .to_string();
            let token = self.anonymous_token(&challenge).await?;
            self.client
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("连不上镜像仓库：{e}"))?
        } else {
            first
        };
        if !res.status().is_success() {
            return Err(format!("镜像仓库返回 HTTP {}", res.status()));
        }
        let body: TagList = res.json().await.map_err(|e| format!("标签列表解析失败：{e}"))?;
        Ok(body.tags.unwrap_or_default())
    }

    async fn anonymous_token(&self, challenge: &str) -> Result<String, String> {
        let params = parse_bearer_challenge(challenge).ok_or("看不懂镜像仓库的鉴权要求")?;
        let realm = params.iter().find(|(k, _)| k == "realm").map(|(_, v)| v.clone()).ok_or("鉴权要求里没有 realm")?;
        let mut url = reqwest::Url::parse(&realm).map_err(|e| format!("鉴权地址不合法：{e}"))?;
        url.query_pairs_mut().extend_pairs(params.iter().filter(|(k, _)| k != "realm"));
        let res = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("取镜像仓库令牌失败：{e}"))?;
        if !res.status().is_success() {
            return Err(format!("取镜像仓库令牌失败：HTTP {}（仓库是私有的？）", res.status()));
        }
        let t: TokenBody = res.json().await.map_err(|e| format!("令牌回包解析失败：{e}"))?;
        t.token.or(t.access_token).ok_or_else(|| "令牌回包里没有 token".to_string())
    }
}

#[derive(Deserialize)]
struct TagList {
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct TokenBody {
    token: Option<String>,
    access_token: Option<String>,
}

/// `Bearer realm="…",service="…",scope="…"` → [(realm, …), (service, …), (scope, …)]
fn parse_bearer_challenge(h: &str) -> Option<Vec<(String, String)>> {
    let rest = h.trim().strip_prefix("Bearer ").or_else(|| h.trim().strip_prefix("bearer "))?;
    let mut out = Vec::new();
    let mut s = rest;
    while !s.is_empty() {
        let (key, after) = s.split_once('=')?;
        let after = after.strip_prefix('"')?;
        let end = after.find('"')?;
        out.push((key.trim().trim_start_matches(',').trim().to_string(), after[..end].to_string()));
        s = after[end + 1..].trim_start_matches(',').trim_start();
    }
    Some(out)
}

impl ReleaseChannel for RegistryChannel {
    fn repo(&self) -> Option<&str> {
        Some(&self.repo)
    }
    fn tags(&self) -> BoxFut<'_, Vec<String>> {
        Box::pin(self.fetch_tags())
    }
}

#[cfg(test)]
mod tests {
    use super::parse_bearer_challenge;

    #[test]
    fn parses_acr_challenge() {
        let h = r#"Bearer realm="https://dockerauth.cn-hangzhou.aliyuncs.com/auth",service="registry.aliyuncs.com:cn-shanghai:26842",scope="repository:aide-org/aide-knowledge:pull""#;
        let p = parse_bearer_challenge(h).unwrap();
        assert_eq!(p[0], ("realm".into(), "https://dockerauth.cn-hangzhou.aliyuncs.com/auth".into()));
        assert_eq!(p[1], ("service".into(), "registry.aliyuncs.com:cn-shanghai:26842".into()));
        assert_eq!(p[2], ("scope".into(), "repository:aide-org/aide-knowledge:pull".into()));
    }

    /// 真网络：匿名查官方发布仓库。`cargo test -- --ignored real_registry`
    #[tokio::test]
    #[ignore]
    async fn real_registry_lists_version_tags() {
        use crate::port::ReleaseChannel;
        let ch = super::RegistryChannel::new(crate::config::DEFAULT_RELEASE_REPO);
        let tags = ch.tags().await.expect("查标签失败");
        assert!(tags.iter().any(|t| t == "stable"), "tags = {tags:?}");
        let latest = crate::domain::release::pick_latest(&tags).expect("没有版本号标签");
        println!("latest = {latest}, tags = {tags:?}");
    }

    #[test]
    fn rejects_non_bearer() {
        assert!(parse_bearer_challenge(r#"Basic realm="x""#).is_none());
    }
}
