# 内置浏览器 agent 工具 v2：eval 语义、等待原语、可见性如实上报

日期：2026-09-20
状态：**已实现，并已在真机 WebView2 上端到端实测通过**（见「实测记录」）
基线证据：agent 在一轮真实开发（Vue + Element Plus + Vite 项目）中的使用反馈 +
代码走查（正文逐步给出 `文件:行号`，标注「代码事实」与「推断」）

## 背景

用户把 agent 用 aide 内置浏览器工具做完一轮开发后的反馈原样带回来。反馈质量很高，但它把**三类东西混在一起**，直接照单全收会做错事：

| 反馈的坑 | 归属 | 判据 |
|---|---|---|
| 隐藏面板渲染冻结、rAF 停摆、Transition 卡 enter-from | **浏览器行为**（Chromium/WebView2），**扳机在我们** | `useEmbeddedBrowser.ts:71` → `facade.rs:193` → `adapter/webview2/mod.rs:149` 调 `wv.hide()` = `ICoreWebView2Controller::SetIsVisible(false)`（wry-0.55.1 `src/webview2/mod.rs:1487`）。真内核级隐藏，非移出屏幕 |
| `ElMessage` **完全没进 DOM** | **存疑，待复验** | rAF 停摆的标准签名是「元素**在 DOM 里**、停在 enter-from」——Vue 的 `nextFrame()` 卡住只停第一帧，`querySelector` 仍应命中。"完全不在 DOM" 与该签名不符，不作结论 |
| `browser_eval` 不 await Promise | **插件缺陷**（实现 + 文档双缺） | `op:"eval"` 走 `ExecuteScript`（`native.rs:99-115`）。全模块四处讨论 ExecuteScript 契约，**全是"抛异常回 null"，无一处提 promise**（`act.ts:86`、`format.ts:61`、`projection.ts:17`、`native.rs:94`）。观测到的 `{}` 正是 Promise 被当普通对象序列化的签名（**推断**，见「未决问题 1」） |
| `import("/src/...")` 拿到过期模块 | **被测应用（Vite）问题**，非插件 | 裸 `import` 绕过 `?t=` 时间戳。归文档，不归代码 |
| 合成点击降级后"页面没变" | **已如实上报，指错了地方** | `act.ts:155-160` 明说走了 synthetic、且要求 verify。缺的不是 in-act 断言（会让「点了但本就不该变」变成假失败），是**点击之后的确认原语**（= 本设计的 P1） |

**另有一条反馈没提到、走查挖出的更严重问题**：`browser_act` 可能在 CDP 实际拒绝时报成功。见下节。

### 走查新发现：`browser_act` 的假成功

两半都是**代码事实**：

- `native.rs:71-78`：`drill` 拿到 CDP 回包后**只做 JSON 解析**。CDP 的方法级错误是一个合法 JSON 响应体（`{"error":{"code":-32601,"message":"…"}}`），照常解析成功 → Rust 回 `ok: true`。
- `act.ts:102-107`（`cdpClick`）与 `act.ts:207`（`performHover`）：**只看桥层 `ok`**，不看回包里有没有 `error`。

合起来：WebView2 一旦拒绝 `Input.dispatchMouseEvent`，`browser_act` 会回 "Clicked … with a real mouse event via CDP" —— **而它根本没点**。

这个模式代码里是认得的：`screenshot.ts:88-98` 显式识别了方法级 error，`frames.ts:164-168` 识别了 `exceptionDetails`，`browserTools.test.ts:395` 的夹具里就躺着 `'Page.captureScreenshot' wasn't found`。**唯独 act 这条路径漏了。**

它比反馈里那五条都严重：不是"不告诉你走了哪条路"，是**报了个假成功**，且正好解释"返回值说点了、页面没反应"这类幽灵故障。

### 一个改变成本的架构事实

**这批改动不需要动 Rust 一行。** `call_cdp` 是**无白名单的通用透传**（`browserClient.ts:23`；`native.rs:118-158` 只做字符串透传 + JSON 解析），且 `Runtime.evaluate` 这条路径**本机已由 `frames.ts:152-159` 证明可用**。

因此 P0/P1/P2 全部落在 sidecar，正好兑现 `frames.ts:20-21` 那句"把 op 面收窄成三个机制词汇 + 编排留在 sidecar"。

## 目标

