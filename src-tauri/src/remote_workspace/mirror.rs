//! 远程工作区的扩展镜像：插件、用户级 skills / agents / commands / hooks、全局 CLAUDE.md、
//! settings 里的 `mcpServers` / `hooks`——**桌面是唯一真相源**，目标机只有一份按内容哈希
//! 命名、只读、可随时删的缓存（`~/.aide/host/ext/<hash>/`）。
//!
//! 为什么不在每台服务器上各装一份：本机 + 多个远程工作区同时开是常态，逐台安装就是 N 份
//! 各自漂移的状态。这里把「安装」留在桌面，远程只做**投影**：每条 send 前把当前启用集合
//! 缺的单元补传过去，再把目标机路径随 send 递给那台机器上的 sidecar（`extensions` 字段）。
//!
//! 可靠性要点（逐条对应设计文档的风险表，docs/remote-workspaces.md「插件与用户扩展」）：
//! - **半截镜像**：每个单元一条 tar.gz 流，解到 `<hash>.part/` 写好 `.complete` 再整体 `mv`；
//!   探针只认带 `.complete` 的目录，断线重试就是重做 `.part`。
//! - **运行中的会话**：目录按内容哈希命名、永不原地修改；插件更新 = 新目录，旧会话用旧的。
//!   GC 只删当前集合之外、7 天没被刷新过的目录。
//! - **Windows → Linux 文件语义**：可执行位按「shebang / `.sh` / 被 hooks 或 .mcp.json 以
//!   `${CLAUDE_PLUGIN_ROOT}/…` 引用 / 本机本来就可执行」重建（NTFS 上没有 x 位）；**内容逐字节
//!   不改**（换行问题在安装端解决：插件检出关掉 autocrlf，见 marketplace/install.rs）。
//! - **机密**：只取扩展相关的东西，绝不整份搬 settings.json（其 `env` 块可能有 API Key）；
//!   settings 片段随 send 走 stdin，不落目标机磁盘；镜像根 `chmod 700`。
//! - **桌面专属的东西**：Windows 形态的命令、监听桌面回环的 MCP URL——不下发，进
//!   `unavailable` 如实告诉用户，不静默消失。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::install;
use super::path::HostId;

/// 用户级 claude home 里属于「扩展」的条目（桌面 sidecar 把整个 claude home 当无清单插件
/// `aide-user` 加载——远程只投影其中的扩展部分；transcripts / 凭据 / 记忆不在此列）。
const USER_ENTRIES: &[&str] = &[
    ".claude-plugin",
    "skills",
    "agents",
    "commands",
    "hooks",
    "output-styles",
    "CLAUDE.md",
];

/// 单个单元的体积上限：超过就不传、如实上报（防 `.git/objects` 这类误入的大目录）。
const MAX_UNIT_BYTES: u64 = 50 * 1024 * 1024;

/// 不进镜像的目录名（版本库元数据；插件运行不需要）。
const SKIP_DIRS: &[&str] = &[".git"];

/// 目标机上的镜像目录名长度（sha256 前缀，足够唯一）。
const HASH_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub enum UnitKind {
    Plugin,
    User,
}

#[derive(Debug, Clone)]
struct FileEntry {
    rel: String,
    abs: PathBuf,
    size: u64,
    mtime_ns: u128,
    /// 本机权限位说它可执行（仅 unix 桌面有意义；Windows 上恒 false）。
    native_exec: bool,
}

/// 一个同步单元（一个插件版本目录，或用户扩展整体）。
#[derive(Debug, Clone)]
pub struct Unit {
    pub label: String,
    pub kind: UnitKind,
    files: Vec<FileEntry>,
    pub hash: String,
}

/// 桌面侧算好的一次投影。
#[derive(Debug, Clone, Default)]
pub struct Bundle {
    pub units: Vec<Unit>,
    /// settings.json 里可下发的 `mcpServers` / `hooks`（已剔除桌面专属的条目）。
    pub settings: Value,
    /// 桌面侧就能判定「这台主机用不了」的条目，一条一句话。
    pub unavailable: Vec<String>,
}

// ── 桌面侧：收集 + 哈希 + 打包 ──

