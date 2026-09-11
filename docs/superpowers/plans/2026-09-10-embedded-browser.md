# Aide 内嵌浏览器 — 方案设计

> 2026-09-10 · 状态：**方案待评审**（非实现稿）
> 范围定调（用户确认）：四类用途全要 — ① agent 跑网页任务 ② 浏览任意外站 ③ 预览信任/本地内容 ④ 外部登录/OAuth；跨平台 **Windows 优先，v1 可只做 Win**，但架构红线要求 macOS/Linux 接口预留。
>
> ✅ **API 已核实**：文中 Tauri/WebView2 签名已对着 pin 的 **tauri 2.11.2 / wry 0.55.1 / webview2-com 0.38.2** 官方源码（docs.rs source view，经代理）逐条核验，结论见 §10 核验表。仅余运行期行为（坐标同步、z 序、拖动跟随）须原型实测。

---

## 1. 选型结论

四类用途里「浏览任意外站」+「OAuth」+「agent 编程式控制」三条，直接淘汰纯 DOM 方案：

| 方案 | 判定 | 理由 |
|---|---|---|
| `<iframe>` | ❌ 出局 | 外站 `X-Frame-Options`/`frame-ancestors` 普遍拒绝被嵌；拿不到 cookie/导航事件/截图，agent 任务与 OAuth 都做不了 |
| CEF（cef-rs 内嵌 Chromium） | ❌ v1 不取 | +100~200MB 体积、Rust 绑定不成熟；与「VC++ 运行库都要精打细算随包」的体积取向冲突。仅当未来必须三平台像素级一致时再评估 |
| 独立 `WebviewWindow`（owned 子窗） | 🔶 兜底 | 稳定 API、无需 unstable；但真·OS 窗口的 z 序/焦点/拖动跟随难驯服，「内嵌」体感差。作为方案 A 不稳时的退路 |
| **Tauri 原生子 webview + 直采 WebView2** | ✅ **选定** | 复用系统 WebView2、0 额外体积、官方 multiwebview 路线；用 `Webview::with_webview`（门控 `feature="wry"`，默认开）下钻到 `ICoreWebView2` 拿完整浏览器控制（导航事件/cookie/截图/脚本注入/请求拦截），四类用途全覆盖。**代价**：multiwebview 需开 tauri `unstable` feature（已核实，§10#1），锁死在 adapter 内 |

**一句话**：容器用 Tauri 子 webview（融入窗口布局/生命周期），能力用 `with_webview` 下钻裸 WebView2（cookie/截图/注入/拦截）。Windows 上 WebView2 = 微软文档齐全的成熟浏览器内核。

---

## 2. 核心架构约束（必须先讲清的物理事实）

**原生子 webview 渲染在主 webview 的 HTML 之上，是兄弟层，不能与 Vue 元素 z 序交错。**

推论（决定整个前端形态）：
- Vue 布局里浏览器区域是一个**占位「洞」**（placeholder `<div>`），原生 webview 浮在这个洞的屏幕坐标上。
- 任何**必须盖在网页之上**的 UI（工具栏下拉、查找栏、右键菜单、tooltip）不能放进这个洞的矩形内 —— 要么排在洞外（工具栏在洞上方），要么用独立原生 webview / 原生菜单。
- 占位 div 的 `getBoundingClientRect()` 必须实时同步到 webview bounds：`ResizeObserver` + 窗口 resize/scroll + **切到别的 tab 时把 webview 移到屏外或尺寸置 0**（否则它会浮在所有内容之上）。
- 这与团队踩过的 `backdrop-nested-root-teleport`、`nested-scroller-wheel-trap` 同源 —— 原生 view 重新引入坐标同步复杂度，需在 §6 专门处理。

---

## 3. 分层与模块地图

遵循项目红线「可替换技术必须藏在端口后面」（knowledge-server port/adapter 样板）+「Feature logic → submodule layering」+「文件超 1000 行必拆」。

