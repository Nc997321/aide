# 内置浏览器可观测层（recorder / network / console）真机验收清单

对应特性：`docs/superpowers/specs/2026-09-22-browser-observability-design.md`（§12 的真机验收表 = 本清单的判据 1–14）
夹具页：`docs/testing/browser-recorder-fixture.html`（`browser_eval("window.__expect()")` 一次读回页面自报判据）
夹具服务：`node scripts/diag/serve-browser-fixture.mjs`（8780；四端点 `/api/ok` `/api/fail` `/api/hang` `/api/big`）
设计原则：**判据必须能被机器判定**——每条都写死"调什么、期望的逐字形态是什么"，所以一个没有上下文的 agent 也能跑完整场；人只负责起实例、开对话、以及看两件机器判不了的事（第 3 节）。

**谁的代价是什么**（这一节先读，别让用户为"顺手跑一下"买单）：

| 谁 | 做什么 | 代价 |
|---|---|---|
| **用户** | `pnpm build:sidecar`、起 dev 实例、起夹具服务、在 **dev 实例里开一个新对话**并把本清单交给它 | 约 5 分钟 + 一个会话的上下文（这是唯一能验真机的地方：sidecar 改的是 `dist/`，安装版跑的是另一份） |
| **agent** | 本清单第 1–2 节：开 3–5 个 **parked** 视图（不抢用户面板；判据 0 会顺带开关几个）、约 30 次工具调用、3 张截图（都是元素级小图） | 不需要用户手工开浏览器面板；不需要用户盯着看 |
| **跑完** | 台账回写 + spec 状态行（第 5 节） | 10 分钟 |

> 前置没做完就开跑 = 验的是上一版行为（v2 的旧价：`browser_tab` 回 `unknown op`）。

---

## 0. 前置（人工，约 5 分钟）

**① 构建**（改的是 sidecar，dev 实例跑 `agent-sidecar/dist/`）：

```bash
pnpm build:sidecar
# 只有要验安装版才需要下面这步（分钟级，需先关掉 Aide）
pnpm build:sidecar && pnpm tauri build
```

**② 重启**（Rust 与 sidecar 都变了，热重载不够），并**确认跑的是新构建**。本机可能同时有安装版与 dev 版
（`tasklist | grep aide.exe` 会看到两个），**对话必须开在 dev 实例里**。三条判据，全部要给 agent 跑：

| 探什么 | 新构建 | 旧构建（别在它上面验） |
|---|---|---|
| `browser_tabs` 的用词 | `parked` / `displayed` | `visible` / `hidden` |
| `browser_network {…}` | 回一段报文（哪怕空） | `unknown op: …` |
| 工具清单里有没有 `browser_network` / `browser_console` | 两个都在 | 缺任一个 = 验收构建没做出来，**停下来告诉控制者** |

**③ 起夹具服务**（仓库根执行，终端留着）：

```bash
node scripts/diag/serve-browser-fixture.mjs          # fixture → http://127.0.0.1:8780/
```

**④ 自检夹具（省得白跑一轮）**——**必须做**，三个坑都在这几条命令上现形：

```bash
curl -s http://127.0.0.1:8780/ | grep -c 'id="hidden-zone"'              # 期望 1；0 = 夹具没上或端口上蹲着别的服务
curl -s http://127.0.0.1:8780/ | grep -c HIDDENMAGIC                     # 期望 5（页面上 1 处 + 页内脚本/注释 4 处——**别拿它当"页面上出现了几次"**）
curl -s -o /dev/null -w '%{http_code}\n'   http://127.0.0.1:8780/api/ok    # 期望 200
curl -s -o /dev/null -w '%{http_code}\n'   http://127.0.0.1:8780/api/fail  # 期望 500
curl -s -o /dev/null -w '%{size_download}\n' http://127.0.0.1:8780/api/big # 期望 ≈307220（300KB 档）
curl -s -m 2 -o /dev/null -w 'exit=%{http_code}\n' http://127.0.0.1:8780/api/hang  # 期望：卡到 curl 超时（退出码 28），什么都不回
netstat -ano | grep LISTENING | grep ":8780"                             # 只该有一条，PID 是你刚起的那个
```

- **第一个 `grep` 回 0**：夹具没上，或端口上蹲着**别的**静态服务；第二个 `grep` 回 1 或回 0（而不是 5）= **旧夹具页**
  （元素清单对不上，判据 10/11/12 全会误判）——两种都要腾端口重起 / 换页面再跑。
