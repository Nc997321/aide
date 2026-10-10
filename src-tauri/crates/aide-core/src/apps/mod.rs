//! 侧栏应用（Aide App）：用户与 agent 自己给 Aide 加功能。一个应用 = 清单 + 沙箱网页界面
//! （+ 可选后端）。应用归 Host，装在 `~/.aide/apps/<id>/`；受信任工作区的 `.aide/apps/<id>/`
//! 是开发态。设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md。
//!
//! 这些命令**不进 `aide-link` 暴露目录**：面板只在桌面。

pub mod bridge;
pub mod manifest;
pub mod net;
pub mod servers;
pub mod store;
pub mod wsfs;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::registry::{blocking, Command as HostCommand};
use crate::{command, Core};

use store::{AppInfo, Roots};

pub static COMMANDS: &[HostCommand] = &[
    command!("app_list", app_list),
    command!(bytes "app_asset", app_asset),
    command!("app_call", app_call),
    command!("app_consent", app_consent),
    command!("app_set_enabled", app_set_enabled),
    command!("app_set_placement", app_set_placement),
    command!("app_install", app_install),
    command!("app_uninstall", app_uninstall),
];

/// 应用增删改后发的事件；面板据此重新 `app_list`（不做本地乐观更新）。
pub const APPS_CHANGED: &str = "apps-changed";

/// 真实布局。开发态目录只认**受信任**的活动工作区——不受信任的仓库里放一个
/// `.aide/apps/x`，不能让它出现在 rail 上等用户误点同意。外加日常目录（恒受信任）：
/// 日常会话的 cwd 在那儿，而窗口的活动工作区可以是别的。
fn roots(core: &Core) -> Roots {
    let base = crate::paths::our_config_dir();
    let daily = crate::commands::workspace::daily::daily_path_in(&base);
    let daily_apps = Some(daily.join(".aide").join("apps"));
    let workspace_apps = core
        .workspace
        .active_root()
        .filter(|root| crate::commands::workspace::is_path_trusted(&root.to_string_lossy()))
        .map(|root| root.join(".aide").join("apps"));
    Roots {
        user_apps: base.join("apps"),
        workspace_apps,
        daily_apps,
        workspace_root: core.workspace.active_root(),
        data: base.join("app-data"),
    }
}

/// 跑应用后端用的 Node。找到一次就记住（`find` 每次都要起子进程问版本，`app_list` 是被轮询的）。
static NODE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// `download` = 找不到时去下载一份（只在用户点同意时这么做；平时找不到就如实说）。
fn node(core: &Core, download: bool) -> Result<PathBuf, String> {
    let mut cached = NODE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(path) = cached.as_ref().filter(|p| p.is_file()) {
        return Ok(path.clone());
    }
    let found = if download {
        crate::lsp::packs::node::ensure(core.resources.as_ref())
    } else {
        crate::lsp::packs::node::find(core.resources.as_ref()).ok_or_else(|| "这台 Host 上没有可用的 Node.js（18+）".to_string())
    }?;
    *cached = Some(found.clone());
    Ok(found)
}

/// 某个应用后端里免确认的工具。要起后端问一次 `tools/list`，所以按（应用，版本）记住——
/// 问失败了也记（空）：`app_list` 是被轮询的，不能每两秒重起一次坏掉的后端。
fn read_only_tools(core: &Core, roots: &Roots, node: &std::path::Path, id: &str) -> Vec<String> {
    static CACHE: Mutex<Option<std::collections::HashMap<String, (u64, Vec<String>)>>> = Mutex::new(None);
    let Ok(app) = store::locate(roots, id) else { return Vec::new() };
    // 开发态不认只读声明（见 store::read_only_tools）：连后端都不用起
    if app.source != store::Source::User {
        return Vec::new();
    }
    let Some(spec) = app.server_spec(roots, node) else { return Vec::new() };
    {
        let cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((revision, tools)) = cache.as_ref().and_then(|c| c.get(id)) {
            if *revision == spec.revision {
                return tools.clone();
            }
        }
    }
    let tools = match core.apps.request(&spec, "tools/list", json!({})) {
        Ok(list) => store::read_only_tools(app.source, &list),
        Err(e) => {
            tracing::warn!("[apps] 问不到应用「{id}」的工具清单，它的工具全部逐次确认：{e}");
            Vec::new()
        }
    };
    CACHE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(Default::default)
        .insert(id.to_string(), (spec.revision, tools.clone()));
    tools
}

