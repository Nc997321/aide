# 内置浏览器 parking 真机验收清单（双 agent 并发版）

对应特性：`docs/superpowers/specs/2026-09-21-agent-tabs-and-parking-design.md`
夹具页：`docs/testing/browser-parking-fixture.html`（页面自报状态，agent 用 `window.__probe()` 一次读完）
设计原则：**判据必须能被机器判定**——所以断言全部落在夹具页自报的字段上，人只看三件机器判不了的事。

---

## 0. 前置（人工，约 5 分钟）

**① 确认对话跑在哪个实例**（v2 spec 踩过的坑：安装版用 `%LOCALAPPDATA%\Aide\agent-runtime\aide-agent.exe`，
改 `dist` 不影响它）：

```bash
pnpm build:sidecar                 # dev 实例：sidecar → agent-sidecar/dist/
# 要验安装版才需要下面这步（分钟级，需先关掉 Aide）
pnpm build:sidecar && pnpm tauri build
```

**② 重启 Aide**（Rust 与 sidecar 都变了，热重载不够）。

**②′ 确认跑的是新构建**——本机可能同时有安装版与 dev 版（`tasklist | grep aide.exe` 会看到两个），
**agent 必须在新的那个里跑**，否则 `browser_tab` 会回 `unknown op: open`。最快的判据：让 agent 跑一次
`browser_tabs`，**看它的输出用词**：

| 新构建 | 旧构建 |
|---|---|
| `[ready, displayed, …]` / `[ready, parked, …]`，可能带 `"label"` | `[ready, visible, …]` / `[hidden]` |

旧构建一律重跑前置，别在它上面验——那验的是上一版行为。

**③ 起夹具服务**（仓库根执行，前面那个终端留着）：

```bash
node -e "const h=require('http'),f=require('fs');h.createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});s.end(f.readFileSync('docs/testing/browser-parking-fixture.html'))}).listen(8777,'127.0.0.1',()=>console.log('fixture → http://127.0.0.1:8777/'))"
```

**③′ 自检夹具（省得白跑一轮）**——**必须做**，两个坑都在这条命令上现形：

```bash
curl -s "http://127.0.0.1:8777/?who=preflight" | grep -c __probe     # 期望 1；0 = 夹具没上
netstat -ano | grep LISTENING | grep ":8777"                        # 只该有一条，PID 是你刚起的那个
```

- **回 `no` / 404**：8777 上蹲着**别的**静态服务（它把带 query 的请求当文件名，找不到就 404）。
  先 `taskkill /PID <PID> /F` 腾出端口再起夹具——这是 2026-09-21 实际踩过的坑。
- **回 200 但没有 `__probe`**：那是**旧夹具页**（早期探针版），同样要换掉。

**④ 你自己开一个 tab 给 Agent B 用**：右栏浏览器地址栏输入

```
http://127.0.0.1:8777/?who=user
```

回车。**就让它停在面板上看着**——整场验收你要一直看着它（这正是"agent 在后台干活、用户前台不受影响"的现场）。

**⑤ 起两个对话**，把下面两段 prompt 分别粘给它们，**同时发出去**（并发的意义就在于互相干扰）。

---

## 1. 角色分工

| 角色 | 干什么 | 覆盖的能力 |
|---|---|---|
| **Agent A** | 自己 `browser_tab open` 一个新 tab，全程在**后台**干活 | open / label / parked / 后台渲染 / 后台截图 |
| **Agent B** | 用**你手工开的**那个 tab，重复同一批判据 + 导航/前进后退 | 旧工作流不退化 / navigate / back / forward / 缺省 view_id 纪律 |
| **你** | 看三件机器判不了的事（第 4 节） | 不抢前台 / focus 才抢 / 托盘 |

---

## 2. 给 Agent A 的 prompt（原样粘贴）