- **`/api/hang` 立刻回包**：那不是夹具服务（它是**永不回包**的），同样要腾端口重起。

**⑤ 开新对话**，把下面这段原样粘给 dev 实例里的 agent：

> 你在验收 Aide 内置浏览器的可观测层（recorder / `browser_network` / `browser_console`）。
> 清单在 `docs/browser-observability-test-checklist.md`：**严格按它执行**，每步把工具返回**原文**记下来，
> 最后把第 5 节的台账填满——**不许美化失败**，失败就把返回原文附上。夹具服务已经起好了（8780）。

**⑥ 权限**：`browser_network` / `browser_console` 已进放行名单（与其余七个浏览器工具同款，见 `browserMcp.ts` 的
`BROWSER_ALLOW_RULES`），**不会**弹窗——若真弹了，说明跑的不是本批构建。

---

## 1. 判据 0：注册路（**门禁**——不通过就别往下跑）

整套 recorder 的地基是"**在文档创建那一刻**把探针装上"（加载期请求、新文档自动带上都靠它）。
实现走的是 CDP `Page.addScriptToEvaluateOnNewDocument`（零 Rust），**这条路在真机 WebView2 上从未验过**。

**它不需要额外工具**：注册成没成由实现自己报出来（注册被拒 ⇒ 输出里会出现一句
`the recorder could not be registered for future page loads: … was rejected by the runtime (…)`），
而"注册到底交没交货"由**加载期请求在不在**直接回答。所以门禁就是下面这一小段，走完再进第 2 节。

1. `browser_tab {action:"open", url:"http://127.0.0.1:8780/", label:"gate"}` → 记下 **VG**。
2. `browser_network {view_id:VG}`（本视图的第一次 recorder 调用）→ 期望两句：`armed in this document by this call`
   的 NOTE + `No requests recorded yet.`；**不应**出现 `could not be registered` 那句。
3. `browser_tab {action:"navigate", view_id:VG, url:"http://127.0.0.1:8780/?gate=1"}`（**要一份新文档**）。
4. 等 1 秒（读响应体是异步的）→ `browser_network {view_id:VG}` → 期望**两行**加载期请求：
   `GET http://127.0.0.1:8780/api/ok → 200`，fetch 与 XHR 各一条（夹具在文档创建时同时发这两条）。

**判定**：

| 第 4 步看到什么 | 含义 | 下一步 |
|---|---|---|
| 两行加载期请求 | 注册生效 ✓ | 门禁过，进第 2 节 |
| 空表，且第 2 步有 `could not be registered … rejected by the runtime` | CDP 那条路在真机不可用 | **停**，原文交控制者：计划里的条件任务（Rust 宿主 API `AddScriptToExecuteOnDocumentCreated`）必须先做、重建、重启 |
| 空表，且第 2 步**没有**那句 | 注册被接受但**没交货** | 同上：停，原文交控制者 |

**不要在没装上的构建上验判据 1–16**——那验的是"懒装"，而懒装恰好漏掉本批最想要的加载期请求，全绿也是假的。

**顺带记一条**（不改判定，但决定判据 7b 怎么读）：**第 3 步的返回**是"落点一致"还是"落点不符"，以及紧接着
`browser_eval {view_id:VG, script:"location.href"}` 读到的是新 URL 还是旧 URL：

| 第 3 步 | 落点读取 | 含义 |
|---|---|---|
| 报一致 | 新 | `NAV_SETTLE_MS = 250ms` 够用 |
| 报不符 | 新 | settle **太短**（正常导航被误报成不符）→ 把 `250` 调大 |
| 报不符 | 旧 | 导航还没提交，属异常 → 原文交控制者 |

---

## 2. 主判据（agent 执行）

**通用纪律**：每步都带 `view_id`（会场上有多个视图，工具**不会猜**）；每步把返回**原文**抄进台账；
所有页面访问都走 `http://127.0.0.1:8780/` 这一份夹具，**别用别的页面**（判据的期望值全部钉在这份夹具上）。

### 2.1 主视图 V1

**S1（开场，无判据）** `browser_tab {action:"open", url:"http://127.0.0.1:8780/", label:"rec-main"}` → 记下 **V1**。
返回里应说明它是 **PARKED**（后台跑，不抢用户面板）。