```
src-tauri/src/browser/                 # 内聚新逻辑下沉同名子目录
├── mod.rs                             # 只导出 + 编排（门面）；≤ 一屏
├── port/                              # 端口层：只定义 trait 与领域类型，零第三方
│   ├── mod.rs
│   ├── engine.rs                      # trait BrowserEngine（能力，不分类）
│   └── types.rs                       # BrowserView / NavState / Bounds / UrlGuard 领域类型
├── core/                              # 纯核心：无 IO、可脱离 webview 单测
│   ├── mod.rs
│   ├── url_guard.rs                   # URL 校验/规范化（scheme allowlist）纯函数
│   └── nav_decision.rs                # 历史/前进后退决策纯函数
├── adapter/                           # 适配层：唯一允许碰 webview2-com / wry 的地方
│   ├── mod.rs
│   └── webview2/                      # Windows 实现（v1 唯一实现）
│       ├── mod.rs                     # #[cfg(windows)] 收口在此，业务层零 cfg
│       ├── engine_impl.rs             # impl BrowserEngine for Webview2Engine
│       ├── capture.rs                 # CapturePreview → PNG
│       ├── cookies.rs                 # CoreWebView2CookieManager
│       └── inject.rs                  # ExecuteScript / AddScriptToExecuteOnDocumentCreated
├── state.rs                           # BrowserRegistry：BrowserView 集合的主人（Arc<…> 注册）
├── commands.rs                        # Tauri 命令：薄外壳（拿数据→调 core→调 port→送回）
├── dto.rs                             # 跨 IPC 边界的扁平 DTO + From/TryFrom
└── facade.rs                          # 子系统总开关/门控收口（Facade pattern 记忆）

# 跨平台预留（v1 不实现，仅占位 + 编译 gated 空壳）
└── adapter/wkwebview/   (macOS, v2)
└── adapter/webkitgtk/   (Linux, v2)
```

依赖方向单向：`commands → core / port`，`adapter → port`，`core` 不知道任何层存在。`webview2-com`/`wry` 的 `use` **只允许出现在 `adapter/webview2/`**（验收时 grep 第三方库名，adapter 之外不得出现 —— 照搬 knowledge-server 验收尺）。

---

## 4. 端口层：`BrowserEngine` trait（签名 = 合同）

trait 表达「调用方需要对浏览器视图做什么」，不表达「它是什么内核」。按 S1（输入 ≤4）/ S5（最弱类型）/ S3（无 Option<bool>）设计。

```rust
// port/engine.rs
use crate::browser::port::types::{Bounds, BrowserViewId, NavState, ScriptResult, Shot};

/// 浏览器内核能力端口。v1 仅 Webview2Engine 实现；macOS/Linux v2 补。
/// 线程契约：所有方法必须在 webview 所属线程（主/UI 线程）执行 —— 实现方负责编组。
pub trait BrowserEngine: Send + Sync {
    /// 在 window 的 bounds 处创建一个加载 initial_url 的视图。
    fn create(&self, window: &tauri::Window, id: BrowserViewId, cfg: CreateCfg) -> Result<(), EngineError>;

    fn navigate(&self, id: BrowserViewId, url: &Url) -> Result<(), EngineError>;
    fn reload(&self, id: BrowserViewId) -> Result<(), EngineError>;
    fn go_back(&self, id: BrowserViewId) -> Result<(), EngineError>;
    fn go_forward(&self, id: BrowserViewId) -> Result<(), EngineError>;
    fn stop(&self, id: BrowserViewId) -> Result<(), EngineError>;

    /// 布局同步：把占位 div 的矩形拍到原生视图（LogicalPosition/Size）。
    fn set_bounds(&self, id: BrowserViewId, bounds: Bounds) -> Result<(), EngineError>;
    fn set_visible(&self, id: BrowserViewId, visible: bool) -> Result<(), EngineError>;

    /// agent 网页任务：注入脚本并取回 JSON 结果（WebView2 ExecuteScript）。
    fn eval(&self, id: BrowserViewId, script: &str) -> Result<ScriptResult, EngineError>;
    /// agent 网页任务：截图为 PNG 字节（WebView2 CapturePreview）。
    fn capture(&self, id: BrowserViewId) -> Result<Shot, EngineError>;

    /// OAuth：cookie 读写（CoreWebView2CookieManager）。
    fn cookies_get(&self, id: BrowserViewId, uri: &Url) -> Result<Vec<Cookie>, EngineError>;
    fn cookies_clear(&self, id: BrowserViewId) -> Result<(), EngineError>;

    fn close(&self, id: BrowserViewId) -> Result<(), EngineError>;
}
```

