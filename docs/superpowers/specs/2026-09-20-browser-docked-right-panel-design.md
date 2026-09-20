# 内嵌浏览器改停靠右栏：单例槽位 + 宽度档案 + 最大化铺满 + 截图如实失败

日期：2026-09-20
状态：**设计定稿，待实现**（实现计划见 `docs/superpowers/plans/`，由 writing-plans 产出）
基线证据：2026-09-20 真机复现（截图 10s 超时）+ 代码走查（正文逐条给 `文件:行号`，标注「代码事实」与「推断」）

## 背景

### 病根：用户看着聊天时，浏览器视图必然是隐藏的（实测）

2026-09-20 在一台真机 Aide 上复现并测量：

| 观测 | 值 | 判据 |
|---|---|---|
| `browser_tabs` 返回的视图状态 | `[ready, hidden]` | 宿主侧领域状态 |
| `document.visibilityState` | `"hidden"` | 页面自述 |
| JS 上下文 | **活着**（脚本有返回值、DOM 可读） | 求值正常 |
| `requestAnimationFrame` 循环 | 装好数秒后 `frames = 0`、`firstAt = null` | **引擎一帧都不合成** |
| `Page.captureScreenshot` | 10s 无回包，落到 `NATIVE_TIMEOUT` | `native.rs:38` |

隐藏动作链（**代码事实**）：面板不可见 → `BrowserPanel.vue:379-382` → `hideTab()` `:142-145` → `browser_set_visible(id,false)` → `adapter/webview2/mod.rs:149-158` 的 `wv.hide()` → wry 0.55.1 `src/webview2/mod.rs:1487` 的 `ICoreWebView2Controller::SetIsVisible(false)`。**这是内核级隐藏**，不是把窗口移出屏幕：Chromium 停止合成、rAF 停摆、timer 降频（`visibility.ts:1-17` 已把这套语义写进代码）。

超时文案把原因指错了（**代码事实**）：`native.rs:75-77` 回 `"native call got no reply within 10s (view closed mid-flight?)"`；`screenshot.ts:80-87` 再转一手成 `"was the view closed mid-call?"`。实际视图**没关**，它只是被隐藏了——错因把当场的 agent 引向了"窗口最小化/被遮挡"的错误方向。

### 为什么隐藏是主路径而不是边缘情况

浏览器当前是**主区一级视图**，与聊天在同一个 `v-show` 条件上互斥（`App.vue:1029-1040`：`PaneLayout` 的 v-show 含 `!browserPanel.panelOpen.value`），而选中会话还会主动关面板（`App.vue:401` `browserPanel.closePanel()`）。于是：

> **「用户在看着聊天」与「浏览器视图有合成帧」在当前布局里不可能同时成立。**

而 agent 的视觉类工具（`browser_screenshot`、过渡/动画类断言）**以合成帧为前提**。用户上一轮的结论是准确的：这不是操作问题，是设计冲突。

### 这笔代价是记过账的，只是到期了

- 09-10 原方案：浏览器 = 会话式 tab，**能与会话并排/分屏共存**（`docs/superpowers/plans/2026-09-10-embedded-browser-handoff.md:21`，当时明确否决了「主区一级视图」）。
- 09-15 改形态为「主区一级视图」，理由是把风险面从"碰全 app 最纠缠的聊天渲染"缩到"加一个自包含面板"，同段末尾写着代价原文：**浏览器不再能与会话并排分屏**（`docs/superpowers/plans/2026-09-10-embedded-browser.md:316-329`）。
- 09-16/09-20 接上 agent 读写与截图工具后，这笔代价到期。

### 现状尺寸为什么不满足（**代码事实**）

- `App.vue:100-105`：`rightResize = useResizable({ cssVar:"--aide-right-w", initial:340, min:300, max:540 })` —— 右栏上限 540px。
- `App.vue:119-123`：轨道 `left | 1px | minmax(400px,1fr) | 1px | right` —— 中心区保底 400px。
- 用户要求浏览器"至少和对话五五开"，540px 差得远。

## 目标

1. **停靠态**：浏览器与聊天同屏；切会话不踢浏览器。
2. **最大化保留**：视觉上等于今天的全屏浏览器，但**不搬 DOM**（不引入 teleport / 第二挂载点）。
3. **右栏宽度分档**：窄档给现有 7 个工具 tab（原样），宽档给浏览器（默认 ≈ 窗口 50%，聊天 400px 底线优先）。
4. **截图如实失败**：视图隐藏时**立即**返回可行动的错误，不烧 10 秒、不说 `view closed`。

## 非目标