**S2（判据 6a / 未装的如实说明）** 紧接着 `browser_network {view_id:V1}`——**这是这个视图上的第一次 recorder 调用**。
期望同时出现两句：

- `NOTE: the recorder was armed in this document by this call, so anything the page did before now (including its load-time requests) is not in the buffer. Navigate or reload to capture a fresh document from its first request.`
- `Network requests (last 0 of 0, newest last):` + `No requests recorded yet.`

判据：**"这次才装上"与"装了但没请求"必须长得不一样**。若这里没有这句 NOTE（只回一句空态），记 FAIL——
那会让 agent 把"探针刚装上、之前看不到"读成"页面没发请求"，正是本批要消灭的那种误读。
（顺带确认：页面加载期那两条**不**在这里出现——这是对的，它们发生在装探针之前。）

**S3（判据 1；顺带判据 7b）** 装上了才去导航，让**新文档**从头被录：

1. `browser_tab {action:"navigate", view_id:V1, url:"http://127.0.0.1:8780/?load=1"}`
   → 期望落点一致分支：`Navigated view … — the document confirms it is at http://127.0.0.1:8780/?load=1.`
   （若这里报"落点不符"而页面报的又是**旧** URL，见判据 7b。）
2. 等 1 秒（读响应体是异步的），`browser_network {view_id:V1}` → 期望表头 `Network requests (last 2 of 2, newest last):`
   下**两行**，都是加载期发出的 `GET /api/ok → 200`，各带响应片段 `{"ok":true,"rows":[1,2,3]}`。
   夹具在文档创建时**同时**发一条 `fetch` 与一条 `XMLHttpRequest`（同一 URL），所以"两行"就是"两条通道都被包上了"。
   - 可选确诊（行里不区分通道）：`browser_eval {view_id:V1, script:"window.__aideRec.reqs.map(function(r){return r.kind})"}` → 期望 `["fetch","xhr"]`。
   - 这里**不该**再出现"armed by this call"的 NOTE（那是 S2 那次的事）。

**S4（判据 2）** `browser_eval {view_id:V1, script:'__probe("fail")'}` → 再 `browser_network {view_id:V1, filter:"/api/fail"}`。
期望：表头写明过滤（`Network requests matching "/api/fail" (…)`）+ **失败摘要行** `⚠ 1 of 1 matches failed — first failure #…`
+ 该行 `→ 500` 且片段里有 `No enum constant com.demo.EQUIPMENT_MAINTENANCE_TASK_AUDIT`。

**S5（判据 3）** `browser_eval {view_id:V1, script:'__probe("hang"); "fired"'}` → 再 `browser_network {view_id:V1, filter:"/api/hang"}`。
期望该行状态列是 `(pending, Nms so far)`（N 随每次读变大），**不是** `200`、**不是** `(no status code)`。

> ⚠️ 脚本必须写成 `__probe("hang"); "fired"`（**别只写 `__probe("hang")`**）：这条请求永不回包，
> 而 `browser_eval` 会 await 表达式的结果——只写前者会让这次 eval 一直等到 15 秒超时。

**S6（判据 4）** `browser_eval {view_id:V1, script:'__probe("big")'}` → 再 `browser_network {view_id:V1, filter:"/api/big"}`。
期望该行状态 `200`、**没有 300KB 正文**，代之以 `body skipped (3072xx bytes)`。

**S7（判据 5）** 控制台：

1. `browser_act {view_id:V1, action:"click", selector:"#btn-throw"}` → `browser_console {view_id:V1}`
   → 期望一行 `[uncaught] Uncaught ReferenceError: nope is not defined`。
2. 再补一条真 `console.error` 对照：`browser_eval {view_id:V1, script:"console.error('boom-marker'); 'ok'"}`
   → 再 `browser_console {view_id:V1}`。
   **判据**：`[error]  boom-marker` 与 `[uncaught] …` 是**两行、两个标签**——合成一类就把"这错是页面自己打印的、
   还是它没接住的"这条线索抹掉了（本批最值钱的一条）。

**S8（判据 9）** `browser_wait {view_id:V1, until:"condition", condition:"document.readyState.length > 0", interval_ms:200, timeout_ms:5000}`
→ 期望 `Condition met after N poll(s) (Mms, polling every 200ms): …`，其中 **M 是实测墙钟**：
`N = 1` 时 M 应**明显小于 200**（本机量级几十毫秒）。
**FAIL 判据**：M 恰好等于 `N × 200`（合成值回来了），或 M ≥ 200 而 N = 1（首次轮询就成立却报满一个 interval）。

