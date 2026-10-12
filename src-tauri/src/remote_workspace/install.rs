//! 远程套件（remote kit）安装：把 aide-host + sidecar 送到目标机，目标机**不需要**
//! 联网、不需要预装任何东西（node 缺失时也由桌面代下）。
//!
//! 目标机布局（`$HOME/.aide/host/`）：
//!
//! ```text
//! <ver>/aide-host              ← 桌面随包的 linux 静态二进制（musl，按架构：
//!                                  随包文件名 remote-kit/aide-host-linux-{x64,arm64}）
//! <ver>/runtime/runtime.js     ← sidecar bundle（平台无关 JS）
//! deps/claude-<sdk>-<plat>/claude   ← Claude CLI（npm 平台包，桌面下载后上传）
//! deps/node-<ver>-<plat>/bin/node   ← 仅当目标机没有 node ≥ 18 时
//! ```
//!
//! `<ver>` = 应用版本 + aide-host/runtime.js 内容哈希：开发期重编 host 也会触发重装，
//! 旧版本目录在安装新版后清理。所有下载都在**桌面**进行（走桌面的代理设置），经
//! wsl/ssh 管道流式上传——很多服务器出不了公网，但桌面能。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

use super::launcher::{self, sh_quote};
use super::path::HostId;

/// sidecar 锁定的 Claude Agent SDK 版本（CLI 平台包必须同版本）。
const SIDECAR_PACKAGE_JSON: &str = include_str!("../../../agent-sidecar/package.json");
// node 版本与下载源：与语言包安装器共用一份（aide_core::mirrors）。
use aide_core::mirrors::{NODE_MIN_MAJOR, NODE_MIRRORS, NODE_VERSION, NPM_REGISTRIES};

/// 安装完成后 agent 启动所需的全部路径（目标机路径）。
#[derive(Debug, Clone)]
pub struct Installed {
    pub host_bin: String,
    pub claude_exe: String,
    /// None = 用目标机登录 shell PATH 上的 node。
    pub node: Option<String>,
    /// 桌面回环代理在目标机上的改写地址：WSL（NAT）= 默认网关（即 Windows 主机）；
    /// SSH = None（服务器上没有通往桌面回环的路，回环代理只能丢弃）。
    pub loopback_rewrite: Option<String>,
}

#[derive(Debug, Default)]
struct Probe {
    arch: String,
    home: String,
    musl: bool,
    host_ok: bool,
    claude_ok: bool,
    node_path: Option<String>,
    node_major: Option<u32>,
    bundled_node_ok: bool,
    gateway: Option<String>,
}

/// 目标平台标识（npm / node 发行包命名）。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Plat {
    X64,
    Arm64,
}

impl Plat {
    fn from_uname(m: &str) -> Result<Plat, String> {
        match m {
            "x86_64" | "amd64" => Ok(Plat::X64),
            "aarch64" | "arm64" => Ok(Plat::Arm64),
            other => Err(format!("不支持的目标机架构：{other}（支持 x86_64 / aarch64）")),
        }
    }
    fn npm(self) -> &'static str {
        match self {
            Plat::X64 => "x64",
            Plat::Arm64 => "arm64",
        }
    }
    fn kit_dir(self) -> &'static str {
        match self {
            Plat::X64 => "linux-x64",
            Plat::Arm64 => "linux-arm64",
        }
    }
}

fn sdk_version() -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(SIDECAR_PACKAGE_JSON).map_err(|e| e.to_string())?;
    v["dependencies"]["@anthropic-ai/claude-agent-sdk"]
        .as_str()
        .map(|s| s.trim_start_matches(['^', '~']).to_string())
        .ok_or_else(|| "agent-sidecar/package.json 缺少 claude-agent-sdk 版本".to_string())
}

