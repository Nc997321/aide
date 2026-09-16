# 内嵌浏览器 — 续作交接（HANDOFF）

> ⚠️ **本文档已作废（2026-09-15）**：其「两步走 + 会话式 tab」方案被用户否掉，形态改为主区一级视图
> + 面板自带标签页。**续作请读 `2026-09-15-embedded-browser-handoff.md`**；本文保留作决策演进记录
> （其中 §5 的地雷清单大部分仍然有效，已并入新文档）。

> 写于 2026-09-10 收工。**明天新会话从这份文档接着做。**
> 架构设计/选型理由见同目录 `2026-09-10-embedded-browser.md`（含 §10.5 实现进度、§10 已核实的 7 个核验点）。
> 本文档是「续作 playbook」：现状 + 已锁决策 + 待确认决策 + 下一步 + 地雷清单。

---

## 0. 一句话现状
方案 A（Tauri multiwebview + 原生 WebView2 子视图）**已实跑验证通过**，全栈竖切片（Rust adapter+命令 / Vue 全屏 overlay 原型）编译+测试+类型三道门禁全绿，`pnpm tauri dev` 按 `Ctrl+Shift+B` 能看到真正内嵌的网页。**下一步是把这个 overlay 原型升级成「会话式 tab」**（用户已选定形态），并接事件通道。

---

## 1. 已锁定的决策（别再翻案，省时间）
1. **方案 A 成立、不退 B**：可视原型经 dev 实跑，三个决定性物理问题全过——① z 序（网页待在占位洞、浮在 Vue 内容上、工具栏不被盖）② 坐标跟随（resize/最大化贴合）③ 隐藏干净度（关面板原生视图真消失、无残影）。
2. **接受 tauri `unstable` feature**（multiwebview 硬依赖，已锁死在 `browser/adapter` 内）。
3. **面板形态 = 会话式 tab**：浏览器作为中间区 PaneLayout 的一个 tab，能与会话**并排/分屏**共存；**入口在左侧栏**。（否决了「主区一级视图」和「弹窗模态」。）
4. **抽象方式 = 可辨识联合 + tab-kind 处理器注册表**，**不是 TS 泛型**（异构 tab 列表上泛型空转）。`TabItem = ChatTab | BrowserTab`，`handlerFor(tab).label/icon/statusTone/onClose/toPersisted`，加第三种 tab = 注册 handler（开闭原则）。联合类型让编译器替我们审计 `sessionId` 碰撞点。
5. **渲染彻底统一**：抽 `ChatTabContent.vue`（自带 `useChatSession`），聊天与浏览器内容都成自包含组件 → PaneGroup 用统一 `<component :is>`。（用户拍板要彻底统一，不接受「渲染处保留单个 v-if」的折中。）
6. **下一个构建项 = 事件通道 + 加载态/标题**：`on_page_load` → emit `browser-nav` 事件 → 前端更新标题/地址栏/Loading→Ready（用途②打磨）。

---

## 2. ⚠️ 待用户确认的决策（用户在「考虑一下」，明天先问这个）
我提出的**两步走 + 对账点**，用户尚未点头：

- **Step 1（纯重构，先证聊天没变）**：抽 `ChatTabContent.vue`，**字面搬运** PaneGroup 里的 `useChatSession` + `<ChatPanel>`(~30 props/~12 events) + handlers。钉死三条不变量：① 只渲染激活 tab 内容（每组单实例）② **绝不加 per-tab `:key`**（切聊天 tab 复用实例 + 响应式 sessionId，不重挂）③ props/events 逐条对账。**配一个重挂冒烟测试**（挂载组、切两个聊天 tab、断言 ChatTabContent 实例未重挂）。**这步不碰浏览器。**
- **Step 2（纯增量加浏览器）**：在已验证基座上加联合类型 + handler 注册表 + browser tab kind + BrowserPanel 作为 content 组件 + 事件通道。

**我为什么坚持两步**（明天若用户问起，复述这个理由）：聊天面板接线是全 app 最关键/最纠缠/测试最薄的表面，且有载荷承重的连续性不变量——App.vue「PaneLayout 用 v-show 保活(流式会话不掉线)」、PaneGroup「常驻一个 ChatPanel…切 tab 只换 sessionId prop」。`<component :is>` 若误带 `:key=tab.id` → 切聊天 tab 重挂 → 正是他们防过的「流式掉线」类事故，**vue-tsc 抓不到**（类型全对、行为变了）。两步走让「逻辑不变」被那个重挂测试**验过**而非**假设**，且聊天若坏可归因到 Step 1。