**S9（判据 7）** navigate 落点——两条都要跑：

- **7a 守卫弹回（不许报假成功）**：`browser_tab {action:"navigate", view_id:V1, url:"http://127.0.0.1:8780/#/two"}`
  夹具的路由守卫会把 hash 弹回 `#/one`。
  期望**不一致分支**：以 `but the document reports ` + 实际落在的 URL（**带 `#/one`**，前面可能还挂着当前查询串）
  + ` instead.` 收尾，并给出两条成因（尚未提交 / 页面重定向或路由守卫弹回）。
  再用 `browser_eval {view_id:V1, script:"location.hash"}` 复核 → `"#/one"`。
  **FAIL**：任何形式的"已导航到 `#/two`"（哪怕只是完成时语气的断言）。
- **7b 普通跨文档导航（必须对得上）**：`browser_tab {action:"navigate", view_id:V1, url:"http://127.0.0.1:8780/?plain=1"}`，
  再跑一次到 `?plain=2`。
  期望两次都走**一致分支**（`the document confirms it is at …`）。
  **若每一次普通跨文档导航都报"落点不符"、且页面报的是旧 URL** ⇒ 那 250ms 的 settle 太短（异步投递还没提交），
  这是**已知的待验常量**，按 finding 记下来（附原文），不是用户操作问题。

**S10（判据 8）** 同文档导航的提示：

1. `browser_eval {view_id:V1, script:"history.pushState(null,'','?same=1'); 'pushed'"}`（同文档导航，不触发 load）
2. `browser_wait {view_id:V1, until:"load", timeout_ms:3000}`
   期望文案里带 **`SAME-DOCUMENT`**（"若你刚做的是同文档导航（hash / pushState），它不会触发 load，也不会出现在这里"）。
   **FAIL**：只回一句"没有东西在加载"而**不提同文档导航**——agent 会把它读成"导航没发生"。

**S11（判据 16）** `browser_wait` 的文档身份——`performance.timeOrigin` 是免费指纹：

- **16a 指纹确实随文档变化**：`browser_eval {view_id:V1, script:"performance.timeOrigin"}` → 记 T1；
  `browser_tab {action:"navigate", view_id:V1, url:"http://127.0.0.1:8780/?t=1"}`；
  再读一次 → 记 T2。**期望 T2 ≠ T1**（两者都是有限正数）。
  T2 = T1 ⇒ 本运行时没有文档身份概念，P2-2 整条建在沙上 → 记 finding（附两个值）。
- **16b 一场跨文档替换的等待必须自己说明**：
  `browser_wait {view_id:V1, until:"condition", interval_ms:500, timeout_ms:10000, condition:"(function(){ if (sessionStorage.getItem('aideReload')) return true; sessionStorage.setItem('aideReload','1'); setTimeout(function(){ location.reload(); }, 200); return false; })()"}`
  这段条件自己触发一次 reload，且只在**新文档**里成立 ⇒ 这场等待**跨越了文档替换**。
  期望成功文案后**附一行**：`NOTE: the page was replaced 1 time(s) during this wait (last at poll #…) — observations before that were reading a different document.`
  **FAIL**：默默成功、只字不提替换过（"我等的到底是哪个文档"重新变成不可观测——这正是本判据存在的理由）。
  收尾：`browser_eval {view_id:V1, script:"sessionStorage.removeItem('aideReload'); 'cleared'"}`。
  （若这次调用回 `The condition could not be evaluated at all: …`：那是轮询正好撞进 reload 的窗口，**先记下来**，
  清掉 flag 再跑一次；连着两次都在同一处炸 = 求值通道在导航中途不可用，按 finding 记。）

**S12（判据 10）** Raw text 的可见性过滤——**这段要读三个数、看三种形态**：

1. `browser_eval {view_id:V1, script:"window.__expect()"}` → 记下三个布尔，**期望**：
   `hiddenMagicVisible:false`（页面自己的 `innerText` 能把隐藏的 `HIDDENMAGIC` 滤掉）、
   `hiddenMagicInText:true`（字符串确实在 DOM 里——不然这条判据是空的）、
   `hiddenMagicInClone:true`（**游离 clone 上的 `innerText` 会退化成 `textContent` 语义**，就是那个陷阱）。