- `browser_eval` 的返回值语义**可预测**：`await` 生效；「脚本抛异常」与「确实返回 null」**可区分**。
- `browser_act` 的返回值**不再撒谎**：CDP 拒绝一律如实失败，不报成功。
- agent 获得一条**时序原语**，使"点了之后等结果"从手搓轮询变成一次调用；超时输出**可诊断**，不是假阴性。
- 视图的可见性对 agent **可见**——它是"哪些断言可信"的前提，现在完全不可观测。

## 非目标

- **不做** `browser_network` / `browser_style` / 视觉快照 diff / `browser_open`（下一批，按实测效果再定）。
- **不改隐藏策略**（用户明确选择「只做如实上报」）：不试 `Bounds::hidden()`、不加 WebView2 反节流参数、不碰 `TrySuspendAsync`。零真机风险。
- **不改 Rust、不新增 CDP 事件订阅**（`webview2-com` 安全封装未导出 `DevToolsProtocolEventReceiver`，要用得下钻 `-sys`）。
- **不做"多 view 并行"**：引擎**已支持 N 个视图**（`BrowserPanel.vue:16-17`「每个标签一个原生视图…视图常驻注册表」），`browser_tabs` 也会把隐藏视图连同 id 列出，`runtime/browser_agent.rs:111-152` 按显式 `view_id` 解析。真正卡住的是隐藏视图冻结，即 P2 在治的那个病。让 agent 自己开视图反而要动 UI 契约（新视图得在面板里长出标签页），跨三层。

## 架构

```text
agent
  → MCP tool（aide-browser）
    → sidecar: browser/runEval.ts（新增，**唯一**的求值出口）
        ├─ 主路径: call_cdp → Runtime.evaluate {awaitPromise, returnByValue}
        └─ 降级:   op:"eval" → ExecuteScript
      ← 归一化成 {ok, value} | {ok:false, error, kind}
    → 各工具（read / eval / act / wait）消费同一结果形状
```

两处收口：

1. **求值收口**：`browser_eval` / `browser_read`（投影脚本）/ `act.ts` 的 resolve/fill/fallback / `frames.ts` 的 `evalInContext` 现在**各自直调桥**，四条路径各写一遍 `{ok,…}` 信封解析。全部改走 `runEval`。
2. **可见性收口**：页面侧 `document.visibilityState` 由**我们控制的包装器/投影脚本**统一带出（先例：`projection.ts:151` 的 `out.readyState`），不靠调用方自觉。

## 组件

| 位置 | 职责 | 状态 |
|---|---|---|
| `agent-sidecar/src/extensions/browser/runEval.ts` | 求值出口：CDP 主路径 + ExecuteScript 降级 + 三种失败判据 + 信封归一 | 新增 |
| `agent-sidecar/src/extensions/browser/visibility.ts` | 可见性判读与文案（隐藏时的告警句） | 新增 |
| `agent-sidecar/src/extensions/browser/wait.ts` | `browser_wait` 的轮询编排与超时诊断 | 新增 |
| `agent-sidecar/src/extensions/browserTools.ts` | 加 `buildBrowserWaitTool`；`buildBrowserTools` 表加一项；四处 eval 改走 `runEval` | 改 |
| `agent-sidecar/src/extensions/browser/act.ts` | 方法级 error 判据（修假成功）+ 走 `runEval` | 改 |
| `agent-sidecar/src/extensions/browser/projection.ts` | 信封加 `visibility` | 改（一行） |
| `agent-sidecar/src/extensions/browser/actions.ts` | resolve / fill / fallback 三个信封加 `visibility` | 改 |
| `agent-sidecar/src/extensions/browser/format.ts` | 隐藏时输出告警行；`browser_wait` 的结果渲染 | 改 |
| `agent-sidecar/src/extensions/browserMcp.ts` | `BROWSER_ALLOW_RULES` 加一条 + `BROWSER_INSTRUCTIONS` 加一节 | 改 |
| `agent-sidecar/src/extensions/browserSkill.ts` | reference 补三条契约 | 改 |

**前端镜像两处别漏**（新工具必然触发）：`packages/aide-sdk/src/composables/useCustomizations.ts:78`、
`scripts/diag/measure-builtin-mcp.ts:39`；测试快照 `__snapshots__/browserMcp.test.ts.snap` 需 `-u`。

## P0：求值语义

### `runEval` 的三步判据