**明天的第一个动作**：问用户「两步走 + Step 1 重挂冒烟测试」是否认可；认可就先做 Step 1。若用户想一步到位，至少要保留那个重挂测试当对账点。

---

## 3. 已完成且验证绿（别重做）
**门禁状态**：`cargo check`（bin+lib）exit 0（仅 1 条既有 automation warning）；`cargo test --lib browser` = **41 passed**；`vue-tsc --noEmit` exit 0；`check-tauri-imports` 通过。独立 `rust-reviewer` 审查骨架+纯核心 = **通过 0 违反**。

**Rust（src-tauri/src/）**：
- `browser/mod.rs`：门面 + `#![allow(dead_code)]`（骨架期，接线后移除）。
- `browser/core/{nav_decision,url_guard}.rs` + `core_test.rs`：纯核心，完整实现+单测。
- `browser/port/types.rs` + `types_test.rs`：`BrowserViewId`/`Position`/`Size`/`Bounds`/`NavState`(枚举状态机)/`BrowserView`(状态+行为守门)，完整+单测。
- `browser/port/engine.rs`：`BrowserEngine` trait（`create` 取 `&tauri::Window<tauri::Wry>`）+ `CreateCfg` + `EngineError`（含 `Internal`）。
- `browser/dto.rs` + `dto_test.rs`：`BoundsDto`/`NavStateDto`/`BrowserViewDto`/`NavEventDto`/`CreateBrowserDto`(含 `id`)，From/TryFrom。
- `browser/state.rs`：`BrowserRegistry`(HashMap 唯一主人) + `BrowserState(Arc<Mutex<..>>)`。
- `browser/adapter/mod.rs`：`PlatformEngine` 别名（win=Webview2Engine，else=UnsupportedEngine），命令层零 cfg。
- `browser/adapter/webview2/mod.rs`：**已实现**可视子集 create(add_child)/navigate(eval location.href)/reload/stop/set_bounds(set_position+set_size)/set_visible(show/hide)/close；capture/cookies_clear 返回带说明的 EngineError（待 webview2-com）；eval 是 fire-and-forget 返 Null。
- `browser/adapter/unsupported.rs`：非 Win 占位（全返 PlatformUnsupported）。
- `browser/facade.rs`：STUB（门控收口，待接）。
- `commands/browser.rs`：7 个 **async** 命令 browser_create/navigate/set_bounds/set_visible/go_back/go_forward/close。
- `lib.rs`：`mod browser;`(第4行) + manage `Arc<PlatformEngine>` & `BrowserState` + generate_handler 注册 7 命令。
- `Cargo.toml`：tauri features 加 `"unstable"`；加 `url = "2.5"` 直接依赖。

**前端（src/）**：
- `composables/useEmbeddedBrowser.ts`：IPC 封装（直接 invoke，已登记 check-tauri-imports 例外）。导出 `BoundsDto`/`NavStateDto`/`BrowserViewDto` 类型 + create/navigate/setBounds/setVisible/goBack/goForward/close。
- `components/Browser/BrowserPanel.vue`：**当前是全屏 overlay 原型形态**（占位洞 + 工具栏 + ResizeObserver/rAF 坐标同步 + 生命周期）。**Step 2 要把它改成 tab content 形态**（props browserId/url，统一 sync 见下）。
- `App.vue`：`browserOpen` ref + `Ctrl+Shift+B` 切换 + 挂 `<BrowserPanel :open>`（全屏 overlay）。**Step 2 这套 overlay 开关要被「左侧栏入口 → openBrowserTab」取代。**
- `scripts/check-tauri-imports.mjs`：登记了 `src/composables/useEmbeddedBrowser.ts` 例外。

---

## 4. 下一步执行计划（明天按序）