2. `browser_read {view_id:V1}` → **`## Raw text` 段里不许出现 `HIDDENMAGIC`**；skeleton 照旧干净：
   隐藏的 `.same` 按钮（`#same-c`）不在可点元素清单里，且有一行计数 NOTE，本夹具期望
   `NOTE: 1 clickables hidden (display:none / zero-size) and not listed — pass include_hidden to include them.`
   （数字对不上照实记，但别为它单独判 FAIL——本判据的靶子是 Raw text 那一段。）
3. **判形态**（这一条是本判据的重点）：
   | 看到的 | 结论 |
   |---|---|
   | Raw text 无 `HIDDENMAGIC`，也没有"text 未过滤"的 NOTE | **PASS**（默认路径） |
   | Raw text **有** `HIDDENMAGIC`，但同时有 `NOTE: the raw text below is the document's full text content … This runtime could not produce rendered text.` | **如实降级**，不是谎；但它说明 `innerText` 这条路在这个视图上不可用 ⇒ 记 finding：修法要改成"剪枝隐藏子树后再取 textContent" |
   | Raw text **有** `HIDDENMAGIC`，且**没有**那句 NOTE | **FAIL（最坏形态）**：声称过滤了却在泄漏。特别是当上面那个 `hiddenMagicVisible:false`（页面自己明明滤得掉）时 ⇒ 说明 sidecar 用的不是**活着的那份文档**的 `innerText`（典型：拿游离 clone 求的），是**假过滤**，必须改实现 |

**S13（判据 11）** CJK 空白容错：`browser_act {view_id:V1, action:"click", text:"确定"}`
期望 `Clicked <button> "确 定" #cjk-ok with a real mouse event via CDP at (x, y).`
**FAIL**：报"文本在页面上且可见，但元素不像可点击"并给出 `#copyline`（`确定通过审核？` 那段文案）——
真正的按钮 `<button>确　定</button>`（中间是 **U+3000**）从没进候选池。

**S14（判据 12）** 歧义报数：`browser_act {view_id:V1, action:"click", selector:".same"}`
期望 `Clicked <button> "保存" #same-a with a real mouse event via CDP at (x, y) (2 elements matched; used index 0).`
夹具里 `.same` 有**三个**（两个可见 + 一个 `display:none`）⇒ 池子里是 **2**，隐藏的那个**不许进池**。
`count` 为 3 或点到 `#same-c` = FAIL。只有一个命中时**不该**出现这句脚注。

**S15（判据 13 + 14）** 元素截图：

- `browser_screenshot {view_id:V1, selector:"#cjk-ok"}`
  期望：一行说明 `Screenshot of <button> "确 定" #cjk-ok in the embedded browser as JPEG. …` + **一张小图**，
  图上就是那一个按钮（不是整页、不是别处）。
- `browser_screenshot {view_id:V1, text:"不存在的按钮"}`
  期望：以 `Could not find the target:` 开头的**纯文本**错误，**没有图像块**。
  **FAIL**：退化成整页截图（会让 agent 以为拿到了局部）。

### 2.2 第二个视图 V2（未装的如实说明 + 两处未验的裁剪坐标）

**S16（判据 6b）** `browser_tab {action:"open", url:"http://127.0.0.1:8780/", label:"rec-fresh"}` → 记 **V2**，
**第一次 recorder 调用就用 `browser_console {view_id:V2}`**（顺序别换）。
期望 `NOTE: the recorder was armed in this document by this call, so anything the page logged before now is not in the buffer. Reload or navigate to capture a fresh document from its first line.`
+ `Nothing recorded yet.`（console 版的两种空态也必须可辨）。

**S17（判据 15）** 元素截图的**两处按构造未验的坐标口径**。夹具页里**没有**可滚动的长页、也没有 fixed 元素，
所以这一步**在页面里现造**（只动 V2 这个 agent 自己的 parked 视图，不碰 V1、不动夹具文件）：

1. 造场景（一次 `browser_eval`，脚本照抄）：

