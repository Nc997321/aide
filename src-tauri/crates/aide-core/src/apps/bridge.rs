//! 桥：应用界面经 `app_call` 能调到的全部方法。**权限检查只在这一处**——GUI 只是管道，
//! 把界面的调用原样转过来（同 `aide-link` 暴露目录的 `prepare` 只在一处）。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::servers::ServerPool;
use super::store::{self, Located, Roots};
use super::{net, wsfs};
use crate::settings::SecretStore;

/// 一个应用的 KV 总大小上限。
const MAX_STORAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_KEY_CHARS: usize = 256;
const MAX_LOG_CHARS: usize = 4000;

/// 桥要用到的 Host 能力（测试里换成内存实现）。
pub struct Ctx<'a> {
    pub roots: &'a Roots,
    pub secrets: &'a dyn SecretStore,
    pub servers: &'a ServerPool,
    /// 找到跑后端用的 Node；找不到就如实报错。
    pub node: &'a dyn Fn() -> Result<PathBuf, String>,
}

/// 调一个方法要满足什么。
#[derive(Clone, Copy, Debug, PartialEq)]
enum Need {
    Nothing,
    /// 清单里申请了这项权限。
    Permission(&'static str),
    /// `net` 或某个 `net:<主机>`；具体到哪台主机由 [`net::fetch`] 再判。
    Net,
    /// 清单里写了 `server`。
    Server,
}

/// 方法 → 要求。**没列在这里的方法一律拒绝。**
/// 屏幕上的事（主题、通知、角标、往输入框填字、会话事件）不在这里：那些由 GUI 自己答。
const METHODS: &[(&str, Need)] = &[
    ("host.info", Need::Nothing),
    ("log.write", Need::Nothing),
    ("storage.get", Need::Permission("storage")),
    ("storage.set", Need::Permission("storage")),
    ("storage.delete", Need::Permission("storage")),
    ("storage.keys", Need::Permission("storage")),
    ("secrets.get", Need::Permission("secrets")),
    ("secrets.set", Need::Permission("secrets")),
    ("secrets.delete", Need::Permission("secrets")),
    ("net.fetch", Need::Net),
    ("fs.read", Need::Permission("workspace:read")),
    ("fs.list", Need::Permission("workspace:read")),
    ("fs.write", Need::Permission("workspace:write")),
    ("tools.list", Need::Server),
    ("tools.call", Need::Server),
];

/// 同一进程内串行化 KV 的读改写（两个面板同时写不丢更新）。
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

pub fn call(ctx: &Ctx, id: &str, method: &str, params: &Value) -> Result<Value, String> {
    let roots = ctx.roots;
    let app = store::locate(roots, id)?;
    app.usable(roots)?;
    let Some(&(_, need)) = METHODS.iter().find(|(name, _)| *name == method) else {
        return Err(format!("没有这个方法：{method}"));
    };
    match need {
        Need::Nothing => {}
        Need::Permission(permission) if !app.manifest.has_permission(permission) => {
            return Err(format!("应用「{id}」没有申请权限「{permission}」，不能调用 {method}"));
        }
        Need::Net if !app.manifest.permissions.iter().any(|p| p == "net" || p.starts_with("net:")) => {
            return Err(format!("应用「{id}」没有申请权限「net」，不能调用 {method}"));
        }
        Need::Server if app.manifest.server.is_none() => {
            return Err(format!("应用「{id}」的清单里没有 server，不能调用 {method}"));
        }
        _ => {}
    }
    let workspace = roots.workspace_root.as_deref();
    match method {
        "host.info" => Ok(json!({ "os": std::env::consts::OS, "source": app.source })),
        "log.write" => {
            let level = params.get("level").and_then(Value::as_str).unwrap_or("error");
            let text: String = params.get("text").and_then(Value::as_str).unwrap_or("").chars().take(MAX_LOG_CHARS).collect();
            app.dev_log(&format!("ui {level}: {text}"));
            Ok(Value::Null)
        }
        "storage.get" => storage(roots, id, |kv| Ok((kv.get(key(params)?).cloned().unwrap_or(Value::Null), false))),
        "storage.keys" => storage(roots, id, |kv| Ok((json!(kv.keys().collect::<Vec<_>>()), false))),
        "storage.delete" => storage(roots, id, |kv| {
            kv.remove(key(params)?);
            Ok((Value::Null, true))
        }),
        "storage.set" => storage(roots, id, |kv| {
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            kv.insert(key(params)?.to_string(), value);
            Ok((Value::Null, true))
        }),
        "secrets.get" => ctx.secrets.get(&secret_key(id, params)?).map(|v| json!(v)).map_err(|e| e.to_string()),
        "secrets.delete" => ctx.secrets.delete(&secret_key(id, params)?).map(|_| Value::Null).map_err(|e| e.to_string()),
        "secrets.set" => {
            let value = params.get("value").and_then(Value::as_str).ok_or("secrets.set 的 value 必须是字符串")?;
            ctx.secrets.set(&secret_key(id, params)?, value).map(|_| Value::Null).map_err(|e| e.to_string())
        }
        "net.fetch" => net::fetch(&app.manifest, params),
        "fs.read" => wsfs::read(workspace, params),
        "fs.list" => wsfs::list(workspace, params),
        "fs.write" => wsfs::write(workspace, params),
        "tools.list" => backend(ctx, &app, "tools/list", json!({})),
        "tools.call" => {
            let name = params.get("name").and_then(Value::as_str).ok_or("tools.call 需要 name")?;
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            backend(ctx, &app, "tools/call", json!({ "name": name, "arguments": arguments }))
        }
        _ => Err(format!("没有这个方法：{method}")),
    }
}

/// 调应用自己的后端；它的 stderr 与失败原因顺手记进开发日志。
fn backend(ctx: &Ctx, app: &Located, method: &str, params: Value) -> Result<Value, String> {
    let node = (ctx.node)()?;
    let spec = app.server_spec(ctx.roots, &node).ok_or("清单里没有 server")?;
    let _ = fs::create_dir_all(ctx.roots.data_dir(&app.manifest.id));
    let result = ctx.servers.request(&spec, method, params);
    for line in ctx.servers.take_stderr(&app.manifest.id) {
        app.dev_log(&format!("server: {line}"));
    }
    if let Err(e) = &result {
        app.dev_log(&format!("server {method} failed: {e}"));
    }
    result
}

/// 密钥在 Host 密钥库里的键：按应用隔开，应用只说得出自己名下的。
fn secret_key(id: &str, params: &Value) -> Result<String, String> {
    match params.get("key").and_then(Value::as_str) {
        Some(k) if !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) => {
            Ok(format!("app/{id}/{k}"))
        }
        _ => Err("密钥的 key 只能用字母、数字、点、下划线、连字符，最长 64".into()),
    }
}

