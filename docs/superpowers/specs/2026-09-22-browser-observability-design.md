# 内置浏览器 agent 工具 v3：可观测层（网络 / 控制台）+ 四条实测 gap

日期：2026-09-22
状态：**已实现并真机验收通过 17/17**（2026-09-23，台账见 `docs/browser-observability-test-checklist.md`）。
注入路走了两轮：CDP `Page.addScriptToEvaluateOnNewDocument` 在本机 WebView2 上**被接受但不交货**
（新文档里没有探针，而桥上 `ok:true`、无方法级 error——**失败是静默的**，"出错再回退"那种链根本不会触发），
⇒ 改走 WebView2 宿主 API `AddScriptToExecuteOnDocumentCreated`（`0d140fad`）后**交货**，门禁与判据 1–5 复跑全过。
（顺带实测结论：`NAV_SETTLE_MS = 250` **够用**，普通跨文档导航无一次误报；CDP `clip` **确为文档坐标**，
滚动页上的 `position: fixed` 元素也裁对了——这条**证伪**了"检测 fixed 就不加滚动偏移"的修法，别照做。
验收另发现并已修一条：体积闸门把"没读正文"塞进 `err`，导致 200 被计入失败摘要。）
上一版：`2026-09-20-browser-agent-tools-v2-design.md`（求值语义 / `browser_wait` / 可见性如实上报）
——**动手前先读它**，尤其是它末尾的「返工记录」两节

基线证据：agent 在一轮真实开发（Vue + Element Plus + 管理后台审批流）里用 aide-browser
的完整反馈原文（本文档第 1 节逐条摘录）+ **本轮设计前在真机 WebView2 上跑的探针**（第 13 节，
逐条可复跑）+ 代码走查（正文给出 `文件:行号`，标注「代码事实」与「推断」）

---

## 0. 给新会话的交接（先读这一节）

你手上没有上一轮的对话上下文。三句话补齐：

1. **agent 的结论是「读和点都够用，缺的是看请求、看控制台」**。它靠现有工具走通了读页面、
   点按钮、翻页、开弹窗、读审批进度全流程，没有出现"点错元素"这类不可逆误操作。
   最大的空白是两个**同名**工具：`browser_network` 与 `browser_console`。
2. **昨天（09-21 22:18 ~ 09-22 00:57）已经落过一批浏览器优化**，反馈里有三条是**那批刚做完的**
   ——第 2 节给了逐条对照，**别重做**。
3. **动手第一件事不是写代码，是跑第 12 节的「步骤 0」探针。** 上一版 spec 的血泪教训原文：
   *「形状这种东西猜一次错一次。这一批三次返工里有两次，根因都只是"我没有真回包"。
   下次第一步是拿真回包，不是写实现。」*

本批共 9 项：1 个注入机制（地基）+ 2 个新工具 + 4 条真 gap + 2 个小件。

---

## 1. 前因：这份 spec 从哪来

### 1.1 agent 的反馈原文（摘录，保持原话）

**真实碰到的问题**

1. `browser_tab navigate` 到 hash 路由会"报成功但没生效"——最近真 bug 的一条。navigate 到
   `http://localhost:3000/#/failure-to-report`，工具返回的 URL 就是新地址，但紧接着 `browser_read`
   拿到的仍是 `/#/repair-handle`。再调 `browser_wait until:"load"` 又说"没有导航在进行"。
   对 hash 路由的 SPA，同文档导航不触发 load，工具似乎把**请求的 URL 当作当前 URL 回报**了。
   最后改用点侧边栏链接才进去。
2. `location.reload()` 之后，`browser_wait` 的条件会被「重载前的旧文档」满足——条件"出现审核人员
   且没有 暂数据"，第一次轮询（200ms）就成立，可随后 eval 出来 `rows: []`。这类"旧文档先满足"的
   假阳性，比超时更难发现。
3. 文本点得容易撞上非可点击元素——点"确定"命中的是提示文案「确定通过审核？」，工具拒绝执行并提示
   用 selector。**这个行为本身是对的**（宁可拒绝也不乱点）。但 EP 把双字按钮渲染成「确 定」
   （中间有空格），文本匹配就很不友好；最后只能落到 `.app-dialog__savebtn`。
4. 选择器没有可见性过滤——EP 的弹窗关闭后仍留在 DOM 里，`.app-dialog__savebtn` 到底会命中哪个
   心里没底，只能先用 `browser_eval` 枚举弹窗探路。这次侥幸命中，但属于赌。
5. `browser_read` 的 Raw text 段没做隐藏过滤——日期选择器的日历、成串的数字列表都混进来了，
   "\*1308+ 隐藏元素"只在 NOTE 里提了一句。**skeleton 部分干净，Raw text 部分明显更脏。**

**最缺的两个功能**

- `browser_network` — "本轮最大的空白。审批没推进、审核配置页空白，最快的诊断路径就是
  '刚才那个请求返回了什么'，但这个信息我拿不到，只能绕到 Bash 里 curl 重建请求。
  一个能列出最近 XHR/fetch（方法/URL/状态码/响应片段）的工具，能帮我相当一部分往返。"
- `browser_console` — 同源问题。"审核配置页空白其实是后端返回了
  `No enum constant ... EQUIPMENT_MAINTENANCE_TASK_AUDIT`，但被前端错误处理吞了；
  如果能看到 console 里的报错或未捕获异常，定位会快很多。"

**其他想要的**

- `browser_act` 的预演模式：先列出所有匹配元素让我挑，再执行。现在 `index` 的"最匹配优先"
  语义不好预测。
- `navigate` 后回报实际观测到的 URL，或对同文档导航显式等待策略变化（呼应第 1 条）。
- 元素级截图：整页截图因上下文成本全程没用（这个取舍提示是对的），但"只截这个按钮"
  很多时候便宜且决定性。

**明确好用的部分**（改这批时别弄坏）

- `browser_eval` 是主力——返回 JSON、插错如实上报、能读 frame，用它紧凑地贴表格行，
  比 `browser_read` 省很多上下文字数。
- `browser_act` 拒绝执行并给出候选与替代建议的报错质量很高。
- `browser_tab` open 的 parked 视图 + 不抢面板 + label 都对路。

**一句话总结**（用户原话）：读和点都够用，缺的是「看请求、看控制台」这层→而驱动一个 SPA 时，
这层往往正是卡住时唯一想知道的东西。

### 1.2 这份反馈跑在哪个构建上

反馈里同时出现 `browser_tab`（`85e4c462`，09-21 22:39）与"隐藏元素只在 NOTE 里提了一句"
（`f0104d22`，09-22 00:42 的 `hiddenSkipped` NOTE）——**说明 agent 跑的是 ≥ `f0104d22` 的构建**。
所以第 2 节的"已完成"对照是有意义的：反馈不是旧构建的陈旧抱怨，而是**那批修完之后**的残留痛感。