```js
(() => {
  const mk = (id, css, text) => { const d = document.createElement('div'); d.id = id; d.style.cssText = css; d.textContent = text; document.body.appendChild(d); return d; };
  mk('crop-spacer', 'height:2400px;background:#101820', 'spacer');
  mk('crop-static', 'width:260px;height:90px;background:#22c55e;color:#03170a;font:700 20px/90px system-ui;text-align:center;margin:20px 0', 'STATICMARK');
  const f = mk('crop-fixed', 'position:fixed;left:40px;bottom:40px;width:260px;height:90px;background:#e11d48;color:#fff;font:700 20px/90px system-ui;text-align:center;z-index:99', 'FIXEDMARK');
  window.scrollTo(0, 1500);
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
  return { scrollY: window.scrollY, static: r(document.getElementById('crop-static')), fixed: r(f) };
})()
```

   期望回一个对象：`scrollY` ≈ 1500，`static.top` 是**大数**（元素在视口下方很远处），`fixed.top` 是**视口内的小数**
   （它不随滚动移动）。记下这三个数——它们就是"裁剪框该是多少"的算式输入（clip = rect.top + scrollY）。
   若 `static.top` 竟落在视口内，再滚一次把它推到视口外（判据要的正是"元素在视口外"这个形态：
   裁剪框对了才说明 clip 吃的是**文档坐标**，而不是侥幸落在视口里）。

2. **15a 文档坐标（静态元素）**：`browser_screenshot {view_id:V2, selector:"#crop-static"}`
   期望：图上就是那个**绿色 STATICMARK 方块**。
   判据意义：实现假设 CDP 的 `clip` 是**文档坐标**（并发了 `captureBeyondViewport: true`）。若这个假设错，
   裁剪会落在**离屏幕顶部不远**的别处（多半是一片深色空白）——**看到深色/空白就是 finding**，不是用户操作问题。
3. **15b 滚动页上的 `position: fixed` 元素**：`browser_screenshot {view_id:V2, selector:"#crop-fixed"}`
   记录实际截到了什么：**红色 FIXEDMARK 方块** = 这条口径能用；**深色空白 / 别的区域** = 固定定位元素的
   裁剪坐标是错的（实现在源码里明写了这条假设"没量过"）⇒ **按 finding 报**（附三张图的判断与上面的 rect 数）。
   这一格**必须有结论**，哪怕结论是"错的"——它是本判据唯一的存在理由。
4. 收尾：**把这一场自己开的视图全部关掉**（VP / V1 / V2 以及判据 0 里顺带开的那些）：
   `browser_tab {action:"close", view_id:…}`（parked 视图一直在渲染，留着白烧 CPU/GPU）。

---

## 3. 只有人能判的两件事

**① 前台没被抢。** 整场跑在 agent 自己开的 parked 视图里：用户的面板**不该有任何变化**（不该跳页、不该多出标签、
不该被推到前台）。看到面板自己动了 = **FAIL**（本批没做 UI，这是回归项）。

**② 用户屏幕上"没有被弹窗打断"。** 全场**不该**有任何权限弹窗（九个浏览器工具都在放行名单里，
见 `browserMcp.ts` 的 `BROWSER_ALLOW_RULES`）。多出来的提示 = 工具面漏登记，记下来。

---

## 4. 四条"像故障但不是"的现象（别误报）

1. **超时文案里的实测跨度会略超预算**（例如 `budget 3000ms` 而实测 3100ms）：出口判定在最后一次 sleep 之后。
   这是**诚实的**（数字是实测的），不要当缺陷报。
2. **刚导航完就读网络，条目可能是 `(pending, …)` 或没有响应体**：读响应体是异步的（`res.clone().text()`）。
   本地回环上等 1 秒再读一次即可——第二次还是 pending 才算问题。
3. **导航之后旧请求全没了**：recorder 的缓冲活在**当前文档**里，任何导航/reload 都会清零。这是**设计**（本批要看的正是
   "新文档自己加载期"的请求），不是丢数据；跨导航追查本批**明确不做**。
4. **带 filter 的失败摘要分母恒用复数**（只命中一条失败时也印 `1 of 1 matches failed`）：已知的措辞瑕疵，
   不是缺陷；别为它单开一条 finding（要报就并到"文案类"里一起报）。

---

## 5. 验收台账（跑完当天回写）

