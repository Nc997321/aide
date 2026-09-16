# 内嵌浏览器 agent 能力（aide-browser MCP 插件）

> ## 落地进度（2026-09-16）
>
> | 批 | 状态 | 落在哪 |
> |---|---|---|
> | 批 1A Rust 下钻（eval 回值 + call_cdp） | ✅ | `browser/adapter/webview2/native.rs`（+ `port/engine.rs` 加 `CdpFailed`/`call_cdp`，`unsupported.rs` 补占位） |
> | 批 1A 门面出口 + 视图稳定排序 | ✅ | `browser/facade.rs`（list_views/eval/call_cdp）、`browser/state.rs`（`views_in_order` + 2 用例） |
> | 批 1B 桥五处 | ✅ | `browser/agent_bridge.rs`（纯函数 + 8 用例）、`runtime/browser_agent.rs`（执行体）、`runtime/mod.rs` 拦截、`engine/types.ts` 两契约、`session-manager.ts` 分流、`browserClient.ts` |
> | 批 1C 工具面 | ✅ **5 个工具**（tabs / read / **act** / eval / **screenshot**） | `extensions/browserMcp.ts`（注册+instructions+放行规则）/ `browserTools.ts`（工具定义）/ `browserClient.ts`（桥客户端，顶层）/ `browser/{projection,actions,act,frames,screenshot,format}.ts`（脚本 + 编排 + 格式化） |
> | 批 1D 登记 + 测试 | ✅ | `queryContext.ts` / `queryOptions.ts` / `useCustomizations.ts` / `headless-schema.ts` / `index.ts`（`AIDE_HEADLESS`）；63 个新用例 |
> | 批 1E 蓝湖 skill | ✅ 骨架（SKILL.md + 通用 reference）／⬜ **站点 reference 未写** | `extensions/browserSkill.ts` |
>
> **两处对原方案的偏离（都是实现中修正的）**：
> 1. **CDP 探针不再是前置门槛**：WebView2 是 Evergreen 运行时，CDP 域名可用性是**运行期变量**
>    而非构建属性 → `browser_act` 改为 **CDP 优先 + 脚本兜底 + 如实上报走了哪条路**。
> 2. **`browser_act` 不用 ref 表**：改为**文本/选择器定位**——快照 ref 那套有跨调用的失效问题，
>    而"点那个写着 X 的按钮"本来就是模型的自然表达，且无状态。
>
> **未做**：`DocumentTitleChanged` 标题、`NavigationCompleted.IsSuccess` 失败判定、
> 前进后退能力位（三条同属一次下钻，见 handoff §2；**截图已补**，见下）；
> 蓝湖站点 reference（**必须见过真实 DOM 才写**——编造选择器比没有更糟）；
> `browser_wait`；远程 PWA 暴露（`remote/rpc.rs` REGISTRY 未收录，agent 桥不走它）。
> 端口上的 `capture`（`CapturePreview`）仍**未实现**——截图走的是 CDP，端口那条留作 CDP 不可用时的兜底。
>
> **未验证（需真机）**：整条链路只在单测层验过。端到端要在 `pnpm tauri dev` 里真跑——见 §5。

---

## 续修（2026-09-16 实测驱动，三轮真机迭代）

