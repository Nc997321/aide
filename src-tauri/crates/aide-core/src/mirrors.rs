//! 下载源与回退链：官方源优先，国内镜像兜底（同一份文件，路径同构）。
//!
//! 单一事实源：远程套件（桌面代装 WSL / SSH 目标机的 node 与 sidecar 依赖）与语言包安装器
//! （`lsp::packs`，在 Host 本机装语言服务器）都从这里取，新增镜像只改这一处。

/// npm registry 候选。tarball 路径与元数据路径在两者间同构。
pub const NPM_REGISTRIES: &[&str] = &["https://registry.npmjs.org", "https://registry.npmmirror.com"];

/// Node 发行包镜像（`<mirror>/<version>/node-<version>-<plat>.<ext>`）。
pub const NODE_MIRRORS: &[&str] = &["https://nodejs.org/dist", "https://npmmirror.com/mirrors/node"];

/// 目标机缺 node 时代下的版本（LTS）。
pub const NODE_VERSION: &str = "v22.12.0";

/// 能跑 sidecar 与 npm 系语言服务器的最低 node 主版本。
pub const NODE_MIN_MAJOR: u32 = 18;