### 1.3 上一版 spec（v2）留下的接口

v2 已落地并在真机验收通过（14/14）。本批直接复用、不重造：

| 已有机制 | 位置 | 本批怎么用 |
|---|---|---|
| `runEval`：唯一求值出口，CDP `Runtime.evaluate{awaitPromise,returnByValue}` + ExecuteScript 降级 + 三种失败判据 | `browser/runEval.ts` | recorder 的读写都走它 |
| `call_cdp` 通用透传（**无方法白名单**） | `browserClient.ts:23`；Rust 侧 `native.rs:118-158` 只做字符串透传 + JSON 解析 | 注入与截图裁剪都靠它，**可能一行 Rust 都不用改** |
| `frames.ts` 的 `frame` 参数（按 URL 子串进 iframe） | `browser/frames.ts` | 两个新工具的 `frame` 参数照抄 |
| `browser_wait` 的宿主侧轮询 + 诊断式超时 | `browser/wait.ts` | 本批给它补文档身份（P2-2） |
| 元素解析（`labelOf` / `describe` / 可见性判据） | `browser/actions.ts`、`browser/clickable.ts` | 元素级截图与歧义报数都复用 |

---

## 2. 反馈条目 × 现状对照（**别重做已完成的**）

逐条对着**代码**（不是提交信息）核对过：

| # | 反馈条目 | 现状 | 证据 |
|---|---|---|---|
| ③ | 文本点撞上非可点击元素 | **已修** | `clickable.ts` 一份判据喂 read+act（`f0104d22`）+ `6fbe89ec` 的「可点过滤（自己或祖先）」让那条分支在真页面上够得着。反馈里那句"工具拒绝执行并提示用 selector，这个行为本身是对的"——**描述的正是修完后的行为** |
| ③残 | 「确 定」中间的空格 | **真 gap** | `actions.ts:79` 的 `labelOf` 把空白折成**单空格**，`确 定` 既不等于也不包含 `确定`。已逐字复现（第 13 节 R3） |
| ④ | 选择器没有可见性过滤 | **已修** | `actions.ts:184-193`：先 `visible()` 过滤，可见的优先，全不可见才回退全集 |
| ④残 | 命中歧义不报数 | **真 gap（小）** | `actions.ts:192` 已经算出了 `count`，但 `act.ts` / `format.ts` **一处都没引用**——写而不读的字段。"到底会命中哪个心里没底"就是这么来的 |
| ⑤ | Raw text 脏 | **一半** | skeleton 已过滤 + 如实报数（`f0104d22`）；**Raw text 段确实没过滤**，`format.ts:385` 直接 `out.push("## Raw text", text)`。已逐字复现（第 13 节 R2） |
| ① | hash navigate 报成功但没生效 | **真 gap** | `facade.rs:192` `view.begin_nav(url)` 记的是**请求值**，紧接着 `BrowserViewDto::from(&view)` 回报——**从不观测落点**。代码事实 + 探针复现 |
| ② | reload 后 wait 假阳性 | **真 gap（机制未证实，见下）** | 全浏览器模块**没有任何文档身份概念**（无 `timeOrigin`、无 `contextId` 追踪）→ 无法分辨自己轮询的是哪个文档 |
| — | `browser_network` | **新功能** | v2 spec 的「未决问题 3」点名留给下一批，**不是重复** |
| — | `browser_console` | **新功能** | 同上 |
| 想要 | act 预演模式 | **部分** | = ④残。只要报数就够（用户明确要求"一定要简单"） |
| 想要 | navigate 回报实际 URL | **= ①** | 同一件事 |
| 想要 | 元素级截图 | **新功能（小）** | `screenshot.ts:79-82` 的 `params` 是裸对象直传 `Page.captureScreenshot`，加 `clip` 键即可 |

### 2.1 这批 9 项与昨天那批的重叠关系：**零重复**（逐项核过）

结论先说：**没有一项是昨天做过的。** 但有两项**挨着**昨天的成果，写法必须是"接上去"而不是"另起一套"：

| 本批项 | 与昨天那批的关系 |
|---|---|
| P0 recorder 注入点 | 全新机制，昨天没碰过注入 |
| P1 `browser_network` / `browser_console` | 全新工具；v2 spec 当时把它们**明确列进非目标** |
| P2-1 navigate 回报落点 | 昨天没碰 `facade.rs` / `agent_bridge.rs` |
| P2-2 wait 文档身份 + 真实耗时 | 昨天只在 `wait.ts` 删了一个只写不读字段（`NavSnapshot.visible`），**没动它的语义** |
| P2-3 Raw text 过滤 | **机制上接昨天**：可见性过滤 + 报数 + `include_hidden` 这套是 `f0104d22` 建的（`hiddenSkippedNote`，管 headings/tables/fields/clickables **四个桶**）——本项是给它**加第五个桶**，不是新建。但 **Raw text 那条路径昨天没碰**，且修法在**页面侧**（见 9.3） |
| P2-4 CJK 空白容错 | 昨天没动 `labelOf` 的归一化 |
| P3-1 元素级截图 | 昨天没碰 `screenshot.ts` 的 params |
| P3-2 命中歧义报数 | 昨天没碰。`count` 是**插件初版**（`184215f2`）就存在的写而不读字段，**不是昨天留下的半成品**（`git log -S "count: pool.length"` 核实） |

**要避免的重复**（这才是"重复"的真正风险）：

- **不要为 Raw text 另写一份可见性判据**——`f0104d22` 的提交信息里第一条讲的就是
  "判据只有一份"（在此之前 `projection.ts` 与 `actions.ts` 各有一份标签表，
  后果是"索引里没有、按文本也点不到"）。本项要么复用页面侧 `clickable.ts` 那份，
  要么干脆交给浏览器自己（`innerText`，见 9.3）。
- **不要为两个新工具新建 Rust 事件通道**——v2 已经有 `call_cdp` 通用透传。
- **不要重做反馈里那三条**（③/④/⑤ 的前一半）。

---

## 3. 目标

- agent 能回答「**刚才那个请求返回了什么**」：方法 / URL / 状态码 / 耗时 / 响应片段，
  含**页面加载期**自己发的请求（这是本批的核心，见 P0 的取舍）。
- agent 能回答「**控制台报了什么**」：`console.*` 与**未捕获异常 / 未处理的 Promise 拒绝**
  （反馈里的现场就是后端错误被前端 try/catch 吞了）。
- 导航类操作**不再自欺**：`browser_tab navigate` 回报**观测到的落点**，同文档导航明说。
- `browser_wait` 的观测对象**有身份**：能说清"我等的是哪个文档"，并在文档被替换时如实报告。
- `browser_read` 的 Raw text 与 skeleton 用**同一份**可见性判据。
- `browser_act` 的文本匹配对 **CJK 空白**容错。