fn walk(root: &Path, dir: &Path, out: &mut Vec<FileEntry>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        let Ok(meta) = std::fs::metadata(&path) else { continue }; // 跟随文件符号链接
        let is_link = e.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        if meta.is_dir() {
            // 目录符号链接不跟（防环）；版本库元数据不要。
            if is_link || SKIP_DIRS.iter().any(|d| e.file_name() == *d) {
                continue;
            }
            walk(root, &path, out);
        } else if meta.is_file() {
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            out.push(FileEntry {
                rel,
                abs: path.clone(),
                size: meta.len(),
                mtime_ns: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos()),
                native_exec: native_exec(&meta),
            });
        }
    }
}

#[cfg(unix)]
fn native_exec(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn native_exec(_meta: &std::fs::Metadata) -> bool {
    false
}

/// hooks.json / .mcp.json 里以 `${CLAUDE_PLUGIN_ROOT}/…` 引用的相对路径（这些会被直接执行）。
fn referenced_scripts(text: &str) -> HashSet<String> {
    const VAR: &str = "${CLAUDE_PLUGIN_ROOT}/";
    let mut out = HashSet::new();
    let mut rest = text;
    while let Some(i) = rest.find(VAR) {
        rest = &rest[i + VAR.len()..];
        let end = rest
            .find(|c: char| c == '"' || c == '\'' || c == '\\' || c.is_whitespace())
            .unwrap_or(rest.len());
        if end > 0 {
            out.insert(rest[..end].to_string());
        }
    }
    out
}

/// 该文件在目标机上要不要 +x。
fn wants_exec(f: &FileEntry, head: &[u8], referenced: &HashSet<String>) -> bool {
    f.native_exec || head.starts_with(b"#!") || f.rel.ends_with(".sh") || referenced.contains(&f.rel)
}

fn referenced_in_unit(files: &[FileEntry]) -> HashSet<String> {
    files
        .iter()
        .filter(|f| f.rel == "hooks/hooks.json" || f.rel == ".mcp.json")
        .filter_map(|f| std::fs::read_to_string(&f.abs).ok())
        .flat_map(|t| referenced_scripts(&t))
        .collect()
}

/// 内容哈希：相对路径 + 可执行位 + 字节。按 (路径, 大小, mtime) 指纹缓存——每条 send 都要
/// 算一遍当前集合，未变化的单元不重读内容。
fn content_hash(files: &[FileEntry]) -> String {
    static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    let mut fp = Sha256::new();
    for f in files {
        fp.update(f.rel.as_bytes());
        fp.update([0]);
        fp.update(f.size.to_le_bytes());
        fp.update(f.mtime_ns.to_le_bytes());
        fp.update([f.native_exec as u8]);
    }
    let fp = hex(&fp.finalize());
    if let Some(h) = CACHE.lock().ok().and_then(|c| c.as_ref().and_then(|m| m.get(&fp).cloned())) {
        return h;
    }
    let referenced = referenced_in_unit(files);
    let mut h = Sha256::new();
    for f in files {
        let bytes = std::fs::read(&f.abs).unwrap_or_default();
        h.update(f.rel.as_bytes());
        h.update([0, wants_exec(f, &bytes[..bytes.len().min(2)], &referenced) as u8, 0]);
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    let out = hex(&h.finalize())[..HASH_LEN].to_string();
    if let Ok(mut c) = CACHE.lock() {
        let m = c.get_or_insert_with(HashMap::new);
        if m.len() > 512 {
            m.clear();
        }
        m.insert(fp, out.clone());
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn make_unit(label: String, kind: UnitKind, root: &Path, entries: Option<&[&str]>) -> Result<Unit, String> {
    let mut files = Vec::new();
    match entries {
        None => walk(root, root, &mut files),
        Some(names) => {
            for n in names {
                let p = root.join(n);
                if p.is_dir() {
                    walk(root, &p, &mut files);
                } else if p.is_file() {
                    walk_single(root, &p, &mut files);
                }
            }
        }
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let total: u64 = files.iter().map(|f| f.size).sum();
    if total > MAX_UNIT_BYTES {
        return Err(format!(
            "{label}: {} MB exceeds the {} MB limit for syncing to a remote workspace",
            total / (1024 * 1024),
            MAX_UNIT_BYTES / (1024 * 1024)
        ));
    }
    let hash = content_hash(&files);
    Ok(Unit { label, kind, files, hash })
}

fn walk_single(root: &Path, p: &Path, out: &mut Vec<FileEntry>) {
    let Ok(meta) = std::fs::metadata(p) else { return };
    let Ok(rel) = p.strip_prefix(root) else { return };
    out.push(FileEntry {
        rel: rel.to_string_lossy().replace('\\', "/"),
        abs: p.to_path_buf(),
        size: meta.len(),
        mtime_ns: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos()),
        native_exec: native_exec(&meta),
    });
}

/// 把单元打成确定性的 tar.gz（固定 mtime / 属主，权限只有 0644 / 0755 两种）。
pub fn pack(unit: &Unit) -> Result<Vec<u8>, String> {
    let referenced = referenced_in_unit(&unit.files);
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    for f in &unit.files {
        let bytes = std::fs::read(&f.abs).map_err(|e| format!("{}: {e}", f.abs.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(if wants_exec(f, &bytes[..bytes.len().min(2)], &referenced) { 0o755 } else { 0o644 });
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        tar.append_data(&mut header, &f.rel, bytes.as_slice())
            .map_err(|e| format!("pack {}: {e}", f.rel))?;
    }
    tar.into_inner()
        .and_then(|gz| gz.finish())
        .map_err(|e| format!("pack {}: {e}", unit.label))
}

/// 桌面当前的扩展集合（阻塞：遍历 + 读文件，调用方走 spawn_blocking）。
pub fn build_bundle(claude_home: &Path, manifest: &Path, host_label: &str) -> Bundle {
    let mut b = Bundle::default();
    #[derive(serde::Deserialize)]
    struct Entry {
        name: String,
        path: String,
    }
    let entries: Vec<Entry> = std::fs::read_to_string(manifest)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    for e in entries {
        let dir = PathBuf::from(&e.path);
        if !crate::commands::marketplace::is_plugin_dir(&dir) {
            continue;
        }
        match make_unit(format!("plugin `{}`", e.name), UnitKind::Plugin, &dir, None) {
            Ok(u) => b.units.push(u),
            Err(msg) => b.unavailable.push(msg),
        }
    }
    if claude_home.is_dir() {
        match make_unit("your skills, agents and commands".into(), UnitKind::User, claude_home, Some(USER_ENTRIES)) {
            Ok(u) if !u.files.is_empty() => b.units.push(u),
            Ok(_) => {}
            Err(msg) => b.unavailable.push(msg),
        }
    }
    let settings: Value = std::fs::read_to_string(claude_home.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    b.settings = portable_settings(&settings, host_label, &mut b.unavailable);
    b
}

// ── settings 的可下发子集 ──

/// 命令的第一个词（去引号）。
fn first_word(cmd: &str) -> String {
    let t = cmd.trim_start();
    if let Some(q) = t.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let rest = &t[1..];
        return rest.split(q).next().unwrap_or("").to_string();
    }
    t.split_whitespace().next().unwrap_or("").to_string()
}

/// 只能在 Windows 桌面上跑的命令（盘符路径 / UNC / .exe 这类 / cmd、powershell）。
pub fn windows_only_command(cmd: &str) -> bool {
    let w = first_word(cmd);
    let lw = w.to_ascii_lowercase();
    let bytes = w.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive
        || w.starts_with("\\\\")
        || [".exe", ".bat", ".cmd", ".ps1"].iter().any(|s| lw.ends_with(s))
        || ["cmd", "powershell", "pwsh"].contains(&lw.as_str())
}

/// URL 指向桌面回环（目标机上的 127.0.0.1 是它自己，不是桌面）。
fn loopback_url(url: &str) -> bool {
    install::proxy_host_port(url).is_some_and(|(h, _)| install::is_loopback_host(&h))
}

fn portable_settings(settings: &Value, host_label: &str, unavailable: &mut Vec<String>) -> Value {
    let mut out = Map::new();
    if let Some(servers) = settings.get("mcpServers").and_then(Value::as_object) {
        let mut kept = Map::new();
        for (name, cfg) in servers {
            if cfg.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if let Some(url) = cfg.get("url").and_then(Value::as_str) {
                if loopback_url(url) {
                    unavailable.push(format!(
                        "MCP server `{name}`: it listens on the desktop ({url}), which {host_label} cannot reach"
                    ));
                    continue;
                }
            }
            if let Some(cmd) = cfg.get("command").and_then(Value::as_str) {
                if windows_only_command(cmd) {
                    unavailable.push(format!(
                        "MCP server `{name}`: `{}` is a Windows command and cannot run on {host_label}",
                        first_word(cmd)
                    ));
                    continue;
                }
            }
            kept.insert(name.clone(), cfg.clone());
        }
        if !kept.is_empty() {
            out.insert("mcpServers".into(), Value::Object(kept));
        }
    }
    if let Some(events) = settings.get("hooks").and_then(Value::as_object) {
        let mut kept_events = Map::new();
        for (event, groups) in events {
            let Some(groups) = groups.as_array() else { continue };
            let mut kept_groups = Vec::new();
            for g in groups {
                let mut g = g.clone();
                if let Some(hooks) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                    hooks.retain(|h| {
                        let cmd = h.get("command").and_then(Value::as_str).unwrap_or("");
                        let drop = h.get("type").and_then(Value::as_str) == Some("command") && windows_only_command(cmd);
                        if drop {
                            unavailable.push(format!(
                                "{event} hook `{}`: Windows command, cannot run on {host_label}",
                                first_word(cmd)
                            ));
                        }
                        !drop
                    });
                    if hooks.is_empty() {
                        continue;
                    }
                }
                kept_groups.push(g);
            }
            if !kept_groups.is_empty() {
                kept_events.insert(event.clone(), Value::Array(kept_groups));
            }
        }
        if !kept_events.is_empty() {
            out.insert("hooks".into(), Value::Object(kept_events));
        }
    }
    Value::Object(out)
}

// ── 目标机侧：同步 ──

/// 已确认在某台主机上完整存在的单元哈希（避免每条 send 都探一次）。
#[derive(Default)]
pub struct HostMirror {
    present: HashSet<String>,
}

fn ext_dir(base: &str) -> String {
    format!("{base}/ext")
}

/// 把 bundle 投到目标机，返回随 send 下发的 `extensions` 值（目标机路径）。
/// **不失败**：传不上去的单元进 `unavailable`，会话照常发出。
pub async fn sync(host: &HostId, base: &str, bundle: Bundle, state: &mut HostMirror) -> Value {
    let Bundle { units, settings, mut unavailable } = bundle;
    let dir = ext_dir(base);
    let q = install_quote(&dir);
    if units.iter().any(|u| !state.present.contains(&u.hash)) {
        // 一次往返：建根（700）、列出已完整的单元、刷新当前集合的 mtime、GC。
        let keep: Vec<String> = units.iter().map(|u| install_quote(&u.hash)).collect();
        let script = format!(
            r#"umask 077; mkdir -p {q} && chmod 700 {q} && cd {q} || exit 1
for d in */; do d=${{d%/}}; [ -f "$d/.complete" ] && echo "have=$d"; done
touch -c {keep} 2>/dev/null
find . -mindepth 1 -maxdepth 1 -name '*.part' -mtime +1 -exec rm -rf {{}} + 2>/dev/null
find . -mindepth 1 -maxdepth 1 -type d -mtime +7 {not} -exec rm -rf {{}} + 2>/dev/null
true"#,
            keep = keep.join(" "),
            not = units
                .iter()
                .map(|u| format!("! -name {}", install_quote(&u.hash)))
                .collect::<Vec<_>>()
                .join(" "),
        );
        match install::run_script(host, &script, None).await {
            Ok(out) => {
                for l in out.lines() {
                    if let Some(h) = l.strip_prefix("have=") {
                        state.present.insert(h.trim().to_string());
                    }
                }
            }
            Err(e) => tracing::warn!(host = %host, error = %e, "extension mirror: probe failed"),
        }
        let to_upload: Vec<&Unit> = units.iter().filter(|u| !state.present.contains(&u.hash)).collect();
        for u in to_upload {
            match upload_unit(host, &dir, u).await {
                Ok(()) => {
                    state.present.insert(u.hash.clone());
                }
                Err(e) => {
                    tracing::warn!(host = %host, unit = %u.label, error = %e, "extension mirror: upload failed");
                    unavailable.push(format!("{}: could not be copied to {} ({e})", u.label, host.label()));
                }
            }
        }
    }
    let path_of = |u: &Unit| format!("{dir}/{}", u.hash);
    let plugins: Vec<Value> = units
        .iter()
        .filter(|u| u.kind == UnitKind::Plugin && state.present.contains(&u.hash))
        .map(|u| json!({ "path": path_of(u) }))
        .collect();
    let user_dir = units
        .iter()
        .find(|u| u.kind == UnitKind::User && state.present.contains(&u.hash))
        .map(path_of);
    json!({
        "plugins": plugins,
        "user_dir": user_dir,
        "settings": settings,
        "unavailable": unavailable,
    })
}

async fn upload_unit(host: &HostId, dir: &str, u: &Unit) -> Result<(), String> {
    let unit = u.clone();
    let tgz = tokio::task::spawn_blocking(move || pack(&unit))
        .await
        .map_err(|e| e.to_string())??;
    let d = install_quote(&format!("{dir}/{}", u.hash));
    let part = install_quote(&format!("{dir}/{}.part", u.hash));
    let script = format!(
        "umask 077; rm -rf {part} && mkdir -p {part} && tar -xzf - -C {part} && touch {part}/.complete && rm -rf {d} && mv {part} {d}"
    );
    tracing::info!(host = %host, unit = %u.label, bytes = tgz.len(), "extension mirror: uploading");
    install::run_script(host, &script, Some(&tgz)).await.map(|_| ())
}

fn install_quote(s: &str) -> String {
    super::launcher::sh_quote(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aide-mirror-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn plugin(root: &Path) {
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::write(root.join(".claude-plugin/plugin.json"), r#"{"name":"p"}"#).unwrap();
        std::fs::create_dir_all(root.join("hooks")).unwrap();
        std::fs::write(
            root.join("hooks/hooks.json"),
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" start"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(root.join("hooks/run-hook.cmd"), ": polyglot\n").unwrap();
        std::fs::write(root.join("hooks/session-start"), "#!/bin/bash\necho hi\n").unwrap();
        std::fs::write(root.join("README.md"), "# p\n").unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/objects/x"), "junk").unwrap();
    }

    fn modes(tgz: &[u8]) -> HashMap<String, u32> {
        let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(tgz));
        ar.entries()
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.path().unwrap().to_string_lossy().to_string(), e.header().mode().unwrap())
            })
            .collect()
    }

    /// NTFS 上没有 x 位：被 hooks 直接执行的脚本与 shebang 文件在目标机上必须可执行，其余 0644；
    /// `.git` 不进镜像。
    #[test]
    fn pack_restores_exec_bits_and_skips_git() {
        let root = tmp("pack");
        plugin(&root);
        let u = make_unit("p".into(), UnitKind::Plugin, &root, None).unwrap();
        let m = modes(&pack(&u).unwrap());
        assert_eq!(m["hooks/run-hook.cmd"], 0o755, "referenced by hooks.json");
        assert_eq!(m["hooks/session-start"], 0o755, "shebang");
        assert_eq!(m["README.md"], 0o644);
        assert!(!m.keys().any(|k| k.starts_with(".git/")), "{m:?}");
    }

    /// 同内容 → 同哈希（目录名稳定，第二次同步什么都不传）；内容变 → 新哈希（旧会话不受影响）。
    #[test]
    fn hash_is_content_addressed_and_pack_is_deterministic() {
        let root = tmp("hash");
        plugin(&root);
        let a = make_unit("p".into(), UnitKind::Plugin, &root, None).unwrap();
        let b = make_unit("p".into(), UnitKind::Plugin, &root, None).unwrap();
        assert_eq!(a.hash, b.hash);
        assert_eq!(pack(&a).unwrap(), pack(&b).unwrap());
        std::fs::write(root.join("README.md"), "# p v2\n").unwrap();
        let c = make_unit("p".into(), UnitKind::Plugin, &root, None).unwrap();
        assert_ne!(a.hash, c.hash);
    }

    /// 用户单元只取扩展条目：transcripts（projects/）与 settings.json 不进镜像。
    #[test]
    fn user_unit_takes_only_extension_entries() {
        let home = tmp("home");
        std::fs::create_dir_all(home.join("skills/s")).unwrap();
        std::fs::write(home.join("skills/s/SKILL.md"), "---\nname: s\n---\n").unwrap();
        std::fs::write(home.join("CLAUDE.md"), "be nice\n").unwrap();
        std::fs::write(home.join("settings.json"), r#"{"env":{"ANTHROPIC_API_KEY":"sk-secret"}}"#).unwrap();
        std::fs::create_dir_all(home.join("projects/x")).unwrap();
        std::fs::write(home.join("projects/x/t.jsonl"), "{}").unwrap();
        let b = build_bundle(&home, &home.join("missing.json"), "WSL");
        let user = b.units.iter().find(|u| u.kind == UnitKind::User).unwrap();
        let rels: Vec<&str> = user.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["CLAUDE.md", "skills/s/SKILL.md"]);
        assert!(!b.settings.to_string().contains("sk-secret"), "settings 只取 mcpServers / hooks");
    }

    /// 启用清单里的非插件目录（克隆残留）不同步。
    #[test]
    fn manifest_entries_without_plugin_json_are_skipped() {
        let root = tmp("manifest");
        let real = root.join("real");
        plugin(&real);
        let junk = root.join(".git/objects");
        std::fs::create_dir_all(&junk).unwrap();
        let manifest = root.join("enabled.json");
        std::fs::write(
            &manifest,
            serde_json::to_string(&json!([
                {"name": "real", "marketplace": "m", "path": real},
                {"name": ".git", "marketplace": "temp", "path": junk}
            ]))
            .unwrap(),
        )
        .unwrap();
        let b = build_bundle(&root.join("no-home"), &manifest, "WSL");
        assert_eq!(b.units.len(), 1);
        assert_eq!(b.units[0].label, "plugin `real`");
    }

    /// 桌面专属的 MCP / hook 不下发，而是如实进 unavailable。
    #[test]
    fn desktop_only_settings_are_reported_not_shipped() {
        let s = json!({
            "env": {"ANTHROPIC_API_KEY": "sk"},
            "mcpServers": {
                "fs": {"command": "npx", "args": ["-y", "@x/fs"]},
                "win": {"command": "C:\\tools\\srv.exe"},
                "ps": {"command": "powershell", "args": ["-File", "a.ps1"]},
                "local": {"type": "http", "url": "http://127.0.0.1:8080/mcp"},
                "cloud": {"type": "http", "url": "https://mcp.example.com"},
                "off": {"command": "npx", "disabled": true}
            },
            "hooks": {
                "Stop": [{"hooks": [
                    {"type": "command", "command": "powershell -c beep"},
                    {"type": "command", "command": "notify-send done"}
                ]}]
            }
        });
        let mut un = Vec::new();
        let out = portable_settings(&s, "WSL: Debian", &mut un);
        let names: Vec<&String> = out["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(names, vec!["cloud", "fs"]);
        assert_eq!(out["hooks"]["Stop"][0]["hooks"].as_array().unwrap().len(), 1);
        assert!(out.get("env").is_none());
        assert_eq!(un.len(), 4, "{un:?}");
        assert!(un.iter().any(|m| m.contains("`local`") && m.contains("127.0.0.1")));
    }

    #[test]
    fn windows_command_shapes() {
        assert!(windows_only_command("C:\\x\\y.exe --a"));
        assert!(windows_only_command("\"C:/Program Files/x/y\" a"));
        assert!(windows_only_command("cmd /c npx foo"));
        assert!(windows_only_command("run.bat"));
        assert!(!windows_only_command("npx -y foo"));
        assert!(!windows_only_command("/usr/bin/python3 x.py"));
    }
}
