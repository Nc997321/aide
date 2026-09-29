//! 浏览器子系统门面：**能力入口**（顶层组织文件）。
//!
//! 谁从这里进：命令层（UI 薄壳）、未来的 agent 工具桥接、以及任何新消费方。门面是唯一做
//! 「校验 → 引擎 → 注册表 → 广播」编排的地方——**新增一个消费方 = 加一个适配器，不动内核**
//! （设计原则见 docs/superpowers/plans/2026-09-10-embedded-browser.md §11）。
//!
//! **门面不认识「用途」**（同 CLAUDE.md headless 的机制/策略边界：引擎提供机制，宿主决定策略）：
//! 它不知道调用方是面板、agent 工具，还是将来某个「把页面存进知识库」的按钮，所以这里不出现
//! 「保存」「引用」这类词——那些是消费方的组合，不是内核能力。
//!
//! 广播口径：**状态变化只由加载事件路径广播**（`apply_page_load`）。命令路径回同步快照给调用方
//! （UI 或 agent 自己知道刚做了什么），不额外广播——页面加载信号随后会把同一份状态推给所有人，
//! 两个驱动者（用户/agent）因此看到同一个页面。
//!
//! 线程：方法可能被 async 命令从 tokio worker 调用；锁内不做引擎 IO（state.rs 红线）。

use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::browser::adapter::PlatformEngine;
use crate::browser::core::url_guard;
use crate::browser::dto::{
    BoundsDto, BrowserViewDto, CreateBrowserDto, NavEventDto, NavStateDto, ViewEventDto,
    ViewEventKind,
};
use crate::browser::port::engine::{BrowserEngine, CreateCfg, EngineError, PageLoadObserver};
use crate::browser::port::types::{
    Bounds, BrowserOrigin, BrowserView, BrowserViewId, NavState, PageLoadSignal, SizeError,
};
use crate::browser::state::{BrowserRegistry, BrowserState};

/// 主窗口 label（lib.rs setup 里创建的 "main"）。命令层因此零窗口知识。
const MAIN_WINDOW: &str = "main";

/// 导航事件广播名。前端 `useEmbeddedBrowser.onBrowserNav` 订阅同名事件。
pub const NAV_EVENT: &str = "browser-nav";

/// 视图生命周期广播名（created / closed）。前端 `onBrowserView` 订阅——
/// 面板靠它把 agent 开的 tab 长出来，而不是靠"面板自己知道"。
pub const VIEW_EVENT: &str = "browser-view";

/// 「请把某个视图露到前台」的广播名。**是请求不是命令**：显示权在面板（方案 A）。
pub const FOCUS_EVENT: &str = "browser-focus";

/// 门面错误：把各层具体错误汇总成调用方能读的形态（应用层汇总传播）。
#[derive(Debug, Clone, PartialEq)]
pub enum FacadeError {
    /// URL 未过 `url_guard`（scheme 白名单/畸形）。
    UrlRejected(String),
    /// 矩形非法（负/NaN 尺寸）——进边界守门失败。
    BoundsRejected(SizeError),
    /// 视图 id 非法（空串）。
    ViewIdRejected(String),
    /// 视图不存在（已关闭/从未创建）。文案带调用方传来的原始 id（可读性优先）。
    ViewNotFound(String),
    /// main 窗口不存在（启动早期竞态）。
    NoMainWindow,
    /// 注册表锁中毒：状态不可信。
    RegistryPoisoned,
    /// 引擎侧失败。
    Engine(EngineError),
}

impl std::fmt::Display for FacadeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FacadeError::UrlRejected(detail) => write!(f, "url rejected: {detail}"),
            FacadeError::BoundsRejected(detail) => write!(f, "invalid bounds: {detail}"),
            FacadeError::ViewIdRejected(detail) => write!(f, "invalid view id: {detail}"),
            FacadeError::ViewNotFound(id) => write!(f, "browser view not found: {id}"),
            FacadeError::NoMainWindow => write!(f, "main window not found"),
            FacadeError::RegistryPoisoned => write!(f, "browser registry lock poisoned"),
            FacadeError::Engine(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for FacadeError {}

impl From<EngineError> for FacadeError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}

/// 浏览器门面。持 `AppHandle` 只为两件事：取托管状态、广播事件。
pub struct BrowserFacade {
    app: AppHandle,
    engine: Arc<PlatformEngine>,
    registry: Arc<Mutex<BrowserRegistry>>,
}

impl BrowserFacade {
    /// 从 Tauri 托管状态装配（engine / registry 都在 `lib.rs` setup 里 manage）。
    pub fn new(app: &AppHandle) -> Self {
        Self {
            engine: app.state::<Arc<PlatformEngine>>().inner().clone(),
            registry: app.state::<BrowserState>().0.clone(),
            app: app.clone(),
        }
    }

