# agent 自建 tab + parking：让后台标签页继续干活

日期：2026-09-21
状态：**已实现并真机验收通过**（2026-09-21）。

- 单测：Rust `cargo test --lib` 919 passed / 前端+sidecar `pnpm test` 3243 passed / typecheck 通过。
- 真机验收：**14/14 全 PASS**（台账见执行清单）。agent 可判的 1–10 由两个并发 agent 跑
  （A 7/7、B 8/8），人判的 11–14（前台没被抢 / focus 幂等展开 / 托盘里继续跑 / 回归三条）由用户跑。
- 执行清单：`docs/browser-parking-test-checklist.md`；夹具页：`docs/testing/browser-parking-fixture.html`；
  任务拆解与提交对照：`docs/superpowers/plans/2026-09-21-agent-tabs-and-parking.md`。

实现落地清单（提交）：`9b04dc8d` 改名 → `67292c88` parking → `06a733b6` label/origin + 生命周期事件 →
`06ec76fb` 列表命令 → `611c11db` focus → `050fc30c` agent 的五个 tab op + 缺省不猜 →
`4c5525d5` 面板消费 → `85e4c462` browser_tab 工具 → `352a9d85` 可见性收编 → `3715598e` SDK 文案。
基线：v2 spec《内置浏览器 agent 工具 v2》（`docs/superpowers/specs/2026-09-20-browser-agent-tools-v2-design.md`）
——本文档**推翻其两条非目标**，见「偏离记录」。

## 背景

用户的开发流：一个前端项目、**≤3 个 agent 并发**，都用内置浏览器看同一个 dev server，于是面板上有多个 tab。今天的现实是——**agent 想把活干完，必须先把它的 tab 切到前台**：

> 它们工作都需要将 tab 激活走面板上才能完成某些工作。

原因在代码里是确定的：非活动 tab 走 `set_visible(false)` → `wv.hide()`（`adapter/webview2/mod.rs:149`）→ `ICoreWebView2Controller::SetIsVisible(false)`（wry-0.55.1 `src/webview2/mod.rs:1487`）——**内核级隐藏**：不合成、rAF 停摆、动画与过渡不推进、`Page.captureScreenshot` 取不到帧（会一直挂到超时）。而 agent 侧今天**没有任何 tab 级能力**（`agent_bridge.rs` 只有 `ListViews` / `Eval` / `CallCdp` 三个 op），tab 全靠手工开，三个 tab 对着同一个 URL 时 agent 也无从分辨哪个是自己的。

结论：要补的是**两块**，缺一不可——

1. **机制**：把"不显示"从**内核级隐藏**换成**挪出可见区**（parking），后台 tab 继续活着；
2. **归属**：agent 能自己开 tab、自己收，并从创建返回值拿到 `view_id`（不再靠 URL/标题猜）。

## 实测记录（一次性探针，2026-09-21）

探针程序 `%TEMP%\wry-park-probe`（wry 0.55.1 + tao + webview2-com 0.38.2，与 aide 依赖版本一致），同窗口五个同尺寸子 webview，只差"被怎么对待"；fixture 页自报 rAF/点击/可见性。

| 处置 | 5s 内 rAF 增量 | 3s 内 | `document.visibilityState` | 容器 HWND WS_VISIBLE | CDP 真实点击 | `Page.captureScreenshot` |
|---|---|---|---|---|---|---|
| normal（客户区内） | 250 | 150 | visible | true | 落地 | ok（11787B） |
| **hidden（今天的 `set_visible(false)`）** | **0** | **0** | hidden | false | 落地 | **(no reply，合成器永不产帧)** |
| **parked（`SetWindowPos` 到客户区外，不隐藏）** | **250** | **150** | **visible** | **true** | 落地 | **ok（11787B，与 normal 同字节数）** |
| under（与 over 同矩形、被同级窗口压住） | 250 | 150 | visible | true | 落地 | ok |

追加一轮：**顶层窗口 `SW_HIDE`（模拟藏到托盘）期间**，parked 视图 4s 内仍 +276 帧（约 69fps），恢复后 +202（约 50fps）；对照组 hidden 全程 0。

**结论：parking ≡ displayed，除了没人看得见。** 且 parking 与顶层窗口自身的可见性无关——只取决于我们有没有调 `SetIsVisible(false)`。

**顺带证伪**：CDP 注入的真实点击在 **hidden** 视图上也落地（计数 +1 而 `visibilityState=hidden`）。即本仓 `act.ts` 原有假设成立，而"隐藏视图连点击都被丢掉"的说法在真机上不成立（见 [[aide-embedded-browser-input]] 的另一条独立证伪）。