> **已核实（tauri 2.11.2 源码）**：创建子 webview 的权威 API 是
> `Webview::builder(label, WebviewUrl::External(url))`（构造 `WebviewBuilder`，链式 `.on_navigation()/.on_page_load()/.initialization_script()/.user_agent()/.data_store_identifier()…`）
> → `window.add_child(webview_builder, position: impl Into<Position>, size: impl Into<Size>) -> Result<Webview>`。
> `add_child` 内部用 `std::sync::mpsc::channel` 把 builder 编组到事件循环线程并阻塞取回 —— 创建期线程问题它已替你处理。
> adapter 据此实现 `create`：组装 builder → `add_child` → 存回 `Webview` 句柄。

`CreateCfg`（对象化，避免相邻同类型裸传 S2）：
```rust
pub struct CreateCfg {
    pub initial_url: Url,
    pub bounds: Bounds,
    pub user_agent: Option<String>,   // 可选在后；OAuth/反爬可能需要
    pub devtools: bool,               // 单 bool，release 默认 false（安全）
}
```

---

## 5. 对象建模（让非法状态造不出来）

遵循 M1（禁贫血）/ M5（枚举封闭状态）/ M6（变更守门）/ M3（边界 DTO）。

```rust
// port/types.rs
pub struct BrowserViewId(String);          // newtype，try_new 校验非空
impl BrowserViewId { pub fn try_new(s: impl Into<String>) -> Result<Self, ...> }

pub struct Bounds { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }  // logical px

/// 导航状态机 —— 枚举封闭，不堆 bool 旗帜（M5）
pub enum NavState {
    Idle,
    Loading,
    Ready { url: Url, title: String },
    Failed { url: Url, reason: String },
}

/// 领域对象：状态 + 行为同处，字段私有，变更走方法守门（M1/M6）
pub struct BrowserView {
    id: BrowserViewId,
    nav: NavState,
    bounds: Bounds,
    visible: bool,
    history: Vec<Url>,        // 前进/后退栈，core::nav_decision 据此判定
    cursor: usize,
}
impl BrowserView {
    /// 守门：bounds 宽高非负、url 过 url_guard，非法拒绝返回 Result（M6）
    pub fn begin_nav(&mut self, url: Url) -> Result<(), ViewError>;
    pub fn finish_nav(&mut self, title: String) -> Result<(), ViewError>;
    pub fn fail_nav(&mut self, reason: String);
    pub fn can_go_back(&self) -> bool;     // 纯查询，委托 core::nav_decision
    pub fn can_go_forward(&self) -> bool;
    pub fn move_cursor_back(&mut self) -> Option<&Url>;
    pub fn set_bounds(&mut self, b: Bounds) -> Result<(), ViewError>;
}
```

**纯核心**（functional core，脱离 webview 可单测）：
```rust
// core/url_guard.rs
/// scheme allowlist：http/https/file/localhost；拒 javascript:/data:（除非显式放行）。
pub fn guard(raw: &str) -> Result<Url, UrlGuardError>;   // 纯函数

// core/nav_decision.rs
pub fn can_go_back(history_len: usize, cursor: usize) -> bool;     // 纯
pub fn can_go_forward(history_len: usize, cursor: usize) -> bool;  // 纯
```