真机跑通后暴露的三个问题，均已修：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | agent 拿 Playwright 的工具去列"标签页" | 会话里同时有两套浏览器工具，instructions 没说清 | `BROWSER_INSTRUCTIONS` 第 1 条加「别的浏览器工具驱动的是**另一个**浏览器」 |
| 2 | 主帧被当成子帧白读一次，且排在最前冒充内容 | 跳主帧**靠 URL 匹配**——CDP 给的帧 URL **不含 fragment**，投影给的 `location.href` 带 `#/item/...`，永不相等 | 改按**树结构**排除（根节点就是主帧）；`frameTree()` 同时给 `children`（不含主帧）与 `all`（含，供 `browser_eval` 列候选） |
| 3 | agent 写了抽取脚本却没处跑 | **`browser_eval` 只能跑在父页面上下文，够不到跨域帧**——Axure 导出页全是绝对定位 div，通用骨架只读得到一个标题 | `browser_eval` 加 **`frame`** 参数（URL 子串）：`getFrameTree` → `createIsolatedWorld` → `Runtime.evaluate(agent 的脚本)` |
| 4 | `Frame content` 只有一行 title，**与空帧无法区分**（agent 差点据此下错结论） | `formatRead` 的帧内容块渲染了 tables/fields/clickables，**漏了 `text`**——主文档一直有 `## Raw text`，帧这边漏了 | 帧文本必渲染 + 结构面全空时加显式说明；三种状态（失败／读到无结构／读到有结构）各自可辨 |
| 5 | agent 要截图（DOM 答不了"用户此刻看到的到底是哪一块"） | 无截图能力 | 补 `browser_screenshot`——**走 CDP 不走端口的 `capture`**：零 Rust 改动、走已证明可用的 `call_cdp`；**默认 jpeg q80**（见下） |

**截图落盘口径（实测）**：**不写任何图片文件**（WebView2 → COM → Rust 内存 → stdin 管道 → sidecar 内存 → API）。
但 base64 **会进会话转录** `~/.aide/claude/projects/<编码cwd>/<会话id>.jsonl`——工具返回原文落盘，
且**全库已有 61 个转录含 image 块**可证。含义：① 每截一次给会话文件加 ~150–400KB（PNG）；
② 截图成为**对话历史的一部分，后续每轮重发给模型**（prompt cache 摊薄，5 分钟 TTL，miss 全付）。
这就是默认 jpeg q80 的理由——UI 截图通常比 PNG 小 5–10 倍。要像素级保真时显式 `format: "png"`。

**实测证据（第三轮，全部 ok、零 error）**：
```
list_views → eval → call_cdp×5（帧读取：1 树 + 2 帧×2）
           → call_cdp×3（帧定位求值：getFrameTree + createIsolatedWorld + Runtime.evaluate）
```
agent 的原话：「the embedded prototype frame came back nearly empty — let me look inside it directly」→ 随即带 `frame` 调用。

**观测口径**：桥的 `tracing::info!/warn!` 写 **`~/.aide/log/aide.<日期>`**（`lib.rs:27-34` 的滚动文件 appender），**不在终端**——第一次排查时我 grep 终端，白找。

**仍未做**：蓝湖站点 reference（**必须见过真实 DOM 才写**）；Axure 的 `display:none` 隐藏页状态特性已写进 skill 的通用 reference（`textContent` 而非 `innerText`、警惕叠放面板），但**站点专属的那一层仍是空的**。

---

## agent 实测反馈（2026-09-16，第四轮 —— 它自己写的复盘）

> 整体觉得好用。`browser_tabs` 拿 view_id → `browser_eval` 带 `frame` 钻进跨域 Axure iframe，
> 那个原型页的正文全靠这条路才读到；`browser_read` 一把捞出外层结构、页面树、帧列表，省了不少事。
>
> **卡点：`browser_read` 读跨域帧时会静默降级。** 标着「read via CDP frame-level evaluation」，
> 但 Frame content 里只有一行 title，正文全空；同一个帧用 `browser_eval` 一读就有 592 字符。
> 它既不报错也不说明，**结果长得像「成功读取」**，我差点据此下结论。

**复核属实，且是真 bug**：`formatRead` 的帧内容块渲染了 tables/fields/clickables，**漏了 `text`**
（主文档一直有 `## Raw text`）。Axure 那页结构面本就全空、内容全在文本里 → 渲染成只剩 title 的空小节，
**与空帧无法区分**。已修：帧文本必渲染 + 结构面全空时加显式说明；三种状态（失败/读到无结构/读到有结构）
各自可辨。**这是本特性里第一次由 agent 自己发现并准确归因的缺陷。**