/// 重写给 sidecar 读的那份「哪些应用后端挂进会话」，返回每个应用免确认的工具。
/// 失败只记日志：它不该挡住界面。
fn sync_mcp_file(core: &Core, roots: &Roots) -> std::collections::HashMap<String, Vec<String>> {
    let mut read_only = std::collections::HashMap::new();
    let wanted = store::list(roots).iter().any(|a| a.error.is_none() && a.enabled && a.consented && a.has_server);
    let entries = match wanted.then(|| node(core, false)) {
        Some(Ok(node)) => {
            let seen = std::cell::RefCell::new(&mut read_only);
            store::mcp_entries(roots, &node, &|id| {
                let tools = read_only_tools(core, roots, &node, id);
                seen.borrow_mut().insert(id.to_string(), tools.clone());
                tools
            })
        }
        Some(Err(e)) => {
            tracing::warn!("[apps] 应用后端不会挂进会话：{e}");
            Vec::new()
        }
        None => Vec::new(),
    };
    if let Err(e) = store::write_mcp_file(roots, &entries) {
        tracing::warn!("[apps] 写 {} 失败：{e}", store::MCP_FILE);
    }
    read_only
}

/// 开发态应用的清单问题记进它的开发日志——只在问题变了的时候记（`app_list` 是被轮询的）。
fn log_manifest_problems(roots: &Roots, apps: &[AppInfo]) {
    static LAST: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
    let last = last.get_or_insert_with(Default::default);
    for app in apps.iter().filter(|a| a.source == store::Source::Workspace) {
        // 与 list 同一个优先级：第一个有这个文件夹的开发态目录
        let Some(app_dir) = roots
            .app_dirs()
            .into_iter()
            .filter(|(source, _)| *source == store::Source::Workspace)
            .map(|(_, dir)| dir.join(&app.id))
            .find(|dir| dir.is_dir())
        else {
            continue;
        };
        let key = app_dir.to_string_lossy().into_owned();
        let now = app.error.clone().unwrap_or_default();
        // 第一次见到也记（哪怕是 ok）：agent 靠这一行知道「Aide 已经看到这个应用了」
        if last.get(&key).is_some_and(|before| *before == now) {
            continue;
        }
        let line = if now.is_empty() { "manifest: ok".to_string() } else { format!("manifest: {now}") };
        store::append_dev_log(&app_dir, &line);
        last.insert(key, now);
    }
}

/// 多久看一次应用目录。
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_millis(2500);

/// Host 自己盯着应用目录：有变化就记开发日志、发 [`APPS_CHANGED`]。Host 启动时调一次。
///
/// 为什么不靠界面轮询 `app_list`：agent 干活时用户多半在看别的窗口，被遮住的窗口定时器是停的——
/// 应用写好了没人扫，开发日志不出现，agent 只能瞎猜（2026-10-10 真机：它转头去搭假桥、开浏览器自测）。
/// 「Aide 看到这个应用了没有」不能取决于有没有一块亮着的屏幕。Core 没了线程自己退。
pub fn start(core: &Arc<Core>) {
    let core = Arc::downgrade(core);
    let spawned = std::thread::Builder::new().name("aide-apps-watch".into()).spawn(move || {
        let mut before = String::new();
        loop {
            std::thread::sleep(WATCH_EVERY);
            let Some(core) = core.upgrade() else { return };
            let roots = roots(&core);
            let apps = store::list(&roots);
            log_manifest_problems(&roots, &apps);
            let now = serde_json::to_string(&apps).unwrap_or_default();
            if now != before {
                // 第一轮只是记下起点：界面挂载时自己会 list 一次
                if !before.is_empty() {
                    core.emit(APPS_CHANGED, json!({}));
                }
                before = now;
            }
        }
    });
    if let Err(e) = spawned {
        tracing::warn!("[apps] 起不了应用目录的监视线程，开发态应用不会自动出现：{e}");
    }
}

