//! 「最新发布的是哪一版」：从发布渠道的标签里挑出最大的版本号，并缓存。
//!
//! 版本号标签不可变、每次发布都推一个（见 release.sh），所以「最大的版本号标签」就是
//! 最新发布。`stable`、`latest` 这类非版本号标签不参与比较。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::port::ReleaseChannel;

/// registry 在外网，别每次打开面板都查一次。
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

pub struct LatestRelease {
    channel: Arc<dyn ReleaseChannel>,
    cache: Mutex<Option<(Instant, String)>>,
}

impl LatestRelease {
    pub fn new(channel: Arc<dyn ReleaseChannel>) -> Self {
        Self { channel, cache: Mutex::new(None) }
    }

    pub fn repo(&self) -> Option<&str> {
        self.channel.repo()
    }

    /// 最新版本号。`refresh` = 跳过缓存（用户点「检查更新」）。
    /// 只缓存成功的结果：一时连不上外网，下次打开面板应该重试，而不是认死 30 分钟。
    pub async fn latest(&self, refresh: bool) -> Result<String, String> {
        if !refresh {
            if let Some((at, v)) = self.cache.lock().await.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return Ok(v.clone());
                }
            }
        }
        let tags = self.channel.tags().await?;
        let latest = pick_latest(&tags).ok_or("镜像仓库里没有版本号标签")?;
        *self.cache.lock().await = Some((Instant::now(), latest.clone()));
        Ok(latest)
    }
}

/// 只认纯数字的 `x.y.z`（段数不限）；预发布、`stable` 之类一律跳过。
pub fn pick_latest(tags: &[String]) -> Option<String> {
    tags.iter()
        .filter_map(|t| parse(t).map(|v| (v, t)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, t)| t.clone())
}

fn parse(tag: &str) -> Option<Vec<u64>> {
    let segs: Option<Vec<u64>> = tag.split('.').map(|s| s.parse().ok()).collect();
    segs.filter(|v| v.len() >= 2)
}

#[cfg(test)]
mod tests {
    use super::pick_latest;

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn picks_highest_numeric_version() {
        // 按数值比，不按字典序：0.10.0 > 0.9.1
        assert_eq!(pick_latest(&tags(&["0.1.0", "0.9.1", "0.10.0", "stable"])).as_deref(), Some("0.10.0"));
        assert_eq!(pick_latest(&tags(&["0.5.0", "0.5.1", "stable", "latest"])).as_deref(), Some("0.5.1"));
    }

    #[test]
    fn ignores_non_version_tags() {
        assert_eq!(pick_latest(&tags(&["stable", "dev", "0.6.0-rc1"])), None);
    }
}
