# browser_act 键盘 / 歧义 / fill 如实性 真机验收清单

对应改动（2026-09-29，源自一次真实走查的反馈）：

| # | 改动 | 一句话 |
|---|---|---|
| ① | `browser_act action:"press"` | 真实按键（CDP `Input.dispatchKeyEvent`）：`fill` 之后按回车/转焦（Tab）/关抽屉（Esc） |
| ② | selector 多命中不再猜 | 没给 `index` → **失败 + 候选清单**（旧行为：默默取文档序第一个，值灌错控件） |
| ③ | `browser_tab action:"open"` 时 arm recorder | 建视图时（首次导航之前）注册启动脚本 → 自己开的 tab **第一个请求起**就在记录里 |
| ④ | `fill` 读回校验 + 事件路径 | 值没落住 → **报失败**；成功时印 `dispatched input + change` |

夹具页：`docs/testing/browser-act-fixture.html`（判据 1–7；`browser_eval("window.__state()")` 一次读回页面自报事实）
③ 的夹具复用：`docs/testing/browser-recorder-fixture.html` + `node scripts/diag/serve-browser-fixture.mjs`（8780）
设计原则同隔壁两张清单：**判据必须能被机器判定**——每条写死"调什么、期望的逐字形态"，没有上下文的 agent 也能跑完。

**谁的代价是什么**：

| 谁 | 做什么 | 代价 |
|---|---|---|
| **用户** | `pnpm build:sidecar`、起 dev 实例、起夹具服务、在 **dev 实例里开一个新对话**并把本清单交给它 | 约 5 分钟 + 一个会话的上下文（sidecar 改的是 `dist/`，安装版跑的是另一份；Rust 也变了，热重载不够，要重启） |
| **agent** | 第 1–2 节：2 个 parked 视图、约 25 次工具调用、0 张截图 | 不需要用户手工开浏览器面板、不需要盯着看 |
| **跑完** | 第 3 节：台账回写 | 5 分钟 |

---

## 0. 前置（人工，约 5 分钟）

**① 构建**（Rust 与 sidecar 都改了，两份都要）：

```bash
pnpm build:sidecar
# 起 dev 实例（tauri dev 会自己编 Rust）；只有要验安装版才 pnpm tauri build
```

**② 重启并确认跑的是新构建**（热重载不够）。三条判据，全部交给 agent 跑：

| 探什么 | 新构建 | 旧构建（别在它上面验） |
|---|---|---|
| 工具清单里 `browser_act` 的参数 | 有 `key` / `modifiers` | 没有 = 验收构建没做出来，**停下来告诉控制者** |
| `browser_act {action:"press", key:"a"}`（无修饰键） | 回一句"press is for keys and shortcuts, not for typing… use action=\"fill\"" | 报 `unsupported key` 或直接没反应 |
| `browser_tab {action:"open", url:"http://127.0.0.1:8780/"}` 的回文 | 含 "Its network/console recorder is armed at creation" | 不含 = sidecar 没重编 |

**③ 起夹具服务**（仓库根，两个终端或两个后台进程）：

```bash
node scripts/diag/serve-browser-fixture.mjs     # ③ 用 → http://127.0.0.1:8780/
node -e "const h=require('http'),f=require('fs');h.createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});s.end(f.readFileSync('docs/testing/browser-act-fixture.html'))}).listen(8781,'127.0.0.1',()=>console.log('fixture → http://127.0.0.1:8781/'))"
```

**④ 开两个自己的视图**（parked，不抢用户面板）：

```
browser_tab {action:"open", url:"http://127.0.0.1:8781/", label:"act-fixture"}
browser_tab {action:"open", url:"http://127.0.0.1:8780/", label:"rec-fixture"}
```

把两个 `view_id` 记下来，下面全部显式传。

---

## 1. 判据 1–7：fill 如实性 / 键盘 / 歧义（夹具 8781）

每条都写"调什么 → 期望的**逐字**形态"。**判据 1、4 是这次改动的主证**（旧行为在那两条上会绿）。