## 目标

- 非显示视图**保持引擎活着**：合成、rAF、动画、真实输入、截图全部与前台视图一致。
- agent 能**自己开 tab**（返回 `view_id`）、**自己收**、导航、把某个 tab 推到用户眼前。
- 用户的面板**不被 agent 静默抢走**；用户自己开的 tab 与 agent 开的 tab 在标签条上一眼可分。
- 删掉因旧隐藏策略而存在的可见性告警机器（`document.visibilityState` 今后恒为 visible）。

## 非目标

- **不做"挂起/休眠"**（把长期无人使用的视图真隐藏以省资源）。≤3 个 tab 的开销用户已确认可接受；真觉得费电再加。
- **不做 agent 身份**（把 view 绑定到具体 agent 会话 id）。归属靠"谁创建的"这一事实 + `label`；缺省 `view_id` 的解析纪律改为"不猜"（见 §4）。
- **不改远程/headless 面**：内置浏览器只有桌面端有，headless 短路照旧（`browserTools.ts:48-50`）。
- **不做「认领用户已开的 tab」**（用户已在两个方案里选了「agent 自己开」）。
- **不做「真实键盘输入」**（`browser_act` 加 `type`：CDP `Input.insertText` + `Input.dispatchKeyEvent`）。`fill` 走脚本置值 + 派发 `input`/`change`，用户在企业表单页上的实战已证明够用（2026-09-21）。**何时该补**：撞上「只在 blur 上跑的校验」或「必须逐键输入才生效的控件」（`filterable` 下拉、富文本）——同一个工具加一个 action，不新增 schema 成本，随时可补。
  另注：`fill` 是脚本路径，隐藏视图上也能用；"能不能后台填信息"从来不是问题，卡住的是渲染被冻（过渡/截图/懒加载），那正是 parking 治的。

## 架构

```text
agent
  → MCP tool browser_tab（sidecar: extensions/browser/tab.ts —— 唯一编排点）
      → browserClient op: open/close/navigate/back/forward/focus
        → Rust runtime/browser_agent.rs（策略层：view_id 解析、默认视口）
          → BrowserFacade（编排：校验 → 引擎 → 注册表 → 广播）
              ├─ 引擎端口 set_displayed(id, bool) → WebView2 适配器 = parking（SetWindowPos 出可见区）
              └─ 事件：browser-view（created/closed）、browser-nav（既有）、browser-focus（请求）
面板（UI 是显示权主人，方案 A）
  ← 命令通道：browser_create / browser_set_displayed / browser_set_bounds / browser_close
```

**为什么显示权留在面板**（而不是把"哪个视图 displayed"搬进领域）：面板的"标签"比"视图"多一维——**空标签没有视图**（`BrowserPanel.vue` 的 `viewId: null`），且标签还有宽度档、浮层让位、最大化等纯 UI 状态。把视图可见性收进领域等于把两套模型缝在一起。所以 agent 的 `focus` 是**请求**（事件），由面板执行。

## 组件（改动文件清单）

### A. Rust：引擎 / 领域 / 桥（`src-tauri/src/`）

| 文件 | 改动 |
|---|---|
| `browser/port/types.rs` | `BrowserView.visible` → `displayed`（含义变精确：露在面板上）；加 `label: Option<String>`；`types_test.rs` 同步 |
| `browser/port/engine.rs` | trait `set_visible` → `set_displayed`；`CreateCfg` 加 `displayed: bool` |
| `browser/adapter/webview2/mod.rs` | **parking 实现**（本文档的技术核心）+ `create` 按 `displayed` 分支 |
| `browser/adapter/unsupported.rs` | 签名同步 |
| `browser/facade.rs` | `set_visible` → `set_displayed`；`create` 接 `label`/`displayed`；**广播 `browser-view`**；新增 `request_focus` → **广播 `browser-focus`** |
| `browser/dto.rs` | `BrowserViewDto.visible` → `displayed`、加 `label`；`CreateBrowserDto` 加 `label?` / `displayed?`；`dto_test.rs` 同步 |
| `browser/agent_bridge.rs` | 新 op：`open` / `close` / `navigate` / `back` / `forward` / `focus`（枚举 + 解析 + 测试） |
| `runtime/browser_agent.rs` | 六个 op 的执行分支；`resolve_view` 规则收紧；`summarise` 带 label 与 parked 标记；**agent 建视图的默认视口（1280×800）也住这里**（`view_id` 解析与默认视口同属"策略层"，门面不参与） |
| `commands/browser.rs` | `browser_set_visible` → `browser_set_displayed`；`browser_create` 透传新字段 |
| `lib.rs` | 命令注册改名 |