    /// 创建视图并加载首个 URL。**id 由注册表发**（身份归状态主人：面板与未来的 agent 工具
    /// 拿到的都是同一个可寻址 id）。
    pub fn create(&self, dto: &CreateBrowserDto) -> Result<BrowserViewDto, FacadeError> {
        let url = url_guard::guard(&dto.url).map_err(|e| FacadeError::UrlRejected(e.to_string()))?;
        let bounds = Bounds::try_from(dto.bounds).map_err(FacadeError::BoundsRejected)?;
        // 缺省露头（面板路径不传）；agent 的后台 tab 显式 false → 直接建在停靠点。
        let displayed = dto.displayed.unwrap_or(true);

        // **先入库、再建引擎视图**：加载信号可能在 `create` 返回前就到达（它们在主线程上跑），
        // 注册表里必须先有这一条，否则首个 Started 会被当成「视图不存在」丢掉。
        // 领域与引擎的显示状态在入库时就对齐——否则 `browser_tabs` 会把 parked 报成 displayed。
        let id = {
            let mut reg = self.lock()?;
            let id = reg.allocate_id();
            let mut view = BrowserView::new(id.clone(), bounds);
            view.set_displayed(displayed);
            view.set_label(dto.label.clone());
            view.set_origin(dto.origin.map(BrowserOrigin::from).unwrap_or_default());
            reg.insert(view);
            id
        };

        let window = self
            .app
            .get_window(MAIN_WINDOW)
            .ok_or(FacadeError::NoMainWindow)?;
        let cfg = CreateCfg {
            initial_url: url.clone(),
            bounds,
            user_agent: None,
            devtools: false,
            displayed,
            // 直通：门面不认识用途（脚本内容由调用方决定），只保证它落在**首次导航之前**。
            init_script: dto.init_script.clone(),
            on_page_load: Some(self.observer(id.clone())),
        };
        if let Err(e) = self.engine.create(&window, id.clone(), cfg) {
            // 建视图失败 → 回收注册表占位，不留幽灵条目。
            let _ = self.lock()?.remove(&id);
            return Err(e.into());
        }

        let (snapshot, event) = {
            let mut reg = self.lock()?;
            let view = reg
                .get_mut(&id)
                .ok_or_else(|| FacadeError::ViewNotFound(id.as_str().to_string()))?;
            // 首个导航入历史。**仅当还停在 Idle**：若加载信号已经先推进了状态（`create` 期间主线程
            // 就在收事件），这里不重复记账——否则历史会多一条、甚至把 Ready 拖回 Loading。
            if matches!(view.nav(), NavState::Idle) {
                view.begin_nav(url);
            }
            (
                BrowserViewDto::from(&*view),
                ViewEventDto::of(view, ViewEventKind::Created),
            )
        };
        // 广播在锁外：面板靠它长出标签页（agent 开的 tab 尤其需要）。
        broadcast_view(&self.app, event);
        Ok(snapshot)
    }

    /// 导航。**同一 URL = 重载**（浏览器惯例：不压历史，否则「后退」退到同一页看起来像坏了）。
    pub fn navigate(&self, id_raw: &str, url_raw: &str) -> Result<BrowserViewDto, FacadeError> {
        let id = self.parse_id(id_raw)?;
        let url = url_guard::guard(url_raw).map_err(|e| FacadeError::UrlRejected(e.to_string()))?;

        // 读态（锁内）→ 引擎 IO（锁外）→ 改写（锁内）：锁内不做 IO。
        let is_reload = {
            let reg = self.lock()?;
            let view = reg
                .get(&id)
                .ok_or_else(|| FacadeError::ViewNotFound(id_raw.to_string()))?;
            view.current_url() == Some(&url)
        };

        if is_reload {
            self.engine.reload(&id)?;
        } else {
            self.engine.navigate(&id, &url)?;
        }

        let mut reg = self.lock()?;
        let view = reg
            .get_mut(&id)
            .ok_or_else(|| FacadeError::ViewNotFound(id_raw.to_string()))?;
        if is_reload {
            view.reload_current();
        } else {
            view.begin_nav(url);
        }
        Ok(BrowserViewDto::from(&*view))
    }

    /// 后退：领域移游标取目标 URL（历史唯一主人是 `BrowserView`）→ 引擎导航 → 回快照。
    pub fn go_back(&self, id_raw: &str) -> Result<BrowserViewDto, FacadeError> {
        self.move_cursor(id_raw, |v| v.go_back())
    }

    /// 前进：对称于 [`go_back`](Self::go_back)。
    pub fn go_forward(&self, id_raw: &str) -> Result<BrowserViewDto, FacadeError> {
        self.move_cursor(id_raw, |v| v.go_forward())
    }