**边界 DTO**（M3：进 TryFrom 校验、出 From 拍平，不在 DTO 上写业务规矩）：
```rust
// dto.rs
#[derive(Serialize)] pub struct BrowserViewDto { id, nav_state, url, title, bounds, can_back, can_fwd }
#[derive(Deserialize)] pub struct BoundsDto { x, y, w, h }   // TryFrom → Bounds（校验非负）
#[derive(Serialize)] pub struct NavEventDto { id, kind, url, title }  // 经事件通道广播
```

---

## 6. 前端（Vue）分层与坐标同步

```
src/components/Browser/                 # 同名子目录内聚
├── BrowserPanel.vue                    # 容器：工具栏 + 占位洞 + 状态条
├── BrowserToolbar.vue                  # 地址栏/前进后退/刷新/停止（排在洞外，不浮在网页上）
├── BrowserSurface.vue                  # 占位 div：只负责量 rect、发同步、不放任何盖网页的内容
└── useBrowserView.ts                   # 闭包：调 browser_* 命令、订阅 nav 事件、维护 rect 同步
```

**坐标同步（核心难点，单独对待）**：
- `useBrowserView` 持 `ResizeObserver` 观察占位 div + 监听窗口 `resize`/`scroll` + `IntersectionObserver` 判可见。
- 任一变化 → 节流（rAF）→ `getBoundingClientRect()` → 转 logical px（除 `devicePixelRatio`）→ 调 `browser_set_bounds`。
- **panel 不可见（切到别的 tab/折叠）→ 立即 `browser_set_visible(false)` 或 bounds 置 0**，否则原生视图浮在全部内容之上。
- 盖在网页之上的浮层（查找栏/下拉）一律 `Teleport` 到 body + `fixed` 定位（照 `backdrop-nested-root-teleport` 配方），且**矩形不得与洞重叠**，重叠部分会被原生视图吃掉。

主题/配色走 `var(--aide-*)` token，禁硬编码 hex（CLAUDE.md 主题红线）。

---

## 7. Tauri 命令（薄外壳）与状态

`BrowserRegistry` 作为所有 `BrowserView` 的唯一主人，注册成 `Arc<…>`（项目记忆：`State<T>` 不能跨 `spawn_blocking`，state 注册 `Arc<T>` 后 clone 进闭包）。

```rust
// commands.rs —— 每个命令 ≤4 输入（S1），外壳只做：拿数据→调 core 校验→调 port→送回
#[tauri::command] async fn browser_create(window: tauri::Window, state: State<'_, Arc<BrowserRegistry>>, cfg: CreateBrowserDto) -> Result<BrowserViewDto, CmdError>;
#[tauri::command] async fn browser_navigate(state: ..., id: String, url: String) -> Result<(), CmdError>;   // url 先过 core::url_guard
#[tauri::command] async fn browser_set_bounds(state: ..., id: String, bounds: BoundsDto) -> Result<(), CmdError>;
#[tauri::command] async fn browser_eval(state: ..., id: String, script: String) -> Result<serde_json::Value, CmdError>;
#[tauri::command] async fn browser_capture(state: ..., id: String) -> Result<Vec<u8>, CmdError>;   // PNG
#[tauri::command] async fn browser_cookies_clear(state: ..., id: String) -> Result<(), CmdError>;
#[tauri::command] async fn browser_close(state: ..., id: String) -> Result<(), CmdError>;
```

**线程模型（关键风险，§10 核验）**：WebView2 是主线程/STA 绑定。命令虽 `async`，但真正碰 `ICoreWebView2` 的调用必须经 `Webview::with_webview(|w| …)` 编组到 webview 线程，结果用 channel/oneshot 回传 —— **不能**对这些 COM 调用用 `spawn_blocking`（会跑到错误线程）。截图/eval 的异步回调（WebView2 用 completed handler）需桥接成 future。

