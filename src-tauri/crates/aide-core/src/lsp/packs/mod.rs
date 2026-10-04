//! 语言包：在插件市场一键把语言服务器装到**当前 Host**（本机 / WSL / SSH 各装各的）。
//!
//! 设计见 docs/superpowers/specs/2026-10-04-lsp-language-packs-design.md。要点：
//! - 装在 `~/.aide/lsp/packs/<id>/`，每个目录一份 `pack.json` 记版本、来源与启动方式；
//! - 查找链里排在「用户手动配置」之后、「随包捆绑 / PATH」之前（`registry::resolve`）——
//!   装过语言包就不会再被 PATH 上的错误版本劫持（WSL 的 PATH 里常混着 Windows 版）；
//! - 目录（装什么、从哪装）是数据（`catalog.rs`），安装器与查找链对语言一无所知。

pub mod archive;
pub mod catalog;
pub mod fetch;
pub mod install;
pub mod node;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::lsp::detector::LanguageId;
use crate::registry::Command as HostCommand;
use crate::resources::HostResources;
use crate::{command, Core};

use catalog::{PackSpec, Recipe, CATALOG};

pub static COMMANDS: &[HostCommand] = &[
    command!("lsp_packs", lsp_packs),
    command!("lsp_pack_install", lsp_pack_install),
    command!("lsp_pack_uninstall", lsp_pack_uninstall),
];

const MANIFEST: &str = "pack.json";

pub fn packs_root() -> PathBuf {
    crate::paths::our_config_dir().join("lsp").join("packs")
}

/// 已装语言包的落盘记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub installed_at: String,
    /// 安装来源（给人看的）："npm" / "rustup 组件" / "GitHub Releases"。
    pub source: String,
    pub launch: Launch,
}

/// 启动方式。路径相对安装目录，`External` 是工具链装在别处的绝对路径。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launch {
    /// `node <script>`，node 每次启动时现找（见 `node::find`），不把路径写死在记录里。
    Node { script: String },
    Binary { path: String },
    External { path: String },
}

pub fn read_manifest(id: &str) -> Option<Manifest> {
    let body = std::fs::read(packs_root().join(id).join(MANIFEST)).ok()?;
    serde_json::from_slice(&body).ok()
}

/// 某语言已装语言包的启动命令 `(program, args)`（语言特有参数如 `--stdio` 由 profile 另加）。
/// 没装、或装了但启动物已经不在（node 被卸了、工具链被删了）= None，查找链继续往下走。
pub fn launch_for(lang: LanguageId, resources: &dyn HostResources) -> Option<(String, Vec<String>)> {
    let spec = catalog::for_lang(lang)?;
    let manifest = read_manifest(spec.id)?;
    let dir = packs_root().join(spec.id);
    match manifest.launch {
        Launch::Node { script } => {
            let script = dir.join(script);
            let node = node::find(resources)?;
            script.is_file().then(|| {
                (
                    node.to_string_lossy().into_owned(),
                    vec![dunce::simplified(&script).to_string_lossy().into_owned()],
                )
            })
        }
        Launch::Binary { path } => {
            let p = dir.join(path);
            p.is_file().then(|| (dunce::simplified(&p).to_string_lossy().into_owned(), vec![]))
        }
        Launch::External { path } => PathBuf::from(&path).is_file().then_some((path, vec![])),
    }
}

/// TypeScript 语言包自带的 typescript 模块目录（ts_sdk 的兜底档：项目里没装 typescript 时用它）。
pub fn bundled_typescript_module() -> Option<PathBuf> {
    let dir = packs_root().join("typescript").join("node_modules").join("typescript");
    dir.join("lib").join("tsserver.js").is_file().then_some(dir)
}

// ── 命令 ──