**它另一条需求**（"这套工具没有截图能力……我是靠 getBoundingClientRect 反推版面坐标才确认用户看到的
到底是哪一块，有截图会快很多"）→ 已补 `browser_screenshot`。**注意这条与用户最初的诉求不矛盾**：
用户拒的是"截图当主通道"（慢/贵/坐标靠猜），而 DOM 答不了"用户此刻看到哪一块"这类**视觉判断**。
**DOM 为主、截图兜底**——两边独立收敛到同一结论。

**它没判断的**：`browser_act` 本轮没用上，故对其好不好用无结论（真机只验到 read/eval/screenshot 的路径）。

> 上游文档：`2026-09-10-embedded-browser.md`（架构/决策）、`2026-09-15-embedded-browser-handoff.md`
> （续作 playbook，本特性 = 其 §2 的第 1、2、3 步合并交付）。
> 本文只写**这次要做什么**与本批**新核实的事实**，不重复上游已锁决策。

## 1. 目标与边界

**做什么**：新增内置 MCP 插件 `aide-browser`，让 agent 能**读**内嵌 WebView2 页面、能**操作**页面。
顺带根治三条既有债（与「读」共用同一次 `webview2-com` 下钻）：
页面标题（`DocumentTitleChanged`）、失败页判定（`NavigationCompleted.IsSuccess`）、
前进后退能力位（`CanGoBackChanged` / `CanGoForwardChanged`）。

**第一个消费者**：给 agent 一个蓝湖（lanhuapp.com）Axure 原型链接 → 读出整套原型所有页面规格
（表格列 / 表单字段 / 按钮 / 下拉项 / 跳转）→ 对照现有前后端代码产出变更清单。

**红线（验收尺）**：蓝湖是第一个用户，**不是设计者**。
- `grep -ri "lanhu\|蓝湖" agent-sidecar/src src-tauri/src` = **0 命中**
- 换一个站点 = 加一份 skill reference 文件，**MCP server / Rust / 工具面一行不动**

**已拍板**：
1. `browser_eval` 权限 = 自动放行 + `AIDE_BROWSER_TOOLS=off` operator 开关。
2. 批 1 一次到位：读 + 操作。

## 2. 本批新核实的事实（含行号，实现时别推翻）

### 2.1 线程模型 —— 整个卡死家族的真正形状

`tauri-runtime-wry-2.11.2/src/lib.rs:235-255` `send_user_message`：

```rust
if current_thread().id() == context.main_thread_id {
    handle_user_message(...)            // 主线程：内联同步执行
} else {
    context.proxy.send_event(message)   // 非主线程：投递后立即返回
}
```

- `Webview::with_webview`（`tauri-2.11.2/src/webview/mod.rs:1668-1677`）→
  `tauri-runtime-wry-2.11.2/src/lib.rs:1613-1622` → `send_user_message`。
  **非主线程调用 = 发出去就返回，闭包稍后在主线程跑。**
- **契约**：要拿回结果只能走 channel；等待方必须在非主线程（tokio worker）。
  主线程调用 → 闭包内联跑 → 闭包内阻塞等一个只能由消息循环泵出的 COM 回调 = 自锁。
- **`spawn_blocking` 的准确语义**（澄清 `2026-09-10` §10#3）：禁止的是「绕开 `with_webview`
  直接在池线程上发 COM 调用」。**把「阻塞等待」那一段放进 `spawn_blocking` 是合法的**——
  编组由 `with_webview` 自己完成，与调用方线程无关。`script.rs` 头注释要写清这个区分。
- **禁止**给 tauri 开 `tracing` feature（`src-tauri/Cargo.toml:14-19`）：它让 wry 的 `eval_script`
  编译成阻塞版 → 管道回压 → 后端 wedge。

### 2.2 下钻入口与 CDP（handoff 里没有）