> 你在验收 Aide 内置浏览器的一个新特性：**看不见的 tab 也要能干活**。严格按下面步骤做，
> 每步把工具返回**原文**记下来，最后交一张 PASS/FAIL 表（不许美化失败；失败就把返回原文附上）。
> 夹具页在 `http://127.0.0.1:8777/`，页面上有 `window.__probe()` 可以一次读完所有判据。
>
> 1. `browser_tabs` —— 记下当前有哪些视图（id / label / displayed 还是 parked）。
> 2. `browser_tab {action:"open", url:"http://127.0.0.1:8777/?who=alpha", label:"alpha-accept"}`
>    —— 记下返回的 `view_id`（下文叫 **VID**）。**断言**：返回文本里说了它是 parked/后台。
> 3. **合成在跑**：`browser_eval {view_id:VID, script:"window.__probe().raf"}` → 记 A；
>    睡 3 秒；再求一次 → 记 B。**断言**：`B > A + 30`（旧世界这条是 0）。
> 4. **真实点击**：`browser_act {view_id:VID, action:"click", selector:"#btn"}`，
>    然后 `browser_eval {view_id:VID, script:"window.__probe().clicks"}`。**断言**：等于 1。
> 5. **过渡跑不跑得完**（旧世界的死穴）：`browser_act {view_id:VID, action:"click", selector:"#anim-btn"}`，
>    然后 `browser_wait {view_id:VID, until:"condition", condition:"window.__probe().animDone === 'yes'",
>    timeout_ms:8000}`。**断言**：条件成立（不是超时）。
> 6. **懒加载**：`browser_wait {view_id:VID, until:"condition",
>    condition:"window.__probe().lazyReady === 'yes'", timeout_ms:10000}`。**断言**：成立。
> 7. **填值**：`browser_act {view_id:VID, action:"fill", selector:"#name", value:"alpha-填值"}`；
>    `browser_act {view_id:VID, action:"fill", selector:"#pick", value:"jia"}`；
>    然后 `browser_eval {view_id:VID, script:"window.__probe()"}`。**断言**：`name==="alpha-填值"`、
>    `pick==="jia"`、`change===true`、`vis==="visible"`。
> 8. **截图**：`browser_screenshot {view_id:VID}`。**断言**：拿到图像块（不是一段文字错误）。
> 9. **先别关这个 tab**（我要看标签条上的标记），把 VID 与最终 PASS/FAIL 表报给我。

---

## 3. 给 Agent B 的 prompt（原样粘贴）

> 你在验收 Aide 内置浏览器的一个新特性：**看不见的 tab 也要能干活**。严格按步骤做，每步记录工具
> **返回原文**，最后交 PASS/FAIL 表（不许美化失败）。
>
> 1. `browser_tabs` —— 找到 URL 里含 `who=user` 的那个视图（**用户手工开的**），记下它的 `view_id`
>    （下文叫 **VID**）。**断言**：它的状态是 `displayed`（用户正看着它）。
> 2. **确认并发**：把完整清单抄给我，并说明它与另一个 agent 自己开的那个视图（URL 含 `who=alpha`）
>    **不是同一个 id**。
> 3. **合成在跑**：`browser_eval {view_id:VID, script:"window.__probe().raf"}` → A；睡 3 秒 → B。
>    **断言**：`B > A + 30`。
> 4. **真实点击**：`browser_act {view_id:VID, action:"click", selector:"#btn"}` →
>    `browser_eval {view_id:VID, script:"window.__probe().clicks"}`。**断言**：等于 1。
> 5. **过渡**：`browser_act {view_id:VID, action:"click", selector:"#anim-btn"}` →
>    `browser_wait {view_id:VID, until:"condition", condition:"window.__probe().animDone === 'yes'",
>    timeout_ms:8000}`。**断言**：成立。
> 6. **填值**：`browser_act {view_id:VID, action:"fill", selector:"#name", value:"beta-填值"}` →
>    `browser_eval {view_id:VID, script:"window.__probe()"}`。**断言**：`name==="beta-填值"`。
> 7. **导航 + 历史**：`browser_tab {action:"navigate", view_id:VID, url:"http://127.0.0.1:8777/?who=beta"}`
>    → `browser_eval {view_id:VID, script:"window.__probe().who"}`。**断言**：`"beta"`。
>    然后 `browser_tab {action:"back", view_id:VID}` → 再求一次。**断言**：回到 `"user"`。
>    再 `browser_tab {action:"forward", view_id:VID}` → **断言**：又回到 `"beta"`。
> 8. **缺省 view_id 的纪律**（现在有两个视图）：`browser_eval {script:"1+1"}`（**故意不传 view_id**）。
>    **断言**：它**报错并列出两个视图**，而不是随便挑一个来执行。
> 9. 把 VID 与 PASS/FAIL 表报给我；**别关这个 tab**（它是用户自己开的）。

---

## 4. 只有你能判的三件事

**① 全程你的前台没被抢。** 从两个 agent 开始到结束，浏览器面板应当**一直停在你那个 `?who=user` 的页面上**
（它们开 tab、跑断言、截图，都不该把面板切走）。看到任何一次"面板自己跳到别的 tab"= **FAIL**。