## 4. 非目标

- **不做 CDP 事件订阅**（`Network.enable` + `Runtime.consoleAPICalled` 那条路）。
  recorder 包装 fetch 时 `res.clone().text()` **白拿响应体**；CDP 那条路要为每个请求额外发一次
  `Network.getResponseBody`。少一条通道、少一份状态、少一处 Rust。
  （**更正上一版 spec 的一条错误前提**：v2 的「非目标」写着"`webview2-com` 安全封装未导出
  `DevToolsProtocolEventReceiver`，要用得下钻 `-sys`"。这句**在效果上是错的**——
  `GetDevToolsProtocolEventReceiver`（`webview2-com-sys-0.38.2/src/bindings.rs:1518`）与
  `AddScriptToExecuteOnDocumentCreated`（同文件 `:1325`）**都在 `ICoreWebView2` 上**，正是
  `native.rs:27` 已经 import 的那个接口，而 `native.rs:60` 已经握着裸句柄。
  本批不用它们不是"够不着"，是**不需要**。）
- **recorder 不落盘、不跨会话、不发事件**。纯内存环形缓冲，随文档消亡。
- **不做 `browser_style` / 视觉快照 diff / `browser_open`**（v2 未决问题 3 里的其余候选）。
- **不改隐藏策略**（parking 已落地且验收通过）。
- **不做 act 的完整"预演模式"**：用户明确要求"命中歧义如实报数**一定要简单**"，
  只报一个数字，不列候选清单（`browser_read` 已经能列元素）。

---

## 5. 架构

```text
页面内（文档创建那一刻装入，见 P0）
  window.__aideRec = { reqs: [], logs: [], ... }   ← 环形缓冲，只在内存
    ├─ fetch 包装              → reqs[]：method / url / status / ms / body 片段 / err
    ├─ XMLHttpRequest 包装     → reqs[]：同上
    ├─ console.{log,warn,error,info,debug} 包装 → logs[]
    └─ error / unhandledrejection 监听          → logs[]
                    ↑ 只写内存：不发事件、不落盘、不新增 Rust 通道

sidecar
  browser/recorder.ts   ← recorder 的**源码字符串**（唯一事实源）+ 读取编排
       │  install: 一次廉价求值，把源码送进页面（幂等）
       └─ read:    一次廉价求值，把 reqs/logs 取回来
  browser_network / browser_console   ← 两个薄工具，只做「信封 → 紧凑文本」
```

**为什么读取走求值而不是新通道**：读一次 = 一次 `Runtime.evaluate`，和 `browser_read` 的投影
脚本同一个机制、同一份幂等保证、同一个降级路径。新增通道（Rust 事件 → sidecar）在这一批里
是纯粹的复杂度。

### 5.1 缓冲的生命周期（必须如实告诉 agent）

`window.__aideRec` **挂在页面的 JS 世界上**，因此：

- **页面**导航（含 reload）→ 新文档，缓冲清零。这对本批的核心场景是**对的**：
  "审核配置页空白"要看的正是**那个新文档自己加载期**的请求。
- 但"点了个按钮 → 请求失败 → 页面跳走了"这种跨导航的追查**拿不到**（缓冲已清零）。

**明确决策：P1 就做 per-document，不做持久化。** 想让缓冲跨同源导航存活可以塞
`sessionStorage`，但会引入配额/性能/条目归属（要标 `timeOrigin` 才知道是哪次加载）三个新问题，
留给实测之后再定——记在「未决问题」。

---

## 6. 组件表

| 位置 | 职责 | 状态 |
|---|---|---|
| `agent-sidecar/src/extensions/browser/recorder.ts` | recorder 源码字符串（唯一事实源）+ install / read 编排 + 信封归一 | 新增 |
| `agent-sidecar/src/extensions/browser/network.ts` | `browser_network` 的渲染（reqs → 紧凑行） | 新增 |
| `agent-sidecar/src/extensions/browser/console.ts` | `browser_console` 的渲染（logs → 紧凑行） | 新增 |
| `agent-sidecar/src/extensions/browserTools.ts` | 两个 builder + 表加两项 | 改 |
| `agent-sidecar/src/extensions/browserMcp.ts` | `BROWSER_ALLOW_RULES` 加两条 + `BROWSER_INSTRUCTIONS` 加一节 | 改 |
| `agent-sidecar/src/extensions/browserSkill.ts` | reference 补两条契约（缓冲随文档清零；读之前装了才有的如实说明） | 改 |
| `agent-sidecar/src/extensions/browser/projection.ts` | 页面侧产出「只含渲染中内容」的正文文本（P2-3 的**主改点**，见 9.3） | 改 |
| `agent-sidecar/src/extensions/browser/format.ts` | `hiddenSkippedNote` 加一个 text 桶 + `include_hidden` 管 Raw text（P2-3 的报数半边） | 改 |
| `agent-sidecar/src/extensions/browser/actions.ts` | 文本匹配的 CJK 空白容错（P2-4）+ `count` 进结果（P3-2） | 改 |
| `agent-sidecar/src/extensions/browser/wait.ts` | 文档身份 + 真实耗时（P2-2） | 改 |
| `agent-sidecar/src/extensions/browser/screenshot.ts` | `clip` 裁剪（P3-1） | 改 |
| `src-tauri/src/browser/facade.rs` + `agent_bridge.rs` | navigate 回报落点（P2-1） | 改（**仅在步骤 0 证明 CDP 路不通时才动 Rust 装 recorder**） |
| `docs/testing/browser-recorder-fixture.html` | 真机夹具页（元素清单见第 11 节） | 新增 |

**新工具的编辑点清单（少一处工具就静默变成要弹窗）**：

1. `browserTools.ts` — builder + `buildBrowserTools` 的表
2. `browserMcp.ts` — `BROWSER_ALLOW_RULES`（**工具级**规则，逐个写，别照抄 server 级写法）
   + `BROWSER_INSTRUCTIONS`（`browserMcp.test.ts` 强制**每条规则里出现的工具名必须已在 allowlist**，
   反之新增工具也要在 INSTRUCTIONS 里被提到）
3. `browserSkill.ts` — reference
4. `__snapshots__/browserMcp.test.ts.snap` — 需 `-u`
5. 前端镜像两处：`packages/aide-sdk/src/composables/useCustomizations.ts:78`、
   `scripts/diag/measure-builtin-mcp.ts:39`

---

## 7. P0：注入点（地基，也是唯一可能动 Rust 的地方）

### 7.1 为什么必须"文档创建那一刻"装