1. **主路径** `Runtime.evaluate {expression, awaitPromise: true, returnByValue: true}`（经 `call_cdp`）。
2. **判方法级 error**：照抄 `screenshot.ts:88-98` 的判据（回包里有 `error` 字段即 CDP 拒绝）。命中则**降级到 `op:"eval"`/ExecuteScript**，并把「CDP 不可用」如实带出——**不许静默降级**（`port/engine.rs:145-146`、`act.ts:11-13` 的既有纪律）。
3. **判 `exceptionDetails`**：这是主路径**白拿的收益**——把"脚本抛异常"与"确实返回 null"彻底分开，了结代码里抱怨了四处的老问题。归一成 `{ok:false, kind:"exception", error}`，与 `kind:"unserializable"` 并列。
4. **降级路径不提供 `exceptionDetails`**：ExecuteScript 回 null 时仍走既有的信封约定（`{ok:false}` 自述），文案里说明这条通道分辨不出异常。

### `browser_act` 的假成功修复

`cdpClick` 与 `performHover` 改用 `runEval` 的同一判据：**method-level error 一律不许报成功**。失败文案要区分两种成因（CDP 拒绝 vs 桥层失败），因为它们指向不同的下一步。

### 为什么以 CDP 为主路径

不是"CDP 更高级"，是**语义无歧义**：`awaitPromise` 是 CDP 的显式参数，不随 Evergreen 运行时漂移；而 ExecuteScript 的 promise 行为**外部资料说法不一**（有说必须写顶层 `await`、有说与版本相关），我们**没有本机实测**。主路径换成显式参数，就把这个不确定性从关键路径上移走了。

## P1：`browser_wait`

```
browser_wait(view_id?, until?, condition?, timeout_ms?, interval_ms?)
```

| 参数 | 取值 |
|---|---|
| `until` | `"condition"`（默认）\| `"load"` |
| `condition` | JS **表达式**（`until="condition"` 时必填）。真值即满足 |
| `timeout_ms` | 默认 5000，上限 30000 |
| `interval_ms` | 默认 200 |

### 两条硬约束

**其一：轮询在 Node 侧做，绝不写成页面内 `setTimeout` 循环。** 隐藏视图的 timer 会被降频（后台 5 分钟后可低至 1 次/分钟）——等待本身会被冻掉，"等 5 秒"实际只轮询 4 次。这正是反馈里"假阴性"的来源。主机侧轮询对这个病免疫。

**其二：`until:"load"` 无法用页面内表达式表达，所以必须有这个模式。** `document.readyState` 在跨导航时由**旧文档**回答（永远 `complete`），页面内无从判断"新页面到位没有"。只能从宿主侧轮询 `list_views` 的 `nav.state`（`format.ts:79`，已有四态）。点链接后等页面加载是最高频场景，为此开一个模式是划算的。

四态各自的处置（**不许把终态当"还在等"**）：

| `nav.state` | 处置 |
|---|---|
| `ready` | 满足，返回（附 url/title） |
| `loading` | 继续轮询 |
| `failed` | **立即结束**，不是超时：返回带 `reason` 的失败文本。「等到超时」会把一个明确的加载失败伪装成"慢" |
| `idle` | **立即结束**：视图还没导航过，等下去不会有结果。文案引导先 `browser_act` 点击或用 `browser_tabs` 确认目标视图 |

### 每 tick 的包装器

条件**抛异常不算失败**——`document.querySelector('.x').textContent` 在元素尚未出现时必然抛，那是"尚未满足"，不是错误：

```js
(function () {
  var out = { visibility: document.visibilityState, readyState: document.readyState };
  try { out.value = (CONDITION); out.met = !!out.value; }
  catch (e) { out.met = false; out.threw = true; out.error = String(e && e.message || e); }
  return out;
})()
```

**`condition` 定为同步表达式**（文档写明）。理由：降级路径（ExecuteScript）await 不了 Promise，而两条路径**行为必须一致**——否则同一句条件在有的机器上成立、有的机器上永远不成立，正是本设计要消灭的那类病。若「未决问题 1」的探针证明 ExecuteScript 会 await，可解除此限制。

### 超时：诊断，不是 isError

守 `browserTools.ts:54` 的"永不抛"红线。超时返回：最后一次的 `value` 与异常、`visibility`、`readyState`、轮询次数、实际耗时，以及**一句话结论**：

- 页面报告 hidden → 「这个视图当前不可见。渲染、过渡、动画类条件在此视图里不会推进——把它切到前台，或把条件换成不依赖渲染的判据。」
- 页面可见 → 说明是条件确实未满足，附最后观察到的值，让模型判断是改条件还是改判据。

## P2：可见性如实上报

两个信号**性质不同、都要有**：

| 信号 | 来源 | 现状 | 本设计 |
|---|---|---|---|
| 宿主侧 `visible` | 领域状态（`port/types.rs:205`） | `browser_tabs` 已展示（`format.ts:84`） | 不动 |
| 页面侧 `document.visibilityState` | 引擎的真实认知 | **完全没有** | 包装器/投影脚本统一带出 |

