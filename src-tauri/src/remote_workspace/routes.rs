//! IPC 拦截层：所有前端 invoke 在进入 Tauri 命令前经过 [`intercept`]。
//!
//! 规则（按命令名查表，表外命令零开销放行）：
//! 1. **转发**：参数里的路径（或工作区根）属于远程主机的工作区命令 → 路径译成目标机
//!    路径，交给 aide-host 执行同一份实现，结果里的绝对路径译回桌面形态。
//! 2. **拒绝**：会在本机起进程去操作工作区的命令（LSP / 代码索引 / 运行配置…）遇到远程
//!    路径 → 明确报错。它们若回落本机，就是「用 Windows 的工具链跑 Linux 上的项目」——
//!    跑错机器，且不报错。
//! 3. 其它命令放行：把路径当**数据**存的（注册表 / 信任 / 会话元数据 / 最近文件）本来就
//!    该在桌面执行；WSL 路径是真实 UNC，本机能力（资源管理器、默认程序打开）天然可用。
//!
//! 新增一个「按路径操作工作区文件」的命令时：aide-workspace 实现 → aide-host 分派 →
//! 这里登记路径参数。三处缺一，远程工作区里它就会走规则 3 回落本机。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{AppHandle, Manager, Wry};

use super::path::{self, HostId};
use super::RemoteWorkspaces;
use crate::commands::WorkspaceState;

/// 参数里哪些键是路径（桌面形态），以及结果里哪些位置要译回。
struct FsRoute {
    cmd: &'static str,
    path_args: &'static [&'static str],
    result: ResultMap,
}

#[derive(Clone, Copy)]
enum ResultMap {
    None,
    /// 数组元素的 `path` 字段（list_directory）
    EntriesPath,
    /// 字符串数组（find_files_by_name）
    StringList,
    /// `{"$bytes": b64}` → 原始字节（read_file_binary）
    Bytes,
    /// 对象的 `root` 字段（get_project_info：前端拿它当文件树根）
    ProjectRoot,
}

const FS_ROUTES: &[FsRoute] = &[
    FsRoute { cmd: "list_directory", path_args: &["path"], result: ResultMap::EntriesPath },
    FsRoute { cmd: "read_file_content", path_args: &["path"], result: ResultMap::None },
    FsRoute { cmd: "read_file_base64", path_args: &["path"], result: ResultMap::None },
    FsRoute { cmd: "read_file_binary", path_args: &["path"], result: ResultMap::Bytes },
    FsRoute { cmd: "write_file_content", path_args: &["path"], result: ResultMap::None },
    FsRoute { cmd: "delete_file", path_args: &["path"], result: ResultMap::None },
    FsRoute { cmd: "file_exists", path_args: &["path"], result: ResultMap::None },
    FsRoute { cmd: "create_file", path_args: &["parentPath"], result: ResultMap::None },
    FsRoute { cmd: "create_dir", path_args: &["parentPath"], result: ResultMap::None },
    FsRoute { cmd: "copy_file", path_args: &["src", "dest"], result: ResultMap::None },
    FsRoute { cmd: "move_file", path_args: &["src", "dest"], result: ResultMap::None },
    FsRoute { cmd: "grep_symbol", path_args: &["cwd"], result: ResultMap::None },
    FsRoute { cmd: "find_files_by_name", path_args: &["cwd"], result: ResultMap::StringList },
    FsRoute { cmd: "search_in_files", path_args: &["cwd"], result: ResultMap::None },
    FsRoute { cmd: "replace_in_files_preview", path_args: &["cwd"], result: ResultMap::None },
];