| # | 判据 | 调用（简） | 期望（逐字/形态） | 实测片段 | 结论 |
|---|---|---|---|---|---|
| 0 | 注册路（门禁） | `browser_network` → navigate → `browser_network` | 无 `could not be registered` 那句；新文档能看到两行加载期请求 | | |
| 1 | 加载期请求可见 | `browser_network` → navigate → `browser_network` | 两行 `GET /api/ok → 200`（fetch + XHR） | | |
| 2 | 失败可诊断 | `__probe("fail")` → `browser_network {filter:"/api/fail"}` | `→ 500` + `No enum constant …` + 失败摘要行 | | |
| 3 | 未结束可辨 | `__probe("hang"); "fired"` → `filter:"/api/hang"` | `(pending, Nms so far)` | | |
| 4 | 体积闸门 | `__probe("big")` → `filter:"/api/big"` | `body skipped (3072xx bytes)`，无正文 | | |
| 5 | 控制台吞错可查 | 点 `#btn-throw` → `browser_console`；再补 `console.error` | `[uncaught] …` 与 `[error] …` **分行** | | |
| 6 | 未装的如实说明 | V1 首次 `browser_network`；V2 首次 `browser_console` | `NOTE: the recorder was armed in this document by this call …` | | |
| 7 | navigate 落点 | `navigate #/two`；普通 `navigate ?plain=1/2` | 7a 报实际 `#/one`（不报假成功）；7b 两次都一致 | | |
| 8 | 同文档导航提示 | `pushState` → `browser_wait until:"load"` | 文案含 `SAME-DOCUMENT` | | |
| 9 | wait 实测耗时 | `browser_wait` 立刻成立的条件（`interval_ms:200`） | `(Mms …)`，M 是实测，**≠ N×200** | | |
| 10 | Raw text 过滤 | `window.__expect()` + `browser_read` | 三布尔 `false/true/true`；Raw text 无 `HIDDENMAGIC` | | |
| 11 | CJK 空白 | `browser_act {text:"确定"}` | 命中 `<button> "确 定" #cjk-ok` | | |
| 12 | 歧义报数 | `browser_act {selector:".same"}` | `(2 elements matched; used index 0)`，点到 `#same-a` | | |
| 13 | 元素截图 | `browser_screenshot {selector:"#cjk-ok"}` | 只含那个按钮的小图 + 说明行 | | |
| 14 | 截图失败不退化 | `browser_screenshot {text:"不存在的按钮"}` | `Could not find the target:`，**无图像块** | | |
| 15 | 裁剪坐标两处 | 造滚动页 + fixed 元素，各截一张 | 15a 含 `STATICMARK`；15b 记实际形态 | | |
| 16 | wait 文档身份 | `performance.timeOrigin` 前后对比；自触发 reload 的等待 | 16a 前后**不等**；16b 带 `the page was replaced N time(s)` | | |

**验收结论（YYYY-MM-DD）：N/17（判据 0–16）。** 失败项与 finding 逐条附在下面（原文，不转述）。

**回写清单**（跑完当天做完，别拖）：

1. 本文件：整表填满 + 结论行。
2. `docs/superpowers/specs/2026-09-22-browser-observability-design.md` 头部状态行 →「已实现并真机验收通过（N/N）」；
   第 16 节未决问题补两条：`frame` 为何不做（隔离世界观察不到主世界）、Raw text 为何用布尔旁注而非计数
   （`innerText` 与 `textContent` 的空白折叠规则不同，字符差可以是 0 甚至负数，报一个会骗人的数字更糟）。
3. 判据 0 的实测结论（注册路通不通 / settle 够不够）写进实现计划的「步骤 0 实测结果」节。
4. 判据 0 若被拒或"被接受但没交货" ⇒ 条件任务（Rust 兜底注入）落地后再重跑本清单。

---

## 6. 失败时留什么现场

**别关视图、别重启、别改代码**——先把这四样存下来：

1. 失败那条工具调用的**返回原文**（不要转述，尤其别把 `#/one` 抄成 `#/two` 这类手抄失真）
2. `browser_tabs` 的完整输出（确认 view_id 与 parked/displayed）
3. 失败前最后一条成功与第一条失败的**工具名 + 时间**
4. 若是截图类失败：那张图和它的说明行一起存（图像本身是证据）

然后按 `superpowers:systematic-debugging` 走。两条分诊建议：**先看判据 0**（没装上的话，判据 1/6/10 的结论全是假的）；
再看 `browser_eval {script:"window.__expect()"}`（页面侧自报的判据能立刻把"页面不对"与"工具不对"分开）。
