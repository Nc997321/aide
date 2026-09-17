//! 站点图标（favicon）缓存：**按页面 URL 索引的独立存储**，与书签记录分离。
//!
//! 为什么不是书签上的一个字段：这是 Chromium / Firefox 同构的做法（profile 里的 `Favicons` 库、
//! Firefox 的 `favicons.sqlite`）。图标是**页面的属性**、不是"某条书签的属性"——同一 URL 出现在多个
//! 目录下只该有一份图标，将来标签页/历史要显示图标也查同一张表。
//!
//! **查找链**（照抄业界，缺一档往前退）：
//! 1. 精确 URL
//! 2. 同主机（该域下任意页面）
//! 3. 引擎实时抓（`ICoreWebView2_15`，另一批）
//! 4. 前端给默认地球图标
//!
//! 第 2 档是必需的：导入文件里没带 `ICON` 的条目，多半跟带图标的条目同域。
//!
//! **落盘**：`~/.aide/browser/favicons/<sha256(键)>.<ext>`——**用键的哈希当文件名，不维护索引**。
//! 没索引就没有"索引与文件不同步"这类坏状态，查找 = 探一遍存在的扩展名。代价是同一张图在不同 URL
//! 下会各存一份（Chromium 按图标内容去重；我们没有图像编解码，也不值得为几十 KB 引一套）。
//! 哈希用 sha2 而不是 `DefaultHasher`：**文件名要在磁盘上跨版本存活**，而 std 不保证后者的算法稳定
//! ——换了算法，磁盘上的图标会集体变成查不到的孤儿。
//!
//! 图标是**装饰**：写失败不回滚导入、解析不出就当没有，任何一处都不该因为它把导入搞挂。

use std::fs;
use std::path::PathBuf;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::browser::core::url_guard;
use crate::commands::our_config_dir;

/// 单条图标上限。真机 16×16 PNG 约 1 KB，32 KB 足够大——再大就是异常数据，不该进缓存。
pub const MAX_ICON_BYTES: usize = 32 * 1024;

/// 一条通过校验的图标数据（媒体类型不存这里：落盘靠扩展名，回读时由 [`MIMES`] 反查）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Icon {
    /// 落盘扩展名，也是回读时的探测键。
    pub ext: &'static str,
    pub bytes: Vec<u8>,
}

/// 认得的图片类型：`(媒体类型, 落盘扩展名)`。顺序 = 回读时的探测顺序。
///
/// **不含 `image/svg+xml`**：SVG 可以带 `<script>`。虽然在 `<img>` 里浏览器不执行它，但图标不值得
/// 为这点便利开一个口子——真机导出里 100% 是 PNG。
const MIMES: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/x-icon", "ico"),
    ("image/vnd.microsoft.icon", "ico"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/bmp", "bmp"),
];

/// 校验并解出一条 `data:` URI 形态的图标。任何不合规 → `None`（宁可没图标，也不猜）。
///
/// 只认 `data:<已知图片类型>;base64,<载荷>`：少数导出器写百分号编码，那要另一套解码，明说不支持。
pub fn decode_data_uri(raw: &str) -> Option<Icon> {
    let (ext, payload) = split_data_uri(raw)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(Icon { ext, bytes })
}

/// `data:<mime>;base64,<载荷>` → `(扩展名, 载荷)`。媒体类型大小写不敏感（导出器写法不一）。
fn split_data_uri(raw: &str) -> Option<(&'static str, &str)> {
    let (head, payload) = raw.split_once(',')?;
    let mime = head
        .to_ascii_lowercase()
        .strip_prefix("data:")?
        .strip_suffix(";base64")?
        .to_string();
    let (_, ext) = MIMES.iter().copied().find(|(m, _)| *m == mime)?;
    Some((ext, payload))
}

/// 一个 URL 的两级键。前缀 `u:` / `h:` 把两类键隔开——不然一个恰好长成 `h:example.com` 的 URL
/// 会跟主机键撞上。键里的 URL 与书签共用 `url_guard` 归一化，否则"手打地址加书签"会因写法差异查不到。
fn keys_of(url_raw: &str) -> Result<(String, Option<String>), url_guard::UrlGuardError> {
    let url = url_guard::guard(url_raw)?;
    let exact = format!("u:{}", url.as_str());
    let host = url.host_str().map(|h| format!("h:{h}"));
    Ok((exact, host))
}

/// 键 → 文件名主干（sha256 十六进制）。
fn hash_key(key: &str) -> String {
    Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 图标缓存。默认位置：`~/.aide/browser/favicons`。
#[derive(Debug, Clone)]
pub struct FaviconStore {
    dir: PathBuf,
}

impl FaviconStore {
    pub fn at_default_location() -> Self {
        Self {
            dir: our_config_dir().join("browser").join("favicons"),
        }
    }

    /// 指定目录。**只给测试用**：生产路径只有默认位置一条（否则"图标存哪"会有第二个答案）。
    #[cfg(test)]
    pub fn at(dir: PathBuf) -> Self {
        Self { dir }
    }

    #[cfg(test)]
    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    /// 存一条：**精确 URL 与所属主机两级都写**（同主机回落靠后者）。
    ///
    /// URL 过不了 `url_guard` → `Err`（连键都构不出来，什么也不写）。
    pub fn put(&self, url_raw: &str, icon: &Icon) -> Result<(), std::io::Error> {
        let (exact, host) = keys_of(url_raw).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string())
        })?;
        self.write(&exact, icon)?;
        if let Some(host) = host {
            self.write(&host, icon)?;
        }
        Ok(())
    }

    /// 查一条：精确 URL → 同主机，命中即给可直接塞进 `<img src>` 的 data URI。
    pub fn get(&self, url_raw: &str) -> Option<String> {
        let Ok((exact, host)) = keys_of(url_raw) else {
            return None;
        };
        let (mime, path) = self
            .find(&exact)
            .or_else(|| host.as_deref().and_then(|h| self.find(h)))?;
        let bytes = fs::read(&path).ok()?;
        let payload = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Some(format!("data:{mime};base64,{payload}"))
    }

    fn write(&self, key: &str, icon: &Icon) -> Result<(), std::io::Error> {
        fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(format!("{}.{}", hash_key(key), icon.ext));
        fs::write(path, &icon.bytes)
    }

    /// 按键找已存在的文件。`ico` 在 [`MIMES`] 里有两个媒体类型写法，会探到同一个路径——重复一次
    /// `is_file` 而已，不值得为此再维护一张去重表（两张表必然漂移）。
    fn find(&self, key: &str) -> Option<(&'static str, PathBuf)> {
        let stem = hash_key(key);
        MIMES.iter().find_map(|(mime, ext)| {
            let path = self.dir.join(format!("{stem}.{ext}"));
            path.is_file().then_some((*mime, path))
        })
    }
}

#[cfg(test)]
mod favicon_test;