/// 会在本机起进程/建索引去操作工作区的命令：远程路径一律拒绝（规则 2）。
/// `lsp_` 不在此列：LspManager 对远程工作区经 `aide-host lsp` 在**目标机**上起服务器
/// （`lsp::manager::spawn_remote`），文件访问走 `lsp::workspace_access`——不会回落本机。
const DENY_PREFIXES: &[&str] = &["codegraph_", "run_process_", "memory_observatory_", "memory_index_"];
const DENY_EXACT: &[&str] = &[
    "detect_run_command",
    "detect_run_targets",
    "list_run_configs",
    "save_run_configs",
    "workspace_get_jdk",
    "workspace_set_jdk",
];
/// 本机外壳能力：WSL 的 UNC 路径 Windows 原生可用；SSH 的不行（规则 2 的特例）。
const LOCAL_SHELL: &[&str] = &["file_open", "show_in_explorer"];

/// 入口。返回 `Some(invoke)` = 不归我管，交给 Tauri 命令；`None` = 已接管并应答。
pub fn intercept(invoke: Invoke<Wry>) -> Option<Invoke<Wry>> {
    let cmd = invoke.message.command().to_string();
    if !is_candidate(&cmd) {
        return Some(invoke);
    }
    let args = match invoke.message.payload() {
        InvokeBody::Json(v) => v.clone(),
        InvokeBody::Raw(_) => return Some(invoke),
    };
    let app = invoke.message.webview().app_handle().clone();
    match plan(&app, &cmd, &args) {
        Plan::PassThrough => Some(invoke),
        Plan::Reject(msg) => {
            invoke.resolver.reject(msg);
            None
        }
        Plan::Forward(fwd) => {
            let app = app.clone();
            invoke
                .resolver
                .respond_async_serialized(async move {
                    forward(app, fwd).await.map_err(|e| InvokeError::from(Value::String(e)))
                });
            None
        }
    }
}

fn is_candidate(cmd: &str) -> bool {
    FS_ROUTES.iter().any(|r| r.cmd == cmd)
        || cmd.starts_with("git_")
        || matches!(cmd, "get_project_info" | "path_types" | "apply_replacements" | "file_tree_watch")
        || DENY_PREFIXES.iter().any(|p| cmd.starts_with(p))
        || DENY_EXACT.contains(&cmd)
        || LOCAL_SHELL.contains(&cmd)
}

enum Plan {
    PassThrough,
    Reject(String),
    Forward(Forward),
}

enum ForwardKind {
    Invoke { cmd: String, root: Option<String>, result: ResultMap },
    PathTypes { order: Vec<Option<usize>>, local: Vec<String> },
    Watch { root: Option<(HostId, String)> },
}

struct Forward {
    host: Option<HostId>,
    args: Value,
    kind: ForwardKind,
}

fn plan(app: &AppHandle, cmd: &str, args: &Value) -> Plan {
    if let Some(route) = FS_ROUTES.iter().find(|r| r.cmd == cmd) {
        return plan_fs(cmd, route, args);
    }
    if cmd.starts_with("git_") || cmd == "get_project_info" {
        return plan_rooted(app, cmd, args);
    }
    match cmd {
        "path_types" => plan_path_types(args),
        "apply_replacements" => plan_apply(args),
        "file_tree_watch" => {
            let root = args.get("root").and_then(Value::as_str).unwrap_or("");
            // 本机根也要经过这里：切回本机工作区时得把远程主机上的表停掉
            Plan::Forward(Forward {
                host: None,
                args: args.clone(),
                kind: ForwardKind::Watch { root: path::parse(root) },
            })
        }
        _ if LOCAL_SHELL.contains(&cmd) => match first_remote(args) {
            Some((HostId::Ssh(_), _)) => {
                Plan::Reject("SSH 远程工作区里的文件无法用本机程序打开".to_string())
            }
            _ => Plan::PassThrough,
        },
        _ => match first_remote(args) {
            Some((host, _)) => Plan::Reject(format!(
                "远程工作区（{}）暂不支持该功能（{cmd}）",
                host.label()
            )),
            None => Plan::PassThrough,
        },
    }
}