| # | 调用 | 期望（逐字形态） |
|---|---|---|
| 1 | `browser_act {view_id, action:"fill", selector:".search", value:"x"}` | **失败**：`Could not find the target: selector ".search" matched 3 elements` + 段落 `Elements the selector matched (nothing was written — retry with \`index\`, or narrow the \`selector\`)` + 列出 `plain` / `commit` / `controlled` 的 name 或 placeholder。**旧行为**：回 `Set <input…> to "x" (3 elements matched; used index 0)`——那正是把值灌错控件的那条路 |
| 2 | `browser_act {view_id, action:"fill", selector:"#plain", value:"电压异常"}` | 成功：`Set <input …> to "电压异常" (dispatched input + change).`；然后 `browser_eval {view_id, script:"window.__state().values.plain"}` → `"电压异常"` |
| 3 | `browser_eval {view_id, script:"window.__state().plainEvents"}` | 含 `"input"` 与 `"change"`（与工具自报的事件路径一致——工具说谎这里就对不上） |
| 4 | `browser_act {view_id, action:"fill", selector:"#controlled", value:"abc"}` | **失败**，且文案含 `reads back`（形如 `the element reads back "" after the write, not "abc"`）。**绝不许**出现 `Set <input…> to "abc"`。再 `browser_eval("window.__state()")` → `controlledInputs >= 1` 且 `values.controlled === ""` |
| 5 | `browser_act {view_id, action:"fill", selector:"#rich", value:"abc"}` | 失败，文案含 `not an input, textarea or select`；`__state().values.rich === ""` |
| 6 | `browser_act {view_id, action:"fill", selector:"#off", value:"abc"}` | 失败，文案含 `disabled`；`__state().values.off === ""` |
| 7 | `browser_act {view_id, action:"fill", selector:"#commit", value:"泵-01"}` → `browser_act {view_id, action:"press", key:"Enter"}` | fill 成功带 `(dispatched input + change)`；press 回 `Pressed Enter on <input …> with a real key event via CDP.`；再 `browser_eval("window.__state()")` → `keys` 里有一条 `{"key":"Enter","trusted":true,…}` 且 `commits === 1`（**trusted:true 是这条的主证**：合成兜底会给 false） |
| 7b | `browser_act {view_id, action:"press", key:"Tab"}` → `browser_eval("document.activeElement.id")` | 焦点离开 `commit`（Tab 会移焦——合成事件做不到这件事） |
| 7c | 新开一个空视图或刷新夹具后 `browser_act {view_id, action:"press", key:"Enter"}`（**不填任何字段**） | 失败，文案含 `nothing is focused in the page`（页面上没有焦点时**不许**发一个没人接的键） |

## 2. 判据 8–10：open 时 arm（夹具 8780）

| # | 调用 | 期望 |
|---|---|---|
| 8 | `browser_tabs {}` | 「rec-fixture」那条的 url 是 `http://127.0.0.1:8780/`（**不是 about:blank**——create 走了「空白 → 注册 → 导航」这条新路，落点必须照旧） |
| 9 | `browser_network {view_id:"<rec-fixture 的 id>"}` | 列出**加载期**的请求（`/api/ok` 之类）；**不许**出现 `the recorder was armed in this document by this call`（那句 = 又走回"读取时才装"的旧路） |
| 10 | `browser_console {view_id:"<rec-fixture 的 id>"}` | 同上：能读到加载期的 console 输出，且没有"这次才装上"的 NOTE |

> 判据 9 是这次改动的**主证**：旧行为下第一次调用必然带那句 NOTE，加载期请求一条都看不到。

## 3. 跑完之后（回写，5 分钟）

1. 把每条判据的**实际回文**（逐字，别改写）追加到本文件的「验收台账」小节；
2. 全绿 → 更新本文件顶部表格里对应行的状态；有红 → 保留现场（截图/回文）并说明是哪一条；
3. 若发现与本节判断不符的行为，**先别改代码**：把回文贴回来，判定是"改动没生效"（build 没做 / 新对话没开）还是"真回归"。

---

## 验收台账

（待跑。跑的人把逐字回文填在这里，不要只写"通过"。）