（`capabilities/default.json` 无需改：browser 命令未在那里逐条登记。）

### B. 前端（`src/`）

浏览器专属的 composable 收进 **`src/composables/browser/`**（用户 2026-09-21 定）：顶层仍按种类分（components / composables / utils），特性分组在下一层——`components/Browser/` 已是这个形状，此处是同一形状的镜像。**只搬本次要碰的三个**，不做全仓重排；`components/Browser/`（组件）与 `utils/browser.ts`（纯函数）不动。

| 文件 | 改动 |
|---|---|
| `composables/browser/useEmbeddedBrowser.ts`（**移动**） | 命令与类型改名；新增 `onBrowserView` / `onBrowserFocus` 订阅 |
| `composables/browser/useBrowserViews.ts`（**新**） | 常驻订阅（面板未挂载也要接住）：`browser-focus` → `useRightPanel.ensureBrowserShown()` + 存 pending 视图 id；供面板消费 |
| `composables/browser/useBrowserBookmarks.ts`（**移动**，无逻辑改动） | 随目录归一 |
| `components/Browser/BrowserPanel.vue` | 标签随 `browser-view` 增删；**挂载时先拉快照对账**；label 与归属显示；消费 pending focus；调用改名 `setDisplayed`；改 import 路径 |
| `composables/useRightPanel.ts` | 加 `ensureBrowserShown()`：**幂等展开**。现成的 `select()` 是 toggle，agent 的 focus 路径不能用它——用户正看着浏览器时会把面板收起来。（`useRightPanel` 本身是右栏总状态，不属于浏览器特性，**不搬**。） |
| `App.vue` | 挂一次 `useBrowserViews()`（一行接线，逻辑不在 App 里） |
| `scripts/check-tauri-imports.mjs` | 门面例外白名单里的两条路径跟着搬（`:27` `:28`）——这个脚本按**字面路径**登记，不改就红 |
| `components/Browser/BrowserPanel.test.ts`、`Browser/BookmarkFolderMenu.test.ts`、`composables/browser/useBrowserBookmarks.test.ts`、`composables/useRightPanel.test.ts` | 更新（import 路径 + 行为） |

### C. agent-sidecar（**能力只在这里**：`agent-sidecar/src/extensions/`）

| 文件 | 改动 |
|---|---|
| `extensions/browserTools.ts` | 新增 `buildBrowserTabTool` + `buildBrowserTools` 表加一行 |
| `extensions/browser/tab.ts`（**新**） | `browser_tab` 六个 action 的编排、载荷、文案（照 `act.ts` 的组织方式） |
| `extensions/browserClient.ts` | op 类型扩充（六个新 op） |
| `extensions/browserMcp.ts` | `BROWSER_ALLOW_RULES` 加 `browser_tab`；`BROWSER_INSTRUCTIONS` 加"多视图纪律"一节 |
| `extensions/browserSkill.ts` | reference 补契约（何时自己开 tab、focus 的打扰语义） |
| `extensions/browser/visibility.ts`（**删**）、`runEval.ts`、`act.ts`、`format.ts`、`screenshot.ts`、`wait.ts`、`projection.ts`、`actions.ts` | 可见性告警收编（§5） |
| 测试：`browserTools.test.ts`、`browserMcp.test.ts(.snap)`、`runEval.test.ts`、`format.test.ts`、新增 `tab.test.ts` | 更新/新增 |

### D. 唯一一处 SDK 触点（**纯文案镜像，不是能力**）

| 文件 | 改动 |
|---|---|
| `packages/aide-sdk/src/composables/useCustomizations.ts:78` | 内置插件说明里"六个工具"→"七个工具"，并补一句 `browser_tab` 的用途。**不放进 SDK 的是能力**；这一行是 UI 文案，不改则界面说明与实际工具面不符。 |
| `scripts/diag/measure-builtin-mcp.ts` | 工具清单镜像（同类，诊断脚本用） |

### E. 文档

- 本文档；`browser-agent-tools-v2-design.md` 不动（历史记录），偏离在本文档「偏离记录」交代。

## 详细设计

### 1. parking（引擎适配器）