fn plan_fs(cmd: &str, route: &FsRoute, args: &Value) -> Plan {
    let mut hosts: Vec<Option<HostId>> = Vec::new();
    let mut translated = args.clone();
    for key in route.path_args {
        let Some(p) = args.get(*key).and_then(Value::as_str) else {
            hosts.push(None);
            continue;
        };
        match path::parse(p) {
            Some((h, posix)) => {
                translated[*key] = Value::String(posix);
                hosts.push(Some(h));
            }
            None => hosts.push(None),
        }
    }
    let remote: Vec<&HostId> = hosts.iter().flatten().collect();
    if remote.is_empty() {
        return Plan::PassThrough;
    }
    let all_same_remote = hosts.iter().all(|h| h.as_ref() == Some(remote[0]));
    if !all_same_remote {
        // 跨机复制/移动：WSL ↔ 本机走 UNC 由 Windows 原生完成（同一份文件）；SSH 做不到
        if remote.iter().all(|h| matches!(h, HostId::Wsl(_))) && remote.len() == 1 {
            return Plan::PassThrough;
        }
        return Plan::Reject(format!("{cmd}：暂不支持跨主机操作"));
    }
    Plan::Forward(Forward {
        host: Some(remote[0].clone()),
        args: translated,
        kind: ForwardKind::Invoke { cmd: cmd.to_string(), root: None, result: route.result },
    })
}

/// git_* / get_project_info：根 = `cwd` 参数（会话所属工作区）→ 活动工作区。
fn plan_rooted(app: &AppHandle, cmd: &str, args: &Value) -> Plan {
    let explicit = args
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .map(String::from);
    let root = explicit.or_else(|| {
        app.try_state::<WorkspaceState>().and_then(|ws| {
            ws.path
                .lock()
                .ok()
                .and_then(|p| p.as_ref().map(|p| p.to_string_lossy().into_owned()))
        })
    });
    let Some((host, posix)) = root.as_deref().and_then(path::parse) else {
        return Plan::PassThrough;
    };
    if !aide_host::commands::is_supported(cmd) {
        return Plan::Reject(format!("远程工作区（{}）暂不支持 {cmd}", host.label()));
    }
    let mut a = args.clone();
    if let Some(o) = a.as_object_mut() {
        o.remove("cwd");
    }
    Plan::Forward(Forward {
        host: Some(host),
        args: a,
        kind: ForwardKind::Invoke {
            cmd: cmd.to_string(),
            root: Some(posix),
            result: if cmd == "get_project_info" { ResultMap::ProjectRoot } else { ResultMap::None },
        },
    })
}

/// path_types：候选路径可能混着本机与远程（@ 补全）。按主机分组，远程组转发，本机组就地算。
fn plan_path_types(args: &Value) -> Plan {
    let paths: Vec<String> = args
        .get("paths")
        .and_then(|p| serde_json::from_value(p.clone()).ok())
        .unwrap_or_default();
    let mut host: Option<HostId> = None;
    let mut remote: Vec<String> = Vec::new();
    let mut local: Vec<String> = Vec::new();
    let mut order: Vec<Option<usize>> = Vec::new(); // Some(i) = remote[i]，None = 顺取 local
    for p in &paths {
        match path::parse(p) {
            Some((h, posix)) if host.as_ref().is_none_or(|x| x == &h) => {
                host = Some(h);
                order.push(Some(remote.len()));
                remote.push(posix);
            }
            // 其它主机的路径：按不存在处理（一次补全不会跨两台远程机）
            Some(_) => {
                order.push(None);
                local.push(String::new());
            }
            None => {
                order.push(None);
                local.push(p.clone());
            }
        }
    }
    let Some(host) = host else {
        return Plan::PassThrough;
    };
    Plan::Forward(Forward {
        host: Some(host),
        args: json!({ "paths": remote }),
        kind: ForwardKind::PathTypes { order, local },
    })
}

