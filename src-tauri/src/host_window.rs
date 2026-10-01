//! 「一个窗口 = 一个 Host」的桌面侧：窗口 ↔ Host 绑定、开 Host 窗口、按窗口投递事件。
//!
//! - **本机窗口**（没绑远程 Host 的窗口）连本机 Host（进程内 aide-core，见 `host_door`）。
//! - **Host 窗口**（`host-…`）连一台目标机上的 `aide-host serve`：它的 core 命令由
//!   `host_door::forward` 原样转发（Host 原生路径，不翻译），serve 的事件只投给它自己。
//! - 绑定是**窗口当下的属性**，可以换（`switch_window_host`：「在此窗口中打开」）。**没有「主窗口」一说**：
//!   所有窗口平等，标签只是身份（第一扇碰巧叫 `main`，不代表它特殊、更不代表它连本机）。
//!   需要「哪扇窗口」时问 [`current_window`]（最近获得焦点的）/ [`local_window`]（连着本机 Host 的）。
//! - 事件隔离两头都要：后端对 Host 事件一律 `emit_to(窗口)`，前端监听一律窗口作用域
//!   （`@aide/sdk` 的 TauriTransport）——Tauri 的全局 `listen` 会收到发给任何窗口的事件。
//!
//! 设计见 docs/host-model.md。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Window};

use crate::remote_workspace::path::HostId;
use crate::remote_workspace::RemoteWorkspaces;

/// 窗口标签 → 它连着的远程 Host。不在表里 = 本机 Host（主窗口）。
#[derive(Default)]
pub struct HostWindows {
    map: Mutex<HashMap<String, HostId>>,
    /// 最近获得焦点的窗口——「当前窗口」。
    focused: Mutex<Option<String>>,
}

impl HostWindows {
    /// 窗口获得焦点（`on_window_event` 的 `Focused(true)`）。
    pub fn note_focus(&self, label: &str) {
        *self.focused.lock().unwrap_or_else(PoisonError::into_inner) = Some(label.to_string());
    }

    fn last_focused(&self) -> Option<String> {
        self.focused.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn host_of(&self, label: &str) -> Option<HostId> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(label)
            .cloned()
    }

    fn bind(&self, label: &str, host: &HostId) {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(label.to_string(), host.clone());
    }

    /// 改绑（`None` = 换回本机）。返回旧 Host 与它是否已没有别的窗口（调用方据此断开连接）；
    /// 本来就没绑远程 Host 的窗口换成远程时返回 `None`。
    fn rebind(&self, label: &str, host: Option<&HostId>) -> Option<(HostId, bool)> {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        let old = match host {
            Some(h) => map.insert(label.to_string(), h.clone()),
            None => map.remove(label),
        }?;
        let last = !map.values().any(|h| h == &old);
        Some((old, last))
    }

    /// 解绑，返回该 Host 是否已没有别的窗口（调用方据此断开连接）。
    fn unbind(&self, label: &str) -> Option<(HostId, bool)> {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        let host = map.remove(label)?;
        let last = !map.values().any(|h| h == &host);
        Some((host, last))
    }

    fn windows_of(&self, host: &HostId) -> Vec<String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(_, h)| *h == host)
            .map(|(l, _)| l.clone())
            .collect()
    }
}


/// 「当前窗口」：最近获得焦点且还活着的窗口，否则任意一扇（标签最小的，保证确定）。没有窗口 = `None`。
pub fn current_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.state::<HostWindows>();
    if let Some(w) = windows.last_focused().and_then(|l| app.get_webview_window(&l)) {
        return Some(w);
    }
    let all = app.webview_windows();
    let label = all.keys().min()?.clone();
    all.into_iter().find(|(l, _)| *l == label).map(|(_, w)| w)
}