/// 本机套件目录候选：release 在资源目录 `remote-kit/`，dev 在源码树（`pnpm build:remote-kit`）。
/// runtime.js 在 dev 另有 agent-sidecar/dist 兜底（改 sidecar 后不必重跑套件构建）。
pub fn kit_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("remote-kit"));
    }
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        dirs.push(manifest.join("remote-kit"));
        dirs.push(manifest.join("..").join("agent-sidecar").join("dist"));
    }
    dirs
}

fn local_kit_file(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn read_kit(dirs: &[PathBuf], plat: Plat) -> Result<(Vec<u8>, Vec<u8>, String), String> {
    let host_rel = format!("aide-host-{}", plat.kit_dir());
    let host_path = local_kit_file(dirs, &host_rel).ok_or_else(|| {
        format!(
            "本机缺少远程套件 remote-kit/{host_rel}（开发环境请先运行 `pnpm build:remote-kit`）"
        )
    })?;
    let runtime_path = local_kit_file(dirs, "runtime.js")
        .ok_or("本机缺少远程套件 runtime.js（开发环境请先构建 agent-sidecar）")?;
    let host = std::fs::read(&host_path).map_err(|e| format!("读取 {}：{e}", host_path.display()))?;
    let runtime =
        std::fs::read(&runtime_path).map_err(|e| format!("读取 {}：{e}", runtime_path.display()))?;
    let mut h = Sha256::new();
    h.update(&host);
    h.update(&runtime);
    let digest = h.finalize();
    let hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let ver = format!("{}-{hash}", env!("CARGO_PKG_VERSION"));
    Ok((host, runtime, ver))
}

/// 探测类短脚本的上限：超过即说明卡在用户 rc 文件之类的地方，尽早报出来。
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// 上传 / 解包（Claude CLI 压缩包约 70MB，慢速 SSH 链路要留足时间）。
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(900);
/// 上传分块：每送完一块报一次进度。
const SEND_CHUNK: usize = 1 << 20;

/// 安装进度回报：正在做什么 + 可量化时的完成比例（0–1）。
pub type StageFn<'a> = &'a (dyn Fn(&str, Option<f64>) + Sync);

/// 「正在下载 Claude CLI（37 / 107 MB）」；总量未知时只报已完成的量。
fn transfer_text(what: &str, done: u64, total: Option<u64>) -> String {
    const MB: u64 = 1024 * 1024;
    match total {
        Some(t) if t > 0 => format!("{what}（{} / {} MB）", done / MB, t.div_ceil(MB)),
        _ => format!("{what}（{} MB）", done / MB),
    }
}

fn ratio(done: u64, total: Option<u64>) -> Option<f64> {
    total.filter(|t| *t > 0).map(|t| (done as f64 / t as f64).min(1.0))
}

/// 在目标机跑一段脚本并收集 stdout（带超时）。
pub(super) async fn run_script(host: &HostId, script: &str, stdin: Option<&[u8]>) -> Result<String, String> {
    run_script_sending(host, script, stdin, &|_, _| {}).await
}

/// 同 [`run_script`]，并在往目标机送 `stdin` 的途中回报（已送字节, 总字节）——大文件上传的进度。
async fn run_script_sending(
    host: &HostId,
    script: &str,
    stdin: Option<&[u8]>,
    on_sent: &(dyn Fn(u64, u64) + Sync),
) -> Result<String, String> {
    let limit = if stdin.is_some() { TRANSFER_TIMEOUT } else { PROBE_TIMEOUT };
    let mut cmd = launcher::command(host, script)?;
    let mut child = cmd.spawn().map_err(|e| format!("无法连接 {}：{e}", host.label()))?;
    let mut child_stdin = child.stdin.take().ok_or("no stdin")?;
    // 边写边等：写完必须放掉 stdin（对端才见 EOF）；对端提前退出时写失败无所谓，以退出码为准
    let write = async move {
        if let Some(d) = stdin {
            let total = d.len() as u64;
            let mut sent = 0u64;
            for chunk in d.chunks(SEND_CHUNK) {
                if child_stdin.write_all(chunk).await.is_err() {
                    break;
                }
                sent += chunk.len() as u64;
                on_sent(sent, total);
            }
        }
        let _ = child_stdin.shutdown().await;
        drop(child_stdin);
    };
    let (out, ()) = tokio::time::timeout(limit, async { tokio::join!(child.wait_with_output(), write) })
        .await
        .map_err(|_| format!("{} 上的安装步骤超时", host.label()))?;
    let out = out.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{} 上的命令失败（{}）：{}",
            host.label(),
            out.status,
            ssh_hint(err.trim())
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 常见 ssh 失败给出可操作的提示。
fn ssh_hint(stderr: &str) -> String {
    if stderr.contains("Permission denied") {
        format!("{stderr}\n提示：Aide 需要免密登录（SSH 密钥或 ssh-agent）。请先在终端里确认 `ssh <主机>` 无需输入密码即可登录。")
    } else if stderr.contains("Host key verification failed") {
        format!("{stderr}\n提示：首次连接需在终端里运行一次 `ssh <主机>` 确认主机指纹。")
    } else {
        stderr.to_string()
    }
}

fn parse_probe(out: &str) -> Probe {
    let mut p = Probe::default();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k {
            "arch" => p.arch = v.trim().to_string(),
            "home" => p.home = v.trim().to_string(),
            "libc" => p.musl = v.trim() == "musl",
            "host" => p.host_ok = v.trim() == "ok",
            "claude" => p.claude_ok = v.trim() == "ok",
            "node" if v.starts_with('/') => p.node_path = Some(v.trim().to_string()),
            "nodever" => {
                p.node_major = v
                    .trim()
                    .trim_start_matches('v')
                    .split('.')
                    .next()
                    .and_then(|m| m.parse().ok())
            }
            "bundled_node" => p.bundled_node_ok = v.trim() == "ok",
            "gateway" if !v.trim().is_empty() => p.gateway = Some(v.trim().to_string()),
            _ => {}
        }
    }
    p
}

fn claude_pkg(plat: Plat, musl: bool) -> String {
    format!(
        "claude-agent-sdk-linux-{}{}",
        plat.npm(),
        if musl { "-musl" } else { "" }
    )
}

/// 确保目标机套件就绪（幂等：已装且版本一致则只做一次探测）。`kit` = 本机套件目录候选
/// （见 [`kit_dirs`]）；参数化而非取 AppHandle，便于脱离 Tauri 做真机集成测试。
/// `stage`：真要装东西时报正在做什么与进度（已装好只探测时不调）。
pub async fn ensure_installed(kit: Vec<PathBuf>, host: &HostId, stage: StageFn<'_>) -> Result<Installed, String> {
    let sdk = sdk_version()?;
    // 先拿架构才能选对 host 二进制；探测脚本里的版本号用占位，拿到 ver 后再精确判定。
    let arch_out = run_script(host, "uname -m", None).await?;
    let plat = Plat::from_uname(arch_out.trim())?;
    let (host_bytes, runtime_bytes, ver) = {
        tokio::task::spawn_blocking(move || read_kit(&kit, plat))
            .await
            .map_err(|e| e.to_string())??
    };

    let probe_script = format!(
        r#"D="$HOME/.aide/host"
printf 'arch=%s\nhome=%s\n' "$(uname -m)" "$HOME"
if ls /lib/ld-musl-* >/dev/null 2>&1; then echo libc=musl; else echo libc=gnu; fi
[ -x "$D/{ver}/aide-host" ] && [ -f "$D/{ver}/runtime/runtime.js" ] && echo host=ok
for c in "$D"/deps/claude-{sdk}-*/claude; do [ -x "$c" ] && echo claude=ok && break; done
# node 常由 nvm 装在 ~/.bashrc 里，而 Debian/Ubuntu 的 .bashrc 对非交互 shell 直接 return：
# 必须用交互式登录 shell（-lic）解析。timeout 必须带 --foreground——否则 timeout 把子进程放进
# 后台进程组，交互 shell 做作业控制时被 SIGTTOU 挂起，连 timeout 自己都杀不掉（实测 wsl.exe 下
# 永久挂起）。busybox 的 timeout 没有 --foreground → 退到非交互 -lc。
S="${{SHELL:-/bin/sh}}"
N=$( (timeout --foreground -k 2 15 "$S" -lic 'command -v node' || timeout -k 2 15 "$S" -lc 'command -v node') </dev/null 2>/dev/null | tail -n 1)
case "$N" in /*) printf 'node=%s\nnodever=%s\n' "$N" "$("$N" -v 2>/dev/null)" ;; esac
[ -x "$D/deps/node-{NODE_VERSION}/bin/node" ] && echo bundled_node=ok
G=$(ip route show default 2>/dev/null | awk '{{print $3; exit}}')
[ -n "$G" ] && printf 'gateway=%s\n' "$G"
true"#
    );
    let probe = parse_probe(&run_script(host, &probe_script, None).await?);
    let base = format!("{}/.aide/host", probe.home);
    let claude_dir = format!("{base}/deps/claude-{sdk}-{}", claude_pkg(plat, probe.musl));

    if !probe.host_ok {
        tracing::info!(host = %host, %ver, "installing aide-host");
        stage("正在安装远程套件…", None);
        upload(host, &format!("{base}/{ver}/aide-host"), &host_bytes, true).await?;
        upload(host, &format!("{base}/{ver}/runtime/runtime.js"), &runtime_bytes, false).await?;
        // 清理旧版本目录（只动形如 x.y.z-<hash> 的目录，deps/ 永不碰）
        let cleanup = format!(
            r#"cd "$HOME/.aide/host" && for d in *; do case "$d" in {ver}|deps) ;; [0-9]*.[0-9]*.[0-9]*-*) rm -rf -- "$d" ;; esac; done; true"#
        );
        let _ = run_script(host, &cleanup, None).await;
    }

    if !probe.claude_ok {
        let pkg = claude_pkg(plat, probe.musl);
        tracing::info!(host = %host, %pkg, "installing claude cli");
        stage("正在下载 Claude CLI（首次连接或升级后才需要）…", None);
        let tgz = fetch_cached(
            &format!("{pkg}-{sdk}.tgz"),
            NPM_REGISTRIES
                .iter()
                .map(|r| format!("{r}/@anthropic-ai/{pkg}/-/{pkg}-{sdk}.tgz"))
                .collect(),
            &|done, total| stage(&transfer_text("正在下载 Claude CLI", done, total), ratio(done, total)),
        )
        .await?;
        let script = format!(
            "mkdir -p {d} && tar -xzf - -C {d} --strip-components=1 package/claude && chmod +x {d}/claude",
            d = sh_quote(&claude_dir)
        );
        let what = format!("正在把 Claude CLI 装到 {}", host.label());
        stage(&format!("{what}…"), None);
        run_script_sending(host, &script, Some(&tgz), &|sent, total| {
            stage(&transfer_text(&what, sent, Some(total)), ratio(sent, Some(total)))
        })
        .await?;
    }

    // 登录入口：Claude 官方账号登录（system default 供应商）的凭据住在目标机自己的
    // claude home。桌面**不**同步 OAuth 凭据过去——refresh token 会轮换，两台机器共用
    // 一份会互相顶掉；服务器也可能多人共用。用户在 Aide 的远程终端里跑一次
    // `~/.aide/host/aide-claude` 然后 /login 即可（API Key 类供应商无需这步，
    // 凭据随每条 send 下发）。
    let wrapper = format!(
        "#!/bin/sh\n# Aide 远程工作区：以 Aide 的 claude home 运行 Claude CLI（首次登录：运行后输入 /login）\nCLAUDE_CONFIG_DIR=\"${{CLAUDE_CONFIG_DIR:-$HOME/.aide/claude}}\" exec {} \"$@\"\n",
        sh_quote(&format!("{claude_dir}/claude"))
    );
    if !probe.host_ok || !probe.claude_ok {
        upload(host, &format!("{base}/aide-claude"), wrapper.as_bytes(), true).await?;
    }

    let node = match (probe.node_major, &probe.node_path) {
        (Some(m), Some(_)) if m >= NODE_MIN_MAJOR => None,
        _ => {
            let dir = format!("{base}/deps/node-{NODE_VERSION}");
            if !probe.bundled_node_ok {
                if probe.musl {
                    return Err(format!(
                        "{} 是 musl 系统（如 Alpine）且没有 node ≥ {NODE_MIN_MAJOR}。请先在目标机安装 node（例如 `apk add nodejs`）后重试。",
                        host.label()
                    ));
                }
                tracing::info!(host = %host, "installing node {NODE_VERSION}");
                stage("正在下载 Node.js 运行时…", None);
                let name = format!("node-{NODE_VERSION}-linux-{}.tar.gz", plat.npm());
                let tgz = fetch_cached(
                    &name,
                    NODE_MIRRORS
                        .iter()
                        .map(|m| format!("{m}/{NODE_VERSION}/{name}"))
                        .collect(),
                    &|done, total| stage(&transfer_text("正在下载 Node.js 运行时", done, total), ratio(done, total)),
                )
                .await?;
                let script = format!(
                    "mkdir -p {d} && tar -xzf - -C {d} --strip-components=1",
                    d = sh_quote(&dir)
                );
                let what = format!("正在把 Node.js 运行时装到 {}", host.label());
                stage(&format!("{what}…"), None);
                run_script_sending(host, &script, Some(&tgz), &|sent, total| {
                    stage(&transfer_text(&what, sent, Some(total)), ratio(sent, Some(total)))
                })
                .await?;
            }
            Some(format!("{dir}/bin/node"))
        }
    };

    Ok(Installed {
        host_bin: format!("{base}/{ver}/aide-host"),
        claude_exe: format!("{claude_dir}/claude"),
        node,
        loopback_rewrite: match host {
            HostId::Wsl(_) => probe.gateway,
            HostId::Ssh(_) => None,
        },
    })
}

/// 代理 URL 的 (host, port)（仅解析；无端口按 scheme 默认）。
pub fn proxy_host_port(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let rest = rest.split('/').next().unwrap_or(rest);
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let (h, tail) = v6.split_once(']')?;
        (h.to_string(), tail.strip_prefix(':').and_then(|p| p.parse().ok()))
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()),
            None => (rest.to_string(), None),
        }
    };
    let default = if scheme.starts_with("socks") { 1080 } else if scheme == "https" { 443 } else { 80 };
    Some((host, port.unwrap_or(default)))
}

pub fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.starts_with("127.") || host == "::1"
}

/// 桌面回环代理在目标机上该用哪个主机名：
/// - SSH：None（服务器到不了桌面的回环，只能丢弃）
/// - WSL：先在目标机上试 `127.0.0.1:<port>`（mirrored 网络模式下回环与 Windows 共享）；
///   不通则用默认网关（NAT 模式下即 Windows 主机，代理需开「允许局域网连接」）。
pub async fn loopback_host_for(host: &HostId, inst: &Installed, port: u16) -> Option<String> {
    let HostId::Wsl(_) = host else { return None };
    let script = format!(
        "timeout 2 bash -c ': > /dev/tcp/127.0.0.1/{port}' 2>/dev/null && echo loopback_ok; true"
    );
    match run_script(host, &script, None).await {
        Ok(out) if out.contains("loopback_ok") => Some("127.0.0.1".to_string()),
        _ => inst.loopback_rewrite.clone(),
    }
}

/// 把 URL 的主机部分换成 `new_host`（保留 scheme / 认证 / 端口 / 路径）。
pub fn replace_proxy_host(url: &str, new_host: &str) -> String {
    let Some((old_host, _)) = proxy_host_port(url) else { return url.to_string() };
    let needle = if old_host.contains(':') { format!("[{old_host}]") } else { old_host };
    match url.find(&needle) {
        Some(i) => format!("{}{}{}", &url[..i], new_host, &url[i + needle.len()..]),
        None => url.to_string(),
    }
}

/// 流式上传单个文件：先写 `.part` 再 rename（中断不留半截可执行文件）。
async fn upload(host: &HostId, dest: &str, bytes: &[u8], exec: bool) -> Result<(), String> {
    let q = sh_quote(dest);
    let chmod = if exec { format!(" && chmod +x {q}.part") } else { String::new() };
    let script = format!(
        "mkdir -p \"$(dirname {q})\" && cat > {q}.part{chmod} && mv -f {q}.part {q}"
    );
    run_script(host, &script, Some(bytes)).await.map(|_| ())
}

/// 下载到本机缓存 `~/.aide/cache/remote-kit/<name>`（命中缓存直接读）。候选 URL 依次尝试。
/// `progress`（已下字节, 总字节）：只在真去下载时回报，命中缓存不调。
async fn fetch_cached(
    name: &str,
    urls: Vec<String>,
    progress: &(dyn Fn(u64, Option<u64>) + Sync),
) -> Result<Vec<u8>, String> {
    let dir = crate::commands::our_config_dir().join("cache").join("remote-kit");
    let path = dir.join(name);
    // 下载在阻塞线程里跑，进度经通道回到这边（回调借着调用方的东西，进不了 'static 闭包）
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, Option<u64>)>();
    let task = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if let Ok(b) = std::fs::read(&path) {
            if !b.is_empty() {
                return Ok(b);
            }
        }
        let report = |done: u64, total: Option<u64>| {
            let _ = tx.send((done, total));
        };
        let save = |bytes: Vec<u8>| {
            let _ = std::fs::create_dir_all(&dir);
            write_atomic(&path, &bytes);
            bytes
        };
        // 第一轮：太慢的源直接放弃换下一个（官方源经代理 50KB/s、镜像 19MB/s 是实测过的差距，
        // 「没失败」不等于「能用」）；全都不行再回头把慢的那几个耐心下完——慢总比没有强。
        let mut errors = Vec::new();
        let mut slow = Vec::new();
        for url in &urls {
            match download(url, &report, true) {
                Ok(bytes) => return Ok(save(bytes)),
                Err(DownloadError::Slow) => slow.push(url),
                Err(DownloadError::Failed(e)) => errors.push(format!("{url}: {e}")),
            }
        }
        for url in slow {
            match download(url, &report, false) {
                Ok(bytes) => return Ok(save(bytes)),
                Err(e) => errors.push(format!("{url}: {e}")),
            }
        }
        Err(format!("下载远程套件失败：\n{}", errors.join("\n")))
    });
    // 发送端随闭包结束而释放，循环自然收尾
    while let Some((done, total)) = rx.recv().await {
        progress(done, total);
    }
    task.await.map_err(|e| e.to_string())?
}

enum DownloadError {
    /// 连得上但太慢（见 [`too_slow`]）：换个源可能快得多。
    Slow,
    Failed(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::Slow => f.write_str("下载过慢"),
            DownloadError::Failed(e) => f.write_str(e),
        }
    }
}

/// 起步这么久之后才评判快慢（握手、慢启动不算数）。
const SLOW_AFTER: Duration = Duration::from_secs(8);
/// 照当前速度还要这么久才下得完 = 太慢。
const SLOW_ETA: Duration = Duration::from_secs(180);
/// 总量未知时的最低可接受速度（字节 / 秒）。
const SLOW_SPEED: u64 = 300 * 1024;

/// 这个源是不是慢到该换一个：按「照现在的速度还要多久」判，不按绝对速度——小文件慢一点无所谓。
fn too_slow(done: u64, total: Option<u64>, elapsed: Duration) -> bool {
    if elapsed < SLOW_AFTER {
        return false;
    }
    let speed = done as f64 / elapsed.as_secs_f64();
    match total {
        Some(t) => t.saturating_sub(done) as f64 > speed * SLOW_ETA.as_secs_f64(),
        None => speed < SLOW_SPEED as f64,
    }
}

/// `progress`（已下字节, 总字节）：每多下 1%（总量未知时每 1MB）报一次。
/// `impatient`：太慢就以 [`DownloadError::Slow`] 放弃（调用方还有别的源可试时用）。
fn download(url: &str, progress: &dyn Fn(u64, Option<u64>), impatient: bool) -> Result<Vec<u8>, DownloadError> {
    let failed = |e: String| DownloadError::Failed(e);
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60));
    if let Some(proxy_url) = crate::commands::proxy::detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) {
            builder = builder.proxy(p);
        }
    }
    let resp = builder.build().get(url).call().map_err(|e| failed(e.to_string()))?;
    let started = std::time::Instant::now();
    let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok()).filter(|t| *t > 0);
    let step = total.map_or(1 << 20, |t| (t / 100).max(1));
    let mut reader = resp.into_reader();
    let mut buf = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut chunk = vec![0u8; 64 * 1024];
    let mut reported = 0u64;
    progress(0, total);
    loop {
        let n = std::io::Read::read(&mut reader, &mut chunk).map_err(|e| failed(e.to_string()))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        let done = buf.len() as u64;
        if impatient && too_slow(done, total, started.elapsed()) {
            return Err(DownloadError::Slow);
        }
        if done - reported >= step {
            reported = done;
            progress(done, total);
        }
    }
    if buf.len() < 1024 {
        return Err(failed(format!("响应过小（{} 字节），疑似错误页", buf.len())));
    }
    Ok(buf)
}

fn write_atomic(path: &Path, bytes: &[u8]) {
    let tmp = path.with_extension("part");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// 目标机 Host 进程给 sidecar 的环境：桌面上的工具开关原样带过去；桌面探测到的代理作
/// **兜底**（目标机登录环境里已有代理就用它自己的），回环地址按目标机网络改写。
pub struct HostEnv {
    pub env: HashMap<String, String>,
    pub default_env: HashMap<String, String>,
}

pub async fn host_env(host: &HostId, installed: &Installed) -> HostEnv {
    let env = tool_switches(|k| std::env::var(k).ok());
    // 桌面探测到的代理（设置 → 环境 → git → 常见本地端口）。
    let desktop_proxy = tokio::task::spawn_blocking(aide_core::proxy::detect_proxy)
        .await
        .ok()
        .flatten();
    let mut default_env = HashMap::new();
    if let Some(url) = desktop_proxy {
        if let Some((h, port)) = proxy_host_port(&url) {
            let target_url = if is_loopback_host(&h) {
                loopback_host_for(host, installed, port)
                    .await
                    .map(|lh| replace_proxy_host(&url, &lh))
            } else {
                Some(url.clone())
            };
            if let Some(u) = target_url {
                tracing::info!(host = %host, proxy = %u, "remote host: default proxy");
                for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                    default_env.insert(k.to_string(), u.clone());
                }
            }
        }
    }
    HostEnv {
        env,
        default_env,
    }
}

/// 桌面进程环境里的工具开关（`AIDE_LSP_TOOLS=off` 这类逃生舱）原样带到目标机。
///
/// 本机车道的 sidecar 继承桌面进程环境，开关天然生效；远程车道的 runtime 起在目标机上，
/// 环境只有随连接递过去的这些——不带过去，用户关掉的工具在 WSL / SSH 工作区里照样挂着
/// （2026-09-30 真机：设了 `AIDE_LSP_TOOLS=off` 的对照轮里 aide-lsp 仍在）。
const TOOL_SWITCHES: &[&str] = &[
    "AIDE_LSP_TOOLS",
    "AIDE_DOCX_TOOLS",
    "AIDE_KB_TOOLS",
    "AIDE_BROWSER_TOOLS",
];

fn tool_switches(get: impl Fn(&str) -> Option<String>) -> HashMap<String, String> {
    TOOL_SWITCHES
        .iter()
        .filter_map(|k| get(k).map(|v| (k.to_string(), v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_switches_travel_to_the_target() {
        let env = tool_switches(|k| (k == "AIDE_LSP_TOOLS").then(|| "off".to_string()));
        assert_eq!(env.len(), 1);
        assert_eq!(env["AIDE_LSP_TOOLS"], "off");
    }

    #[test]
    fn transfer_progress_text_and_ratio() {
        const MB: u64 = 1024 * 1024;
        assert_eq!(transfer_text("正在下载 X", 37 * MB, Some(107 * MB)), "正在下载 X（37 / 107 MB）");
        assert_eq!(transfer_text("正在下载 X", 3 * MB, None), "正在下载 X（3 MB）");
        assert_eq!(ratio(50, Some(200)), Some(0.25));
        assert_eq!(ratio(300, Some(200)), Some(1.0));
        assert_eq!(ratio(50, None), None);
        assert_eq!(ratio(50, Some(0)), None);
    }

    #[test]
    fn slow_sources_are_judged_by_time_remaining() {
        const MB: u64 = 1024 * 1024;
        let secs = Duration::from_secs;
        // 起步阶段不评判
        assert!(!too_slow(0, Some(115 * MB), secs(3)));
        // 2026-10-12 实测：官方源经代理 ~50KB/s，115MB 要半个多小时 → 换源
        assert!(too_slow(500 * 1024, Some(115 * MB), secs(10)));
        // 镜像 19MB/s：不换
        assert!(!too_slow(100 * MB, Some(115 * MB), secs(10)));
        // 小文件慢一点也很快下完：不换
        assert!(!too_slow(500 * 1024, Some(2 * MB), secs(10)));
        // 一个字节都没来
        assert!(too_slow(0, Some(115 * MB), secs(10)));
        // 总量未知：按最低速度判
        assert!(too_slow(MB, None, secs(10)));
        assert!(!too_slow(10 * MB, None, secs(10)));
    }

    #[test]
    fn probe_parsing() {
        let p = parse_probe(
            "motd noise\narch=x86_64\nhome=/home/u\nlibc=gnu\nhost=ok\nnode=/home/u/.nvm/bin/node\nnodever=v20.11.1\n",
        );
        assert_eq!(p.arch, "x86_64");
        assert_eq!(p.home, "/home/u");
        assert!(!p.musl && p.host_ok && !p.claude_ok);
        assert_eq!(p.node_major, Some(20));
        assert_eq!(p.node_path.as_deref(), Some("/home/u/.nvm/bin/node"));
        assert_eq!(p.gateway, None);
        assert_eq!(parse_probe("gateway=172.20.192.1\n").gateway.as_deref(), Some("172.20.192.1"));
    }

    #[test]
    fn proxy_url_parsing_and_rewrite() {
        assert_eq!(proxy_host_port("http://127.0.0.1:7890"), Some(("127.0.0.1".into(), 7890)));
        assert_eq!(proxy_host_port("socks5://u:p@[::1]:1080"), Some(("::1".into(), 1080)));
        assert_eq!(proxy_host_port("http://localhost"), Some(("localhost".into(), 80)));
        assert_eq!(
            replace_proxy_host("http://u:p@127.0.0.1:7890/", "172.20.192.1"),
            "http://u:p@172.20.192.1:7890/"
        );
        assert_eq!(replace_proxy_host("socks5://[::1]:1080", "10.0.0.1"), "socks5://10.0.0.1:1080");
        assert!(is_loopback_host("127.0.0.1") && is_loopback_host("LOCALHOST") && !is_loopback_host("10.0.0.1"));
    }

    #[test]
    fn sdk_version_is_pinned() {
        let v = sdk_version().unwrap();
        assert!(v.chars().next().unwrap().is_ascii_digit(), "{v}");
    }

    #[test]
    fn claude_package_names() {
        assert_eq!(claude_pkg(Plat::X64, false), "claude-agent-sdk-linux-x64");
        assert_eq!(claude_pkg(Plat::Arm64, true), "claude-agent-sdk-linux-arm64-musl");
    }
}