async fn app_list(core: Arc<Core>, _a: crate::commands::NoArgs) -> Result<Vec<AppInfo>, String> {
    blocking(move || {
        let roots = roots(&core);
        let mut apps = store::list(&roots);
        log_manifest_problems(&roots, &apps);
        let mut read_only = sync_mcp_file(&core, &roots);
        for app in &mut apps {
            app.read_only_tools = read_only.remove(&app.id).unwrap_or_default();
        }
        Ok(apps)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAssetArgs {
    app_id: String,
    path: String,
}

async fn app_asset(core: Arc<Core>, a: AppAssetArgs) -> Result<Vec<u8>, String> {
    blocking(move || store::asset(&roots(&core), &a.app_id, &a.path)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCallArgs {
    app_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn app_call(core: Arc<Core>, a: AppCallArgs) -> Result<Value, String> {
    blocking(move || {
        let roots = roots(&core);
        let ctx = bridge::Ctx {
            roots: &roots,
            secrets: core.settings.secrets().as_ref(),
            servers: &core.apps,
            node: &|| node(&core, false),
        };
        bridge::call(&ctx, &a.app_id, &a.method, &a.params)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConsentArgs {
    app_id: String,
    grant: String,
}

async fn app_consent(core: Arc<Core>, a: AppConsentArgs) -> Result<(), String> {
    let (c, id) = (core.clone(), a.app_id.clone());
    blocking(move || {
        let roots = roots(&c);
        // 带后端的应用：同意时就把 Node 备好（可能要下载），备不好就别让用户以为它能用
        if store::locate(&roots, &a.app_id)?.manifest.server.is_some() {
            node(&c, true).map_err(|e| format!("这个应用带后端，但没能准备好 Node.js：{e}"))?;
        }
        store::consent(&roots, &a.app_id, &a.grant)?;
        sync_mcp_file(&c, &roots);
        Ok(())
    })
    .await?;
    core.emit(APPS_CHANGED, json!({ "appId": id }));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetEnabledArgs {
    app_id: String,
    enabled: bool,
}

async fn app_set_enabled(core: Arc<Core>, a: AppSetEnabledArgs) -> Result<(), String> {
    let (c, id) = (core.clone(), a.app_id.clone());
    blocking(move || {
        let roots = roots(&c);
        store::set_enabled(&roots, &a.app_id, a.enabled)?;
        if !a.enabled {
            c.apps.stop(&a.app_id);
        }
        sync_mcp_file(&c, &roots);
        Ok(())
    })
    .await?;
    core.emit(APPS_CHANGED, json!({ "appId": id }));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetPlacementArgs {
    app_id: String,
    placement: manifest::Placement,
}

async fn app_set_placement(core: Arc<Core>, a: AppSetPlacementArgs) -> Result<(), String> {
    let (c, id) = (core.clone(), a.app_id.clone());
    blocking(move || store::set_placement(&roots(&c), &a.app_id, a.placement)).await?;
    core.emit(APPS_CHANGED, json!({ "appId": id }));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIdArgs {
    app_id: String,
}

async fn app_install(core: Arc<Core>, a: AppIdArgs) -> Result<(), String> {
    let (c, id) = (core.clone(), a.app_id.clone());
    blocking(move || store::install(&roots(&c), &a.app_id)).await?;
    core.emit(APPS_CHANGED, json!({ "appId": id }));
    Ok(())
}

async fn app_uninstall(core: Arc<Core>, a: AppIdArgs) -> Result<(), String> {
    let (c, id) = (core.clone(), a.app_id.clone());
    blocking(move || {
        let roots = roots(&c);
        c.apps.stop(&a.app_id);
        store::uninstall(&roots, &a.app_id)?;
        sync_mcp_file(&c, &roots);
        Ok::<(), String>(())
    })
    .await?;
    core.emit(APPS_CHANGED, json!({ "appId": id }));
    Ok(())
}