- `tauri-2.11.2/src/webview/mod.rs:177-184`：
  `pub fn controller(&self) -> webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller`
  → `.CoreWebView2()` 即 `ICoreWebView2`。`PlatformWebview` 只在闭包内可见。
- `webview2-com-sys-0.38.2/src/bindings.rs:1455-1475`：
  `CallDevToolsProtocolMethod(methodname, parametersasjson, handler)`——异步 + completed handler，
  与 `ExecuteScript` 同构。
- `webview2-com-0.38.2/src/callback.rs:296-299`：`ExecuteScriptCompletedHandler::create(closure)`，
  闭包签名 `(windows::core::Result<()>, String)`；`:313-318` `CallDevToolsProtocolMethodCompletedHandler`。
- 依赖：`webview2-com-sys 0.38.2` 依赖 `windows 0.61.3` / `windows-core 0.61.2`，与项目直依赖
  `windows = "0.61"`（`Cargo.toml:119`）同大版本 → **不引入第二份 windows**；adapter 只用
  `windows::core`（不受 feature 门控）→ **无需新增 windows feature**。
- ⚠️ **运行期 CDP 域名可用性未核实** → 批 0 尖刺钉死（见 §4）。

### 2.3 两个必须写进契约的坑

1. **脚本失败与「返回 null」不可区分**：页面脚本抛异常时 `ExecuteScript` 回 `null`。
   → **约定所有经桥的脚本返回信封 `{ok: true|false, ...}`**，投影脚本与站点适配脚本都必须遵守。
2. **宽字符串生命周期**：`ExecuteScript` 是异步的，栈上 `Vec<u16>` 在闭包返回即释放。
   → **把 wide buffer move 进 completed 闭包**（指针先取后传），闭包持活到回调为止。

### 2.4 既有形状（照抄源）

| 用途 | 位置 |
|---|---|
| 桥 client 骨架（79 行） | `agent-sidecar/src/extensions/codegraphClient.ts:24-79` |
| 桥纯函数对 | `src-tauri/src/codegraph/agent_bridge.rs:20-46`（+ `:48-72` 单测） |
| 桥拦截块 | `src-tauri/src/runtime/mod.rs:251-328`（`:292` 有 `app.try_state::<Arc<...>>()` 先例） |
| stdin 分流 | `agent-sidecar/src/engine/session-manager.ts:73-78` |
| MCP 注册形状 | `agent-sidecar/src/extensions/knowledgeMcp.ts:50-66` |
| 工具实现形状 | `agent-sidecar/src/extensions/knowledgeTools.ts` + `knowledge/` 子目录 |
| skill 落盘 | `agent-sidecar/src/extensions/codegraphSkill.ts:90-110` |

## 3. 权限模型

| 工具 | 规则 |
|---|---|
| `browser_tabs` / `browser_read` | 自动放行 |
| `browser_eval` | 自动放行（已拍板）+ `AIDE_BROWSER_TOOLS=off` 可整体摘除 |
| `browser_navigate` / `browser_act` | 自动放行 |

**为什么 act/navigate 也不弹窗**：`browser_eval` 自动放行之后，其他闸门**全是装饰性的**
（eval 里 `location.href=...` 就是导航、`el.click()` 就是点击）。做了只会给**假的安全感**。
唯一真控制 = 挂载开关（`!trusted` → null；`AIDE_BROWSER_TOOLS === "off"` → null）。

**诚实含义**：agent 能在用户已登录的任意页面跑任意脚本、发任意请求。与 **Bash 工具同信任级别**，
不是新开的洞。**若将来想要真闸门，唯一自洽做法是把 `browser_eval` 重新归类为必弹窗**——
不能一边放开 eval 一边指望其他门有效。（注：Aide 权限弹窗有「允许并记住」，`api.ts:137` +
`policy/types.ts:23` 的 `{kind:"tool"}` matcher，会话级一次授权即可，代价没有"每次弹"那么高。）