反馈里最值钱的一条是「审核配置页空白，其实是后端返回了 `No enum constant…`」——那是**页面
加载期**自己的 XHR。**懒注入**（等工具被调用才装探针）恰好漏掉它，等于把最想要的场景做没了。

### 7.2 两条路

| 路径 | 成本 | 状态 |
|---|---|---|
| **首选**：CDP `Page.addScriptToEvaluateOnNewDocument` | 走**已有的 `call_cdp` 透传**（`browserClient.ts:23` 无白名单）→ **零 Rust** | **实测不通**（2026-09-23 真机）：WebView2 **收下**该方法却从不执行它 —— 新文档里 `window.__aideRec` 不存在（`browser_eval` 复核 `{hasRec:false}`）。**失败是静默的**（无方法级 error），所以"CDP 优先、出错回退"这条链根本不会触发 |
| **兜底**：WebView2 宿主 API `AddScriptToExecuteOnDocumentCreated` | `native.rs` 加一个 `drill()` 形状的函数 + 逐层一个 op（port → 两个 adapter → facade → bridge → 执行体 → sidecar 客户端） | **已落地**（`0d140fad`），注入改走这条；**交货与否待真机重跑判据 0** |

两条路的差别只有"谁去调"：CDP 那条是 sidecar 直接发一条已有的透传命令；兜底那条要在
`native.rs`（全仓库**唯一**允许 `use webview2_com` 的文件）里加一个 op，再由 sidecar 触发。
**步骤 0 先探首选，通了就不碰 Rust。**

### 7.3 recorder 源码（**已在真机 WebView2 上端到端跑通**，第 13 节 R5）

下面这段是**跑通过的原文**（通过 `browser_eval` 注入页面后实测：fetch / XHR / console /
未捕获异常全部抓到，含响应体）。落地时整段搬进 `browser/recorder.ts` 的字符串常量：

```js
(function () {
  if (window.__aideRec) return 'already armed'
  var R = window.__aideRec = { reqs: [], logs: [], cap: 100 }
  function push(arr, item) { arr.push(item); if (arr.length > R.cap) arr.shift() }
  function now() { return Math.round(performance.now()) }

  var of = window.fetch
  if (of) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || ''
      var method = (init && init.method) || (input && input.method) || 'GET'
      var t0 = now()
      var rec = { kind: 'fetch', method: String(method).toUpperCase(), url: String(url),
                  t: t0, status: null, ms: null, body: null, err: null, done: false }
      push(R.reqs, rec)
      return of.apply(this, arguments).then(function (res) {
        rec.status = res.status; rec.ms = now() - t0
        try {
          // 克隆一份读体：原响应照样交给页面，我们只是旁听
          res.clone().text().then(function (txt) { rec.body = String(txt).slice(0, 300); rec.done = true },
                                    function () { rec.err = 'body unreadable'; rec.done = true })
        } catch (e) { rec.err = String(e); rec.done = true }
        return res
      }, function (e) {
        rec.ms = now() - t0; rec.err = String((e && e.message) || e); rec.done = true
        throw e   // 失败必须继续抛给调用方，recorder 不改变页面行为
      })
    }
  }

  var OX = window.XMLHttpRequest
  if (OX) {
    var open = OX.prototype.open, send = OX.prototype.send
    OX.prototype.open = function (m, u) { this.__m = m; this.__u = u; return open.apply(this, arguments) }
    OX.prototype.send = function () {
      var x = this, t0 = now()
      var rec = { kind: 'xhr', method: String(x.__m || 'GET').toUpperCase(), url: String(x.__u || ''),
                  t: t0, status: null, ms: null, body: null, err: null, done: false }
      push(R.reqs, rec)
      x.addEventListener('loadend', function () {
        rec.status = x.status; rec.ms = now() - t0
        try { rec.body = String(x.responseText || '').slice(0, 300) } catch (e) { rec.err = 'body unreadable' }
        rec.done = true
      })
      return send.apply(this, arguments)
    }
  }

  ;['log', 'warn', 'error', 'info'].forEach(function (lvl) {
    var orig = console[lvl]
    if (!orig) return
    console[lvl] = function () {
      var parts = []
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i]
        try { parts.push(typeof a === 'string' ? a : JSON.stringify(a)) } catch (e) { parts.push(String(a)) }
      }
      push(R.logs, { lvl: lvl, t: now(), text: parts.join(' ').slice(0, 300) })
      return orig.apply(console, arguments)
    }
  })
  window.addEventListener('error', function (e) {
    push(R.logs, { lvl: 'uncaught', t: now(), text: String((e && e.message) || e) })
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason
    push(R.logs, { lvl: 'unhandled', t: now(), text: String((r && r.message) || r) })
  })

  return 'armed'
})()
```

**落地时必须守的四条**（都是上面这段已经遵守、但改的时候容易丢的）：

1. **幂等**：`if (window.__aideRec) return` —— 注入命令可能重发，重复包装会把环形缓冲套娃。
2. **不改页面行为**：fetch 的失败分支 `throw e` 继续抛；`res.clone()` 不动原响应；
   包装的 `console` 必须 `return orig.apply(...)`。
3. **有界**：`cap: 100` + 每条文本 `slice(0, 300)`。无界缓冲会喂爆 agent 的上下文（也可能是内存）。
4. **如实标截断**：`body` 被 slice 时，渲染层要能说出"这里被截断了"，不能假装它就是全部。

**⚠️ 必须补的一条（上面那段跑通的源码里还没有）**：`res.clone().text()` 会把**整段响应体**
复制进内存，MB 级 JSON 会打出峰值（见第 15 节风险 2）。**P1 就要加体积闸门**，
别留到以后：

```js
var len = Number(res.headers && res.headers.get && res.headers.get('content-length'))
if (len > 262144) { rec.bodyNote = 'body skipped (' + len + ' bytes)'; rec.done = true }
else { /* 上面那段 clone().text() 的读体逻辑 */ }
```

⚠️ **哨兵不许写进 `err`**（真机验收抓到的 finding D）：`err` 的语义是"这条请求失败了"，
而"我没读体"**不是失败**。首版把两者塞进同一个字段，于是 200 被计入失败摘要——正好污染了
§8.1 那条"agent 十次里有九次是冲着失败来的"的路径。所以跳过类的说明走独立的 `bodyNote`
（事件流那条同理），`err` 只留真错误（`body unreadable` / 抛错 / 被拒）。

（`content-length` 缺失时按"读"处理——如实标 `body truncated` 已经是既有行为。
这条阈值**要在夹具里用两条 KB 级 + 一条超阈值接口各验一次**，第 12 节的表单测里加三条。）

### 7.4 装与读的编排