- **不动** `PaneLayout` / 聊天渲染 / `TabItem` 联合类型——09-15 换形态的最大收益（聊天接线零改动）必须保持。
- **不做**"浏览器与文件树同时并排"：右栏是单例槽位，浏览器与「文件/变更/Git」互斥（用户 2026-09-20 已确认接受）。
- **不改隐藏策略**：`Bounds::hidden()`、WebView2 反节流参数、`TrySuspendAsync` 一律不碰（2026-09-20 决定：只做如实上报）。
- **宽度不持久化**：只存内存，跨重启按窗口重算（用户 2026-09-20 定）。

## 架构

状态单一来源：**`useRightPanel` 是"右栏显示什么"的唯一主人**，浏览器不再持有自己的开合状态。

```
        ┌─────────────── useRightPanel（模块单例）───────────────┐
        │  collapsed: boolean      tab: RightTabId（含 "browser"） │
        │  maximized: boolean      widths: { narrow, browser }    │
        └───────┬──────────────────────┬──────────────────┬──────┘
                │                      │                  │
     App.vue 读它算轨道           rail / 快捷键写它    useResizable 读档位
     （gridTemplateColumns）    （select / setMaximized）（clamp 与回落）
```

| 概念 | 定义 | 消费者 |
|---|---|---|
| `browserActive` | `tab === "browser" && !collapsed` | 视图可见性总闸（`viewAllowed`）、`everOpened` 懒挂载 |
| `maximized` | **不变量**：仅在 `browserActive` 时可为 `true` | `gridTemplateColumns` 分支、其它主区面板的互斥 |
| `wide` | `browserActive && !maximized` | `useResizable` 的档位选择（浏览器档 vs 窄档） |

## 组件

### 1. `useRightPanel`（新建，模块单例）

- 状态：`collapsed`（默认 `true`，沿用现状）、`tab`（默认 `"files"`）、`wantMaximized`（内部 `ref`，默认 `false`）、`widths.narrow` / `widths.browser`（内存，`0` = 未初始化）。
- **不变量用派生值守，不靠断言**：对外暴露 `maximized = computed(() => wantMaximized.value && browserActive.value)`。折叠 / 切 tab 时 `wantMaximized` 原样留着，派生值立刻为 `false`（回到浏览器 tab 会自然恢复最大化——这一条是有意的，不做额外清理）。
- `select(id)`：沿用 `App.vue:330-341` `onRailSelect` 的现裁决——折叠态点任意项展开并激活；已激活项再点 = 折叠；未激活项 = 切换。
- `setMaximized(b)`：只写 `wantMaximized`；不是 `browserActive` 时派生值为 `false`，无需调用方前置判断。
- `useBrowserPanel`（`composables/useBrowserPanel.ts:20-33`）**收缩**为只提供 `everOpened`（首次打开才挂异步 chunk）；`openPanel/closePanel/togglePanel` 删除，调用方改走 `useRightPanel`。

### 2. `useResizable` 加"档案"

现状是一次性 `{cssVar, initial, min, max, direction}`、值只存内存（`useResizable.ts:1-43`，**代码事实**：`max` 在 `onMousedown` 的闭包里读，改成函数即支持动态上限）。

```ts
interface ResizableProfile { initial: number | (() => number); min: number; max: number | (() => number); }
interface ResizableOptions { cssVar: string; profiles: Record<string, ResizableProfile>; active: () => string; direction: "left"|"right"; }
```

- **窄档**（`narrow`）：`{ initial: 340, min: 300, max: 540 }` —— 与今天完全一致。
- **宽档**（`browser`）：`{ initial: () => Math.round(appW * 0.5), min: 420, max: () => appW - leftTrackW - 400 - 2 }`。
  - `-2` = 两条 1px 分隔线轨道；400 = 中心轨道 `minmax(400px,1fr)` 的保底（**聊天底线优先于五五开**）。
  - `max < min` 的极端窗口（< ~1100px）按 `min` 收，允许中心区被压破 400px 底线由 `overflow` 兜（不新增断点逻辑）。
  - `appW` / `leftTrackW` 从 `.app-layout` 现测（`getBoundingClientRect`），无新状态。
- **值的主人**：两个档位的数值存在 `useRightPanel.widths`（单一来源）。`useResizable` 只做两件事——① `active()` 变化时把该档的值写进 `cssVar`（为 `0` 时先用 `initial()` 算出并存回）；② 拖动时 clamp 后写回该档。它**不再把 `size` 当真相**（`size` 目前无任何消费者，`App.vue` 只用 `isDragging` / `onMousedown`——**代码事实**）。
- 拖过的值在同一次运行内记忆（跨 tab 往返恢复），**不落盘**。

### 3. 布局与 DOM（`App.vue`）