`invoke_handler` 注册以上命令。导航/加载状态变化经**事件通道广播**（`NavEventDto`）给前端，遵循项目「事件通道广播、UI 状态只认事件」红线 —— 前进后退可用性、地址栏、标题都从事件刷新，不在前端乐观更新。

---

## 8. 安全模型（默认即安全，须显式守住）

- **浏览器子 webview 永不授予 Tauri IPC**：加载远程内容的 webview 默认无 `__TAURI__`，只要**不**配置 `dangerousRemoteUrlIpcAccess` 即安全。agent 的脚本注入/截图/cookie 全部从 **Rust 侧经 `with_webview`/裸 WebView2** 驱动，不依赖给页面任何 IPC 权限。
- **URL 守门**：`core::url_guard` scheme allowlist，默认拒 `javascript:`/`data:`/`file:`（本地预览用途显式放行 `file:`/`localhost` 白名单根目录）。
- **devtools**：release 默认关（`CreateCfg.devtools=false`），与项目「生产包禁 devtools 是安全要求」一致；诊断包才开。
- **cookie/凭据隔离**：OAuth 的 cookie 落在 WebView2 的 user data folder；考虑给浏览器视图独立 UDF，避免与未来其它 WebView2 用途串味（核验点）。
- capability：创建/驱动都在 Rust 命令侧，前端只调我们自己的 `browser_*` 命令（app 自定义命令不需 core capability 条目）；**不**给前端开 `core:webview:*` 创建权限，缩小暴露面。

---

## 9. agent 网页任务集成（用途①）

agent（Claude Agent SDK，跑在 sidecar）需要「打开网页 / 点 / 读 / 截图」。两条接线，二选一或并存（待 agent 侧设计细化）：
- **A. MCP 工具**：sidecar 暴露 `browser_*` MCP 工具 → 经桌面 Rust 命令驱动浏览器视图。符合项目「内置 MCP/Hooks 须同步登记前端镜像（useCustomizations）」约束 —— 新增内置 MCP 必须登记，否则「扩展」面板不显示。
- **B. 截图回灌**：`browser_capture` 出 PNG → 作为图像内容回灌给模型（computer-use 风格）。

> agent 侧编排不在本特性 v1 必做范围；v1 先把「人用浏览器面板 + Rust 端口能力」做扎实，agent 工具作为 v1.5 在同一端口上薄接。

---

## 10. 分期 / 风险 / 核验点

**分期**
- **v1（Windows）**：端口 trait + core（url_guard/nav_decision）+ webview2 adapter（navigate/bounds/eval/capture/cookies）+ 浏览器面板 UI + 坐标同步 + 事件广播。`Cargo.toml` 加 `tauri` 的 `unstable` feature 与 `webview2-com`（仅 `[target.'cfg(windows)'.dependencies]`）。
- **v1.5**：agent MCP 工具接线 + 截图回灌。
- **v2（跨平台）**：补 `wkwebview`（macOS）/`webkitgtk`（Linux）adapter，业务层零改动（端口已隔离）。

**核验点 —— 已对着 tauri 2.11.2 / wry 0.55.1 / webview2-com 0.38.2 官方源码核实（2026-09-10，经代理）**