fn plan_apply(args: &Value) -> Plan {
    let Some(files) = args.get("files").and_then(Value::as_array) else {
        return Plan::PassThrough;
    };
    let mut host: Option<HostId> = None;
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let p = f.get("path").and_then(Value::as_str).unwrap_or("");
        match (path::parse(p), &host) {
            (None, None) if out.is_empty() => return Plan::PassThrough,
            (Some((h, posix)), None) if out.is_empty() => {
                host = Some(h);
                let mut f = f.clone();
                f["path"] = Value::String(posix);
                out.push(f);
            }
            (Some((h, posix)), Some(cur)) if &h == cur => {
                let mut f = f.clone();
                f["path"] = Value::String(posix);
                out.push(f);
            }
            _ => return Plan::Reject("apply_replacements：暂不支持跨主机批量替换".to_string()),
        }
    }
    Plan::Forward(Forward {
        host,
        args: json!({ "files": out }),
        kind: ForwardKind::Invoke { cmd: "apply_replacements".into(), root: None, result: ResultMap::None },
    })
}

/// 参数里（递归）第一个远程路径。
fn first_remote(v: &Value) -> Option<(HostId, String)> {
    match v {
        Value::String(s) => path::parse(s),
        Value::Array(a) => a.iter().find_map(first_remote),
        Value::Object(o) => o.values().find_map(first_remote),
        _ => None,
    }
}

async fn forward(app: AppHandle, fwd: Forward) -> Result<InvokeResponseBody, String> {
    let svc = app
        .try_state::<Arc<RemoteWorkspaces>>()
        .ok_or("remote workspaces not initialised")?
        .inner()
        .clone();
    match fwd.kind {
        ForwardKind::Watch { root } => {
            // 本机表：远程根 → 停；本机根 → 交给本机服务
            let local_root = match &root {
                Some(_) => None,
                None => fwd
                    .args
                    .get("root")
                    .and_then(Value::as_str)
                    .filter(|r| !r.is_empty())
                    .map(std::path::PathBuf::from),
            };
            if let Some(local) = app.try_state::<Arc<crate::filewatch::FileWatchService>>() {
                let local = local.inner().clone();
                let app2 = app.clone();
                tokio::task::spawn_blocking(move || {
                    crate::filewatch::retarget_local(&local, local_root.as_deref(), &app2)
                })
                .await
                .map_err(|e| e.to_string())??;
            }
            svc.retarget_watch(root).await?;
            json_body(&Value::Null)
        }
        ForwardKind::Invoke { cmd, root, result } => {
            let host = fwd.host.ok_or("no host")?;
            let conn = svc.connection(&host).await?;
            let v = conn.invoke(&cmd, fwd.args, root).await?;
            map_result(&host, result, v)
        }
        ForwardKind::PathTypes { order, local } => {
            let host = fwd.host.ok_or("no host")?;
            let conn = svc.connection(&host).await?;
            let remote: Vec<String> =
                serde_json::from_value(conn.invoke("path_types", fwd.args, None).await?)
                    .map_err(|e| e.to_string())?;
            let local_types = tokio::task::spawn_blocking(move || {
                local
                    .iter()
                    .map(|p| if p.is_empty() { "none".to_string() } else { aide_workspace::fs_ops::path_types(std::slice::from_ref(p)).remove(0) })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|e| e.to_string())?;
            let mut li = local_types.into_iter();
            let merged: Vec<String> = order
                .into_iter()
                .map(|o| match o {
                    Some(i) => remote.get(i).cloned().unwrap_or_else(|| "none".into()),
                    None => li.next().unwrap_or_else(|| "none".into()),
                })
                .collect();
            json_body(&json!(merged))
        }
    }
}

fn map_result(host: &HostId, map: ResultMap, mut v: Value) -> Result<InvokeResponseBody, String> {
    match map {
        ResultMap::None => {}
        ResultMap::EntriesPath => {
            if let Some(arr) = v.as_array_mut() {
                for e in arr {
                    if let Some(p) = e.get("path").and_then(Value::as_str) {
                        e["path"] = Value::String(path::to_desktop(host, p));
                    }
                }
            }
        }
        ResultMap::StringList => {
            if let Some(arr) = v.as_array_mut() {
                for e in arr {
                    if let Some(p) = e.as_str() {
                        *e = Value::String(path::to_desktop(host, p));
                    }
                }
            }
        }
        ResultMap::ProjectRoot => {
            if let Some(r) = v.get("root").and_then(Value::as_str) {
                v["root"] = Value::String(path::to_desktop(host, r));
            }
        }
        ResultMap::Bytes => {
            use base64::Engine;
            let b64 = v
                .get(aide_host::protocol::BYTES_KEY)
                .and_then(Value::as_str)
                .ok_or("read_file_binary: malformed remote result")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| e.to_string())?;
            return Ok(InvokeResponseBody::Raw(bytes));
        }
    }
    json_body(&v)
}