- `browser_network` / `browser_console` **各自在读取前确保已装**（幂等，一次廉价求值）。
- **装了才有的如实说明**：如果这次调用正是"刚装上"的那一次，输出里必须明说
  **"探针是这次调用才装上的，这之前的请求看不到"**——否则 agent 会把"空"读成"没发请求"。
  这是 v2 立下的纪律（不静默降级）的同一款。
- 未装而工具又要读 → 不要报错，装上 + 如实说明 + 返回空。

---

## 8. P1：两个新工具

两个工具都**只读、只渲染**，不新增任何机制。

### 8.1 `browser_network`

```
browser_network(view_id?, filter?, limit?, frame?)
```

| 参数 | 取值 |
|---|---|
| `filter` | URL 子串，可省（省 = 全部） |
| `limit` | 默认 20，上限 100（**从最近往前取**） |
| `frame` | 同 `browser_read` 的 `frame`（URL 子串） |

输出形态（**紧凑、每请求一行**——反馈明确说 `browser_eval` 好用就是因为"紧凑地贴表格行"）：

```
Requests (last 3 of 12, newest last):
#10 GET  /api/equipment/audit-config  → 500  812ms  {"error":"No enum constant …TASK_AUDIT"}
#11 POST /api/audit/approve            → 200   95ms  {"ok":true}
#12 GET  /api/equipment/audit-config  → (pending, 2400ms so far)
```

要点：

- **未结束的请求要能看出来**（`(pending, Nms so far)`）——"审批没推进"经常就是卡在一条
  永不返回的请求上，而这**恰恰是最难自己发现的一条**。
- **失败优先**：`status >= 400` 或 `err` 非空的条目在文本里**前置一行摘要**
  （`2 of 12 failed — first failure: #10`）。agent 十次里有九次是冲着失败来的。
  ⚠️ 这条判据只在 `err` **只装真错误**时成立——跳过类的说明（体积闸门 / 事件流）走 `bodyNote`，
  不许混进 `err`（见 §7.3 的 finding D）。
- 状态码为 `0` / `null` 且无 err → 如实说"没有状态码"（CORS/中止/未结束），别当成 200。
- 请求体**不做**（P1 不做，`reqs[]` 里也没存）——记在未决问题。

### 8.2 `browser_console`

```
browser_console(view_id?, level?, limit?, frame?)
```

| 参数 | 取值 |
|---|---|
| `level` | `error` \| `warn` \| `all`（默认 `all`） |
| `limit` | 默认 30，上限 100 |

输出形态：

```
Console (last 4 of 9):
[uncaught] Uncaught ReferenceError: nope is not defined
[error]    slow failed NetworkError
[warn]     direct warn {"n":7}
[log]      fast done {"ok":true,"rows":[1,2,3]}
```

要点：

- `uncaught` / `unhandled` 两个级别**必须与 `console.error` 分开显示**——它们是页面**没接住**的
  错误，正是"被前端错误处理吞了"的反面。反馈里那个"后端返回了 `No enum constant…`"就属于这类。
- 空结果时**区分两种空**：没装探针（如实说）/ 装了但一条没有（"页面没往 console 写过东西"）。
  这正是 v2 定下的「空 ≠ 没有」纪律的同一款。

---

## 9. P2：四条真 gap

### P2-1 navigate 回报观测落点

**代码事实**：`facade.rs:166-195`。

```rust
self.engine.navigate(&id, &url)?;      // 请求
...
view.begin_nav(url);                   // :192 —— 记的是**请求值**
Ok(BrowserViewDto::from(&*view))       // :194 —— 立刻回报，从不观测落点
```

**修法**：回报前补读一次实际落点。落点是纯读，走 sidecar 已有的 `runEval`（`location.href`）
即可——**但要注意时序**：`browser_tab navigate` 是 Rust 命令，命令返回时页面可能还没导航完。
两个可接受的形态（实现时二选一，按步骤 0 的实测结果定）：

- **(a) 命令回报请求值 + 明确标注**：`Navigated view browser-1 to <url> (requested; the view has
  not confirmed it yet — use browser_wait until:"load", or browser_eval location.href, to read the
  actual landing URL)`。
- **(b) 命令回报观测值**：命令内 `await` 一次 `location.href` 读回真实落点，
  两者不一致时两边都给出来。

**倾向 (b)**，因为反馈的第 1 条就是"报的 URL 是新的、页面还是旧的"。但 (b) 有代价：
navigate 命令要等一次跨层往返。实现时用步骤 0 量一下这个往返（大概是几十毫秒量级，
可接受；若不可接受就取 (a)）。

**同文档导航（hash 路由）必须明说**：`browser_wait until:"load"` 对 hash 导航会回
"Nothing was loading …"（**这是对的**——同文档导航确实不触发 load），但 agent 会把它读成
"导航没发生"。修法：`until:"load"` 的文案在"没在导航"这一支里补一句
——**"若你刚做的是一次同文档导航（hash/`pushState`），它不会触发 load，也不会出现在这里；
请改用 `until:"condition"` 或直接读 `location.href`"**。

### P2-2 `browser_wait` 的文档身份

**代码事实**：全浏览器模块没有任何文档身份概念（无 `timeOrigin`、无 `contextId` 追踪）；
`wait.ts:150-167` 的轮询循环只认 `met`。

**修法**：

1. 每 tick 的包装器（`wait.ts:141` 附近）带出 `performance.timeOrigin`
   —— **`timeOrigin` 是免费的文档指纹**（每份文档一个值，不需要我们注入任何东西）。
2. `waitForCondition` 开始时记下首个 `timeOrigin`；中途变了 → **不是**"继续等"也**不是**"失败"，
   而是**如实报告文档被替换过**，并把观测基准重置到新文档（或直接结束并说明）。
3. **真实耗时**：`wait.ts:156` 现在算的是 `attempts * input.intervalMs`——**这是合成值不是实测值**。
   反馈里 agent 写的"第一次轮询（200ms）就成立"就是被这个数字骗的（它也据此建立了因果推理）。
   改成记 `Date.now()` 差值。

### P2-3 Raw text 过可见性判据

**代码事实**：`format.ts:385` `if (text) out.push("", "## Raw text", text)`——直接原样输出。

**已复现**：`display:none` 里的独特字符串 `HIDDENMAGIC` 明文出现在 `## Raw text` 里，
而 skeleton 干净（只列 10 个可见可点元素 + NOTE「1 clickables hidden」）。

**⚠️ 修法不在 sidecar，在页面侧**（本 spec 初稿把这里写成了 `format.ts` 的改动，**是错的**）：

`text` 是**扁平字符串**，元素信息已经没了——sidecar 拿到它时**无从判断哪一段属于隐藏节点**。
它由页面侧的投影脚本产出（`projection.ts:264-278`）：

```js
var clone = doc.body ? doc.body.cloneNode(true) : null
... 剥掉 script/style/noscript/template ...
out.text = cut(clone.textContent, 20000)      // :272 —— textContent 不看 CSS
```