**② focus 才切、且是幂等展开。** 让 Agent A 执行一次：

```
browser_tab {action:"focus", view_id:"<Agent A 报的 VID>"}
```

**期望**：面板切到 alpha 那个 tab，**且面板没有被收起来**（旧实现在"用户正看着浏览器"时会 toggle 收起，
那是这条路唯一的坑）。看完再切回你自己的 tab。

**③ 托盘里也在干活**（脚本化，别凭感觉）：

1. 让 Agent A 执行：`browser_tab {action:"open", url:"http://127.0.0.1:8777/?who=tray&lazy=25000",
   label:"tray-accept"}`，紧接着 `browser_wait {view_id:"<新 VID>", until:"condition",
   condition:"window.__probe().lazyReady === 'yes'", timeout_ms:40000}`。
2. **趁它在等**，把 Aide 窗口藏到托盘（点标题栏 ✕ 或托盘菜单），数 15 秒，再叫回来。
3. **期望**：Agent A 报"条件成立"（≈25 秒后），而不是超时——说明窗口不在屏上时它在继续跑。

---

## 5. 回归三条（都别省）

**为什么必须有这一节**：本特性改的是**所有路径共用的那一处**——"不显示"从 `hide()` 换成 parking。
而面板上有三处都会调它：切标签、浮层让位、关面板。判据 1–13 只在**新开的 agent tab** 上验证，
**一条都测不出**这三条路径有没有被改坏（新功能全绿、老功能坏掉，是最常见的失败模式）。

| 回归项 | 原来怎么工作 | 你做什么 | 看什么 |
|---|---|---|---|
| ① 切标签 | 切走的 tab 隐藏但保活，切回来状态还在 | 在标签条上点两个 tab 来回切 | 切回来页面还是原样（填过的值、滚动位置都在） |
| ② 浮层让位 | 设置/权限弹窗一开，内置视图必须**让位**——它浮在所有 HTML 之上，不让位就把弹窗下半截吃掉 | 打开设置面板（或触发一次权限弹窗） | 弹窗完整可见、没被网页压住；**且弹窗开着时页面还在跑** |
| ③ 关面板保活 | 收起右栏 = 视图藏起来但活着 | 收起右栏 → 等 10 秒 → 展开 | 页面还在原处（不是白页、没重新加载）；期间 agent 调用照常成功 |

②③ 的"还在跑"肉眼看不出来，让 agent 采样（两条命令一样，只是时机不同）：

```
browser_eval {view_id:"<你自己那个 tab 的 id>", script:"window.__probe().raf"}
```

隔 2 秒再采一次 → **数字要涨**（+20 以上）：

- 弹窗开着时涨 ⇒ 让位没把视图冻死（**旧世界这里会冻住**）
- 右栏收起时涨 ⇒ 保活生效（不是"藏起来 = 停了"）

**最小跑法**：开弹窗 + 让 agent 采两次 → 收起右栏 + 让 agent 采两次 → 自己点两下标签。

---

## 6. 判定表（把这张表填完即为验收完成）

| # | 判据 | 谁验 | 期望 | 结果 |
|---|---|---|---|---|
| 1 | 自己开 tab 返回 view_id + 提到 parked | A | 返回含 id 与 parked 说明 | ✅ 首轮 PASS（browser-2，返回文本含 "It is PARKED"） |
| 2 | parked 视图 rAF 在涨 | A / B | 3 秒内涨 > 30 帧 | ✅ A: 77→345；B: 225→491 |
| 3 | 后台真实点击落地 | A / B | clicks 1 → 2 | ✅ A/B 均 clicks=1（CDP 真实鼠标 @(76,312)） |
| 4 | **后台过渡跑完** | A / B | `browser_wait` 条件成立 | ✅ A/B 均 400ms 内成立 |
| 5 | 后台懒加载生效 | A | `lazyReady === "yes"` | ✅ PASS |
| 6 | 后台填值 | A / B | name/pick 对得上（`change` 仅 `#pick` 被填时才是 true，见下） | ✅ A: name+pick+change=true；B: name（未碰 select → change=false，正常） |
| 7 | 后台截图 | A | 拿到图像块 | ✅ 真实图像块 |
| 8 | `vis` 恒为 `visible` **且 `vc === 0`** | A | 见下（`vc=0` 更硬） | ✅ A/B 均 `vis="visible"`、`vc=0` |
| 9 | navigate / back / forward | B | who: user → beta → user → beta | ✅ 逐次实测一致 |
| 10 | 缺省 view_id 不猜 | B | 报错 + 列出两个视图 | ✅ 报错并列出 browser-1/browser-2 |
| 11 | 前台全程没被抢 | 你 | 面板一直停在自己的 tab | ✅ PASS（多 agent 全程跑完后用户确认：面板没自己跳走） |
| 12 | focus 才切 + 不收起面板 | 你 | 切过去且面板仍展开 | ✅ PASS（槽位 displayed 从 browser-2 移到 browser-5；**其余全 parked 而仍有 displayed ⇒ 面板没被收起**；用户屏幕上确认切换） |
| 13 | 托盘里继续跑 | 你 | `lazy=25000` 的条件成立 | ✅ **PASS**（见下：时间差本身就是证据） |
| 14 | 回归三条 | 你 | 见第 5 节 | ✅ PASS（切标签/浮层让位/关面板保活，含弹窗与收起期间 raf 照涨） |