### Step 1 — 抽 ChatTabContent.vue（纯重构 + 重挂测试，不碰浏览器）
- 新建 `src/components/panelayout/ChatTabContent.vue`：props `tab: ChatTab`(或当前 TabItem) + `focused`；内部 `useChatSession(sessionIdRef)` + 搬 PaneGroup 的 onSend/onRespondPermission/onSendBtw/effectiveWorkspacePath/wsSnapshot/onPickWorkspace + `<ChatPanel>` 整块。
- PaneGroup 改为渲染 `<ChatTabContent>`（暂时仍只聊天，先不引入 `<component :is>` 也行，但目标是统一）。
- **关键不变量**：只渲染激活 tab；**不加 `:key=tab.id`**；props/events 逐条对账（diff 旧 `<ChatPanel>` 块确保零遗漏）。
- 加冒烟测试（VTU）：挂载组含两个聊天 tab，切 activeTab，断言 ChatTabContent 组件实例**未重挂**（用 setup 计数 / onMounted 计数 / 实例引用相等）。参考记忆 `jsdom-vshow-isvisible-unreliable`、`test-green-does-not-mean-branch-entered`（断言要钉到「未重挂」这个真行为，别只断言渲染绿）。
- 验：`vue-tsc --noEmit` + `vitest run`（相关测试）+ **手动 dev 跑一遍聊天**（切 tab/分屏/发送/流式/权限弹窗都不变）。绿了才进 Step 2。

### Step 2 — 加浏览器 tab（纯增量）+ 事件通道
1. `tree.ts`：`TabItem = ChatTab | BrowserTab`（`kind` 判别）；`BrowserTab{ kind:"browser"; id; browserId; url; title? }`；`createTab` 加 kind；新建 `createBrowserTab()`。
2. 新建 `paneLayout/tabKinds.ts`：`TabKindHandler` 接口 + `chatHandler`/`browserHandler` + `handlerFor()`。把 label/icon/statusTone/onClose/toPersisted 从 PaneTabBar/usePaneLayout 收进 handler。
3. 让 vue-tsc 把 `sessionId` 碰撞点全逼出来 → 逐个 narrowing（`findTabBySession`/`bindSession`/`promoteTab`/`onSend`/`closeSessionTab` 收窄到 ChatTab）。
4. `usePaneLayout.ts`：加 `openBrowserTab(url?)`；`closeTab` 对 browser tab 调 `browser_close(browserId)`；serialize 处理 browser tab（v1 可不持久化）。
5. `BrowserTabContent`：把 BrowserPanel 改成 content 组件形态（props `browserId`/`url`），PaneGroup 用 `<component :is="handlerFor(activeTab).content">`。
6. **统一坐标/可见性 sync**（核心，已验证有效）：`rectOf()` 量占位洞，**rect 为空(display:none/宽高0)→ setVisible(false)，否则 setVisible(true)+setBounds(rect)**；触发器 = ResizeObserver + window resize + tab 激活。这一招自动覆盖所有隐藏场景（切 tab、PaneLayout 被市场 v-show 盖住、分屏后台）。webview 按 browserId 常驻 Rust 注册表，切走只 setVisible(false) 不销毁 → 切回页面状态还在；关 tab 才 browser_close。
7. `SidebarLeft.vue`：加「浏览器」入口 → emit `open-browser` → App.vue → `pl.openBrowserTab()`。（移除 Ctrl+Shift+B overlay 那套，或保留作快捷开 tab。）
8. **事件通道**：Rust `Webview2Engine::create` 的 `WebviewBuilder` 链 `.on_page_load(|webview, payload| { emit "browser-nav" {browserId,url,title,state} })`（需把 AppHandle + browserId move 进闭包；on_page_load 已确认是 WebviewBuilder 方法）。前端 `listen("browser-nav")` → 更新对应 BrowserTab 的 title/url + BrowserPanel 地址栏 + nav 状态 Loading→Ready。事件经事件通道广播（CLAUDE.md 多端一致性：UI 状态只认事件、不乐观更新）。
9. 移除 `browser/mod.rs` 的 `#![allow(dead_code)]`（接线后死代码应清零）。

---

