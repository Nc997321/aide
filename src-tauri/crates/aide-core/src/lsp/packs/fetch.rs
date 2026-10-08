//! 下载与完整性校验。同步实现（ureq），由调用方放进 `spawn_blocking`。
//!
//! - 按回退链逐个源尝试，全失败时把每个源的原因都带上（用户要能看出是「官方源被墙」还是「镜像 404」）；
//! - 走 Aide 的代理探测（设置里显式配置 > 环境变量 > git 配置 > 常见本地端口），与供应商连接测试同一条链；
//! - 大小设上限：语言包里最大的是 node 发行包（~50MB），给到 200MB，防异常源把内存吃满。

use std::io::Read;
use std::time::Duration;

use base64::Engine as _;
use sha2::{Digest, Sha256, Sha512};

const MAX_BYTES: u64 = 200 * 1024 * 1024;

fn agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60));
    if let Some(proxy_url) = crate::proxy::detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) {
            builder = builder.proxy(p);
        }
    }
    builder.build()
}

/// GET 一个地址，返回全部字节。
pub fn get(url: &str) -> Result<Vec<u8>, String> {
    let resp = agent().get(url).call().map_err(|e| match e {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(t) => t.to_string(),
    })?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败：{e}"))?;
    if buf.len() as u64 > MAX_BYTES {
        return Err("文件超过 200MB 上限".into());
    }
    Ok(buf)
}

/// 按顺序尝试多个地址，第一个成功的为准；全失败时列出每个地址的原因。
pub fn get_first(urls: &[String]) -> Result<Vec<u8>, String> {
    let mut errors = Vec::new();
    for url in urls {
        match get(url) {
            Ok(b) => return Ok(b),
            Err(e) => {
                tracing::warn!(url = %url, error = %e, "[lsp-packs] download failed, trying next source");
                errors.push(format!("{}：{e}", host_of(url)));
            }
        }
    }
    Err(format!("所有下载源都失败了（{}）。网络受限时请在设置里配置代理。", errors.join("；")))
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

/// 校验 npm 的 `dist.integrity`（SRI 格式：`sha512-<base64>`）。
pub fn verify_sri(bytes: &[u8], integrity: &str) -> Result<(), String> {
    let (algo, expected) = integrity
        .split_once('-')
        .ok_or_else(|| format!("看不懂的 integrity：{integrity}"))?;
    let actual = match algo {
        "sha512" => base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)),
        "sha256" => base64::engine::general_purpose::STANDARD.encode(Sha256::digest(bytes)),
        other => return Err(format!("不支持的校验算法：{other}")),
    };
    if actual == expected {
        Ok(())
    } else {
        Err("下载内容与 registry 公布的校验值不符，已拒绝安装".into())
    }
}

/// 校验 sha256（十六进制，node 发行包的 SHASUMS256.txt 用这种）。
pub fn verify_sha256_hex(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    let actual: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual.eq_ignore_ascii_case(expected_hex.trim()) {
        Ok(())
    } else {
        Err("下载内容与官方公布的 sha256 不符，已拒绝安装".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sri_sha512_roundtrip_and_mismatch() {
        let data = b"hello aide";
        let good = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(Sha512::digest(data))
        );
        assert!(verify_sri(data, &good).is_ok());
        assert!(verify_sri(b"tampered", &good).is_err());
        assert!(verify_sri(data, "md5-xxx").is_err());
        assert!(verify_sri(data, "garbage").is_err());
    }

    #[test]
    fn sha256_hex_check() {
        // echo -n abc | sha256sum
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_sha256_hex(b"abc", abc).is_ok());
        assert!(verify_sha256_hex(b"abc", &abc.to_uppercase()).is_ok());
        assert!(verify_sha256_hex(b"abd", abc).is_err());
    }

    #[test]
    fn host_of_extracts_domain() {
        assert_eq!(host_of("https://registry.npmmirror.com/pyright/1.0"), "registry.npmmirror.com");
    }
}