/// 把「当前窗口」叫出来（托盘 / 二次启动 / 通知点击共用）：显示 + 取消最小化 + 聚焦。
pub fn show_current_window(app: &AppHandle) {
    if let Some(w) = current_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 此刻连着本机 Host 的窗口：优先「当前窗口」，否则任何没绑远程 Host 的窗口。没有 = `None`。
pub fn local_window(app: &AppHandle) -> Option<String> {
    let windows = app.state::<HostWindows>();
    let unbound = |l: &String| windows.host_of(l).is_none();
    if let Some(l) = windows.last_focused().filter(|l| app.get_webview_window(l).is_some() && unbound(l)) {
        return Some(l);
    }
    app.webview_windows().into_keys().filter(unbound).min()
}

/// 连着某台远程 Host 的窗口：优先它的标准标签窗口，否则任何一扇绑着它的窗口（窗口可以换绑，标签不再等于身份）。
fn host_window_of(app: &AppHandle, host: &HostId) -> Option<String> {
    let canonical = label_for(host);
    let bound = app.state::<HostWindows>().windows_of(host);
    if bound.contains(&canonical) {
        return Some(canonical);
    }
    bound.into_iter().min()
}

fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 窗口标签：`host-` + 主机键（Tauri 标签只认字母数字与 `-/:_`，其余字符折成 `_`）。
fn label_for(host: &HostId) -> String {
    let key: String = host
        .key()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("host-{key}")
}

/// 本机 Host（进程内 core）的事件：只投给没绑远程 Host 的窗口。
pub fn emit_local(app: &AppHandle, event: &str, payload: &Value) {
    let windows = app.state::<HostWindows>();
    for (label, _) in app.webview_windows() {
        if windows.host_of(&label).is_none() {
            if let Err(e) = app.emit_to(EventTarget::webview_window(&label), event, payload) {
                tracing::warn!(event, window = %label, "core event emit failed: {e}");
            }
        }
    }
}

/// 远程 Host 的事件（serve 的通知帧）：只投给连着这台 Host 的窗口，事件名 / payload 原样。
pub fn emit_to_host(app: &AppHandle, host: &HostId, event: &str, payload: &Value) {
    for label in app.state::<HostWindows>().windows_of(host) {
        if let Err(e) = app.emit_to(EventTarget::webview_window(&label), event, payload) {
            tracing::warn!(event, window = %label, "host event emit failed: {e}");
        }
    }
}

/// Host 窗口里 agent 的内嵌浏览器查询：在**连着这台 Host 的窗口**的浏览器里执行（视图属于
/// 创建它的窗口，本机窗口的 tab 它看不见、也碰不到），结果经 `agent_tool_result` 回到那台 Host
/// 的 runtime。窗口已关 = 门面如实回「window not found」，agent 不会干等超时。
pub fn answer_browser_query(
    app: &AppHandle,
    host: &HostId,
    req: crate::browser::agent_bridge::BrowserQueryRequest,
) {
    let app = app.clone();
    let host = host.clone();
    tauri::async_runtime::spawn(async move {
        let window = host_window_of(&app, &host).unwrap_or_else(|| label_for(&host));
        let payload = crate::runtime::browser_agent::answer(&app, &window, req).await;
        let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
        let sent = async {
            svc.connection(&host)
                .await?
                .invoke("agent_tool_result", serde_json::json!({ "payload": payload }))
                .await
        }
        .await;
        if let Err(e) = sent {
            tracing::warn!(host = %host, "browser query reply failed: {e}");
        }
    });
}

/// GUI 动作（用本机程序打开 / 在资源管理器中显示）要碰 Host 上的文件：显式跨界。
/// 本机窗口原样；WSL Host 的原生路径译成桌面能开的 `\\wsl.localhost\…`；SSH Host 上的文件
/// 本机根本摸不到——如实拒绝，不假装打开。
pub fn gui_path(window: &Window, path: &str) -> Result<String, String> {
    match window.app_handle().state::<HostWindows>().host_of(window.label()) {
        None => Ok(path.to_string()),
        Some(HostId::Wsl(distro)) => Ok(crate::remote_workspace::path::wsl_desktop_path(&distro, path)),
        Some(host) => Err(format!("{} 上的文件无法在本机打开", host.label())),
    }
}

/// 窗口关闭：解绑；该 Host 的最后一扇窗关了就断开连接（serve 退出，Host 上的 agent runtime /
/// 语言服务器随之收掉）。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    // 内嵌浏览器的视图属于窗口：窗口没了，名下的视图一并回收（任何窗口，不止 Host 窗口）。
    crate::browser::facade::release_window(app, label);
    let Some((host, last)) = app.state::<HostWindows>().unbind(label) else {
        return;
    };
    if last {
        let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
        tauri::async_runtime::spawn(async move { svc.disconnect(&host).await });
    }
}

