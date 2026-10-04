//! npm 系语言服务器（typescript-language-server、pyright）的运行时 node。
//!
//! 查找顺序（`find`，只找不装）：
//!   1. Aide 自己装过的那份（`~/.aide/lsp/runtime/node-<ver>-<plat>`）——装它就是因为别的不可用；
//!   2. PATH 上 ≥ 18 的 node（Host 进程跑在用户登录环境里，看到的就是用户终端的 PATH）；
//!   3. sidecar 正在用的那份（远程 Host 上可能是远程套件代装在 deps/ 里的）。
//! 都没有时 `ensure` 才下载：官方源 → 镜像，按官方 SHASUMS256.txt 校验。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::mirrors::{NODE_MIN_MAJOR, NODE_MIRRORS, NODE_VERSION};
use crate::resources::HostResources;

use super::{archive, fetch};

pub fn runtime_root() -> PathBuf {
    crate::paths::our_config_dir().join("lsp").join("runtime")
}

/// (node 发行包平台名, 归档扩展名)。
fn node_platform() -> Option<(&'static str, &'static str)> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => ("linux-x64", "tar.gz"),
        ("linux", "aarch64") => ("linux-arm64", "tar.gz"),
        ("macos", "x86_64") => ("darwin-x64", "tar.gz"),
        ("macos", "aarch64") => ("darwin-arm64", "tar.gz"),
        ("windows", "x86_64") => ("win-x64", "zip"),
        ("windows", "aarch64") => ("win-arm64", "zip"),
        _ => return None,
    })
}

fn managed_dir() -> Option<PathBuf> {
    let (plat, _) = node_platform()?;
    Some(runtime_root().join(format!("node-{NODE_VERSION}-{plat}")))
}

fn node_in(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("node.exe")
    } else {
        dir.join("bin").join("node")
    }
}

/// `node --version` 的主版本号；跑不起来 = None。
pub fn node_major(path: &Path) -> Option<u32> {
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_major(&String::from_utf8_lossy(&out.stdout))
}

fn parse_major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

fn usable(path: &Path) -> bool {
    node_major(path).is_some_and(|m| m >= NODE_MIN_MAJOR)
}

/// 只找不装。
pub fn find(resources: &dyn HostResources) -> Option<PathBuf> {
    if let Some(p) = managed_dir().map(|d| node_in(&d)).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(p) = which::which("node").ok().filter(|p| usable(p)) {
        return Some(p);
    }
    // sidecar 的启动程序是 node 时（开发态 / 远程 Host）借用它；发布版桌面是打包好的 aide-agent，不是 node。
    if let Ok((program, _)) = resources.agent_runtime() {
        let p = which::which(&program).unwrap_or_else(|_| PathBuf::from(&program));
        let is_node = p
            .file_stem()
            .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("node"));
        if is_node && usable(&p) {
            return Some(p);
        }
    }
    None
}

/// 找不到就下载一份到 `~/.aide/lsp/runtime`。
pub fn ensure(resources: &dyn HostResources) -> Result<PathBuf, String> {
    if let Some(p) = find(resources) {
        return Ok(p);
    }
    download()
}

fn download() -> Result<PathBuf, String> {
    let (plat, ext) = node_platform().ok_or("这个平台没有官方 Node.js 发行包，请自行安装 Node.js 18+")?;
    let name = format!("node-{NODE_VERSION}-{plat}.{ext}");
    tracing::info!("[lsp-packs] downloading node runtime {name}");

    let sums = fetch::get_first(
        &NODE_MIRRORS.iter().map(|m| format!("{m}/{NODE_VERSION}/SHASUMS256.txt")).collect::<Vec<_>>(),
    )?;
    let sums = String::from_utf8_lossy(&sums);
    let expected = sums
        .lines()
        .find_map(|l| l.strip_suffix(&name).map(str::trim))
        .ok_or_else(|| format!("SHASUMS256.txt 里没有 {name}"))?
        .to_string();

    let bytes =
        fetch::get_first(&NODE_MIRRORS.iter().map(|m| format!("{m}/{NODE_VERSION}/{name}")).collect::<Vec<_>>())?;
    fetch::verify_sha256_hex(&bytes, &expected)?;

    let root = runtime_root();
    let staging = root.join(format!(".staging-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("创建目录失败：{e}"))?;
    if ext == "zip" {
        archive::unzip_all(&bytes, &staging)?;
    } else {
        archive::untar_gz(&bytes, &staging, None)?;
    }
    // 发行包根目录就是 node-<ver>-<plat>/，整个挪到位
    let dir = managed_dir().ok_or("unreachable: platform checked above")?;
    let unpacked = staging.join(format!("node-{NODE_VERSION}-{plat}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&unpacked, &dir).map_err(|e| format!("安装 node 失败：{e}"))?;
    let _ = std::fs::remove_dir_all(&staging);

    let node = node_in(&dir);
    if !usable(&node) {
        return Err(format!("下载的 node 跑不起来：{}", node.display()));
    }
    Ok(node)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_node_version() {
        assert_eq!(parse_major("v22.12.0\n"), Some(22));
        assert_eq!(parse_major("18.0.0"), Some(18));
        assert_eq!(parse_major("garbage"), None);
    }

    #[test]
    fn current_platform_has_a_node_build() {
        // CI 跑在 macOS，开发机是 Windows / Linux：主流平台都必须有发行包可下
        assert!(node_platform().is_some(), "{} {}", std::env::consts::OS, std::env::consts::ARCH);
    }
}
