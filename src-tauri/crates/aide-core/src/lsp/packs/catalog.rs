//! 语言包目录：每个语言包「装什么、从哪装、装好后怎么启动」的**数据**。
//!
//! 新增一个语言 = 在 [`CATALOG`] 加一条，安装器（`install.rs`）与查找链（`registry`）零改动。
//! 版本一律钉死：语言包是可复现的安装物，不跟 `latest` 漂——升级 = 改这里的版本号发版，
//! 已装的用户在市场里看到「有更新」。

use crate::lsp::detector::LanguageId;

pub struct PackSpec {
    /// 语言包 id（安装目录名、IPC 参数、前端键）。
    pub id: &'static str,
    /// 卡片标题。
    pub name: &'static str,
    /// 语言服务器名（卡片副标题、「语言环境」面板的 server 列）。
    pub server: &'static str,
    /// 一句话介绍。
    pub summary: &'static str,
    /// 它服务哪些语言（`LanguageId::from_ext` 的归属，不是扩展名）。
    pub langs: &'static [LanguageId],
    /// 给用户看的版本；也是「有更新」的比对键（与已装 `pack.json` 的 version 不同 = 有更新）。
    pub version: &'static str,
    pub recipe: Recipe,
}

pub enum Recipe {
    /// npm 包直装：从 registry 取 tarball（校验 sha512 integrity）解进 `node_modules/<name>`，
    /// 用 Host 上的 node 跑 `script`。**不调用 npm**——这几个包都没有必需的运行时依赖，
    /// 直取 tarball 免掉「目标机得有 npm」与 npm 自己的配置/缓存副作用。
    Npm {
        packages: &'static [NpmPackage],
        /// 入口脚本，相对安装目录。
        script: &'static str,
    },
    /// 原生二进制：有工具链就走工具链（官方渠道、复用用户的镜像配置），否则下发行包。
    Binary {
        toolchain: Option<Toolchain>,
        release: Release,
    },
}

pub struct NpmPackage {
    pub name: &'static str,
    pub version: &'static str,
}

/// 工具链安装：`program install_args` 装组件，`program locate_args` 打印装好的二进制路径。
pub struct Toolchain {
    pub program: &'static str,
    pub install_args: &'static [&'static str],
    pub locate_args: &'static [&'static str],
    /// 卡片上说明安装来源用。
    pub label: &'static str,
}

/// 发行包下载：`url` 里的 `{asset}` 换成当前平台的资产名。
pub struct Release {
    pub url: &'static str,
    /// 解出来的可执行文件名（不含 `.exe`）。
    pub binary: &'static str,
    /// (平台键, 资产名)。平台键见 [`platform_key`]；`.gz` = 单文件 gzip，`.zip` = 含该文件的 zip。
    pub assets: &'static [(&'static str, &'static str)],
}

/// 当前 Host 的平台键：`<os>-<arch>`，与 [`Release::assets`] 对照。
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

pub static CATALOG: &[PackSpec] = &[
    PackSpec {
        id: "typescript",
        name: "TypeScript / JavaScript",
        server: "typescript-language-server",
        summary: "为 .ts / .tsx / .js / .jsx 提供跳转、引用、调用层级、悬停类型与诊断。自带 TypeScript 5.9，项目里没装 typescript 也能用。",
        langs: &[LanguageId::TypeScript, LanguageId::JavaScript],
        version: "5.3.0",
        recipe: Recipe::Npm {
            packages: &[
                NpmPackage { name: "typescript-language-server", version: "5.3.0" },
                // tsserver 运行时：项目自己没装 typescript 时用这份（ts_sdk 的兜底档）。
                // 钉 5.x：全局常见的 7.x 是 Go 重写版，没有 lib/tsserver.js。
                NpmPackage { name: "typescript", version: "5.9.3" },
            ],
            script: "node_modules/typescript-language-server/lib/cli.mjs",
        },
    },
    PackSpec {
        id: "python",
        name: "Python",
        server: "pyright",
        summary: "为 .py 提供跳转、引用、调用层级、悬停类型与诊断。",
        langs: &[LanguageId::Python],
        version: "1.1.414",
        recipe: Recipe::Npm {
            packages: &[NpmPackage { name: "pyright", version: "1.1.414" }],
            script: "node_modules/pyright/langserver.index.js",
        },
    },
    PackSpec {
        id: "rust",
        name: "Rust",
        server: "rust-analyzer",
        summary: "为 .rs 提供跳转、引用、调用层级、悬停类型与诊断。装了 rustup 时通过 rustup 安装官方组件。",
        langs: &[LanguageId::Rust],
        version: "2026-09-28",
        recipe: Recipe::Binary {
            toolchain: Some(Toolchain {
                program: "rustup",
                install_args: &["component", "add", "rust-analyzer"],
                locate_args: &["which", "rust-analyzer"],
                label: "rustup 组件",
            }),
            release: Release {
                url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/{asset}",
                binary: "rust-analyzer",
                assets: &[
                    ("linux-x64", "rust-analyzer-x86_64-unknown-linux-gnu.gz"),
                    ("linux-arm64", "rust-analyzer-aarch64-unknown-linux-gnu.gz"),
                    ("darwin-x64", "rust-analyzer-x86_64-apple-darwin.gz"),
                    ("darwin-arm64", "rust-analyzer-aarch64-apple-darwin.gz"),
                    ("windows-x64", "rust-analyzer-x86_64-pc-windows-msvc.zip"),
                    ("windows-arm64", "rust-analyzer-aarch64-pc-windows-msvc.zip"),
                ],
            },
        },
    },
];

pub fn find(id: &str) -> Option<&'static PackSpec> {
    CATALOG.iter().find(|p| p.id == id)
}

/// 服务该语言的语言包。
pub fn for_lang(lang: LanguageId) -> Option<&'static PackSpec> {
    CATALOG.iter().find(|p| p.langs.contains(&lang))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_unique_and_each_lang_has_one_pack() {
        let mut ids: Vec<_> = CATALOG.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "语言包 id 重复");
        let mut langs: Vec<_> = CATALOG.iter().flat_map(|p| p.langs.iter().map(|l| l.id_str())).collect();
        let n = langs.len();
        langs.sort();
        langs.dedup();
        assert_eq!(langs.len(), n, "同一门语言被两个语言包认领，查找链会二义");
    }

    #[test]
    fn release_assets_cover_mainstream_platforms() {
        for p in CATALOG {
            if let Recipe::Binary { release, .. } = &p.recipe {
                assert!(release.url.contains("{asset}"), "{}: url 缺 {{asset}}", p.id);
                for key in ["linux-x64", "darwin-arm64", "windows-x64"] {
                    assert!(release.assets.iter().any(|(k, _)| *k == key), "{} 缺 {key} 资产", p.id);
                }
                for (_, asset) in release.assets {
                    assert!(asset.ends_with(".gz") || asset.ends_with(".zip"), "{asset}: 只认 .gz / .zip");
                }
            }
        }
    }

    #[test]
    fn platform_key_shape() {
        let k = platform_key();
        assert!(k.contains('-'), "{k}");
        assert!(!k.starts_with("macos"), "macOS 归一成 darwin: {k}");
    }
}