/// 新窗口的标签：基础标签没被占用就用它，否则加毫秒后缀（窗口可以换绑，标准标签的窗口可能已连着别的 Host）。
fn fresh_label(app: &AppHandle, base: &str) -> String {
    if app.get_webview_window(base).is_none() {
        return base.to_string();
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("{base}-{ms}")
}

/// 窗口启动 URL；`folder`（Host 原生路径）= 起来后直接打开这个目录。
fn window_query(folder: Option<&str>) -> String {
    match folder {
        Some(f) => format!(
            "?openFolder={}",
            percent_encoding::utf8_percent_encode(f, percent_encoding::NON_ALPHANUMERIC)
        ),
        None => String::new(),
    }
}

/// 建一扇 Aide 窗口（Host 窗口与额外的本机窗口共用外观）。
fn build_window(app: &AppHandle, label: &str, folder: Option<&str>, title: &str) -> Result<(), String> {
    let url = format!("index.html{}", window_query(folder));
    let w = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .decorations(false)
        .visible(true)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    crate::style_window(&w);
    Ok(())
}

/// 后台建立到某台 Host 的连接（首次会安装）。窗口里的第一批命令会等它就绪；进度经
/// `remote-workspace-status` 事件可见。
fn connect_in_background(app: &AppHandle, id: &HostId) {
    let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
    let id = id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = svc.connection(&id).await {
            tracing::warn!(host = %id, "host window connect failed: {e}");
        }
    });
}

/// 打开（或聚焦）连着某台 Host 的窗口。连接 / 首次安装在后台开始，窗口里的第一批命令会
/// 等它就绪；进度经 `remote-workspace-status` 事件可见。`folder`（Host 原生路径）：窗口起来
/// 后直接打开这个目录；窗口已开着则经 `host-open-folder` 事件交给它。
#[tauri::command]
pub async fn open_host_window(
    app: AppHandle,
    host: String,
    folder: Option<String>,
) -> Result<String, String> {
    // 本机 Host（进程内 core，没有连接可建）：聚焦连着它的窗口；主窗口被换去连别的 Host 了就新开一扇。
    if host == crate::host_recents::LOCAL_KEY {
        if let Some(label) = local_window(&app) {
            focus(&app, &label);
            if let Some(f) = folder {
                let _ = app.emit_to(EventTarget::webview_window(&label), "host-open-folder", f);
            }
            return Ok(label);
        }
        let label = fresh_label(&app, "local-window");
        build_window(&app, &label, folder.as_deref(), "Aide")?;
        return Ok(label);
    }
    let id = HostId::parse_key(&host).ok_or_else(|| format!("非法主机标识：{host}"))?;
    if let Some(label) = host_window_of(&app, &id) {
        focus(&app, &label);
        if let Some(f) = folder {
            let _ = app.emit_to(EventTarget::webview_window(&label), "host-open-folder", f);
        }
        return Ok(label);
    }
    let label = fresh_label(&app, &label_for(&id));
    // 先绑定再建窗：窗口一加载就可能发命令，那时绑定必须已在。
    app.state::<HostWindows>().bind(&label, &id);
    connect_in_background(&app, &id);
    if let Err(e) = build_window(&app, &label, folder.as_deref(), &format!("Aide — {}", id.label())) {
        app.state::<HostWindows>().unbind(&label);
        return Err(format!("无法打开 {} 窗口：{e}", id.label()));
    }
    Ok(label)
}

/// 「在此窗口中打开」：把**调用方窗口**换成连另一台 Host（`local` = 换回本机），不另开窗口。
///
/// 做法 = 改绑 + 重载页面：会话 / 工作区 / 终端 / 内嵌浏览器的前端状态全部来自 Host，重载让它们
/// 从新 Host 重新加载，不留旧 Host 的残留。旧 Host 若没有别的窗口了就断开（同关窗口）。
/// `folder`（新 Host 的原生路径）：重载后直接打开这个目录。
#[tauri::command]
pub async fn switch_window_host(window: Window, host: String, folder: Option<String>) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let target = if host == crate::host_recents::LOCAL_KEY {
        None
    } else {
        Some(HostId::parse_key(&host).ok_or_else(|| format!("非法主机标识：{host}"))?)
    };
    if app.state::<HostWindows>().host_of(&label) == target {
        return Err("本窗口已经连着这台 Host".into());
    }
    let old = app.state::<HostWindows>().rebind(&label, target.as_ref());
    if let Some(id) = &target {
        connect_in_background(&app, id);
    }
    if let Some((old_host, true)) = old {
        let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
        tauri::async_runtime::spawn(async move { svc.disconnect(&old_host).await });
    }
    // 内嵌浏览器的视图属于窗口、也属于旧 Host 的上下文：随页面一起收掉
    crate::browser::facade::release_window(&app, &label);
    let title = match &target {
        Some(id) => format!("Aide — {}", id.label()),
        None => "Aide".to_string(),
    };
    let _ = window.set_title(&title);
    let search = serde_json::to_string(&window_query(folder.as_deref())).map_err(|e| e.to_string())?;
    let w = app.get_webview_window(&label).ok_or("窗口不存在")?;
    w.eval(format!("location.replace(location.pathname + {search})")).map_err(|e| e.to_string())
}