`displayed=false`：
1. 记下当前 bounds（供 `displayed=true` 时恢复，或由面板随后的 `set_bounds` 覆盖）；
2. `wv.set_position(PARK_ORIGIN)` —— **不调 `hide()`、不调 `SetIsVisible`**。

`displayed=true`：`wv.set_position(真实坐标)` + `wv.show()`（`set_bounds` 通常紧随其后）。

- `PARK_ORIGIN` 取一个远超任何真实客户区的固定逻辑坐标（探针用 `(20000, 20000)` 实测有效；子窗口会被父窗口裁掉 ⇒ 人看不见，`WS_VISIBLE` 保持）。
- **`CreateCfg.displayed = false` 时视图以 parked 状态创建**：agent 开的 tab 不该在面板上闪一帧；也消掉今天"create 可见 → 随即被 hide"的中间帧。
- 失败模式：`set_position` 失败**如实上抛**（`EngineError::Internal`），不静默降级成 hide。

### 2. 领域与事件

- `BrowserView.displayed`：语义 = "露在面板上"。`browser_tabs` 输出 `[ready, displayed]` / `[ready, parked]`。
- `label: Option<String>`：创建时可选给；页面没有 `<title>` 时标签条用它。
- **`browser-view` 事件**：facade 在 `create` / `close` 时广播 `{ id, kind: "created"|"closed", label, displayed }`。理由 = 仓库红线「改变状态的操作必须广播」——标签集合是 UI 状态，agent 开关视图必须让面板知道。广播经 `spawn_blocking`（同 `apply_page_load` 的线程纪律）。
- **`browser-focus` 事件**：`request_focus(id)` 只校验 id 存在 + 广播 `{ id }`，**不改任何状态**（显示权在面板）。
- **对账规则**：面板**挂载时先拉 `list_views` 快照**，之后消费增量事件——面板可能晚于视图创建才挂载（agent 先开 tab、用户还没点开面板）。

### 3. 面板

- 标签条出现 agent 开的 tab（来自 `browser-view`），带 `label` 与归属标记（agent / 你）。
- 消费 `browser-focus`：`useBrowserViews` 调 `ensureBrowserShown()`（幂等展开）→ 面板挂载（`browserEverActive`）→ 存 pending 视图 id（住 `useBrowserViews`，`useRightPanel` 不掺和）→ 面板挂载后消费并切到该标签。
- **parking 作用域：所有非显示视图一律 parked**（包括用户手工开的），机制统一，切回来不闪、页面状态还在。
- 关掉 agent 的标签 = `close` 视图（沿用现有行为；agent 下次调用会收到"视图不存在"，可重开）。

### 4. `resolve_view` 规则收紧（多驱动者安全）

`runtime/browser_agent.rs:118-152` 现有规则里有一条**在多 agent 下会静默指向错目标**：

> 缺省 + 恰一个**可见**视图 → 用它

三个 agent 各一个 parked tab、用户正看着其中一个时，agent 省略 `view_id` → 命中用户正在看的那个 tab。**改为**：

1. 显式给了 `view_id` → 必须存在；
2. 缺省 → **仅当全库恰好一个视图**时用它；
3. 其余 → 报错 + 清单（清单带 `label` 与 `displayed/parked`），引导 agent 显式传 `view_id`。

`label` 让清单可读：`browser-2 "vue-admin dev" http://localhost:5173 (parked)`。

### 5. 可见性告警收编（删死代码）

`document.visibilityState` 今后恒为 `visible`，下列机制失去意义，逐个删：

| 落点 | 处置 |
|---|---|
| `runEval.ts`：`probeVisibility` + `EvalProbe.visibility` + 降级包装器里的 `visibility` | 删 —— **顺带省掉每次求值的一次 CDP 往返** |
| `visibility.ts`（`readVisibility` / `hiddenNote` / `appendHiddenNote`） | 删 |
| `act.ts`：`withHidden` / `HIDDEN_CONSEQUENCE` | 删 |
| `format.ts`：告警行（`hiddenNote` 调用） | 删 |
| `screenshot.ts`：HIDDEN 闸 + `outcome.visibility` | 删（parked 截图实测 ok） |
| `wait.ts`：超时诊断里的 hidden 分支 | 删 |
| `projection.ts` / `actions.ts` 信封里的 `visibility` 字段 | 删（无消费方的数据＝死数据） |

**替换物**：host 侧 `displayed / parked`（`browser_tabs` 已在展示）。agent 想知道"有没有人在看"从那里看，语义更准（"没人看"不再等于"引擎冻结"）。