    /// 布局同步：占位洞的矩形拍到原生视图 + 领域。
    pub fn set_bounds(&self, id_raw: &str, bounds: BoundsDto) -> Result<(), FacadeError> {
        let id = self.parse_id(id_raw)?;
        let bounds = Bounds::try_from(bounds).map_err(FacadeError::BoundsRejected)?;
        self.engine.set_bounds(&id, bounds)?;
        if let Some(view) = self.lock()?.get_mut(&id) {
            view.set_bounds(bounds);
        }
        Ok(())
    }

    /// 露头/让位。让位是 **parking**（挪出可见区、引擎照常活着），不是 `hide()`——
    /// 视图浮在全部 HTML 之上、不受 DOM 生命周期约束，所以"看不见"只解决遮挡，
    /// "引擎别停"才是这条命令存在的理由（见 `adapter/webview2/mod.rs` 的 PARK 常量）。
    pub fn set_displayed(&self, id_raw: &str, displayed: bool) -> Result<(), FacadeError> {
        let id = self.parse_id(id_raw)?;
        self.engine.set_displayed(&id, displayed)?;
        if let Some(view) = self.lock()?.get_mut(&id) {
            view.set_displayed(displayed);
        }
        Ok(())
    }

    /// **请求**把某个视图露到面板上。只校验 id 存在 + 广播，**不改任何状态**——
    /// 显示权在面板（空标签没有视图，还有宽度档、浮层让位这些纯 UI 状态，领域不该被卷进来）。
    pub fn request_focus(&self, id_raw: &str) -> Result<(), FacadeError> {
        let id = self.parse_id(id_raw)?;
        if self.lock()?.get(&id).is_none() {
            return Err(FacadeError::ViewNotFound(id_raw.to_string()));
        }
        let app = self.app.clone();
        let payload = serde_json::json!({ "id": id.as_str() });
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = app.emit(FOCUS_EVENT, payload);
        });
        Ok(())
    }

    /// 关闭视图：引擎销毁子 webview + 领域移除。此后该 id 不复用。
    ///
    /// 广播在**销毁之后**、载荷取自销毁**之前**的快照——视图没了就再也读不到 label/origin，
    /// 而面板要靠它们把标签关对。
    pub fn close(&self, id_raw: &str) -> Result<(), FacadeError> {
        let id = self.parse_id(id_raw)?;
        let event = self
            .lock()?
            .get(&id)
            .map(|v| ViewEventDto::of(v, ViewEventKind::Closed));
        self.engine.close(&id)?;
        self.lock()?.remove(&id);
        if let Some(event) = event {
            broadcast_view(&self.app, event);
        }
        Ok(())
    }

    /// 列出全部视图快照，**顺序稳定**（id 序号升序，见 `BrowserRegistry::views_in_order`）。
    ///
    /// 用途：agent 发现"有哪些视图可操作"、以及 `view_id` 缺省时的消歧数据源。UI 对账也可用。
    pub fn list_views(&self) -> Result<Vec<BrowserViewDto>, FacadeError> {
        let reg = self.lock()?;
        Ok(reg
            .views_in_order()
            .into_iter()
            .map(BrowserViewDto::from)
            .collect())
    }

    /// 在视图里执行脚本并取回 JSON 结果——**agent 读页面的地基**。
    ///
    /// ⚠️ **必须在非主线程调用**：下钻层（`adapter/webview2/native.rs`）会在**调用线程**上等
    /// COM 回调。主线程调用 = 闭包内联 + 主线程阻塞等消息循环 = 自锁。async 命令请套
    /// `spawn_blocking`（state 已注册成 `Arc`，可直接 clone 进闭包）。
    ///
    /// **脚本契约**：脚本须返回信封 `{ok: true|false, ...}`——页面脚本抛异常时 `ExecuteScript`
    /// 回 `null`，与「脚本确实返回 null」不可区分（见 `native.rs`）。
    pub fn eval(&self, id_raw: &str, script: &str) -> Result<serde_json::Value, FacadeError> {
        let id = self.parse_id(id_raw)?;
        Ok(self.engine.eval(&id, script)?)
    }

    /// 裸 CDP 调用——agent **操作**页面的通道（真实输入事件 `Input.dispatchMouseEvent`、
    /// 文件上传 `DOM.setFileInputFiles`）。线程契约同 [`eval`](Self::eval)。
    ///
    /// CDP 域名可用性是**运行期变量**（WebView2 是 Evergreen 运行时，各机版本不同），
    /// 失败原样上抛，由消费方如实上报——不在这里静默降级。
    pub fn call_cdp(
        &self,
        id_raw: &str,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, FacadeError> {
        let id = self.parse_id(id_raw)?;
        Ok(self.engine.call_cdp(&id, method, params)?)
    }

    /// 给**后续所有文档**注入启动脚本（宿主 API `AddScriptToExecuteOnDocumentCreated`）——
    /// 页面加载期就要在的探针（网络/console recorder）走这里。线程契约同 [`eval`](Self::eval)。
    ///
    /// **只对将来的文档生效**：注册那一刻已加载的文档不会补装上（当前文档由调用方自己补）。
    /// 注册**累积**且**不在这里去重**——同一视图被调 N 次，每份新文档就跑 N 遍脚本；
    /// 去重是调用方的策略（sidecar 的 recorder 按视图只发一次）。
    pub fn add_init_script(&self, id_raw: &str, script: &str) -> Result<(), FacadeError> {
        let id = self.parse_id(id_raw)?;
        self.engine.add_init_script(&id, script)?;
        Ok(())
    }

    /// 加载信号观察者：引擎每报一次事件，就把信号交给 [`apply_page_load`]。
    fn observer(&self, id: BrowserViewId) -> PageLoadObserver {
        let app = self.app.clone();
        PageLoadObserver::new(move |url, signal| apply_page_load(&app, &id, url, signal))
    }

    /// 前后退公共路径：游标移动（锁内）→ 引擎 IO（锁外）→ 回快照。
    fn move_cursor(
        &self,
        id_raw: &str,
        step: impl Fn(&mut BrowserView) -> Option<Url>,
    ) -> Result<BrowserViewDto, FacadeError> {
        let id = self.parse_id(id_raw)?;
        let (target, snapshot) = {
            let mut reg = self.lock()?;
            let view = reg
                .get_mut(&id)
                .ok_or_else(|| FacadeError::ViewNotFound(id_raw.to_string()))?;
            // 无可退/可进：游标不动、状态不动（领域层保证），仍回当前快照。
            (step(view), BrowserViewDto::from(&*view))
        };
        if let Some(url) = target {
            self.engine.navigate(&id, &url)?;
        }
        Ok(snapshot)
    }

    fn parse_id(&self, raw: &str) -> Result<BrowserViewId, FacadeError> {
        BrowserViewId::try_new(raw).map_err(|e| FacadeError::ViewIdRejected(e.to_string()))
    }

    fn lock(&self) -> Result<MutexGuard<'_, BrowserRegistry>, FacadeError> {
        self.registry
            .lock()
            .map_err(|_| FacadeError::RegistryPoisoned)
    }
}