/// 调用方窗口连着哪台 Host（前端据此显示 Host 标签、选路径语义）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentHost {
    /// `local` / `wsl:Debian` / `ssh:devbox`
    pub key: String,
    /// 显示名：`本机` / `WSL: Debian` / `SSH: devbox`
    pub label: String,
    /// Host 的操作系统（`windows` / `linux` / `macos`）——路径语义跟它走，不跟 GUI 所在系统。
    pub os: String,
    /// Host 上的家目录（Host 原生路径）；连接未就绪时为空。
    pub home: String,
}

#[tauri::command]
pub async fn current_host(window: Window) -> Result<CurrentHost, String> {
    let app = window.app_handle();
    match app.state::<HostWindows>().host_of(window.label()) {
        None => Ok(CurrentHost {
            key: "local".into(),
            label: "本机".into(),
            os: std::env::consts::OS.into(),
            home: aide_core::paths::user_home()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }),
        Some(host) => {
            let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
            let conn = svc.connection(&host).await?;
            Ok(CurrentHost {
                key: host.key(),
                label: host.label(),
                os: conn.info.os.clone(),
                home: conn.info.home.clone(),
            })
        }
    }
}

/// 「从本机复制供应商」（Host 窗口里的显式动作）：本机的供应商连同密钥写进这台 Host。
///
/// 供应商按 Host 自持（2026-09-30 定）；跨界必须是用户看得见的一次动作，不做自动同步。
/// 合并规则：按 id——本机有的覆盖 Host 同 id 的（含密钥），Host 独有的原样保留（密钥不动）；
/// 不改 Host 的激活供应商。返回复制过去的条数。
#[tauri::command]
pub async fn import_local_providers(window: Window) -> Result<usize, String> {
    let app = window.app_handle();
    let host = app
        .state::<HostWindows>()
        .host_of(window.label())
        .ok_or("本机窗口不需要复制供应商")?;
    let core = app.state::<Arc<aide_core::Core>>().inner().clone();
    let local = tokio::task::spawn_blocking(move || core.settings.list_runtime_providers())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let local: Vec<Value> = local
        .iter()
        .map(|p| serde_json::to_value(p).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
    let conn = svc.connection(&host).await?;
    let remote = conn.invoke("get_providers", serde_json::json!({})).await?;
    let remote = remote.as_array().cloned().unwrap_or_default();
    let (inputs, copied) = merge_provider_inputs(&remote, &local);
    conn.invoke("set_providers", serde_json::json!({ "providers": inputs }))
        .await?;
    Ok(copied)
}

/// GUI 这台机器上的文件（剪贴板里复制的文件 / 粘贴的截图 / 从资源管理器拖进来的）进到本窗口
/// 的 Host：本机窗口原样返回（Host 就是本机）；Host 窗口把每个文件读出来，写进 Host 的暂存
/// 目录（core `stage_dropped_file`），返回 Host 路径——显式跨界，agent 只看得见 Host 上的文件。
#[tauri::command]
pub async fn upload_local_files(window: Window, paths: Vec<String>) -> Result<Vec<String>, String> {
    let app = window.app_handle();
    let Some(host) = app.state::<HostWindows>().host_of(window.label()) else {
        return Ok(paths);
    };
    let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
    let conn = svc.connection(&host).await?;
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let local = std::path::PathBuf::from(&p);
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let bytes = tokio::fs::read(&local)
            .await
            .map_err(|e| format!("读取本机文件失败 {p}: {e}"))?;
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let staged = conn
            .invoke("stage_dropped_file", serde_json::json!({ "name": name, "base64": b64 }))
            .await?;
        out.push(staged.as_str().unwrap_or_default().to_string());
    }
    Ok(out)
}