static INSTALLING: Lazy<Mutex<HashSet<&'static str>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn installing(id: &str) -> bool {
    INSTALLING.lock().map(|s| s.contains(id)).unwrap_or(false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackView {
    pub id: &'static str,
    pub name: &'static str,
    pub server: &'static str,
    pub summary: &'static str,
    /// 服务的语言（`LanguageId::id_str`，与「语言环境」面板、`lsp_detect_languages` 同一套键）。
    pub langs: Vec<&'static str>,
    /// 目录里的版本（装了且不同 = 有更新）。
    pub version: &'static str,
    /// 安装方式说明（卡片底部那行）。
    pub method: &'static str,
    pub installed: Option<InstalledView>,
    pub installing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledView {
    pub version: String,
    pub installed_at: String,
    pub source: String,
    pub update_available: bool,
}

fn method_of(spec: &PackSpec) -> &'static str {
    match &spec.recipe {
        Recipe::Npm { .. } => "从 npm 下载（官方源 / 国内镜像），校验 sha512；用本机 Node.js 运行，没有就自动下载一份",
        Recipe::Binary { toolchain: Some(_), .. } => "有 rustup 时安装官方组件，否则从 GitHub Releases 下载",
        Recipe::Binary { toolchain: None, .. } => "从 GitHub Releases 下载",
    }
}

fn view(spec: &'static PackSpec) -> PackView {
    let installed = read_manifest(spec.id).map(|m| InstalledView {
        update_available: m.version != spec.version,
        version: m.version,
        installed_at: m.installed_at,
        source: m.source,
    });
    PackView {
        id: spec.id,
        name: spec.name,
        server: spec.server,
        summary: spec.summary,
        langs: spec.langs.iter().map(|l| l.id_str()).collect(),
        version: spec.version,
        method: method_of(spec),
        installed,
        installing: installing(spec.id),
    }
}

#[derive(Deserialize)]
pub struct NoArgs {}

async fn lsp_packs(_core: Arc<Core>, _a: NoArgs) -> Result<Vec<PackView>, String> {
    // 读几个小 json：放进 blocking 池，不占 async worker
    tokio::task::spawn_blocking(|| CATALOG.iter().map(view).collect())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct PackIdArgs {
    id: String,
}

/// 换装前把这几门语言正在跑的 server 停掉：Windows 上运行中的二进制删不掉，
/// 且停掉后下一次请求会按新的查找链重启（换成刚装的语言包）。
async fn stop_servers(core: &Core, spec: &PackSpec) {
    let mgr = core.lsp.0.write().await;
    for lang in spec.langs {
        mgr.kill_lang(*lang).await;
    }
}

async fn lsp_pack_install(core: Arc<Core>, a: PackIdArgs) -> Result<PackView, String> {
    let spec = catalog::find(&a.id).ok_or_else(|| format!("没有这个语言包：{}", a.id))?;
    {
        let mut set = INSTALLING.lock().map_err(|e| e.to_string())?;
        if !set.insert(spec.id) {
            return Err(format!("{} 正在安装中", spec.name));
        }
    }
    stop_servers(&core, spec).await;
    let resources = Arc::clone(&core.resources);
    let result = tokio::task::spawn_blocking(move || install::install(spec, resources.as_ref()))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    if let Ok(mut set) = INSTALLING.lock() {
        set.remove(spec.id);
    }
    match result {
        Ok(m) => {
            tracing::info!(pack = spec.id, version = %m.version, source = %m.source, "[lsp-packs] installed");
            Ok(view(spec))
        }
        Err(e) => {
            tracing::warn!(pack = spec.id, error = %e, "[lsp-packs] install failed");
            Err(e)
        }
    }
}

async fn lsp_pack_uninstall(core: Arc<Core>, a: PackIdArgs) -> Result<PackView, String> {
    let spec = catalog::find(&a.id).ok_or_else(|| format!("没有这个语言包：{}", a.id))?;
    if installing(spec.id) {
        return Err(format!("{} 正在安装中", spec.name));
    }
    stop_servers(&core, spec).await;
    let dir = packs_root().join(spec.id);
    tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除失败：{e}")),
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(view(spec))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip_uses_tagged_launch() {
        let m = Manifest {
            id: "typescript".into(),
            version: "5.3.0".into(),
            installed_at: "2026-10-04T00:00:00Z".into(),
            source: "npm".into(),
            launch: Launch::Node { script: "node_modules/x/cli.mjs".into() },
        };
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["launch"]["kind"], "node");
        assert_eq!(json["installedAt"], "2026-10-04T00:00:00Z");
        let back: Manifest = serde_json::from_value(json).unwrap();
        assert_eq!(back.launch, m.launch);
    }

    #[test]
    fn every_pack_has_a_method_line() {
        for p in CATALOG {
            assert!(!method_of(p).is_empty());
            assert!(!view(p).langs.is_empty(), "{} 没有服务任何语言", p.id);
        }
    }

    /// 真机端到端：真下载、真校验、真解压，再把每个语言服务器起起来做一次 LSP 握手。
    /// 要联网、会下几十 MB，默认不跑：
    ///   HOME=$(mktemp -d) cargo test -p aide-core --lib packs::tests::e2e -- --ignored --nocapture
    /// （HOME 指到临时目录：别装进真正的 ~/.aide。）
    #[test]
    #[ignore]
    fn e2e_install_and_handshake_every_pack() {
        use std::io::{BufRead, BufReader, Read, Write};
        let res = crate::resources::NoResources;
        for spec in CATALOG {
            let m = install::install(spec, &res).unwrap_or_else(|e| panic!("{} 安装失败：{e}", spec.id));
            eprintln!("installed {} {} via {}", spec.id, m.version, m.source);
            let lang = spec.langs[0];
            let (program, args) = launch_for(lang, &res).unwrap_or_else(|| panic!("{} 装完却解析不到启动命令", spec.id));
            let (program, args) = crate::lsp::registry::to_command(lang, &crate::lsp::registry::ServerSource::Pack { program, args }, None);
            let mut child = std::process::Command::new(&program)
                .args(&args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap_or_else(|e| panic!("{} 起不来：{program} {args:?}: {e}", spec.id));
            let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#;
            write!(child.stdin.as_mut().unwrap(), "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            let mut out = BufReader::new(child.stdout.take().unwrap());
            // 服务器可能先发 window/logMessage 之类的通知，读到 id=1 的响应为止
            let reply = loop {
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    out.read_line(&mut line).unwrap();
                    if let Some(v) = line.trim().strip_prefix("Content-Length: ") {
                        len = v.parse().unwrap();
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                let mut buf = vec![0u8; len];
                out.read_exact(&mut buf).unwrap();
                let msg: serde_json::Value = serde_json::from_slice(&buf).unwrap();
                if msg["id"] == 1 {
                    break msg;
                }
            };
            assert!(reply["result"]["capabilities"].is_object(), "{} 握手没拿到 capabilities：{reply}", spec.id);
            eprintln!("  handshake ok: {}", reply["result"]["serverInfo"]);
            let _ = child.kill();
        }
    }
}