⚠️ **`allowedTools` 必须工具级规则**，不能照抄 codegraph/docs 的 server 级前缀写法——
`knowledgeMcp.ts:15-21` 专门警告：mixed server 用前缀会把写操作一起放行。

## 4. 实施

### 批 0：验证尖刺（**已降级为端到端确认**，见下）

> **决策修正（2026-09-16，实现中）**：原计划把 CDP 可用性当前置门槛。**改掉**——WebView2 是
> Evergreen 运行时，各机器版本不同，**CDP 域名可用性是运行期变量，不是我们构建的固定属性**。
> 所以 `browser_act` 的正确设计是 **CDP 优先 + 脚本派发兜底 + 如实上报走了哪条路**，
> 而不是二选一。尖刺随之降级为端到端时确认「本机主路径是哪个」，不再阻塞实现。

端到端时要钉的三件事：
1. `ExecuteScript` 回值经 channel 桥回 tokio 侧（含中文 / 大 JSON 解码）。
2. `CallDevToolsProtocolMethod("Input.dispatchMouseEvent", ...)` 本机是否被 WebView2 接受
   （探针用 `mouseMoved` 到 (0,0)，无害；不要用 `mousePressed` 试）。
3. `Input.dispatchMouseEvent` 坐标口径（CSS px vs 物理 px）——用已知元素点击结果反推。

### 批 1A：Rust 下钻

- `Cargo.toml` `[target.'cfg(windows)'.dependencies]` 加 `webview2-com = "0.38.2"`（同版本，
  `Cargo.lock:8090` 已在树；注释照 `:69-71` url 先例写明「提为直接依赖、零额外编译成本」）。
- **新建 `browser/adapter/webview2/script.rs`**（内聚新逻辑下沉同名子模块；`mod.rs` 现 188 行）：
  `std::sync::mpsc::channel` → `with_webview` 投递 → 闭包内 `pw.controller().CoreWebView2()`
  → `ExecuteScript(wide, handler)` → handler 里 `tx.send` → 调用侧 `rx.recv_timeout(EVAL_TIMEOUT=10s)`
  → `serde_json::from_str`。`mod.rs:160-167` 改为一行委托。
- 超时层级：**adapter 10s < client 15s**（保证 Rust 错误文本先到；关系写进两侧注释防单改其一）。
- 同步更新 `mod.rs:8-11` 模块文档与 `port/engine.rs:104-110` 未接线清单（eval 移出）。
  **trait 签名不变**（`engine.rs:130` 已是 `-> Result<Value, EngineError>`），`unsupported.rs` 无需改。
- 摘 `port/engine.rs:111` 整块 `#[allow(dead_code)]`，剩余项各自带理由。

### 批 1B：桥（五处）

- 新建 `src-tauri/src/browser/agent_bridge.rs`：`parse_browser_query` / `build_browser_result`
  纯函数 + 内联单测（镜像 `codegraph/agent_bridge.rs:20-72`）。
- **新建 `src-tauri/src/runtime/browser_agent.rs`**：执行体**必须外置**——`runtime/mod.rs` 已 928 行，
  内联会撞 1000 行守卫。
- `runtime/mod.rs` 在 codegraph 拦截块后加对称块：命中 → `tokio::spawn` → `continue`（不转发 Vue）。
  `stdin_for_agent`（:240）与 codegraph 共用 clone，不新增捕获。
- sidecar：`types.ts` 加 ChatEvent `browser_query{request_id, op, args}`（op 刻意收窄为
  `list_views | eval`，`read` 不进协议）+ SidecarCommand `browser_result`；
  `session-manager.ts:75` 旁加分支；`browserClient.ts` 照 codegraphClient 骨架（超时 15s）。
  `cancelAllBrowserQueries` 调用点紧挨 `cancelAllCodegraphQueries`（`session-worker.ts:528` / `:1093`）。