所以 P2-3 = **页面侧产出一份"只含渲染中内容"的文本**，两条候选路：

| 路 | 做法 | 风险 |
|---|---|---|
| (a) **`doc.body.innerText`** | 浏览器**自己**的可见性感知文本 API，一行 | ① **强制布局**（大页有成本；投影脚本本来就在跑 `getComputedStyle` 扫描，多半已付过）② **parked 视图上是否正常必须真机验**（见步骤 0）③ 空白折叠规则与 `textContent` 不同，输出形态会变 |
| (b) 剪枝后再 `textContent` | 用 `clone` 走一遍、把 `display:none`/零尺寸的子树摘掉，再取 `textContent` | 要**复用**已有的可见性判据，别新写一份（判据分家正是 `f0104d22` 刚治过的病） |

**倾向 (a)**，因为它把"什么算可见"交给浏览器自己，判据不可能与浏览器不一致。但**必须先真机验
parked 视图**（`innerText` 要求元素在文档里且有布局），验不过就退 (b)。

**⚠️ 一个已知陷阱**：`clone` 是**游离节点**（`cloneNode(true)` 出来的），**对它取 `innerText`
会退化成 `textContent` 语义**（`innerText` 依赖在文档中 + 有布局）。所以 (a) 必须取
`doc.body.innerText`（**在原文档上**），不能图省事改成 `clone.innerText` ——那样会得到一个
"看起来改了、实际没过滤"的假修复。

**报数与开关走既有机制**：隐藏计数进 NOTE + `include_hidden` 同时管 Raw text，
**复用** `f0104d22` 建的 `hiddenSkippedNote`（`format.ts:216-`，它现在管
headings/tables/fields/clickables 四个桶，加一个 text 桶即可）——**不要另起一套**。

### P2-4 `browser_act` 文本匹配的 CJK 空白容错

**代码事实**：`actions.ts:79` `var t = (el.textContent || '').replace(/\s+/g, ' ').trim()`。

`确 定` → `"确 定"`，`确定` → `"确定"`：既不 `===` 也不 `indexOf >= 0`。

**已复现**：`browser_act {text:"确定"}` 在夹具上回

```
Could not find the target: text "确定" is on the page and visible, but its element is not
recognized as clickable (no cursor:pointer, role or handler) — retry with an explicit selector
such as #copyline
Elements carrying that text (not recognized as clickable …):
- <p> "确定通过审核？" #copyline
```

——真正的按钮 `<button>确 定</button>` **从没进过候选池**，命中的是包含"确定"的文案。
与反馈第 3 条逐字一致。

**修法**：匹配时**多比一次"去掉所有空白"的形态**（两侧都去空白后相等 / 包含）。
判据只加在这一处比较上，**不要动 `labelOf` 的归一化**——它的单空格折叠是渲染给模型看的
形态，改了会波及索引输出。

---

## 10. P3：两个小件

### P3-1 元素级截图

`browser_screenshot` 加 `text` / `selector`（二选一）。解析复用现成的元素定位
（`actions.ts` 的 `byText` / `bySelector`），取其 bounding rect，
作为 `clip: {x, y, width, height, scale: 1}` 传给 `Page.captureScreenshot`
（`screenshot.ts:79` 的 `params` 是裸对象，加一个键即可，**不需要动 Rust**）。

要点：
- 元素不可见 / 命中不到 → 如实失败，**不要退化成整页截图**（反馈明确说整页截图因上下文成本
  全程没用，退化会让它以为拿到了局部）。
- 元素超出视口 → CDP 的 `clip` 会自动处理，但要**如实说明**"这个元素在视口外，
  截图可能不含它"（若实测发现确实不含）。

### P3-2 命中歧义报数（用户要求：**一定要简单**）

`actions.ts:192` 的 `count` 已经算出来了，只是没人读。按用户给的形态，只加**一句英文**：

```
Clicked #dlg-a (10 elements matched; used index 0).
```

不需要列候选清单（`browser_read` 已经能列元素）。`index` 越界钳制的现状（`Math.min`）保持不变，
但**钳制了要说**（`used index 0` 已经表达了）。

---

## 11. 降级与错误处理

| 情形 | 行为 |
|---|---|
| 注入命令被 CDP 拒绝 | 如实报"装不上探针" + 原因；两个工具**不报假空**（区别于"装了但没东西"） |
| 页面把 `fetch`/`console` 覆盖了 | 读到的是被覆盖后的版本，如实说明；不试图对抗（记在未决问题） |
| 缓冲为空 | 区分"没装"与"装了没东西"（见 8.2） |
| 缓冲溢出（> cap） | 如实说"只保留了最近 N 条" |
| 值不可序列化（循环引用） | 沿用 `runEval` 的 `kind:"unserializable"`，不伪装成 null |
| headless | 保持 v2 的短路（`browserTools.ts:48-50`），新工具一并遵守 |
| 任何 handler 内部异常 | 折成文本，**绝不穿出**（`browserTools.ts:54` 的红线） |

---

## 12. 测试

**单测（mock 桥）**

- `browser/recorder.test.ts`：**桩** `fetch` / `XMLHttpRequest` / `console` / `addEventListener`，
  跑真 recorder 源码，断言：成功/失败/未结束三种请求形态、响应体被 slice、未捕获异常进 `logs`、
  **幂等**（装两次只有一个缓冲）、**不改页面行为**（失败仍抛、console 仍转发）。
- `browser/network.test.ts` / `console.test.ts`：信封 → 文案。含"没装 vs 装了但空"两种空、
  `pending` 的渲染、失败摘要行。
- `browser/wait.test.ts` 补：文档身份变化的分支；**耗时是实测值不是 `attempts × interval`**
  （钉死这个被 agent 撞上的假数字）。
- `browser/actions.test.ts` 补：CJK 空白三条（`确 定` ↔ `确定`、全角空格、换行）。
- `browser/format.test.ts` 补：Raw text 过滤 + 数字出现在 NOTE。
- `browserTools.test.ts` 补：两个新工具的表单测（未装 → 装上 + 如实说明 + 空）。
- **快照**：`browserMcp.test.ts.snap` 需 `-u`。**加工具必然踩到两道断言**，别绕：
  `browserMcp.test.ts:40` 是 `BROWSER_ALLOW_RULES` 的精确数组断言；
  `:59-61` 是"每条规则的工具名必须出现在 `BROWSER_INSTRUCTIONS` 里"的循环。

**成本（新增工具的必要动作）**

```bash
cd agent-sidecar && npx tsx ../scripts/diag/measure-builtin-mcp.ts
```

**本会话实测的基线（2026-09-22，纯只读、不发起查询）：