## 5. 关键技术事实 & 地雷（别重新踩，全部已核实）
- **add_child 死锁**：`Window::add_child` 内部 `run_on_main_thread` + 阻塞 `rx.recv()` → **必须从非主线程调用**。所以 `browser_create` 等命令**必须 `async`**（跑 tokio worker）。同步命令在主线程调 add_child 会死锁。
- **WebviewUrl 导入路径**：用 `tauri::WebviewUrl`（crate 根），**不是** `tauri::webview::WebviewUrl`（私有，E0603）。`WebviewBuilder`/`Webview` 在 `tauri::webview::`，`Window` 在 `tauri::window::`。
- **BrowserEngine trait 要在 scope**：commands/browser.rs 必须 `use ...::engine::{BrowserEngine, CreateCfg}`，否则 Arc<Engine> 上调不到 trait 方法（E0599）。
- **`WebviewWindow.window/.webview` 是 pub(crate)**：取不到内部 Window；所以命令用 `app.get_window("main")`（Manager::get_window，unstable-gated）拿 `Window<Wry>` 给 add_child。
- **sessionId=null 语义碰撞**：现状 `sessionId=null`=空白新会话；浏览器 tab 也无 sessionId → 会被既有逻辑误当空白聊天 tab。靠**联合类型 + 编译器 narrowing** 解决（BrowserTab 无 sessionId 字段）。这是碰核心 pane 系统的主要风险点。
- **聊天连续性不变量**：每组单 ChatPanel 实例、切 tab 不重挂只换 sessionId、PaneLayout v-show 保活防流式掉线。`<component :is>` 别加 per-tab `:key`。
- **坐标换算**：窗口 `decorations(false)` + 主 webview 铺满客户区 → `getBoundingClientRect()`(CSS px) **直接 == Tauri logical px**（devicePixelRatio == scale_factor），无需换算；rect 视口相对，天然吸收滚动。Rust 侧用 `LogicalPosition`/`LogicalSize`。
- **webview2-com 0.38.2 已在依赖树**（wry/tauri 传递），完整 adapter 阶段提为直接依赖、同版本、零风险。下钻裸 WebView2：`Webview::with_webview(|pw| pw.controller())`（门控 `feature="wry"` 默认开）→ `ICoreWebView2Controller` → `.CoreWebView2()` → CapturePreview/CookieManager/ExecuteScript。
- **check-tauri-imports 门面红线**：src/ 禁直接 import `@tauri-apps/*`；useEmbeddedBrowser.ts 已登记例外（桌面壳专属、无远程对应）。新增直接 invoke 的文件要么走 @aide/sdk 门面、要么登记例外。
- **多 webview = 多原生视图**：N 个浏览器 tab 各需一个原生子 webview，各自 sync 到自己的洞；后台/不可见的必须 setVisible(false)。

---

## 6. 暂缓 / 已知限制（按用途）
| 用途 | 状态 | 缺什么 |
|---|---|---|
| ② 浏览任意外站 | ✅ 原型可用 | Step 2 事件通道补加载态/标题/重定向 |
| ③ 预览信任/本地内容 | 🔶 file:// 已放行 | 本地预览 UI 入口 + file:// 根目录白名单守门 |
| ① agent 跑网页任务 | ⬜ 未接 | webview2-com 下钻：CapturePreview 截图 / ExecuteScript 带返回值 / 请求拦截 + MCP 工具接线（sidecar，须同步登记 useCustomizations 前端镜像） |
| ④ 外部登录/OAuth | ⬜ 未接 | CookieManager + `data_store_identifier`/`incognito` 隔离 + `on_navigation` 捕获回调重定向 |

**其它收尾债**：浏览器 tab 跨重启持久化（v1 暂缓）；多浏览器 tab 同时分屏（设计支持、v1 先稳单路径）；macOS/Linux adapter（v2，`UnsupportedEngine` 已占位）；adapter/命令层 instrumented 覆盖率（骨架纯核心已有 41 测对账，见设计文档 §10）；WebView2 Runtime 随包兜底（照 vc_redist NSIS POSTINSTALL，发布前）。

---

## 7. 怎么跑 / 怎么验
- **dev**：`pnpm tauri dev`（首次开 unstable 重编 tauri 几分钟），`Ctrl+Shift+B` 开当前 overlay 原型。
- **Rust 门禁**：`cd src-tauri && cargo check` + `cargo test --lib browser`（避开 codegraph chinese_query 需 Ollama；LNK1104 杀软锁则 sleep 重试）。
- **前端门禁**：`npx vue-tsc --noEmit` + `node scripts/check-tauri-imports.mjs` + `pnpm test`(vitest)。
- **格式化**：`cd src-tauri && cargo fmt -p aide`；前端按项目 prettier（若有）。
- **收尾纪律**（code-architect）：写码者不自评 → Rust 派 `rust-reviewer`、TS 派 `ts-reviewer` 独立审查；带分支函数出覆盖对账表 + 实测证据。