- **headless**：`browser_result` **不加**进 `invokeBodySchema`（照 `headless-schema.ts:246-252` 先例）。
  工具**照常注册**、handler 命中 headless 立即返回「本环境没有内嵌浏览器」——
  不经桥、零等待（照 `knowledgeMcp.ts:7-8`「工具面跨宿主稳定」先例）。

### 批 1C：sidecar 工具面

```
extensions/browserMcp.ts       注册 + BROWSER_INSTRUCTIONS + BROWSER_READ_RULES（工具级）
extensions/browserTools.ts     工具总装
extensions/browser/
  client.ts                    桥客户端
  view.ts                      view_id 解析
  projection.ts                PAGE_PROJECTION_SCRIPT（通用骨架抽取，导出字符串）
  format.ts                    结果 → 模型友好文本
```

**工具面（3 个，全部 `view_id?` 可选）**：`browser_tabs`(→`list_views`) /
`browser_read`(→`eval(PAGE_PROJECTION_SCRIPT)`) / `browser_eval`(→`eval(script)`)。

- **`view_id` 解析在 Rust 侧完成**（`browser_agent.rs`），顺序：
  ① 显式传入 → 必须存在，否则 `view_not_found`；② 缺省 + 恰一个可见视图 → 用它；
  ③ 缺省 + 可见为 0 但恰一个视图 → 用它（面板收起但视图存活）；④ 其余 → `view_ambiguous`
  且 `data.views` 带全量清单（id/url/title）。
- **`browser_read` 刻意不收 `script` 参数**：否则「自动放行的读工具」= 权限旁路。
  自定义脚本一律走 `browser_eval`。这条写进 `browserTools.ts` 头注释。
- **投影脚本住 sidecar TS 模块，不住 Rust**：投影脚本认识「表格/表单/按钮」，放 Rust 就是让内核
  认识页面语义（违反红线），且改脚本要重编 Rust。也不放 skill（skill 是站点 know-how 的家，
  通用骨架抽取器必须无 skill 也能用）。Rust 桥只收到一段不透明字符串。
- **投影脚本契约**：信封 `{ok, url, title, readyState, viewport, skeleton, truncated} |
  {ok:false, error}`；内容用**通用词汇**（headings / 表格行列矩阵 / 表单控件含 label 关联 /
  按钮链接 / iframe 清单含是否同源）；`MAX_NODES` / `MAX_TEXT_CHARS` 上限 + `truncated` 位；
  同源 iframe 递归，跨域只报 src。
- `BROWSER_INSTRUCTIONS` 是**必需品**（`codegraphTools.ts:14-23` 实锤）：先 `browser_tabs` 拿
  view_id；读页面用 `browser_read` 而不是猜 DOM；**页面承载用户登录态，只做用户明确要求的操作**。

### 批 1D：登记 4 处 + 测试

1. `queryContext.ts:8` import + `:58` 后调用（**带 emit**，这是它与 knowledge/docs 的区别）+ `:89` 并入
2. `queryOptions.ts:8` import + `:68` `allowedTools` 加工具级规则
3. **`packages/aide-sdk/src/composables/useCustomizations.ts:78`** `builtinMcpServers` 加条目
   （CLAUDE.md 强制，漏了「扩展」面板不显示）
4. `headless-schema.ts` 补注释（browser_result 同理排除）

测试：`browserMcp.test.ts`（门控 3 臂 + headless 臂 + allow rule 防漂移 + `serializedSpec()`
snapshot + instructions 关键子串）、`browserTools.test.ts`（直接调 `handler`，stub emit 捕获帧 →
测试内回灌 → 断言）、`browserClient.test.ts`、`projection.test.ts`（happy-dom 跑固定 HTML）、
`queryContext.test.ts` 补装配断言、`smoke-mcp.ts` 加段、Rust `agent_bridge` 单测 + `state_test` 排序。

### 批 1E：蓝湖落地（"通用 vs 补丁"的最终答案）