| server | tools | toolPayload | instructions | 合计 |
|---|---|---|---|---|
| **aide-browser** | 7 | ≈1586 tok | ≈2229 tok | **≈3815 tok** |
| 内建四 server 总计 | — | — | — | **≈7569 tok** |

**⚠️ 这个脚本的量尺本身偏小，别把它当绝对值。** 它的 `schemaChars()` 注释写着
"schema 实为小头"，于是只数字段名 + `describe()` 文字——**实测低估 1.55×**：

```
agent-sidecar 内实测：schema 近似 3,245 字符 vs 真实 JSON Schema 5,031 字符
（真实形态 = zod 的 toJSONSchema()，即 SDK 真发出去的形态）
```

折算下来 aide-browser 的 toolPayload 实际 ≈2,100 tok、**合计 ≈4,330 tok**
（与本仓库另一份独立量法 ≈4,364 tok 吻合，两份互为佐证）。

**所以**：
- **预算红线用相对值判**：两个新工具的 description + schema 合计 ≤ 600 token
  （即 +16% 以内，按现有工具中位体量估的）。超了就把两个合成一个
  `browser_observe{what:"network"|"console"}`。
- **顺带修 `scripts/diag/measure-builtin-mcp.ts` 的 `schemaChars()`**（改成
  `JSON.stringify(z.toJSONSchema(z.object(raw))).length`）——不然以后每个人都拿着
  偏小的量尺做预算。这条是**量尺**，不是本批功能，可以单独提交。

**真机验收（步骤 0 见下节）**

| 判据 | 期望 |
|---|---|
| 加载期请求可见 | 打开一个会发初始 XHR 的页面，`browser_network` 能看到**它加载期**那条 |
| 失败可诊断 | 夹具页打一条返回 500 的接口，`browser_network` 报出 500 + 响应片段 |
| 未结束可辨 | 夹具页打一条永不返回的接口，报 `(pending, …)` |
| 控制台吞错可查 | 夹具页抛一个未捕获异常，`browser_console` 报 `[uncaught]` |
| 未装的如实说明 | 新视图第一次调 `browser_console`，明说"探针刚装上，之前的看不到" |
| navigate 落点 | hash 导航被应用弹回时，工具**不报假成功** |
| Raw text | 夹具页的隐藏节点字符串**不出现**在 `## Raw text`，NOTE 有数 |
| CJK 空白 | `browser_act {text:"确定"}` 命中 `<button>确 定</button>` |
| 歧义报数 | 命中多个时输出带 `(N elements matched; used index i)` |
| 元素截图 | 只截到目标元素 |

**夹具页元素清单**（`docs/testing/browser-recorder-fixture.html`，本轮的探针页可直接改造成它）：

- 一个 `display:none` 容器，里面放独特字符串（验 Raw text 过滤）
- 一个 `<button>确 定</button>`（**中间是空格**）+ 一段文案 `<p>确定通过审核？</p>`（验 CJK 容错）
- 三个接口：正常 200、500 + JSON 错误体、**永不返回**（验 pending）
- 一个 `console.log` 按钮、一个 `console.warn` 按钮、一个**会抛未捕获异常**的按钮
- 一个 hash 路由模拟（`hashchange` 时改 `#route`）+ 一个"路由守卫"把 hash 弹回
- 一个会延迟出现的元素（验 `browser_wait`）
- 两侧按钮同 class、其中一个 `display:none`（验选择器可见性优先 + 歧义报数）

---

## 13. 步骤 0：动手前的实测探针（**先做这个，别先写实现**）

单测证明不了 WebView2 的真实语义。**第一条探针只回答一个问题：注入点选哪条路。**

1. 用户开一个浏览器面板（或 `browser_tab open` 自建一个），导航到夹具页。
2. 用裸 CDP 调 `Page.addScriptToEvaluateOnNewDocument`，`source` 设为一句
   `window.__aideProbe = 1`（**通过 `call_cdp` 透传**，不需要写代码——用一条现有路径即可发；
   若当前没有暴露裸 CDP 的工具，就在 `browserClient.ts` 边上临时加一个调试用的调用点，
   **验完删掉**）。
3. 导航到另一个页面（或 reload），然后在**新文档**里读 `window.__aideProbe`：
   - 读到 `1` → **首选路径成立，零 Rust**，直接进 P1。
   - 读不到 → 走兜底：Rust `AddScriptToExecuteOnDocumentCreated`（`native.rs` 已是唯一
     `use webview2_com` 的文件，照 `native.rs:55-70` 的 `with_core` 范式加）。
4. **顺带量一次 P2-1 的往返代价**：navigate 后读一次 `location.href` 要多久
   （决定用修法 (a) 还是 (b)）。
5. **顺带验 P2-3 的 `innerText` 在 parked 视图上是否可用**（同一个视图、同一次调用）：
   在页面里放一个 `display:none`、内含独特字符串的节点，然后比
   `doc.body.innerText.includes('那个字符串')` 与 `doc.body.textContent.includes(...)`。
   期望：`innerText` 不含（= 可用），且**不是在游离 clone 上取的**
   （对照 `doc.body.cloneNode(true).innerText` —— 它会退化、**含**那个字符串）。
   这一步**决定 P2-3 走 (a) 还是 (b)**，不验就写 = 上一版那两次返工的老路。

**代价明示**：需要用户开一次面板 + 一次导航。若用户不愿付，则按"首选 + 兜底都写"实施
（两条路各留一个开关），验收改由实机反馈完成——那是不想走的路，但比假装测过好。

**已提前排除的**：`AddScriptToExecuteOnDocumentCreated`
（`webview2-com-sys-0.38.2/src/bindings.rs:1325`）与 `GetDevToolsProtocolEventReceiver`
（同文件 `:1518`）都**在 `ICoreWebView2` 上**，即 `native.rs:27` 已 import 的那个接口。
所以兜底路的可行性是**代码事实**，不是推断。

---

## 14. 实测记录（2026-09-22，本会话在真机 WebView2 上跑的）