页面侧是**免费**的（就在求值信封里，无需额外往返），而宿主侧要额外一次 `list_views`——所以宿主侧只留在 `browser_tabs`，不往每个工具的返回里塞。

**呈现纪律：只在隐藏时输出。** 正常路径上它是噪音，只在它改变结论时才值钱。落四处：

| 落点 | 行为 |
|---|---|
| `browser_read` / `browser_eval` | 隐藏时追加一行告警 |
| `browser_act` | 隐藏时追加一行（点击可能生效，但点击后的过渡不会推进） |
| `browser_wait` | 超时时进诊断块（见 P1） |
| `browser_screenshot` | 隐藏时明说：`Page.captureScreenshot` 在隐藏视图上可能给的是**旧帧** |

## 降级与错误处理

| 情形 | 行为 |
|---|---|
| CDP 域不可用（Evergreen 漂移） | 降级 ExecuteScript，**如实带出**，不静默 |
| 脚本抛异常 | `kind:"exception"` + 真实错误文本（ExecuteScript 降级路径下说明分辨不出） |
| 返回值不可序列化（循环引用等） | `kind:"unserializable"`，如实说明，不伪装成 null |
| `browser_wait` 超时 | 诊断文本，**非 isError** |
| headless | 保持现有短路（`browserTools.ts:48-50`），新工具一并遵守 |
| 任何 handler 内部异常 | 折成文本，**绝不穿出**（`browserTools.ts:54`） |

## 测试

- **单测（mock 桥）**：`awaitPromise`/`returnByValue` 确实出现在 `call_cdp` 请求里；方法级 error 触发降级**且不报成功**（`browser_act` 那条要有专门的回归测试，钉死假成功）；`exceptionDetails` → `kind:"exception"`；超时诊断文案含可见性分支；`browser_wait` 的轮询次数与 `interval` 一致。
- **纯函数单测**：信封→文案（可见性告警的三种状态各自可辨）；`until:"load"` 对四态 `nav.state` 的迁移。
- **快照**：`browserMcp.test.ts.snap` 需 `-u`。**加工具必然踩到两道断言**，别绕：`browserMcp.test.ts:40-46` 是 `BROWSER_ALLOW_RULES` 的精确数组断言，`:56-61` 强制每条规则的工具名出现在 `BROWSER_INSTRUCTIONS` 里（改名漏改规则 = 工具静默变成要弹窗）。
- **真机验收（步骤 0，**动手前**做）**：见下节。

## 步骤 0：动手前的实测探针

单测**证明不了 WebView2 的真实语义**。所以先花两分钟把 P0 从"推断"变成"测过"——**用现有的浏览器工具就能跑，不需要写代码**：

1. 用户开一个浏览器面板，导航到任意页面。
2. `browser_eval` 跑 `(async () => 42)()` —— **不带 `frame`**，走 ExecuteScript 路径。看回 `{}` 还是 `42`。
3. `browser_eval` 带上 `frame: <主文档 URL 的子串>` —— 走 CDP `Runtime.evaluate`（`frames.ts:152-159`，且该路径**未传 `awaitPromise`**，正是 P0 要修的形状）。
4. 对比两次结果，即可判定：ExecuteScript 是否 await、CDP 缺 `awaitPromise` 时的实际返回形状。

**代价明示**：需要用户开一次面板。**若用户不愿付**，则按推断实施，并把降级路径的文案写厚（`condition` 的同步限制保持），验收改由实机反馈完成——那是不想走的路，但比假装测过好。

## 风险

1. **`Runtime.evaluate` 不带 `contextId` 的默认上下文行为**在本机**未验**（`frames.ts` 走的是 `createIsolatedWorld` 拿到的 contextId）。步骤 0 的探针第 3 步会间接覆盖；若默认上下文不可用，主路径退化为"每次都建隔离世界"，多一次往返。
2. **`returnByValue` 对循环引用/超大值的返回形状未验**。归一化按"可能缺字段"写（照 `format.ts` 的守门纪律），不猜。
3. **假成功 bug 的真机触发需要 WebView2 真的拒绝 `Input.dispatchMouseEvent`**。代码事实已确认（回包不判 error 就报成功），但**是否曾真实发生未验**——修复不依赖这一点，它是纪律问题，不是概率问题。
4. **`condition` 强制同步**是一个**用户可感知的限制**。若探针证明 ExecuteScript 会 await，应立即解除并在 spec 里记偏离。
5. **工具的 token 成本**：新增一个工具 = 每轮请求多一份 schema。本批只加一个（`browser_wait`），符合这条纪律；后续批次要按同一标准审。