fn key(params: &Value) -> Result<&str, String> {
    match params.get("key").and_then(Value::as_str) {
        Some(k) if !k.is_empty() && k.chars().count() <= MAX_KEY_CHARS => Ok(k),
        _ => Err(format!("key 必须是 1–{MAX_KEY_CHARS} 个字符的字符串")),
    }
}

/// 读出 KV，交给 `f`；`f` 说改过了就落盘（超上限则拒绝、磁盘上保持原样）。
fn storage(
    roots: &Roots,
    id: &str,
    f: impl FnOnce(&mut BTreeMap<String, Value>) -> Result<(Value, bool), String>,
) -> Result<Value, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = roots.data_dir(id);
    let path = dir.join("kv.json");
    let mut kv: BTreeMap<String, Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let (result, changed) = f(&mut kv)?;
    if changed {
        let text = serde_json::to_string(&kv).map_err(|e| e.to_string())?;
        if text.len() > MAX_STORAGE_BYTES {
            return Err(format!("应用存储超过 {} MB 上限", MAX_STORAGE_BYTES / 1024 / 1024));
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        store::write_atomic(&path, text.as_bytes())?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::store::tests::{temp_roots, write_app};
    use crate::settings::MemorySecretStore;

    /// 用内存密钥库、空的后端池跑一次调用。
    fn call(roots: &Roots, id: &str, method: &str, params: &Value) -> Result<Value, String> {
        thread_local! { static SECRETS: MemorySecretStore = MemorySecretStore::default(); }
        let servers = ServerPool::default();
        SECRETS.with(|secrets| {
            let ctx = Ctx { roots, secrets, servers: &servers, node: &|| Err("这台机器上没有 Node".into()) };
            super::call(&ctx, id, method, params)
        })
    }

    fn consented(tag: &str, permissions: &[&str]) -> Roots {
        let roots = temp_roots(tag);
        write_app(&roots.user_apps, "notes", permissions);
        let grant = store::list(&roots)[0].grant.clone();
        store::consent(&roots, "notes", &grant).unwrap();
        roots
    }

    #[test]
    fn storage_round_trips_and_is_private_to_the_app() {
        let roots = consented("kv", &["storage"]);
        write_app(&roots.user_apps, "other", &["storage"]);
        let grant = store::list(&roots).into_iter().find(|a| a.id == "other").unwrap().grant;
        store::consent(&roots, "other", &grant).unwrap();

        call(&roots, "notes", "storage.set", &json!({ "key": "a", "value": { "n": 1 } })).unwrap();
        assert_eq!(call(&roots, "notes", "storage.get", &json!({ "key": "a" })).unwrap(), json!({ "n": 1 }));
        assert_eq!(call(&roots, "notes", "storage.keys", &json!({})).unwrap(), json!(["a"]));
        assert_eq!(call(&roots, "other", "storage.get", &json!({ "key": "a" })).unwrap(), Value::Null);

        call(&roots, "notes", "storage.delete", &json!({ "key": "a" })).unwrap();
        assert_eq!(call(&roots, "notes", "storage.get", &json!({ "key": "a" })).unwrap(), Value::Null);
    }

    #[test]
    fn every_guarded_method_is_refused_without_what_it_needs() {
        let roots = consented("perm", &[]);
        for (method, need) in METHODS {
            let wants = match need {
                Need::Nothing => continue,
                Need::Permission(p) => p,
                Need::Net => "net",
                Need::Server => "server",
            };
            let err = call(&roots, "notes", method, &json!({ "key": "a" })).unwrap_err();
            assert!(err.contains(wants), "{method} should name what is missing ({wants}), got: {err}");
        }
    }

    #[test]
    fn unknown_methods_are_refused() {
        let roots = consented("unknown", &["composer"]);
        assert!(call(&roots, "notes", "process.run", &json!({})).unwrap_err().contains("没有这个方法"));
        // 屏幕上的事由 GUI 自己答；漏到 Host 来的一律不认
        assert!(call(&roots, "notes", "composer.fill", &json!({})).unwrap_err().contains("没有这个方法"));
    }

    #[test]
    fn nothing_is_callable_before_consent_or_while_disabled() {
        let roots = temp_roots("gate");
        write_app(&roots.user_apps, "notes", &["storage"]);
        assert!(call(&roots, "notes", "host.info", &json!({})).unwrap_err().contains("同意"));

        let grant = store::list(&roots)[0].grant.clone();
        store::consent(&roots, "notes", &grant).unwrap();
        assert!(call(&roots, "notes", "host.info", &json!({})).is_ok());

        store::set_enabled(&roots, "notes", false).unwrap();
        assert!(call(&roots, "notes", "host.info", &json!({})).unwrap_err().contains("禁用"));
    }

    #[test]
    fn storage_refuses_bad_keys_and_oversized_values() {
        let roots = consented("limits", &["storage"]);
        assert!(call(&roots, "notes", "storage.set", &json!({ "value": 1 })).is_err());
        assert!(call(&roots, "notes", "storage.set", &json!({ "key": "", "value": 1 })).is_err());

        call(&roots, "notes", "storage.set", &json!({ "key": "small", "value": 1 })).unwrap();
        let huge = "x".repeat(MAX_STORAGE_BYTES);
        assert!(call(&roots, "notes", "storage.set", &json!({ "key": "big", "value": huge })).unwrap_err().contains("上限"));
        // 超限的写入不能把已有数据带坏
        assert_eq!(call(&roots, "notes", "storage.keys", &json!({})).unwrap(), json!(["small"]));
    }

    #[test]
    fn secrets_are_namespaced_per_app() {
        let roots = consented("secrets", &["secrets"]);
        write_app(&roots.user_apps, "other", &["secrets"]);
        let grant = store::list(&roots).into_iter().find(|a| a.id == "other").unwrap().grant;
        store::consent(&roots, "other", &grant).unwrap();

        call(&roots, "notes", "secrets.set", &json!({ "key": "db.password", "value": "hunter2" })).unwrap();
        assert_eq!(call(&roots, "notes", "secrets.get", &json!({ "key": "db.password" })).unwrap(), "hunter2");
        assert_eq!(call(&roots, "other", "secrets.get", &json!({ "key": "db.password" })).unwrap(), Value::Null);
        // 键里带斜杠就能说出别人名下的密钥：拒绝
        for key in ["../other/x", "a/b", "", "link/relayUrl"] {
            assert!(call(&roots, "notes", "secrets.get", &json!({ "key": key })).is_err(), "{key:?}");
        }
        call(&roots, "notes", "secrets.delete", &json!({ "key": "db.password" })).unwrap();
        assert_eq!(call(&roots, "notes", "secrets.get", &json!({ "key": "db.password" })).unwrap(), Value::Null);
    }

    #[test]
    fn workspace_files_go_through_the_workspace_root() {
        let roots = consented("fs", &["workspace:read", "workspace:write"]);
        let ws = roots.workspace_root.clone().unwrap();
        std::fs::write(ws.join("a.txt"), "hello").unwrap();
        assert_eq!(call(&roots, "notes", "fs.read", &json!({ "path": "a.txt" })).unwrap()["text"], "hello");
        call(&roots, "notes", "fs.write", &json!({ "path": "b.txt", "text": "new" })).unwrap();
        assert_eq!(std::fs::read_to_string(ws.join("b.txt")).unwrap(), "new");
        assert!(call(&roots, "notes", "fs.read", &json!({ "path": "../user/notes/app.json" })).is_err());
    }

    #[test]
    fn a_backend_call_without_node_says_so() {
        let roots = temp_roots("nonode");
        let dir = write_app(&roots.user_apps, "db", &[]);
        std::fs::write(
            dir.join("app.json"),
            r#"{"id":"db","name":"db","version":"1","panel":{"entry":"ui/index.html"},"server":{"entry":"server/main.mjs"}}"#,
        )
        .unwrap();
        let grant = store::list(&roots)[0].grant.clone();
        store::consent(&roots, "db", &grant).unwrap();
        assert!(call(&roots, "db", "tools.list", &json!({})).unwrap_err().contains("没有 Node"));
    }
}