**验收结论（2026-09-21）：14/14 全 PASS。** agent 可判的 1–10 由两个并发 agent 跑（A 7/7、B 8/8），
人判的 11–14 由用户跑。首个回归项都没退化。

### 判据 13 的实测记录（2026-09-21，托盘）

- 窗口被藏进托盘**1–2 分钟**；`browser_wait` 在**等待开始后 23600ms** 报条件成立（夹具定时器 25000ms）。
- **时间差本身就是证据**：条件是在窗口**还藏在托盘里**时成立的。若视图真被隐藏（旧世界），
  `setTimeout` 会被降频（隐藏页 timer 可低至 1 次/分钟），25 秒的条件不可能按时成立——它会等到
  40 秒预算耗尽后超时。
- 意义：探针验的是 `SW_HIDE`，Aide 走的是 `window.hide()`，**两条路径不同**——这条把两者都覆盖了。
- 误报排除：若当时页面是 404，`window.__probe()` 会**抛异常**，而 condition 把抛异常当"尚未满足"
  → 结果只能是**超时**，不可能报 "condition met"。所以那条成功只可能来自真夹具页。

### 夹具的字段接线（首轮踩过的误读）

`change` 与 `blur` 是**按元素分别挂钩**的，不是"填了任意字段就置位"：

| 字段 | 只有谁会置它 |
|---|---|
| `change` | `#pick`（select）的 `change` |
| `blur` | `#name`（input）的 `blur` |

所以「只填了 `#name`」的那条路径上 `change === false`、`pick === ""` **是正确结果**，不是 fill 没派发事件；
反之填了 `#pick` 才会看到 `change === true`。判定时别把两者混起来读。

**两条容易看错的实测现象**（2026-09-21 首轮真机遇到，别误读）：

- **`vc === 0` 比 `vis === "visible"` 硬。** 前者说明这个视图**从头到尾一次都没被隐藏过**——
  不是"藏了又露回来"，是压根没碰可见性。这正是 parking 的实现意图（我们只挪位置、不调
  `SetIsVisible`）。看到 `vc` 在涨才说明有东西在真隐藏它。
- **`blur === true` 不代表"接近真实输入"。** `fill` 是先 `el.focus()` 再置值 + 派发
  `input`/`change`（脚本路径，非 `isTrusted`）。blur 之所以会来，是因为焦点随后被移走
  （下一次 fill、或一次真实点击）。真实键入要 CDP 的 `Input.insertText` / `dispatchKeyEvent`，
  **本轮没做**（`type` 动作在非目标里）。

---

## 7. 失败时留什么现场

**别关面板、别切 tab、别重启**——先把这四样存下来再动手：

1. 现场截图（含标签条：能看到有没有 ◆、label、displayed/parked）
2. `browser_tabs` 的完整输出
3. 失败那条工具调用的**返回原文**（不要转述）
4. 失败前最后一条成功与第一条失败的**工具名与时间**

然后按 `superpowers:systematic-debugging` 走：先看是"引擎侧说 parked、页面侧却在冻"，
还是"面板状态与视图状态不一致"——这两类的下一步完全不同，别猜着改。

（可选对照：`%TEMP%\wry-park-probe` 是设计阶段的一次性探针程序，五个视图并排跑 rAF/截图/点击，
用来把"是 Aide 的问题"与"是 WebView2 的问题"分开。）
