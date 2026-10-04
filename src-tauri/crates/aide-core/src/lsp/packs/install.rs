//! 安装器：按目录里的配方把语言服务器装进 `~/.aide/lsp/packs/<id>/`。同步实现，调用方放进 `spawn_blocking`。
//!
//! 原子性：先装进同级的临时目录，写好 `pack.json` 后整体换上；失败时临时目录删掉，旧安装原样保留。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::mirrors::NPM_REGISTRIES;
use crate::resources::HostResources;

use super::catalog::{platform_key, NpmPackage, PackSpec, Recipe, Release, Toolchain};
use super::{archive, fetch, node, Launch, Manifest};

pub fn install(spec: &PackSpec, resources: &dyn HostResources) -> Result<Manifest, String> {
    let root = super::packs_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("创建 {} 失败：{e}", root.display()))?;
    let staging = root.join(format!(".{}.staging-{}", spec.id, std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("创建临时目录失败：{e}"))?;

    let result = build(spec, resources, &staging).and_then(|(source, launch)| {
        let manifest = Manifest {
            id: spec.id.to_string(),
            version: spec.version.to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            source,
            launch,
        };
        let body = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        std::fs::write(staging.join(super::MANIFEST), body).map_err(|e| format!("写 pack.json 失败：{e}"))?;
        commit(&staging, &root.join(spec.id))?;
        Ok(manifest)
    });
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// 临时目录换上正式位置：旧目录先挪开再删（Windows 上不能直接覆盖非空目录）。
fn commit(staging: &Path, target: &Path) -> Result<(), String> {
    let old = target.with_extension(format!("old-{}", std::process::id()));
    if target.exists() {
        std::fs::rename(target, &old).map_err(|e| format!("替换旧版本失败（文件被占用？）：{e}"))?;
    }
    if let Err(e) = std::fs::rename(staging, target) {
        let _ = std::fs::rename(&old, target); // 回滚
        return Err(format!("安装失败：{e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// 返回 (安装来源说明, 启动方式)。
fn build(spec: &PackSpec, resources: &dyn HostResources, staging: &Path) -> Result<(String, Launch), String> {
    match &spec.recipe {
        Recipe::Npm { packages, script } => {
            // 先确认能跑：没有 node 就先装 node，免得包装好了却起不来
            node::ensure(resources)?;
            for pkg in *packages {
                install_npm_package(pkg, staging)?;
            }
            if !staging.join(script).is_file() {
                return Err(format!("安装包里缺入口脚本 {script}"));
            }
            Ok(("npm".into(), Launch::Node { script: script.to_string() }))
        }
        Recipe::Binary { toolchain, release } => {
            if let Some(tc) = toolchain {
                match via_toolchain(tc) {
                    Ok(Some(path)) => {
                        return Ok((
                            tc.label.to_string(),
                            Launch::External { path: path.to_string_lossy().into_owned() },
                        ))
                    }
                    Ok(None) => {} // 没有这个工具链，走发行包
                    Err(e) => tracing::warn!("[lsp-packs] {} via {} failed, falling back to release: {e}", spec.id, tc.program),
                }
            }
            let rel = download_release(release, staging)?;
            Ok(("GitHub Releases".into(), Launch::Binary { path: rel }))
        }
    }
}

fn install_npm_package(pkg: &NpmPackage, staging: &Path) -> Result<(), String> {
    let dest = staging.join("node_modules").join(pkg.name);
    let mut errors = Vec::new();
    for registry in NPM_REGISTRIES {
        match fetch_npm_tarball(registry, pkg) {
            Ok(bytes) => {
                let _ = std::fs::remove_dir_all(&dest);
                std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败：{e}"))?;
                return archive::untar_gz(&bytes, &dest, Some(()));
            }
            Err(e) => {
                tracing::warn!(registry, package = pkg.name, error = %e, "[lsp-packs] npm fetch failed");
                errors.push(format!("{registry}：{e}"));
            }
        }
    }
    Err(format!(
        "下载 {}@{} 失败（{}）。网络受限时请在设置里配置代理。",
        pkg.name,
        pkg.version,
        errors.join("；")
    ))
}

/// 取元数据里的 tarball 地址与 integrity，下载并校验。
fn fetch_npm_tarball(registry: &str, pkg: &NpmPackage) -> Result<Vec<u8>, String> {
    let meta_url = format!("{registry}/{}/{}", pkg.name.replace('/', "%2F"), pkg.version);
    let meta: serde_json::Value =
        serde_json::from_slice(&fetch::get(&meta_url)?).map_err(|e| format!("元数据不是 JSON：{e}"))?;
    let dist = &meta["dist"];
    let tarball = dist["tarball"].as_str().ok_or("元数据缺 dist.tarball")?;
    let integrity = dist["integrity"].as_str().ok_or("元数据缺 dist.integrity，无法校验，拒绝安装")?;
    let bytes = fetch::get(tarball)?;
    fetch::verify_sri(&bytes, integrity)?;
    Ok(bytes)
}

fn run(program: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.output().map_err(|e| format!("运行 {} 失败：{e}", program.display()))
}

/// 工具链装组件。工具链不存在 = Ok(None)；装了但失败 = Err（调用方退回发行包）。
fn via_toolchain(tc: &Toolchain) -> Result<Option<PathBuf>, String> {
    let Ok(program) = which::which(tc.program) else {
        return Ok(None);
    };
    let out = run(&program, tc.install_args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let out = run(&program, tc.locate_args)?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if out.status.success() && path.is_file() {
        Ok(Some(path))
    } else {
        Err(format!("{} 没有给出可用的路径", tc.program))
    }
}

/// 下载发行包，解出二进制到 `staging/bin/`。返回相对安装目录的路径。
fn download_release(release: &Release, staging: &Path) -> Result<String, String> {
    let key = platform_key();
    let asset = release
        .assets
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, a)| *a)
        .ok_or_else(|| format!("没有适用于 {key} 的发行包"))?;
    let url = release.url.replace("{asset}", asset);
    let bytes = fetch::get_first(&[url])?;
    let file = if cfg!(windows) {
        format!("{}.exe", release.binary)
    } else {
        release.binary.to_string()
    };
    let rel = format!("bin/{file}");
    let dest = staging.join("bin").join(&file);
    if asset.ends_with(".zip") {
        archive::unzip_one(&bytes, &file, &dest)?;
    } else {
        archive::gunzip_to(&bytes, &dest)?;
    }
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_replaces_existing_and_cleans_up() {
        let base = std::env::temp_dir().join(format!("aide-commit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let target = base.join("typescript");
        let staging = base.join(".typescript.staging");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("old.txt"), "old").unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("new.txt"), "new").unwrap();

        commit(&staging, &target).unwrap();
        assert!(target.join("new.txt").is_file());
        assert!(!target.join("old.txt").exists());
        assert!(!staging.exists());
        let leftovers: Vec<_> = std::fs::read_dir(&base).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "旧目录应已删除");
    }
}