### 6. `browser_tab` 工具（sidecar）

一个工具、一个 action 枚举（**不散成五个工具**——每轮请求多一份 schema 是实打实的成本）：

| action | 入参 | 行为 |
|---|---|---|
| `open` | `url`, `label?` | 新建视图（parked、默认视口 1280×800），返回 `view_id`；文案如实说明"这个视图是 parked 的，没人看得见" |
| `close` | `view_id` | 销毁视图 |
| `navigate` | `view_id`, `url` | 导航（同 URL 按重载，与 facade 既有语义一致） |
| `back` / `forward` | `view_id` | 前进后退（领域层是游标主人） |
| `focus` | `view_id` | 请求面板切到该视图；返回"已请求"而非"已显示"（执行在 UI） |

- `browser_tabs`（列表）职责不变，输出加 `label` 与 `displayed/parked`。
- 失败一律如实文本，不静默降级（沿用既有纪律）。
- 默认视口 1280×800：parked 期间页面按这个宽度布局；用户切过去看时会响应式重排一次（**已知代价**，接受）。

## 降级与错误处理

| 情形 | 行为 |
|---|---|
| `set_position`（park）失败 | `EngineError::Internal` 如实上抛，不回退到 hide |
| focus 的目标视图不存在 | 如实报错 + 清单（panel 可能刚把该标签关掉） |
| focus 时面板未挂载 | 事件照发；`useBrowserViews` 驱动挂载，pending 消费 |
| agent 关掉用户正在看的视图 | 允许（视图是 agent 自己开的），面板收到 `browser-view: closed` 后关标签 |
| headless | 保持现有短路，新工具一并遵守 |

## 测试与验收

**Rust 单测**：`displayed` 领域迁移；`CreateCfg.displayed=false` 时"建了但不 show"的调用契约（适配器层可测调用序列，真机验 parking 效果）；`label` 存取；`browser-view` / `browser-focus` 载荷；`resolve_view` 收紧后的四条规则（含"多视图 + 缺省 → 报错"）。

**sidecar 单测**：`browser_tab` 六个 action 的分发与文案（mock 桥）；`browserMcp.test.ts` 的 `BROWSER_ALLOW_RULES` 精确断言与 instructions 覆盖断言（v2 spec 点过名的两道，别绕）；快照 `-u`。

**真机验收（本需求的正面判据）**：
1. 三个 tab 同时挂同一个 dev server，用户随便看哪个 → 另外两个的 `browser_wait` / `browser_screenshot` / `browser_act` 全部正常。
2. agent `open` 时**不抢**用户前台；agent `focus` 时才切过去。
3. 收起面板、Aide 进托盘 → agent 照常干活（探针已证，真机复核一次）。

**回归**：切标签、浮层让位、关面板保活三条现有行为不退化。

## 风险与未验

1. **parking 坐标的普适性**：探针在 1000×460 窗口上验过 `(20000, 20000)`。实现取固定常量，任何真实客户区都够不着；若将来出现超宽虚拟屏，仍由父窗口裁剪保证不可见。
2. **多视图的资源开销**：每个 parked 视图 ~50fps 真渲染。≤3 个已确认可接受；标签越攒越多时需要"休眠"（本次非目标）。
3. **`browser_tab` 的 token 成本**：新增一个工具 = 每轮请求多一份 schema；本批只加一个，符合 v2 spec 定的纪律。
4. **`focus` 的打扰语义**：agent 主动切走用户正在看的页面是**故意的**（用户选了这个能力）。工具文案要说清，让模型只在真需要用户看时才用。

## 偏离记录（对 v2 spec）

| v2 spec 的结论 | 本文档 |
|---|---|
| 非目标：「**不改隐藏策略**（不试 `Bounds::hidden()`、不加 WebView2 反节流参数）」——那是当时「只做如实上报」的选择 | **推翻**：parking 经探针实测可行，隐藏策略改为 parking。当时未测的正是本文档测的 |
| 非目标：「**不做"多 view 并行"**——让 agent 自己开视图反而要动 UI 契约（新视图得在面板里长出标签页），跨三层」 | **推翻**：用户的多 agent 场景需要它；跨三层正是本次要付的代价（清单见 §组件） |
| P2「可见性如实上报」两个信号都要有 | **收编**：页面侧信号失去意义（恒 visible），只留 host 侧 `displayed/parked` |
| "隐藏视图上点击仍能落下"的假设 | **证实**（探针实测落地），且 parking 后连"过渡不推进"的限制也一并消失 |