| # | 核验点 | 结论（权威） |
|---|---|---|
| 1 | multiwebview 是否需 `unstable` | ✅ **需要**。`Window::add_child` = `#[cfg(any(test, all(desktop, feature="unstable")))]`；`Webview::builder(label,url)` = `#[cfg(feature="unstable")]`；`Manager::{webviews,get_webview,get_focused_window,windows}` 同样 unstable-gated。→ `Cargo.toml` 必须 `tauri = { features = [..., "unstable"] }`。**决策**：unstable 自 v2.0 起一直承载 multiwebview、API 干净、生产可用；接受它，但把它**完全锁死在 `adapter/webview2/`**，churn 不外溢。若日后无法接受 → 退方案 B（owned `WebviewWindow`，稳定 API）。 |
| 2 | 裸 WebView2 下钻路径 | ✅ **确认**。`Webview::with_webview(\|pw: PlatformWebview\| …)`，门控是 **`feature="wry"`（tauri 默认开），非 unstable**。Windows 上 `pw.controller() -> webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller`、`pw.environment() -> ICoreWebView2Environment`；`controller.CoreWebView2()` → `ICoreWebView2`（CapturePreview/CookieManager/ExecuteScript/WebResourceRequested）。`webview2-com` **0.38.2 已在依赖树**（wry/tauri 传递引入）→ 提为直接依赖、同版本、零版本风险。 |
| 3 | 线程编组 | ✅ **部分确认**。`add_child` 内部 mpsc channel 编组到事件循环线程并阻塞取回（创建期已处理）。`with_webview` 闭包在 webview 线程执行（`FnOnce(PlatformWebview)+Send+'static`）。CapturePreview/ExecuteScript 的 COM completed-handler 仍需我们在闭包内用 channel 桥回 future —— **禁止对这些 COM 调用 spawn_blocking**（会跑错线程）。 |
| 4 | 坐标同步精度 | ⚠️ **文档不可证，须实测**。运行期用 `Webview::set_position/set_size/set_bounds` 跟随占位 div rect；`devicePixelRatio` 换算、多显示器/缩放切换、窗口拖动跟随延迟是运行期行为，原型阶段实测钉死。 |
| 5 | 占位洞 z 序 | ⚠️ **架构事实成立，须实测钉死**。multiwebview 模型下子 webview 是窗口内容的兄弟层、浮于主 webview HTML 之上、不可被 Vue 浮层覆盖 —— §2/§6 据此设计。 |
| 6 | WebView2 Runtime 依赖 | 外部事实：目标机须 Evergreen WebView2 Runtime（Win11 自带、Win10 多随 Edge 更新到位）；微软提供 NSIS bootstrapper，**照你们 vc_redist.x64.exe 同款 POSTINSTALL 兜底**。 |
| 7 | cookie/UDF 隔离 | ✅ **可隔离**。`WebviewBuilder` 提供 `data_directory` / `data_store_identifier` / `incognito`（incognito 需 WebView2 Runtime ≥ 101.0.1210.39）→ 给浏览器视图独立存储/cookie，不与其它 webview 串味。 |

**WebviewBuilder 能力对照四用途（已确认存在的方法）**：agent 任务 = `initialization_script(_for_all_frames)` / `on_navigation` / `on_page_load` / `on_web_resource_request`(请求拦截) / `on_download` / `on_new_window` / `on_document_title_changed` + `with_webview`→ExecuteScript/CapturePreview；OAuth = CookieManager(via with_webview) + `data_store_identifier`/`incognito` + `on_navigation` 捕获回调重定向；任意外站 = `WebviewUrl::External` / `user_agent` / `proxy_url`；本地预览 = `WebviewUrl::App`/`Html` 或 `file://` + `data_directory`。

**验收（照项目对账尺）**
- `webview2-com`/`wry` 的 `use` grep：adapter 目录之外 0 命中（端口隔离验收）。
- core 纯函数（url_guard/nav_decision）单测覆盖带值路径 + 非法路径，出对账表「分支｜覆盖｜测试名」+ 实测证据。
- `BrowserView` 状态机：非法跳转（如 Idle 直接 finish_nav）造不出来 / 被守门拒绝的测试。
- 坐标同步：panel 隐藏时原生视图确不可见（实测，非断言绿即过 —— 照 `test-green-does-not-mean-branch-entered` 教训）。
- Rust 收尾派 `rust-reviewer`、TS 收尾派 `ts-reviewer` 独立审查，写码者不自评。

---

## 10.5 实现进度（2026-09-10）

