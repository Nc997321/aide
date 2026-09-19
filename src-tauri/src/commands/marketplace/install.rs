use std::process::Command;
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::State;

use crate::commands::marketplace::sources::{parse_marketplace_json, RawSource};
use crate::commands::marketplace::{bundled, manifest, source_cache_dir, sources, PluginEntry};
use crate::settings::SettingsService;

// ── fetch_marketplace (async, source-aware) ──

#[tauri::command]
pub async fn fetch_marketplace(source_id: String) -> Result<Vec<PluginEntry>, String> {
    // async 命令不埋 trace_command（CLAUDE.md：async 的 spawn_blocking 任务不在主线程）
    tokio::task::spawn_blocking(move || -> Result<Vec<PluginEntry>, String> {
        let market_name = sources::default_market_name(&source_id)
            .unwrap_or(&source_id)
            .to_string();
        let cache = source_cache_dir(&source_id);
        // 克隆或拉取
        ensure_source_cache(&source_id)?;
        let mjson = cache.join(".claude-plugin").join("marketplace.json");
        let content = std::fs::read_to_string(&mjson)
            .or_else(|_| std::fs::read_to_string(cache.join("registry.json")))
            .or_else(|_| std::fs::read_to_string(cache.join("plugins.json")))
            .map_err(|e| format!("读 marketplace.json 失败: {e}"))?;
        let m = parse_marketplace_json(&content)?;
        let plugins = m
            .plugins
            .into_iter()
            .map(|raw| {
                let (avail, unsup) = manifest::classify_availability(&raw);
                let provides_lsp = manifest::provides_lsp(&raw);
                // version = 语义版本（marketplace.json 的 version 字段），仅显示用；sha-pinned 为空。
                // version_id = 安装身份（version 或 short_sha(sha)），与 install_git 落盘的版本目录名
                // 同源，供 hasUpdate 比对——sha 不暴露给用户。
                let version = raw.version.clone().unwrap_or_default();
                let version_id = raw
                    .version
                    .clone()
                    .unwrap_or_else(|| resolved_version_from_source(&raw.source));
                PluginEntry {
                    name: raw.name.clone(),
                    display_name: raw.display_name.clone().unwrap_or_else(|| raw.name.clone()),
                    description: raw.description.clone().unwrap_or_default(),
                    version,
                    version_id,
                    source_id: source_id.clone(),
                    market_name: market_name.clone(),
                    category: raw.category.clone().unwrap_or_default(),
                    homepage: raw.homepage.clone().unwrap_or_default(),
                    repository: raw.repository.clone().unwrap_or_default(),
                    availability: avail,
                    unsupported: unsup,
                    provides_lsp,
                    // 内置清单元数据（图标/精选）由 merge_bundled_metadata 后处理填入
                    icon: None,
                    is_featured: false,
                }
            })
            .collect();
        let mut plugins: Vec<PluginEntry> = plugins;
        bundled::merge_bundled_metadata(&mut plugins);
        Ok(plugins)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 确保市场源仓库已克隆到缓存目录（缺失则浅克隆）。启动期内置插件安装与
/// fetch_marketplace 共用；已存在时不 pull（启动路径不做网络慢操作，更新经 UI 刷新）。
pub(super) fn ensure_source_cache(source_id: &str) -> Result<(), String> {
    let cache = source_cache_dir(source_id);
    if cache.exists() {
        return Ok(());
    }
    let repo = sources::fixed_repo(source_id).ok_or("未知市场源")?;
    std::fs::create_dir_all(cache.parent().unwrap_or(&cache)).map_err(|e| e.to_string())?;
    let url = format!("https://github.com/{}.git", repo);
    git_clone(&url, &cache)
}

/// 已安装插件的版本身份（最新版本目录名）；未安装 → None。
pub(super) fn installed_version_id(market: &str, plugin: &str) -> Option<String> {
    latest_version_dir(&plugins_cache_root().join(market).join(plugin)).map(|p| {
        p.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    })
}

/// Resolve version from source (short sha if available; empty otherwise — full resolution at install).
pub(super) fn resolved_version_from_source(src: &Option<RawSource>) -> String {
    match src {
        Some(RawSource::Github { sha: Some(s), .. })
        | Some(RawSource::Url { sha: Some(s), .. })
        | Some(RawSource::GitSubdir { sha: Some(s), .. }) => short_sha(s),
        _ => String::new(),
    }
}
fn short_sha(s: &str) -> String {
    s.chars().take(12).collect()
}

/// Classify a git clone error and return a prefixed error string.
/// The prefix is a machine-readable code; the frontend maps it to
/// user-facing messages and actions.
pub(super) fn git_err(stderr: &str) -> String {
    let code = if stderr.contains("Could not connect")
        || stderr.contains("Failed to connect")
        || stderr.contains("Could not resolve")
    {
        "NETWORK_FAILURE"
    } else if stderr.contains("not found") || stderr.contains("remote: Repository") {
        "REPO_NOT_FOUND"
    } else if stderr.contains("timeout") || stderr.contains("timed out") {
        "TIMEOUT"
    } else {
        "UNKNOWN_ERROR"
    };
    format!("{}: {}", code, stderr.trim())
}

/// 浅克隆 git 仓库（带代理探测）。成功返回 Ok(())；git 进程非零退出或启动失败
/// 一律经 git_err 分类为结构化错误码（NETWORK_FAILURE/REPO_NOT_FOUND/TIMEOUT/...），
/// 供前端 ERROR_MAP 映射为可操作动作（如 REPO_NOT_FOUND → "切换市场源"）。
pub(super) fn git_clone(url: &str, target: &std::path::Path) -> Result<(), String> {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    // 代理作为 git 全局 -c 选项，必须置于子命令之前
    crate::commands::proxy::apply_git_proxy(&mut cmd);
    cmd.args(["clone", "--depth", "1"]).arg(url).arg(target);

    let out = cmd
        .output()
        .map_err(|e| format!("UNKNOWN_ERROR: git clone 启动失败: {e}"))?;
    if !out.status.success() {
        return Err(git_err(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

// ── Task 5: cache 三级目录安装 + 版本解析 + 刷新/更新/卸载 ──

/// 仅用于测试：断言 cache 三级目录布局。生产代码直接 `plugins_cache_root().join(market).join(plugin).join(version)`。
#[cfg(test)]
fn cache_install_path(
    plugins_root: &str,
    market: &str,
    plugin: &str,
    version: &str,
) -> std::path::PathBuf {
    std::path::PathBuf::from(plugins_root)
        .join("cache")
        .join(market)
        .join(plugin)
        .join(version)
}

pub(super) fn plugins_cache_root() -> std::path::PathBuf {
    crate::commands::marketplace::plugins_dir().join("cache")
}

/// 从已缓存的源 marketplace.json 里按 plugin 名查条目
pub(crate) fn lookup_entry(
    source_id: &str,
    plugin_name: &str,
) -> Result<
    (
        String,
        crate::commands::marketplace::sources::RawPluginEntry,
    ),
    String,
> {
    let cache = crate::commands::marketplace::source_cache_dir(source_id);
    let mjson = cache.join(".claude-plugin").join("marketplace.json");
    let content =
        std::fs::read_to_string(&mjson).map_err(|e| format!("源未拉取或读取失败: {e}"))?;
    let m = crate::commands::marketplace::sources::parse_marketplace_json(&content)?;
    let market_name = if m.name.is_empty() {
        crate::commands::marketplace::sources::default_market_name(source_id)
            .unwrap_or(source_id)
            .to_string()
    } else {
        m.name
    };
    let entry = m
        .plugins
        .into_iter()
        .find(|p| p.name == plugin_name)
        .ok_or("插件不在此源中".to_string())?;
    Ok((market_name, entry))
}

pub(super) fn read_marketplace_plugin_root(source_id: &str) -> Option<String> {
    let cache = crate::commands::marketplace::source_cache_dir(source_id);
    let mjson = cache.join(".claude-plugin").join("marketplace.json");
    let content = std::fs::read_to_string(&mjson).ok()?;
    let m = crate::commands::marketplace::sources::parse_marketplace_json(&content).ok()?;
    m.metadata.and_then(|md| md.plugin_root)
}

fn read_plugin_json_version(dir: &std::path::PathBuf) -> Option<String> {
    let p = dir.join(".claude-plugin").join("plugin.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    v["version"].as_str().map(String::from)
}

fn copy_dir_recursive(src: &std::path::PathBuf, dst: &std::path::PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|x| x.to_string())?.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|x| x.to_string())?;
        }
    }
    Ok(())
}

fn run_git(args: &[String], cwd: &std::path::Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(cwd);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    // 代理作为 git 全局 -c 选项，必须置于子命令之前；否则插件克隆/拉取直连
    // github 会挂死（spawn_blocking 阻塞 → 前端「点击更新没反应」）。
    crate::commands::proxy::apply_git_proxy(&mut cmd);
    cmd.args(args);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(git_err(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

/// git 源的版本锚点：分支/tag（ref）与精确提交（sha）。两者相邻同型
/// （Option<&str>）易错位，装箱成对象后签名只剩一个 anchor 参数。
#[derive(Clone, Copy)]
struct GitRef<'a> {
    r#ref: Option<&'a str>,
    sha: Option<&'a str>,
}

fn git_short_sha(dir: &std::path::Path) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["rev-parse", "--short", "HEAD"]).current_dir(dir);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn clone_ref_sha(url: &str, anchor: GitRef<'_>, target: &std::path::PathBuf) -> Result<(), String> {
    let mut a = vec!["clone".into(), "--depth".into(), "1".into()];
    if let Some(r) = anchor.r#ref {
        a.push("--branch".into());
        a.push(r.into());
    }
    a.push(url.into());
    a.push(target.to_string_lossy().to_string());
    // For clone, cwd doesn't matter since target path is absolute; use parent as cwd
    run_git(&a, target.parent().unwrap_or(std::path::Path::new(".")))?;
    if let Some(s) = anchor.sha {
        run_git(
            &[
                "fetch".into(),
                "--depth".into(),
                "1".into(),
                "origin".into(),
                s.into(),
            ],
            target,
        )?;
        run_git(&["checkout".into(), s.into()], target)?;
    }
    Ok(())
}

/// github / url 源通用：浅克隆（带 ref/sha）→ 解析最终版本 → 落 cache 版本目录
fn install_git(
    target_root: &std::path::PathBuf,
    url: &str,
    anchor: GitRef<'_>,
    version: String,
) -> Result<std::path::PathBuf, String> {
    let tmp = target_root.join(".__tmp__");
    let _ = std::fs::remove_dir_all(&tmp);
    clone_ref_sha(url, anchor, &tmp)?;
    let final_ver = if version.is_empty() {
        git_short_sha(&tmp).unwrap_or("unknown".into())
    } else {
        version
    };
    let target = target_root.join(&final_ver);
    if !target.exists() {
        // rename 失败（跨卷）回退到拷贝
        if std::fs::rename(&tmp, &target).is_err() {
            copy_dir_recursive(&tmp, &target)?;
            let _ = std::fs::remove_dir_all(&tmp);
        }
    } else {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    Ok(target)
}

fn clone_subdir(
    url: &str,
    anchor: GitRef<'_>,
    path: &str,
    target: &std::path::PathBuf,
) -> Result<(), String> {
    run_git(
        &[
            "clone".into(),
            "--filter=blob:none".into(),
            "--sparse".into(),
            "--no-checkout".into(),
            url.into(),
            target.to_string_lossy().to_string(),
        ],
        target.parent().unwrap_or(std::path::Path::new(".")),
    )?;
    run_git(
        &["sparse-checkout".into(), "set".into(), path.into()],
        target,
    )?;
    run_git(
        &["checkout".into(), anchor.r#ref.unwrap_or("HEAD").into()],
        target,
    )?;
    if let Some(s) = anchor.sha {
        run_git(
            &[
                "fetch".into(),
                "--depth".into(),
                "1".into(),
                "origin".into(),
                s.into(),
            ],
            target,
        )?;
        run_git(&["checkout".into(), s.into()], target)?;
    }
    Ok(())
}

/// marketplace.json 的内联组件物化：官方 LSP 插件在仓库里只有 LICENSE/README，
/// `lspServers` 与插件元数据以内联字段随清单走——安装拷贝的目录因此缺
/// `.claude-plugin/plugin.json`（harness 识别本地插件的清单）与 `.lsp.json`
/// （LSP 服务器配置），装出来是空壳、harness 起不了 LSP 工具。
/// 落盘后把「缺失的」内联形态补写成文件；已存在的文件一律不覆盖——源目录
/// 自带完整文件的插件不受影响，重装/更新幂等，且能就地修复旧的空壳安装。
fn materialize_inline_components(
    entry: &crate::commands::marketplace::sources::RawPluginEntry,
    target: &std::path::Path,
) -> Result<(), String> {
    let manifest_dir = target.join(".claude-plugin");
    let manifest_path = manifest_dir.join("plugin.json");
    if !manifest_path.exists() {
        let mut obj = serde_json::Map::new();
        obj.insert("name".into(), serde_json::json!(entry.name));
        if let Some(v) = entry.description.as_ref() {
            obj.insert("description".into(), serde_json::json!(v));
        }
        if let Some(v) = entry.version.as_ref() {
            obj.insert("version".into(), serde_json::json!(v));
        }
        if let Some(v) = entry.author.as_ref() {
            obj.insert("author".into(), v.clone());
        }
        if let Some(v) = entry.homepage.as_ref() {
            obj.insert("homepage".into(), serde_json::json!(v));
        }
        if let Some(v) = entry.repository.as_ref() {
            obj.insert("repository".into(), serde_json::json!(v));
        }
        std::fs::create_dir_all(&manifest_dir)
            .map_err(|e| format!("创建 .claude-plugin 失败: {e}"))?;
        let body = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
            .map_err(|e| format!("序列化 plugin.json 失败: {e}"))?;
        std::fs::write(&manifest_path, body).map_err(|e| format!("写 plugin.json 失败: {e}"))?;
    }
    if let Some(lsp) = entry.lsp_servers.as_ref() {
        let lsp_path = target.join(".lsp.json");
        if !lsp_path.exists() {
            let body = serde_json::to_string_pretty(lsp)
                .map_err(|e| format!("序列化 .lsp.json 失败: {e}"))?;
            std::fs::write(&lsp_path, body).map_err(|e| format!("写 .lsp.json 失败: {e}"))?;
        }
    }
    Ok(())
}

pub(super) fn resolve_and_install(
    source_id: &str,
    market: &str,
    plugin: &str,
    entry: &crate::commands::marketplace::sources::RawPluginEntry,
    plugin_root: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let src = entry.source.as_ref().ok_or("插件缺少 source")?;
    let version = entry.version.clone().unwrap_or_default();
    let target_root = plugins_cache_root().join(market).join(plugin);
    std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
    let target = match src {
        crate::commands::marketplace::sources::RawSource::Npm { .. } => {
            return Err("NPM_UNSUPPORTED: npm 源插件暂不支持安装".into());
        }
        crate::commands::marketplace::sources::RawSource::Unknown => {
            return Err("SOURCE_TYPE_UNSUPPORTED: 未知的插件源类型".into());
        }
        crate::commands::marketplace::sources::RawSource::Relative(rel) => {
            let rel = crate::commands::marketplace::sources::resolve_relative(rel, plugin_root);
            let from = crate::commands::marketplace::source_cache_dir(source_id)
                .join(rel.trim_start_matches("./"));
            let ver = if version.is_empty() {
                read_plugin_json_version(&from).unwrap_or_else(|| "local".into())
            } else {
                version
            };
            let target = target_root.join(&ver);
            if !target.exists() {
                copy_dir_recursive(&from, &target)?;
            }
            target
        }
        crate::commands::marketplace::sources::RawSource::Github { repo, r#ref, sha } => {
            let url = format!("https://github.com/{}.git", repo);
            let ver = if !version.is_empty() {
                version
            } else {
                sha.as_ref().map(|s| short_sha(s)).unwrap_or_default()
            };
            install_git(
                &target_root,
                &url,
                GitRef {
                    r#ref: r#ref.as_deref(),
                    sha: sha.as_deref(),
                },
                ver,
            )?
        }
        crate::commands::marketplace::sources::RawSource::Url { url, r#ref, sha } => {
            let ver = if !version.is_empty() {
                version
            } else {
                sha.as_ref().map(|s| short_sha(s)).unwrap_or_default()
            };
            install_git(
                &target_root,
                &url,
                GitRef {
                    r#ref: r#ref.as_deref(),
                    sha: sha.as_deref(),
                },
                ver,
            )?
        }
        crate::commands::marketplace::sources::RawSource::GitSubdir {
            url,
            path,
            r#ref,
            sha,
        } => {
            // 稀疏克隆后取子目录
            let tmp = target_root.join(".__tmp__");
            let _ = std::fs::remove_dir_all(&tmp);
            clone_subdir(
                url,
                GitRef {
                    r#ref: r#ref.as_deref(),
                    sha: sha.as_deref(),
                },
                path,
                &tmp,
            )?;
            let ver = if !version.is_empty() {
                version
            } else {
                sha.as_ref()
                    .map(|s| short_sha(s))
                    .unwrap_or_else(|| git_short_sha(&tmp).unwrap_or("unknown".into()))
            };
            let target = target_root.join(&ver);
            let from = tmp.join(path);
            if !target.exists() {
                copy_dir_recursive(&from, &target)?;
            }
            let _ = std::fs::remove_dir_all(&tmp);
            target
        }
    };
    // 内联组件物化（幂等）： Relative 臂对已存在的 target 也走到这里，
    // 旧的空壳安装因此可以被「再点一次安装/更新」就地修复。
    materialize_inline_components(entry, &target)?;
    Ok(target)
}

// ── 启用键读写 helpers ──
// 全部经 SettingsService 落到 settings.json 的 user-scope `settings` 子对象；
// 旧 config.json 路径（with_config_mut / load_config）迁移后已失效。

fn enabled_key(market: &str, plugin: &str) -> String {
    format!("{plugin}@{market}")
}

fn set_enabled_in_settings(service: &SettingsService, market: &str, plugin: &str, on: bool) {
    let key = enabled_key(market, plugin);
    let _ = crate::commands::marketplace::mutate_user_settings(service, |s| {
        let m = s.entry("enabledPlugins").or_insert(serde_json::json!({}));
        if on {
            m[&key] = serde_json::json!(true);
        } else {
            m[&key] = serde_json::json!(false);
        }
        Ok(())
    });
}

fn remove_enabled_in_settings(service: &SettingsService, market: &str, plugin: &str) {
    let key = enabled_key(market, plugin);
    let _ = crate::commands::marketplace::mutate_user_settings(service, |s| {
        if let Some(m) = s["enabledPlugins"].as_object_mut() {
            m.remove(&key);
        }
        Ok(())
    });
}

/// 扫 cache 最新版本 + 过滤 enabled=true → 写 enabled-plugins.json
fn rewrite_enabled_manifest(service: &SettingsService) -> Result<(), String> {
    crate::commands::marketplace::write_enabled_plugins_manifest(service)
}

fn read_manifest(path: &std::path::PathBuf) -> Option<(String, String, String, String)> {
    let p = path.join(".claude-plugin").join("plugin.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    let name = v["displayName"]
        .as_str()
        .or(v["name"].as_str())
        .unwrap_or("")
        .to_string();
    let desc = v["description"].as_str().unwrap_or("").to_string();
    let author = v["author"]
        .get("name")
        .and_then(|a| a.as_str())
        .or(v["author"].as_str())
        .unwrap_or("")
        .to_string();
    let ver = v["version"].as_str().unwrap_or("").to_string();
    Some((name, desc, author, ver))
}

/// Pick the newest-by-mtime version directory under a plugin's cache root,
/// skipping `.__tmp__`. (Not semver-aware; mtime is correct because install
/// always creates a fresh dir, so newest mtime == most-recently-installed.)
pub(crate) fn latest_version_dir(plugin_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut best: Option<(std::path::PathBuf, std::time::SystemTime)> = None;
    let Ok(entries) = std::fs::read_dir(plugin_root) else {
        return None;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() || e.file_name() == ".__tmp__" {
            continue;
        }
        let m = e.metadata().ok()?.modified().ok();
        match (&best, m) {
            (None, Some(mt)) => best = Some((p, mt)),
            (Some((_, bt)), Some(mt)) if mt > *bt => best = Some((p, mt)),
            _ => {}
        }
    }
    best.map(|(p, _)| p)
}

fn gc_old_versions(market: &str, plugin: &str) {
    // 保留最新版本，其余标记孤立；7 天后删除。简化：保留最新，超过 7 天的旧目录直接删。
    let root = plugins_cache_root().join(market).join(plugin);
    let Ok(vers) = std::fs::read_dir(&root) else {
        return;
    };
    let mut v: Vec<_> = vers
        .flatten()
        .filter(|e| e.path().is_dir() && e.file_name() != ".__tmp__")
        .collect();
    v.sort_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()));
    if v.len() <= 1 {
        return;
    }
    let keep = v.last().unwrap().path();
    for e in v {
        if e.path() == keep {
            continue;
        }
        let Ok(m) = e.metadata() else {
            continue;
        };
        let Ok(t) = m.modified() else {
            continue;
        };
        if t.elapsed().map(|d| d.as_secs() > 604800).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

// ── Async commands ──

#[tauri::command]
pub async fn install_plugin(
    source_id: String,
    plugin_name: String,
    service: State<'_, Arc<SettingsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        install_plugin_blocking(&service, &source_id, &plugin_name, None)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 安装插件（阻塞实现，UI 命令与启动期内置插件安装共用）。
/// `default_enabled_override`：内置清单首次安装时覆盖 marketplace.json 的
/// defaultEnabled；None = 按 marketplace 条目（无 → 默认启用）。
pub(crate) fn install_plugin_blocking(
    service: &SettingsService,
    source_id: &str,
    plugin_name: &str,
    default_enabled_override: Option<bool>,
) -> Result<(), String> {
    let (market, entry) = lookup_entry(source_id, plugin_name)?;
    let plugin_root = read_marketplace_plugin_root(source_id);
    let target = resolve_and_install(
        source_id,
        &market,
        plugin_name,
        &entry,
        plugin_root.as_deref(),
    )?;
    // 官方规则：plugin.json 可选，SDK 按目录布局自动发现组件，故不强制校验其存在。
    // 仅检查安装结果目录非空（ref/sha 错误会得到空目录）。
    if std::fs::read_dir(&target)
        .map(|mut i| i.next().is_none())
        .unwrap_or(true)
    {
        let _ = std::fs::remove_dir_all(&target);
        return Err("安装结果为空目录：插件源 ref/sha 可能无效".into());
    }
    // 默认启用状态：内置清单覆盖 > defaultEnabled（entry）> 无→true
    let enable = default_enabled_override
        .or(entry.default_enabled)
        .unwrap_or(true);
    set_enabled_in_settings(service, &market, plugin_name, enable);
    bundled::clear_tombstone(service, plugin_name, &market);
    rewrite_enabled_manifest(service)?;
    Ok(())
}

#[tauri::command]
pub async fn uninstall_plugin(
    marketplace: String,
    plugin_name: String,
    service: State<'_, Arc<SettingsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let root = plugins_cache_root().join(&marketplace).join(&plugin_name);
        if !root.exists() {
            return Err(format!("插件 '{}' 未找到", plugin_name));
        }
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        remove_enabled_in_settings(&service, &marketplace, &plugin_name);
        // 内置插件被显式卸载 → 记墓碑，启动时不再复活安装
        bundled::mark_uninstalled_if_bundled(&service, &plugin_name, &marketplace);
        rewrite_enabled_manifest(&service)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_marketplace(source_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let repo = crate::commands::marketplace::sources::fixed_repo(&source_id).ok_or("未知源")?;
        let cache = crate::commands::marketplace::source_cache_dir(&source_id);
        if cache.exists() {
            run_git(&["pull".into(), "--ff-only".into()], &cache)?;
        } else {
            std::fs::create_dir_all(cache.parent().unwrap_or(&cache)).map_err(|e| e.to_string())?;
            let url = format!("https://github.com/{}.git", repo);
            git_clone(&url, &cache)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_plugin(
    source_id: String,
    plugin_name: String,
    service: State<'_, Arc<SettingsService>>,
) -> Result<(), String> {
    // 更新 = 用最新条目重装到新版本目录；旧版本目录保留 7 天 GC
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let (market, entry) = lookup_entry(&source_id, &plugin_name)?;
        let plugin_root = read_marketplace_plugin_root(&source_id);
        resolve_and_install(
            &source_id,
            &market,
            &plugin_name,
            &entry,
            plugin_root.as_deref(),
        )?;
        gc_old_versions(&market, &plugin_name);
        rewrite_enabled_manifest(&service)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_installed_plugins(
    service: State<'_, Arc<SettingsService>>,
) -> Result<Vec<crate::commands::marketplace::InstalledPlugin>, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(
        move || -> Result<Vec<crate::commands::marketplace::InstalledPlugin>, String> {
            let settings = crate::commands::marketplace::read_user_settings(&service)?
                .unwrap_or_else(|| serde_json::json!({}));
            let enabled_map: std::collections::BTreeMap<String, bool> = settings
                .get("enabledPlugins")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b)))
                        .collect()
                })
                .unwrap_or_default();
            let root = plugins_cache_root();
            let mut out = Vec::new();
            let Ok(markets) = std::fs::read_dir(&root) else {
                return Ok(out);
            };
            for mk in markets.flatten() {
                let market = mk.file_name().to_string_lossy().to_string();
                let Ok(plugins) = std::fs::read_dir(mk.path()) else {
                    continue;
                };
                for p in plugins.flatten() {
                    let plugin = p.file_name().to_string_lossy().to_string();
                    let Some(latest) = latest_version_dir(&p.path()) else {
                        continue;
                    };
                    // version = plugin.json 语义版本（显示用）；version_id = 版本目录名
                    // （安装身份，hasUpdate 比对用）。两者分离：sha-pinned 插件的 plugin.json
                    // 语义版本 (如 "6.2.0") 与 marketplace short_sha (如 "44c9b2d6e889") 永不
                    // 相等，若用语义版本比对 hasUpdate 会永真、更新按钮永远亮且点击空操作；
                    // 而用 sha 比对正确，但 sha 对用户无意义，不能当版本号展示。
                    let version_id = latest
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let (display, desc, author, semver) = read_manifest(&latest).unwrap_or((
                        plugin.clone(),
                        String::new(),
                        String::new(),
                        String::new(),
                    ));
                    let key = format!("{plugin}@{market}");
                    let installed_at = std::fs::metadata(&latest)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    out.push(crate::commands::marketplace::InstalledPlugin {
                        name: plugin.clone(),
                        market: market.clone(),
                        version: semver,
                        version_id,
                        display_name: display,
                        description: desc,
                        author,
                        path: latest.to_string_lossy().to_string(),
                        installed_at,
                        enabled: super::plugin_enabled(&enabled_map, &key),
                    });
                }
            }
            Ok(out)
        },
    )
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn cache_path_layout() {
        let p = cache_install_path(
            "/home/u/.claude/plugins",
            "claude-plugins-official",
            "github",
            "1.2.0",
        );
        assert_eq!(
            p,
            PathBuf::from("/home/u/.claude/plugins/cache/claude-plugins-official/github/1.2.0")
        );
    }

    #[test]
    fn relative_source_resolved_with_plugin_root() {
        assert_eq!(
            crate::commands::marketplace::sources::resolve_relative(
                "agent-sdk-dev",
                Some("./plugins")
            ),
            "./plugins/agent-sdk-dev"
        );
    }
}

/// 内联组件物化（官方 LSP 插件是「仓库里只有 LICENSE/README、配置内联在
/// marketplace.json」的形态）——空壳回归与幂等保护。
#[cfg(test)]
mod materialize_inline_tests {
    use super::*;
    use crate::commands::marketplace::sources::RawPluginEntry;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "aide-mat-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|t| t.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn lsp_entry() -> RawPluginEntry {
        // author/homepage/repository 照官方 marketplace.json 实况带值（rust-analyzer-lsp
        // 条目即带 author 对象）——带值臂是真实生产路径，不允许 0 覆盖。
        RawPluginEntry {
            name: "rust-analyzer-lsp".into(),
            description: Some("Rust language server".into()),
            version: Some("1.0.0".into()),
            author: Some(serde_json::json!({
                "name": "Anthropic",
                "email": "support@anthropic.com"
            })),
            homepage: Some("https://github.com/anthropics/claude-plugins-official".into()),
            repository: Some("https://github.com/anthropics/claude-plugins-official".into()),
            lsp_servers: Some(serde_json::json!({
                "rust-analyzer": {
                    "command": "rust-analyzer",
                    "extensionToLanguage": { ".rs": "rust" }
                }
            })),
            ..RawPluginEntry::default()
        }
    }

    #[test]
    fn inline_lsp_and_manifest_materialized() {
        let target = scratch("fresh");
        std::fs::write(target.join("LICENSE"), "x").unwrap();
        materialize_inline_components(&lsp_entry(), &target).unwrap();
        let lsp: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(target.join(".lsp.json")).unwrap())
                .unwrap();
        assert_eq!(lsp["rust-analyzer"]["command"], "rust-analyzer");
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(target.join(".claude-plugin").join("plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "rust-analyzer-lsp");
        assert_eq!(manifest["version"], "1.0.0");
        // author 对象形态原样落盘（双形态解析兼容的另一半）
        assert_eq!(manifest["author"]["name"], "Anthropic");
        assert_eq!(manifest["author"]["email"], "support@anthropic.com");
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn existing_files_not_overwritten() {
        let target = scratch("keep");
        std::fs::create_dir_all(target.join(".claude-plugin")).unwrap();
        std::fs::write(target.join(".lsp.json"), r#"{ "own": true }"#).unwrap();
        std::fs::write(
            target.join(".claude-plugin").join("plugin.json"),
            r#"{ "name": "own" }"#,
        )
        .unwrap();
        materialize_inline_components(&lsp_entry(), &target).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join(".lsp.json")).unwrap(),
            r#"{ "own": true }"#
        );
        assert_eq!(
            std::fs::read_to_string(target.join(".claude-plugin").join("plugin.json")).unwrap(),
            r#"{ "name": "own" }"#
        );
        std::fs::remove_dir_all(&target).unwrap();
    }

    /// 错误臂：`.claude-plugin` 被文件占用 → create_dir_all 失败，错误带上下文上传。
    /// 其余 4 个错误闭包（两次序列化 + 两次写文件）需 FS 故障注入（盘满/权限），
    /// 不可移植，对账表中标注「未实测·错误臂」。
    #[test]
    fn manifest_dir_conflict_returns_error() {
        let target = scratch("err");
        std::fs::write(target.join(".claude-plugin"), "占位为文件而非目录").unwrap();
        let result = materialize_inline_components(&lsp_entry(), &target);
        assert!(result.is_err(), "目录被文件占用时应报错");
        assert!(result.unwrap_err().contains("创建 .claude-plugin 失败"));
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn no_lsp_servers_no_lsp_file() {
        let target = scratch("nolsp");
        let entry = RawPluginEntry {
            name: "plain".into(),
            ..RawPluginEntry::default()
        };
        materialize_inline_components(&entry, &target).unwrap();
        assert!(!target.join(".lsp.json").exists());
        assert!(target.join(".claude-plugin").join("plugin.json").exists());
        std::fs::remove_dir_all(&target).unwrap();
    }
}
