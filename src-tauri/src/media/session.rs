use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::browser::dto::{BoundsDto, CreateBrowserDto};
use crate::browser::facade::BrowserFacade;
use crate::host_door::target::HostTarget;
use super::host;
use super::registry::{token, MediaRegistry};
use super::types::{FileInfo, OpenRequest, Selection, SourceFile};

pub(super) struct ActiveFile {
    pub info: FileInfo,
    pub index: usize,
    pub generation: u64,
    pub revoked: AtomicBool,
}

pub(super) struct MediaSession {
    pub token: String,
    pub owner: String,
    pub draft_key: String,
    pub host: HostTarget,
    pub files: Vec<SourceFile>,
    pub theme: HashMap<String, String>,
    initial_selection: Option<Selection>,
    pub page_url: String,
    pub closed: AtomicBool,
    pub streams: Arc<Semaphore>,
    pub saves: Semaphore,
    active: AsyncMutex<Arc<ActiveFile>>,
    selected: AtomicUsize,
    sequence: AtomicU64,
    view: Mutex<Option<String>>,
    created: Instant,
}

impl MediaSession {
    pub fn check(&self, app: &AppHandle) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) || self.created.elapsed() > Duration::from_secs(12 * 60 * 60) {
            return Err("媒体标签已关闭或预览已过期，请重新打开".into());
        }
        if !self.host.belongs_to(app, &self.owner) {
            return Err("原 Host 连接已变化，请重新打开媒体".into());
        }
        if let Some(id) = self.view_id() {
            let id = crate::browser::port::types::BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
            let state = app.state::<crate::browser::state::BrowserState>();
            let registry = state.0.lock().map_err(|_| "浏览器状态不可用")?;
            if registry.get_in(&id, &self.owner).is_none() { return Err("媒体标签已关闭".into()); }
        }
        Ok(())
    }

    pub async fn current(&self) -> Arc<ActiveFile> { Arc::clone(&*self.active.lock().await) }
    pub fn view_id(&self) -> Option<String> { self.view.lock().unwrap_or_else(PoisonError::into_inner).clone() }

    pub fn matches(&self, key: (&str, &str, &str)) -> bool {
        !self.closed.load(Ordering::Acquire) && self.owner == key.0 && self.draft_key == key.1
            && self.files.get(self.selected.load(Ordering::Acquire)).is_some_and(|file| file.path == key.2)
    }

    pub fn revoke(self: &Arc<Self>) {
        if self.closed.swap(true, Ordering::AcqRel) { return; }
        let session = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let active = session.current().await;
            active.revoked.store(true, Ordering::Release);
            host::close(&session.host, &active.info.handle).await;
        });
    }

    pub async fn select(&self, app: &AppHandle, file_id: &str) -> Result<(), String> {
        self.check(app)?;
        let index: usize = file_id.parse().map_err(|_| "媒体文件标识无效")?;
        let source = self.files.get(index).ok_or("媒体文件不在本次交付中")?;
        let mut active = self.active.lock().await;
        let info = host::open(&self.host, &source.path, None).await?;
        if let Err(e) = self.check(app) {
            host::close(&self.host, &info.handle).await;
            return Err(e);
        }
        let old = Arc::clone(&active);
        let generation = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        *active = Arc::new(ActiveFile { info, index, generation, revoked: AtomicBool::new(false) });
        self.selected.store(index, Ordering::Release);
        old.revoked.store(true, Ordering::Release);
        drop(active);
        host::close(&self.host, &old.info.handle).await;
        Ok(())
    }

    pub async fn metadata(&self, app: &AppHandle) -> Result<Value, String> {
        self.check(app)?;
        let active = self.current().await;
        let source = self.files.get(active.index).ok_or("媒体源失效")?;
        let external = app.get_window(&self.owner).is_some_and(|window| {
            crate::host_window::gui_path(&window, &active.info.path).is_ok()
        });
        Ok(json!({
            "files": self.files.iter().enumerate().map(|(index, source)| json!({
                "id": index.to_string(), "title": source.title, "name": name_of(&source.path)
            })).collect::<Vec<_>>(),
            "active": { "id": active.index.to_string(), "title": source.title,
                "name": name_of(&active.info.path), "path": active.info.path,
                "mime": active.info.mime, "size": active.info.size, "revision": active.info.revision },
            "streamUrl": format!("stream?generation={}", active.generation),
            "canOpenExternal": external, "theme": self.theme,
            "initialSelection": if active.generation == 1 { self.initial_selection.as_ref() } else { None }
        }))
    }
}

pub(super) fn name_of(path: &str) -> &str { path.rsplit(['/', '\\']).next().unwrap_or(path) }