- `gridTemplateColumns`（`App.vue:119-123`）加分支：
  - `maximized` → `left | 1px | 0px | 1px | 1fr`；
  - 否则 → 现状（右 = `rightCollapsed ? var(--aide-rail-w,40px) : var(--aide-right-w,300px)`）。
- 中心区 v-show（`App.vue:1037`）：追加 `&& !rightPanel.maximized.value`——聊天**v-show 保活，不卸载**（与今天同语义）。
- `BrowserPanel.vue` 从中心区搬到 `.panel-right-inner` 内（`App.vue:1052-1088`），挂在 `rightTab === "browser"` 的 v-show 分支上，与「文件/变更/Git/…」并列。组件内部**一行不改结构**：它自带的标签条 + 工具栏 + 「洞」原样成立，只是洞的 rect 由右栏内容区量出来。
- 浏览器**退出**三处主区逻辑：`closeOtherPanels`（`App.vue:386`）、中心 v-show 条件（`:1037`）、`onSessionChanged`（`:401`）。
- 与其它主区面板（插件 / 知识库 / 自动化 / 观测台）：
  - 打开任一个 → `setMaximized(false)`；
  - `maximized = true` → 复用 `closeOtherPanels("browser")` 关掉它们。
- rail 视觉**沿用现有激活语义**（`tab === "browser"` 即激活），不为最大化新增专属样式——多一种状态就多一处要对账的地方。

### 4. 入口

| 入口 | 现状 | 改后 |
|---|---|---|
| 左栏第 5 行 | `SidebarNavGroup.vue:32` | **删除** |
| 右栏 rail | 无 | 新增第 8 个图标（浏览器）→ `select("browser")` |
| `Ctrl+8` | 无 | 同 rail 点击（`RAIL_DIGIT_TABS`，`App.vue:344-350`） |
| `Ctrl+Shift+B` | `App.vue:676` `togglePanel()` | `select("browser")`（已激活则折叠，语义与 rail 一致） |

**改造清单**（2026-09-20 全仓 grep：`useBrowserPanel` 的消费者只有下列 9 处，无其它遗漏）：

| 位置 | 现状 | 改后 |
|---|---|---|
| `App.vue:178` | `const browserPanel = useBrowserPanel()` | 改取 `useRightPanel` |
| `App.vue:386` | `closeOtherPanels` 里的 `browserPanel.closePanel()` | **删该行**（浏览器不再占主区） |
| `App.vue:391` | `watch(browserPanel.panelOpen)` → `closeOtherPanels("browser")` | **删该 watch** |
| `App.vue:401` | `onSessionChanged` 里的 `closePanel()` | **删该行** |
| `App.vue:676` | `Ctrl+Shift+B` → `togglePanel()` | `select("browser")` |
| `App.vue:1032-1033` | 主区挂载 `v-if/v-show` | 迁进 `.panel-right-inner`（`rightTab === "browser"` 分支） |
| `App.vue:1037` | 中心 v-show 里的 `!browserPanel.panelOpen.value` | **删该 term**（换成 `!rightPanel.maximized.value`） |
| `BrowserPanel.vue:44` | `const { panelOpen, closePanel } = useBrowserPanel()` | `useRightPanel` 的 `browserActive` / `select` |
| `SidebarNavGroup.vue:15,32` | 左栏入口一行 | 删除（含 import） |

### 5. 截图如实失败（sidecar + Rust）

- **sidecar**（`browserTools.ts:305-320`）：调用 `captureScreenshot` **之前**先 `probeVisibility(args.view_id, emit)`（与 caption 用的是同一个探针，`runEval.ts`；代价 = 一次本地往返，只加在这条本就最贵的路径上）。
  - `hidden` → **不发** `Page.captureScreenshot`，直接 `textResult` 回一条可行动的失败文案：视图被 Aide 隐藏（右栏折叠 / 当前不是浏览器 tab / 有浮层在让位）、隐藏的 WebView2 不合成帧、这不是页面问题、让用户把浏览器 tab 切到前台或改用 `browser_read`/`browser_eval`。
  - `visible` / `unknown` → 照旧截图（`unknown` 不拦：没有依据时不拦路）。
- **`screenshot.ts:111-113` 的注释订正**：现文说隐藏视图"交出来的往往是上一次合成的那一帧"——**该说法未经验证**；实测行为是**压根不返回**（10s 超时）。改后的 caption 只在"判可见成功、截图返回"这条路径上说事：极端竞态下这一帧可能已过期。
- **`native.rs:75-77` 文案订正**：`"view closed mid-flight?"` → 不指名单一原因的等价表述（如 `"no reply within 10s (the view may be closed, or a compositor-dependent call on a hidden view)"`）。下钻层是通用骨架，**只做不撒谎的枚举，不猜**。
- `screenshot.ts:80-87` 的 timedOut 文案同步订正。