**这些都是真的跑过的，不是推断。** 复跑方法：起一个本地夹具页（本会话用的是
`AppData\Local\Temp\aide-browser-probe\`，**临时目录会被清理**，夹具请照第 11 节的元素清单重建），
用 `browser_tab open` 开一个 parked 视图。

| # | 探针 | 结果 |
|---|---|---|
| R1 | 纯净 hash 导航（`#/one` → `#/two`，无重定向） | **生效**，工具报的与页面实际一致 |
| R1b | 页面把 hash 弹回（模拟路由守卫） | **复现**：工具回 `Navigated view browser-1 … /#/failure-to-report`，页面实际仍在**原** hash。与反馈第 1 条一致 |
| R2 | `browser_read` 的 Raw text 与隐藏元素 | **复现**：`display:none` 里的 `HIDDENMAGIC` 明文出现在 `## Raw text`；skeleton 干净并报 `NOTE: 1 clickables hidden` |
| R3 | `browser_act {text:"确定"}`，页面有 `<button>确 定</button>` + `<p>确定通过审核？</p>` | **复现**：报"文本在页面上且可见，但元素不像可点击"，候选只列出 `<p> "确定通过审核？" #copyline`——**真按钮从没进候选池** |
| R4 | parked 视图的定时器是否被降频 | **没有被降频**：`setInterval(100ms)` 在 1281ms 内跑了 12 次（期望 13）。parking 的"照常渲染"承诺在定时器这条轴上成立 |
| R5 | recorder 端到端 | **跑通**：`GET /api/fast → 200, 5ms, {"ok":true,"rows":[1,2,3]}`（fetch 与 XHR 各一条，**响应体都拿到了**）；`GET /api/slow` 在读取时仍是 `pending`；`console.warn` 带对象、`console.log` 都抓到；**未捕获异常抓到** `Uncaught ReferenceError: nope is not defined` |
| R6 | reload 后 `browser_wait` 的假阳性（反馈第 2 条） | **未能复现**（两次尝试）。轮询返回的是**干净的 `false`**，从没打到旧文档。⚠️ 见下 |

### R6 的诚实结论（**这条很重要，别让下一个 agent 以为已证实**）

- 反馈第 2 条的**机制诊断（"旧文档先满足"）我没有证实**。我的探针里，导航进行中的求值返回的是
  干净的 `false`，从未命中旧文档。
- **但我挖出了那条反馈里更可能为真的一个独立缺陷**：`wait.ts:156` 的成功文案
  `Condition met after ${attempts} poll(s) (${attempts * input.intervalMs}ms)`
  ——括号里的毫秒数是**算出来的，不是测出来的**。agent 写的"第一次轮询（200ms）就成立"
  正是照抄了这个数字，并据此建立了因果推理。**这个数字会骗人，修它不需要复现反馈。**
- 因此 P2-2 的修法（文档身份 + 真实耗时）**无论机制如何都成立**：它把"我等的是哪个文档"
  变成可观测的，下一次同类现象能一眼分辨是哪种成因。
- **验收需要真实页面**：本夹具没造出该现象（可能因为我夹具的导航都是秒级完成，
  而反馈现场是重型 SPA + 慢后端）。**别把"夹具没复现"读成"没有这个 bug"。**

**两条方法论提醒**（下一次动这块的人）：

1. **夹具会骗人，两次**：①我第一次做 reload 探针时页面被缓存了，服务端那 8 秒延迟从没生效；
   ②第二次我用 agent 的顺序（reload → 再起 wait）时，**我自己的工具调用往返就超过了导航时长**，
   于是"旧文档窗口"永远等不到我。夹具必须把时序**钉在页面的时间轴上**（用页面里的 `setTimeout`
   自驱动），不能依赖调用方的手速。
2. **拿真回包**：R5 的 recorder 之所以一次跑通，是因为先注入进去实测了，而不是照文档写。
   上一版 spec 的两次返工都是死在"我没有真回包"。

---

## 15. 风险

1. **注入点是唯一可能动 Rust 的地方**，且首选路径未验（步骤 0）。若首选不通，本批从"零 Rust"
   变成"≈15 行 Rust + 一个新 op"，成本上升但仍在一批之内。
2. **`res.clone()` 对大体量响应**会复制一份到内存。夹具里是 KB 级；真实页面的 MB 级 JSON
   可能造成峰值。缓解：只对 `content-length` 小于阈值（如 256KB）的响应读体，
   超了如实标 `body skipped (too large)`。**要在 P1 里就做**，不是以后再说。
3. **页面自己包装 `console`/`fetch`**（埋点库、Sentry、axios 拦截器）会让我们的包装被套在里面，
   甚至读不到我们想要的形态。不试图对抗，如实说明（未决问题 1）。
4. **反馈第 2 条的机制未证实**，验收时可能仍看不到现象。这不是本批失败的判据——
   本批判据是"文档身份可观测"这条能力本身。
5. **工具的 token 成本**：见第 12 节的预算红线。**加第三个工具之前必须再量一次。**
6. **`performance.now()` 是文档相对的**，缓冲随文档清零。跨导航追查做不到（见 5.1），
   这是**刻意的**，不是漏了。

## 16. 未决问题

0. **两个新工具**不收 `frame` 参数**（与本文档 §8 的签名不同）**：recorder 必须活在页面的**主世界**才能看到
   页面自己的 `fetch`/`console`，而 `frames.ts` 够到跨域帧靠的是 `Page.createIsolatedWorld`——隔离世界，
   在那里包装 `window.fetch` 拦不到主世界的调用，装了只会得到一个**恒空的缓冲**（正是本文档反复禁止的"假空"）。
   代价：跨域帧的网络/控制台读不到。（CDP 的注册本身是**每帧**生效的，缺的只是读它们的通道。）
0b. **Raw text 用布尔旁注（`textFiltered`）而不是"隐藏了多少字符"这个数**（与 §9.3 的建议不同）：过滤靠
   `innerText`，它与 `textContent` 的**空白折叠规则不同**（块级元素之间补换行），字符差在真页面上可以是 0
   甚至负数，而隐藏文本确实存在——报一个会骗人的数字比不报更糟。
0c. **响应体与 console 文本现在会随工具调用自动进入模型上下文与会话转录**（两个新工具在放行名单里）。
   暴露面等于 `browser_eval` 早已允许的（那个工具能读任意已登录页面），是**刻意**选择，不是疏漏——
   记在这里免得后人当 bug。

1. **页面自己包装了 `console`/`fetch`** 时怎么办：现在设计是"读到被覆盖后的版本 + 如实说明"。
   要不要在读取时探测"我们的包装还在不在最外层"（比对函数指纹），记着待实测。
2. **缓冲跨同源导航存活**（`sessionStorage`）：本批不做。要做的话先解决"条目归属哪次加载"
   （需要标 `timeOrigin`）与配额/性能两个问题。
3. **请求体 / 响应头**：本批只做响应体片段。要不要抓请求体（POST 的 payload 往往才是关键），
   待反馈再定。
4. **`browser_style` / 视觉快照 diff / `browser_open`**：v2 未决问题 3 里剩下的候选，
   本批仍未做，等这一批在真实项目上跑过一轮再按痛感定序。
5. **`Page.addScriptToEvaluateOnNewDocument` 的会话生命周期**：注册是挂在 WebView2 的
   DevTools 会话状态上的。视图关闭/重建后是否失效、需不需要在视图创建时重装，
   步骤 0 一并观察（若失效，就在 `browser_tab open` 的路径上补装）。