- 新建 `extensions/browserSkill.ts`（照 `codegraphSkill.ts:90-110`；`winPaths.ts` 的
  `toForwardSlashes`/`safeDirname`；写失败静默跳过），落 `skills/browser-inspect/`：
  - `SKILL.md` —— frontmatter **description 用任务词不用站点词**（"extract a prototype/design
    page's specification"）；正文强制工作流 `browser_tabs` → `browser_read` 骨架 → 按 reference 抽取。
    写明「references/ 是站点适配层，遇到新站点先读骨架再写/查对应 reference」——**扩展动作是写数据**。
  - `references/page-extraction.md` —— 通用骨架抽取器进阶用法（站点无关）
  - `references/lanhu-prototype.md` —— 蓝湖薄适配：iframe 定位 + Axure DOM 习惯 + 一段可直接
    粘给 `browser_eval` 的抽取脚本 + 输出 schema
- `index.ts:69` 旁 `ensureBrowserSkill(process.env)`（mainDesktop 内，headless 天然不落盘）
- **验收**：`grep -ri "lanhu\|蓝湖" agent-sidecar/src src-tauri/src` = 0；新增第二站点时
  diff 只含 skill reference 文件。

## 5. 验收

**门禁**：`cd src-tauri && cargo check --all-targets` + `cargo test --lib browser` + `cargo fmt -p aide`；
`npx vue-tsc --noEmit` + `pnpm test` + `pnpm check:tauri-imports` + `pnpm check:sync-io`。

**红线 grep**：
- `webview2-com|wry` 在 `src-tauri/src/browser/adapter/` 之外 0 命中
- `lanhu|蓝湖` 在 `agent-sidecar/src` 与 `src-tauri/src` 0 命中
- `runtime/mod.rs` < 1000 行

**桥的「五处对账」**（照 `new-invoke-command-three-hop-acceptance` 教训——漏一处则编译通过、
测试全绿、功能静默不工作）：client 发出 / ChatEvent 变体 / runtime 拦截命中 / agent_bridge 单测 /
session-manager 分支。**第 3、5 处无测试覆盖 → 端到端真跑时必须确认这两跳确实执行**（看结果真的
回来了，不是只看到"没报错"）。

**端到端**：`pnpm tauri dev`（改 sidecar 要 rebuild dist/runtime.js + 重启 app）→ `Ctrl+Shift+B`
开面板 → 打开蓝湖原型并登录 → agent 走 `browser_tabs` / `browser_read` / `browser_eval`
→ 产出整套原型页面规格清单。

**独立审查**：Rust 派 `code-architect:rust-reviewer`、TS 派 `code-architect:ts-reviewer`。

## 6. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 主线程自锁（历史重灾区） | §2.1 契约 + `script.rs` 头注释；评审 grep `eval(` 调用点确认只有 async 命令/桥两个入口 |
| R2 | ExecuteScript 宽串 use-after-free | move 进 completed 闭包；E2E 必测中文/长脚本 |
| R3 | CDP `Input` 域被 WebView2 限制 | **批 0 先验**；不可用则降级脚本合成事件 + 如实上报（功能不归零） |
| R4 | **蓝湖 Axure iframe 跨域** | 批 1 只能读主 frame + 同源 iframe。跨域 = 骨架列 iframe src + 提示逐页导航读取。**这是「批 1 能否闭环」的最大变数** → 批 0 顺手验一次 |
| R5 | tokio worker 被阻塞（eval 最长 10s） | 桥执行体 `spawn_blocking`（§2.1 已论证合法）；仍见心跳延迟则 adapter 超时降到 3s |
| R6 | `runtime/mod.rs` 撞 1000 行 | 执行体外置 `runtime/browser_agent.rs` |
| R7 | instructions 退化 → 模型对工具视而不见 | snapshot + 关键子串断言 + smoke-mcp 加段 |
| R8 | 装饰性闸门给假安全感 | **不做**；§3 写明唯一真控制是挂载开关 |