fn json_body(v: &Value) -> Result<InvokeResponseBody, String> {
    serde_json::to_string(v)
        .map(InvokeResponseBody::Json)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl(p: &str) -> String {
        format!("\\\\wsl.localhost\\Debian{}", p.replace('/', "\\"))
    }

    #[test]
    fn local_fs_passes_through() {
        let r = FS_ROUTES.iter().find(|r| r.cmd == "read_file_content").unwrap();
        assert!(matches!(plan_fs("read_file_content", r, &json!({"path": "C:\\a.txt"})), Plan::PassThrough));
    }

    #[test]
    fn remote_fs_is_translated() {
        let r = FS_ROUTES.iter().find(|r| r.cmd == "copy_file").unwrap();
        let Plan::Forward(f) = plan_fs("copy_file", r, &json!({"src": wsl("/a/x"), "dest": wsl("/a/y")})) else {
            panic!("expected forward");
        };
        assert_eq!(f.args, json!({"src": "/a/x", "dest": "/a/y"}));
        assert_eq!(f.host, Some(HostId::Wsl("Debian".into())));
    }

    #[test]
    fn wsl_local_copy_uses_native_unc() {
        let r = FS_ROUTES.iter().find(|r| r.cmd == "copy_file").unwrap();
        assert!(matches!(
            plan_fs("copy_file", r, &json!({"src": "C:\\x", "dest": wsl("/a/x")})),
            Plan::PassThrough
        ));
    }

    #[test]
    fn ssh_cross_host_copy_rejected() {
        let r = FS_ROUTES.iter().find(|r| r.cmd == "copy_file").unwrap();
        assert!(matches!(
            plan_fs("copy_file", r, &json!({"src": "C:\\x", "dest": "\\\\aide-ssh.invalid\\box\\a"})),
            Plan::Reject(_)
        ));
    }

    #[test]
    fn every_fs_route_is_supported_by_host() {
        for r in FS_ROUTES {
            assert!(aide_host::commands::is_supported(r.cmd), "{} not in aide-host", r.cmd);
        }
        assert!(aide_host::commands::is_supported("path_types"));
        assert!(aide_host::commands::is_supported("apply_replacements"));
    }

    #[test]
    fn path_types_partitions_and_merges_order() {
        let Plan::Forward(f) = plan_path_types(&json!({"paths": ["C:\\a", wsl("/b"), "C:\\c", wsl("/d")]})) else {
            panic!()
        };
        assert_eq!(f.args, json!({"paths": ["/b", "/d"]}));
        let ForwardKind::PathTypes { order, local } = f.kind else { panic!() };
        assert_eq!(order, vec![None, Some(0), None, Some(1)]);
        assert_eq!(local, vec!["C:\\a", "C:\\c"]);
    }

    #[test]
    fn first_remote_finds_nested() {
        let v = json!({"a": {"b": [1, wsl("/x")]}});
        assert_eq!(first_remote(&v).unwrap().1, "/x");
    }

    #[test]
    fn list_directory_result_mapped_back() {
        let host = HostId::Wsl("Debian".into());
        let body = map_result(&host, ResultMap::EntriesPath, json!([{"name":"a","path":"/h/a","is_dir":true}])).unwrap();
        let InvokeResponseBody::Json(s) = body else { panic!() };
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v[0]["path"], json!(wsl("/h/a")));
    }
}