/// 纯核：Host 现有供应商（视图，无密钥）+ 本机供应商（含密钥）→ `set_providers` 的整表输入。
fn merge_provider_inputs(remote_views: &[Value], local: &[Value]) -> (Vec<Value>, usize) {
    let id_of = |v: &Value| v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let local_ids: std::collections::HashSet<String> = local.iter().map(id_of).collect();
    let unchanged = serde_json::json!({ "action": "unchanged" });
    let secret = |v: &Value, key: &str| match v.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => serde_json::json!({ "action": "set", "value": s }),
        _ => serde_json::json!({ "action": "unchanged" }),
    };
    let mut out = Vec::new();
    for view in remote_views {
        if local_ids.contains(&id_of(view)) {
            continue;
        }
        let mut input = view.clone();
        if let Some(o) = input.as_object_mut() {
            o.retain(|k, _| k != "apiKeyConfigured" && k != "authTokenConfigured");
            o.insert("apiKey".into(), unchanged.clone());
            o.insert("authToken".into(), unchanged.clone());
        }
        out.push(input);
    }
    for p in local {
        let mut input = p.clone();
        if let Some(o) = input.as_object_mut() {
            o.insert("apiKey".into(), secret(p, "apiKey"));
            o.insert("authToken".into(), secret(p, "authToken"));
        }
        out.push(input);
    }
    (out, local.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_import_merges_by_id_and_carries_local_secrets() {
        let remote = vec![
            serde_json::json!({"id": "host-only", "name": "H", "apiKeyConfigured": true}),
            serde_json::json!({"id": "shared", "name": "old"}),
        ];
        let local = vec![serde_json::json!({"id": "shared", "name": "new", "apiKey": "sk-1"})];
        let (inputs, copied) = merge_provider_inputs(&remote, &local);
        assert_eq!(copied, 1);
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0]["id"], "host-only");
        assert_eq!(inputs[0]["apiKey"]["action"], "unchanged");
        assert!(inputs[0].get("apiKeyConfigured").is_none());
        assert_eq!(inputs[1]["name"], "new");
        assert_eq!(inputs[1]["apiKey"], serde_json::json!({"action": "set", "value": "sk-1"}));
        assert_eq!(inputs[1]["authToken"]["action"], "unchanged");
    }

    #[test]
    fn labels_are_tauri_safe_and_distinct() {
        assert_eq!(label_for(&HostId::Wsl("Debian".into())), "host-wsl_Debian");
        assert_eq!(label_for(&HostId::Ssh("dev.box@x".into())), "host-ssh_dev_box_x");
    }

    #[test]
    fn last_window_of_a_host_is_reported() {
        let w = HostWindows::default();
        let h = HostId::Wsl("Debian".into());
        w.bind("host-a", &h);
        w.bind("host-b", &h);
        assert_eq!(w.unbind("host-a"), Some((h.clone(), false)));
        assert_eq!(w.unbind("host-b"), Some((h, true)));
        assert_eq!(w.unbind("host-b"), None);
    }

    #[test]
    fn rebinding_a_window_reports_the_host_it_left() {
        let w = HostWindows::default();
        let a = HostId::Wsl("Debian".into());
        let b = HostId::Ssh("devbox".into());
        // 本机窗口换成远程：没有旧 Host
        assert_eq!(w.rebind("win-1", Some(&a)), None);
        assert_eq!(w.host_of("win-1"), Some(a.clone()));
        // 另一扇窗口也连着 a：win-1 换走时 a 还有人，不能断开
        w.bind("win-2", &a);
        assert_eq!(w.rebind("win-1", Some(&b)), Some((a.clone(), false)));
        assert_eq!(w.host_of("win-1"), Some(b.clone()));
        // win-2 换回本机：a 没人了，该断开
        assert_eq!(w.rebind("win-2", None), Some((a, true)));
        assert_eq!(w.host_of("win-2"), None);
        // 本来就是本机，换回本机：无事发生
        assert_eq!(w.rebind("win-2", None), None);
    }

    #[test]
    fn the_last_focused_window_is_remembered() {
        let w = HostWindows::default();
        assert_eq!(w.last_focused(), None);
        w.note_focus("host-wsl_Debian");
        w.note_focus("main");
        assert_eq!(w.last_focused().as_deref(), Some("main"));
    }
}