/// 加载信号落库 + 广播（观察者的本体）。
///
/// **跑在主线程**（webview 事件回调，线程契约见 `PageLoadObserver`）：
/// - 锁注册表做**纯状态迁移** ✓（无 IO，锁持有期极短）；
/// - 广播必须 `spawn_blocking` 交给 worker —— `AppHandle::emit` 的投递终点是 `Webview::eval`
///   （`run_on_main_thread` + 阻塞 `recv()`），在主线程调就是**主线程等自己 = 自锁**（已核实）。
///
/// 广播载荷是「发出那一刻重新读的快照」而不是事件本体：所以即便两个广播乱序，后跑的重读一次
/// 新状态，UI 不会被旧载荷拉回去。
fn apply_page_load(app: &AppHandle, id: &BrowserViewId, url: &Url, signal: PageLoadSignal) {
    let state = app.state::<BrowserState>();
    let changed = match state.0.lock() {
        Ok(mut reg) => reg
            .get_mut(id)
            .map(|v| v.absorb_page_load(url.clone(), signal))
            .unwrap_or(false),
        // 锁中毒：状态不可信，宁可不广播也不把坏状态推给 UI。
        Err(_) => false,
    };
    if !changed {
        return;
    }

    let app = app.clone();
    let id = id.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(event) = nav_event(&app, &id) {
            let _ = app.emit(NAV_EVENT, event);
        }
    });
}

/// 广播视图生命周期。线程纪律同 [`apply_page_load`]：`AppHandle::emit` 的投递终点是
/// `Webview::eval`（`run_on_main_thread` + 阻塞 `recv`），在主线程调就是主线程等自己。
fn broadcast_view(app: &AppHandle, event: ViewEventDto) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(VIEW_EVENT, event);
    });
}

/// 读一眼当下的导航状态（广播载荷）。
fn nav_event(app: &AppHandle, id: &BrowserViewId) -> Result<NavEventDto, FacadeError> {
    // 先落成变量再取字段：`app.state()` 返回的 `State` 是临时值，链式取 `.0` 会被借用检查拒绝。
    let state = app.state::<BrowserState>();
    let reg = state.0.lock().map_err(|_| FacadeError::RegistryPoisoned)?;
    let view = reg
        .get(id)
        .ok_or_else(|| FacadeError::ViewNotFound(id.as_str().to_string()))?;
    Ok(NavEventDto {
        id: id.as_str().to_string(),
        nav: NavStateDto::from(view.nav()),
        can_go_back: view.can_go_back(),
        can_go_forward: view.can_go_forward(),
    })
}