## 降级与错误处理

| 情形 | 行为 |
|---|---|
| 视图隐藏（面板折叠 / 非激活 tab / 浮层让位） | 截图**立即**失败，文案点名隐藏与出路（不烧 10 秒） |
| 判可见后、截图返回前被隐藏（竞态） | 仍落 10s 超时，文案不再说 `view closed` |
| 页面侧探针拿不到自述（`unknown`） | 照旧尝试截图（`visibility.ts:14-18` 的"没依据不猜"纪律） |
| 最大化时窗口过窄（宽档 clamp 到 min） | 聊天区允许被压破 400px 底线，由 `overflow` 兜，不新增断点 |
| 右栏折叠态收到截图请求 | 与"视图隐藏"同路（`browserActive === false`） |

## 测试

- **`useRightPanel`（新建单测）**：`select` 三态裁决；派生 `maximized`——折叠 / 切到别的 tab 后必为 `false`、切回浏览器 tab 自动恢复 `true`；宽度档位切换与 `max<min` 的收敛。
- **`useResizable`（新测或补测）**：档案切换写入/恢复、动态 `max` 函数生效、拖动写回当前档。
- **`BrowserPanel.test.ts`（改造现有）**：两条回归（遮罩让位、切 tab 隐藏）在新宿主下仍绿；视图 id → `setVisible` 的调用序列不变。
- **`browserTools.test.ts`（补）**：隐藏视图 → **不发** `Page.captureScreenshot`（断言 query 次数），文案含 hidden 与出路；可见 → 照旧发。用现有 mock 桥夹具（`browserTools.test.ts:495` 一带已有截图夹具）。
- **Rust**：`native.rs` 只改文案，无新测；`cargo test --lib` 保持绿。
- **门禁**：`vue-tsc --noEmit`、`npx vitest run`（全仓）、`pnpm check:sync-io`、`check:overlay-layers`、`check-tauri-imports`。

## 真机验收清单（手动，必须逐条过）

1. **停靠态**：右栏 rail 点浏览器 → 聊天与页面同屏；`browser_screenshot` **能出图**（本改动的正经验收点）。
2. 拖宽档到 ≈50%：洞的 rect 跟着变、聊天不被压破 400 底线；窄档 tab 宽度与今天一致。
3. **最大化**：铺满、聊天让位（不卸载）；还原后浏览器回到右栏原宽度。
4. **切会话**：浏览器不被踢（对比现状 `App.vue:401`）。
5. **浮层让位**：设置 / Ctrl+P / 权限弹窗 / 右键菜单弹出时视图隐藏、关闭后回来。
6. **文件窗口层**：最大化时 `FileViewer` 量到 0 宽 → 缩没、还原后自动回来；验证不出现"露半个窗口"（`FileViewer.vue:51-54,145-149` 依赖 `.panel-center` 包围盒）。真露 → 进最大化前先收起它。
7. **快捷键**：`Ctrl+8` / `Ctrl+Shift+B` / rail 点已激活项折叠，三者语义一致。
8. 左栏不再有浏览器入口；`Ctrl+Shift+B` 仍可达。

## 风险

| 风险 | 说明 | 处置 |
|---|---|---|
| `App.vue` 是最纠缠的文件 | 中心 v-show 链（`:1029-1040`）与 `closeOtherPanels`（`:386`）是本改动唯一的"牵一发动全身"处 | 只在链路里**删一个 term / 加一个 term**，不重构该函数；改动点写进计划的 checklist |
| 右栏单例导致浏览器与文件树互斥 | 用户已确认接受 | 非目标里写明，不再讨论 |
| 原生视图让位语义被误伤 | `viewAllowed` 判据从"面板开"改成"浏览器 tab 激活"，`overlayLayerOpen` 不动 | 真机验收第 5 条覆盖 |
| 宽档 50% 在小窗口不成立 | clamp 后可能贴着 min=420 | 降级表已定：聊天底线优先 |
| 两份状态（`rightTab` 与 `useBrowserPanel`）对不上账 | 历史上有过类似分裂 | `useBrowserPanel` 收缩到只剩 `everOpened`，开合只认 `useRightPanel` |

## 未决问题

1. **`unknown` 可见性要不要拦截图**：本设计选"不拦"（没依据不猜，`visibility.ts` 的既有纪律）。若真机上 `unknown` 高频出现（探针脚本没跑到包装器返回那一步），再回来收紧。
2. **宽档默认 50% 是否偏大**：小窗口（1440 宽、左栏固定）下 50% 会让聊天只剩 ~620px。实测手感后再调，不进 spec 硬编码。
