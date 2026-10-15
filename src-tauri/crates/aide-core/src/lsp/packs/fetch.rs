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

/// 大文件下载到 `dest`：**断点续传 + 自动重试 + 进度回调**，下完校验 sha256（十六进制）。
///
/// 为什么不用 [`get`]：jdtls 约 50MB，官方源国内直连实测 ~12KB/s 且会中途断开（2026-10-14：
/// 26.8MB 时 `server closed abruptly`）。一次性下载断了就得从头来；这里断了从已有字节续上
///（`Range: bytes=N-`），源不支持续传（回 200）就从头写。连续失败 [`RESUME_ATTEMPTS`] 次才放弃，
/// `dest` 留着，下次安装接着下。
///
/// `progress(已下字节, 总字节)`：调用方自己节流。
pub fn download_resumable(
    url: &str,
    dest: &std::path::Path,
    expected_sha256_hex: &str,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<(), String> {
    use std::io::Write;
    let mut last_err: String;
    for attempt in 0..RESUME_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2 * attempt as u64));
        }
        let have = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let mut req = agent().get(url);
        if have > 0 {
            req = req.set("Range", &format!("bytes={have}-"));
        }
        let resp = match req.call() {
            Ok(r) => r,
            // 416：已经下完了（上次断在校验之前）
            Err(ureq::Error::Status(416, _)) if have > 0 => break,
            Err(ureq::Error::Status(code, _)) => return Err(format!("{}：HTTP {code}", host_of(url))),
            Err(ureq::Error::Transport(t)) => {
                last_err = t.to_string();
                tracing::warn!(url, attempt, error = %last_err, "[lsp-packs] download interrupted, retrying");
                continue;
            }
        };
        let resumed = resp.status() == 206;
        let base = if resumed { have } else { 0 };
        let total = resp
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| n + base);
        if total.is_some_and(|t| t > MAX_BYTES) {
            return Err("文件超过 200MB 上限".into());
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(dest)
            .map_err(|e| format!("写 {} 失败：{e}", dest.display()))?;
        let mut reader = resp.into_reader();
        let mut got = base;
        let mut buf = vec![0u8; 64 * 1024];
        let outcome = loop {
            match reader.read(&mut buf) {
                Ok(0) => break Ok(()),
                Ok(n) => {
                    file.write_all(&buf[..n]).map_err(|e| format!("写入失败：{e}"))?;
                    got += n as u64;
                    progress(got, total);
                }
                Err(e) => break Err(e.to_string()),
            }
        };
        match outcome {
            Ok(()) if total.is_none_or(|t| got >= t) => break,
            Ok(()) => last_err = format!("连接提前结束（{got}/{} 字节）", total.unwrap_or(0)),
            Err(e) => last_err = e,
        }
        tracing::warn!(url, attempt, got, error = %last_err, "[lsp-packs] download interrupted, resuming");
        if attempt + 1 == RESUME_ATTEMPTS {
            return Err(format!(
                "下载 {} 多次中断（{last_err}）。已下载的部分会保留，重试安装会接着下；网络受限时请在设置里配置代理。",
                host_of(url)
            ));
        }
    }
    let bytes = std::fs::read(dest).map_err(|e| format!("读取下载文件失败：{e}"))?;
    if let Err(e) = verify_sha256_hex(&bytes, expected_sha256_hex) {
        // 校验不过的文件不能留着让下次「续传」：删掉从头来
        let _ = std::fs::remove_file(dest);
        return Err(e);
    }
    Ok(())
}

/// 断点续传的最大尝试次数（含第一次）。
const RESUME_ATTEMPTS: usize = 12;

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