## 实测记录（2026-09-20，真机 WebView2）

步骤 0 的探针 + 三次端到端复跑，全部在**用户桌面上的 dev 实例**（`node dist/runtime.js`）里做。
六项判据全部通过：

| 探针 / 判据 | 结果 |
|---|---|
| `(async () => 42)()` 走 ExecuteScript | `{}` —— **不 await**，agent 的反馈逐字坐实 |
| `(async () => 42)()` 走 CDP（未传 `awaitPromise`） | `{}` —— 旧 frame 路径同病 |
| `var x = 1; x + 2` 走 ExecuteScript | `3` —— **多语句是既有用法**（见「返工一」） |
| `(async () => 42)()` 走新 `runEval` | **`42`** —— `awaitPromise` 生效，P0 达成 |
| `var x = 1; x + 2` 走新 `runEval` | **`3`** |
| `nope()` 走新 `runEval` | `The page script threw: ReferenceError: nope is not defined` |
| `browser_wait {until:"load"}` 在已加载页上 | 如实回"本来就没在加载"，**不假装等到** |
| `browser_wait {condition}` | `Condition met after 1 poll(s)` |
| `browser_read` / `browser_eval` 在隐藏视图上 | 带 `hidden from the engine` 告警 |

**顺带确证**：宿主侧 `visible:false` 与页面侧 `document.visibilityState:"hidden"` **一致**（无假警报）；
且**跟 agent 对话时浏览器面板默认是收起的**（`App.vue:387` 面板互斥）——「隐藏视图」是主路径而非边缘情况。

## 返工记录：两处被实测推翻的设计

这两条是本文档最该被读到的部分——它们都是**单测全绿、真机全错**。

### 返工一：包装器（`await (${script})`）弄坏了多语句脚本

原设计给调用方的脚本套一层 async 包装，好处是顺带拿到页面自述状态。**实测推翻**：
裸通道回的是脚本的**完成值**，`var x = 1; x + 2` 本来能回 `3`；包进 `( ... )` 就变成语法错误。

第一次补救**也错了**：想靠"错误文本里有没有 `SyntaxError`"决定要不要脱壳重试。实测发现
CDP 对**解析错误**只回一个光秃秃的 `Uncaught`，不含类型名，**字符串匹配从未命中**。

**最终做法：CDP 路径不加任何包装**，脚本原样送 + `awaitPromise`；页面自述状态改由一次
**独立的廉价求值**取回。零语义偏移，多一次本地往返。

### 返工二：`exceptionDetails.text` 只有 `"Uncaught"`

脚本**同步抛出**时（不加包装后就是这样），CDP 的 `exceptionDetails.text` **只有一个词
`Uncaught`**，真正的原因在 `exceptionDetails.exception.description`。只读 `text` 的结果是
agent 拿到一句没有信息量的话。现取 `description` 的第一行（后面是栈，对模型是噪音）。

**教训（写给下一次动求值语义的人）**：形状这种东西猜一次错一次。这一批三次返工里有两次，
根因都只是"我没有真回包"。**下次第一步是拿真回包，不是写实现。**

## 未决问题

1. ~~ExecuteScript 的 promise 语义~~ —— **已答**（实测表第 1 行：不 await）。`browser_wait`
   的 `condition` 保持**同步表达式**限制：降级路径 await 不了 Promise，而两条通道行为必须一致。
2. **`ElMessage` 完全不在 DOM** 的现象是否真实存在（背景表第 2 行）。本批只把可见性变成可观测，
   让下次能一眼分辨；要继续追需要一次带 `MutationObserver` 的复现脚本——**不属于本批**。
3. **下一批做什么**（`browser_network` / `browser_style` / 视觉快照 diff / `browser_open`）——
   等本批在**真实项目**上跑过一轮（本次只做了模拟自检，Element Plus 控件、Vue 过渡、
   拦截器断言那三类场景造不出来），按残留痛感定序，**不在本 spec 预设**。
4. **工具链挂在哪个实例上**：本次实测踩到一次——对话跑在**安装版**里，而 `dist/runtime.js`
   的改动只影响 **dev 实例**（安装版用 `AppData\Local\Aide\agent-runtime\aide-agent.exe`，
   独立打包、不受仓库构建影响）。**重建 dist 后必须确认对话所在实例**，否则验的是旧代码。