**✅ 方案 A 已实测锁定**：可视原型经 `pnpm tauri dev` 实跑，三个决定性物理问题全部通过——
① z 序（网页老实待在占位洞、浮在 Vue 内容之上、工具栏不被盖）② 坐标跟随（resize/最大化贴合）
③ 隐藏干净度（关面板原生视图真消失、无残影浮层）。**不退方案 B。**

**已落地（全栈竖切片，三道门禁绿：cargo check bin+lib exit 0 / 41 browser 单测 / vue-tsc + check-tauri-imports 过）**：
- Rust：`Cargo.toml` 开 `unstable`；`browser/adapter/webview2::Webview2Engine`（create=add_child / navigate=eval / set_bounds / set_visible / close，仅用 tauri `Webview` 自带方法，**未引 webview2-com**）；`adapter::PlatformEngine` 别名 + `UnsupportedEngine` 占位（命令层零 cfg）；`commands/browser.rs` 7 个 async 命令（async 是硬约束：add_child 内部 `run_on_main_thread`+阻塞 recv，主线程调用会死锁）；`lib.rs` manage 状态 + 注册命令。
- 前端：`composables/useEmbeddedBrowser.ts`（IPC，已登记 check-tauri-imports 门面例外——桌面壳专属、无远程对应）；`components/Browser/BrowserPanel.vue`（占位洞 + ResizeObserver/rAF 坐标同步，CSS px == logical px 无需换算）；`App.vue` 挂载 + `Ctrl+Shift+B` 开关。
- 关键坐标事实：窗口 `decorations(false)` + 主 webview 铺满客户区 → `getBoundingClientRect()` 视口坐标直接 == 窗口客户区 logical 坐标，且视口相对天然吸收滚动。

**待做（按用途映射）**：
| 用途 | 状态 | 缺什么 |
|---|---|---|
| ② 浏览任意外站 | ✅ 基本可用 | 加载态/标题/重定向反映需接 `on_page_load` 事件通道 |
| ③ 预览信任/本地内容 | 🔶 file:// 已放行 | 缺本地预览 UI 入口 + file:// 根目录白名单守门 |
| ① agent 跑网页任务 | ⬜ 未接 | 需 webview2-com 下钻 `ICoreWebView2`：CapturePreview 截图 / ExecuteScript 带返回值 / 请求拦截 + MCP 工具接线 |
| ④ 外部登录/OAuth | ⬜ 未接 | 需 CookieManager + `data_store_identifier`/`incognito` 隔离 + `on_navigation` 捕获回调重定向 |

**收尾债**：`browser/mod.rs` 的 `#![allow(dead_code)]`（capture/cookies/eval/reload/stop 已实现未接线）随接线移除；adapter/命令层补 instrumented 覆盖率。

## 11. 参考文档（本次核实实际所据，均为 pin 版本权威源）
- `Window::add_child` 源码（unstable 门控 + 签名 + on_page_load 用法示例）: https://docs.rs/tauri/2.11.2/src/tauri/window/mod.rs.html
- `Webview` / `Webview::builder` / `with_webview` / `PlatformWebview::controller` 源码: https://docs.rs/tauri/2.11.2/src/tauri/webview/mod.rs.html
- `WebviewBuilder` 方法集（on_navigation/on_web_resource_request/initialization_script/data_store_identifier/incognito/user_agent/proxy_url…）: https://docs.rs/tauri/2.11.2/tauri/webview/struct.WebviewBuilder.html
- JS `Webview` API: https://v2.tauri.app/reference/javascript/api/namespacewebview/
- 安全 / capabilities / `dangerousRemoteUrlIpcAccess`: https://v2.tauri.app/security/capabilities/
- WebView2 `ICoreWebView2`（CapturePreview / CookieManager / ExecuteScript / WebResourceRequested）: https://learn.microsoft.com/en-us/microsoft-edge/webview2/
- `webview2-com` 0.38.2（已在依赖树，提为直接依赖）: https://docs.rs/webview2-com/0.38.2/