struct OpenContext {
    app: AppHandle,
    owner: String,
    host: HostTarget,
    epoch: u64,
    port: u16,
}

pub(super) async fn open_page(window: &Window, request: OpenRequest) -> Result<(), String> {
    if focus_existing(window, &request).await? { return Ok(()); }
    let context = prepare(window).await?;
    let session = build_session(&context, request).await?;
    register_page(context, session).await
}

async fn prepare(window: &Window) -> Result<OpenContext, String> {
    let app = window.app_handle().clone();
    let owner = window.label().to_string();
    let epoch = app.state::<Arc<MediaRegistry>>().epoch(&owner);
    let host = HostTarget::capture(&app, &owner).await?;
    let port = crate::resource_server::port(&app).await?;
    Ok(OpenContext { app, owner, host, epoch, port })
}

async fn focus_existing(window: &Window, request: &OpenRequest) -> Result<bool, String> {
    if request.target.selection.is_some() { return Ok(false); }
    let wanted = request.files.get(request.selected).ok_or("媒体文件不存在")?;
    let state = window.app_handle().state::<Arc<MediaRegistry>>();
    let Some(existing) = state.matching((window.label(), &request.target.draft_key, &wanted.path)) else { return Ok(false) };
    if existing.check(window.app_handle()).is_err() { state.remove(&existing.token); return Ok(false); }
    let active = existing.current().await;
    if request.target.expected_revision.as_ref().is_some_and(|revision| revision != &active.info.revision) { return Ok(false); }
    let Some(id) = existing.view_id() else { return Ok(false) };
    BrowserFacade::new(window.app_handle(), window.label()).request_focus(&id).map_err(|e| e.to_string())?;
    Ok(true)
}

async fn build_session(context: &OpenContext, request: OpenRequest) -> Result<Arc<MediaSession>, String> {
    let source = request.files.get(request.selected).ok_or("媒体文件不存在")?;
    let info = host::open(&context.host, &source.path, request.target.expected_revision.as_deref()).await?;
    let secret = token();
    Ok(Arc::new(MediaSession {
        page_url: format!("http://127.0.0.1:{}/media/{secret}/player", context.port),
        token: secret, owner: context.owner.clone(), draft_key: request.target.draft_key,
        host: context.host.clone(), files: request.files, theme: safe_theme(request.theme),
        initial_selection: request.target.selection,
        closed: AtomicBool::new(false), streams: Arc::new(Semaphore::new(2)), saves: Semaphore::new(1),
        active: AsyncMutex::new(Arc::new(ActiveFile { info, index: request.selected, generation: 1, revoked: AtomicBool::new(false) })),
        selected: AtomicUsize::new(request.selected), sequence: AtomicU64::new(1),
        view: Mutex::new(None), created: Instant::now(),
    }))
}

fn safe_theme(theme: Option<HashMap<String, String>>) -> HashMap<String, String> {
    theme.unwrap_or_default().into_iter().filter(|(key, value)| {
        key.starts_with("--aide-") && key.len() < 80 && value.len() < 256
            && !value.chars().any(char::is_control)
    }).take(96).collect()
}

async fn register_page(context: OpenContext, session: Arc<MediaSession>) -> Result<(), String> {
    let state = context.app.state::<Arc<MediaRegistry>>().inner().clone();
    if let Err(error) = session.check(&context.app).and_then(|_| state.insert(Arc::clone(&session), context.epoch)) {
        session.revoke();
        return Err(error);
    }
    let page = Arc::clone(&session);
    let app = context.app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || create_view(&app, &page))
        .await.map_err(|e| format!("打开媒体标签失败：{e}")).and_then(|result| result);
    if let Err(error) = result {
        state.remove(&session.token);
        return Err(error);
    }
    Ok(())
}

fn create_view(app: &AppHandle, session: &Arc<MediaSession>) -> Result<(), String> {
    session.check(app)?;
    let facade = BrowserFacade::new(app, &session.owner);
    let view = facade.create(&CreateBrowserDto {
        url: session.page_url.clone(), bounds: BoundsDto { x: 0.0, y: 0.0, w: 800.0, h: 600.0 },
        displayed: Some(false), label: Some("媒体预览".into()), origin: None, init_script: None,
    }).map_err(|e| e.to_string())?;
    *session.view.lock().unwrap_or_else(PoisonError::into_inner) = Some(view.id.clone());
    if let Err(error) = session.check(app) {
        if let Err(close_error) = facade.close(&view.id) { tracing::debug!("stale media view close: {close_error}"); }
        return Err(error);
    }
    facade.request_focus(&view.id).map_err(|e| e.to_string())
}
