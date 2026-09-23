# 内置浏览器可观测层（network / console + 四条 gap）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 补上「刚才那个请求返回了什么」与「控制台报了什么」两个能力（含**页面加载期**的请求），并修掉四条实测 gap（navigate 假成功 / wait 无文档身份 / Raw text 不过滤 / CJK 空白不容错）与两个小件（元素级截图 / 命中歧义报数）。

**Architecture:** 页面内 recorder（`window.__aideRec`）在**文档创建那一刻**装入，包装 `fetch` / `XMLHttpRequest` / `console` / `error` / `unhandledrejection`，只写内存环形缓冲、不发事件、不落盘。sidecar 新增 `browser/recorder.ts` 持有**源码字符串**（唯一事实源）+ 装/读编排；两个新工具只做「信封 → 紧凑文本」。读取走**已有的 `runEval`**，注入走**已有的 `call_cdp` 透传**——两条路都不新增 Rust 协议面。

**Tech Stack:** Tauri v2 + WebView2（CDP）/ TypeScript sidecar（MCP 工具层）/ vitest（node 环境，无 DOM → 页面脚本用桩跑）。

**Spec:** `docs/superpowers/specs/2026-09-22-browser-observability-design.md`（**执行前先读**；本文档的实现细节以它为准，实测记录在它的第 14 节）

---

## 本计划对 spec 的四处修正（**执行前必读**）

执行者按本计划做；这四处是写计划时对着代码复核出来的、与 spec 正文不同**或需要额外动作**的点。每处都给了理由，不同意就回退到 spec 原文（改动量都很小）。

1. **两个新工具不收 `frame` 参数**（spec §8 列了它）。
   理由：recorder 必须活在页面的**主世界**才能看到页面自己的 `fetch`/`console`；而 `frames.ts` 够到跨域帧靠的是 `Page.createIsolatedWorld`——那是**隔离世界**，在那里包装 `window.fetch` 拦不到主世界的调用，只会得到一个恒空的缓冲，正是 spec 反复禁止的「假空」。装了也读不到，所以不做（记进未决问题）。
   （CDP 的 `Page.addScriptToEvaluateOnNewDocument` 本身是**每帧**生效的，未来帧文档照样会被装上——只是本批没有读它们的通道。）

2. **Raw text 的过滤结果用布尔旁注，不用「text 桶计数」**（spec §9.3 建议给 `hiddenSkipped` 加第五个桶）。
   理由：过滤靠 `innerText`，它与 `textContent` 的**空白折叠规则不同**（块级元素之间会补换行），字符差在真页面上可以是 0 甚至负数，而隐藏文本确实存在——报一个会骗人的数字比不报更糟。改报一行 NOTE（"只列了渲染中的文本，`include_hidden` 打开"），语义与既有 NOTE 同款。附带好处：`projection.test.ts` 里那句 `var skipped = { tables: 0, fields: 0, clickables: 0, headings: 0 };` 的字面量断言不用动。

3. **P2-1（navigate 落点）只改 sidecar，零 Rust**（spec 组件表把 `facade.rs` / `agent_bridge.rs` 列进了改动点）。
   spec §9 的修法正文写的是"走 sidecar 已有的 `runEval`（`location.href`）"，本计划取正文。Rust 只在**步骤 0 证明 CDP 注入路不通**时才动（Task 13，条件任务）。

4. **P2-1 在读落点前加一个短 settle（默认 250ms）**。
   理由：WebView2 的 `Navigate()` 是**异步投递**，命令一返回立刻读 `location.href` 多半读到**旧文档**——那会让每一次正常的跨文档导航都报"落点不符"，把真信号淹掉。固定短等待之后读，既抓得住「路由守卫把 hash 弹回」（R1b 复现的那条），也不误报。

另外两条 spec 未列、但执行时会硬红的编辑点（已并入 Task 4）：`browserTools.test.ts` 的**工具名精确数组**断言（文件尾部）、headless 短路用例的工具清单。

### 执行顺序修正（2026-09-23，用户决定）

**Task 2 的探针挪到 Task 12 的验收会话里一起做**（一次重启 + 一次上下文重放，而不是两次）。理由与代价摊开：

- **要重启的是哪一侧**：`runtime/mod.rs:688` 两条路——dev 跑 `agent-sidecar/dist/runtime.js`（构建即生效），安装版跑 `resource_dir/agent-runtime/aide-agent.exe`（要 `pnpm tauri build` + 重装，分钟级）。当前对话跑在**安装版**里，所以要验就得起 dev 实例。
- **探针四问，三个的答案不改代码形状**：① 注入路——两条路都是**同一个函数**（`ensureRegistered`），CDP 不通只是加一个 Task 13；② `innerText`——Task 8 的代码本来就把"拿不到就退回 `textContent` 并如实标 `textFiltered:false`"写在里面；③ `NAV_SETTLE_MS`——纯调参常量；④ 注册生命周期——最坏退化成"每次读时懒装"，而那时输出里**照样**会打「探针是这次调用才装上的」。
- **CDP 注入路的把握**：不是零证据的猜测——`xintaofei/codeg` 的 Windows 实现就是 WebView2 `CallDevToolsProtocolMethod` 调 `Page.addScriptToEvaluateOnNewDocument`（<https://github.com/xintaofei/codeg/pull/723>）；且本仓已有 `Page.captureScreenshot` / `Page.getFrameTree` / `Page.createIsolatedWorld` 在同一条透传上跑通（v2 验收 14/14）。
- **代价**：万一探针回"CDP 不通"，就在验收会话里当场做 Task 13（Rust 兜底）再重启一次；这是**加法**，不是返工。

**因此开发阶段（Task 3–11）按"CDP 优先 + 兜底可加"实施**，验收会话里一次跑完：Task 2 的四个探针 → 判据 1–14。

---

## Global Constraints

- **能力只进 `agent-sidecar/src/extensions/`**。本批**默认零 Rust 改动**；唯一例外是 Task 13（条件任务，仅当步骤 0 证明 CDP 注入路不通）。
- **不新增 Rust 事件通道**：读走 `runEval`，注入/截图走 `call_cdp` 通用透传（`browserClient.ts:23` 无方法白名单；Rust 侧只做字符串透传 + JSON 解析）。
- **工具 handler 永不抛**：任何异常折成文本（`browserTools.ts` 的红线）。
- **不静默降级**（v2 立下的纪律，本批反复用到）：空 ≠ 没有；截断要说；没装探针要说；注册失败要说；pending 要说。
- **有界**：环形缓冲 `cap: 100`、单条文本 `slice(0, 300)`、响应体按 `content-length` 过 256KB 闸门。
- **不加"超时兜底"式的猜测**：探针未装就返回空是可以的，但**必须明说这次才装**。
- 改 sidecar 后必须 `pnpm build:sidecar` + **重启**才算生效（dev 实例跑的是 `agent-sidecar/dist/`）。
- 单测：仓库根 `pnpm test`（`vitest.config.ts` 的 include 已覆盖 `agent-sidecar/src/**/*.test.ts`）；单文件 `cd agent-sidecar && npx vitest run src/extensions/browser/<file>`。
- 新增工具 = **五处同步**，少一处工具就静默变成要弹窗或断言红：`browserTools.ts` 表 / `browserMcp.ts` 的 `BROWSER_ALLOW_RULES` + `BROWSER_INSTRUCTIONS` / `__snapshots__/browserMcp.test.ts.snap`（`-u`）/ `browserTools.test.ts` 的工具名数组 / 前端镜像 `packages/aide-sdk/src/composables/useCustomizations.ts`。
- 函数 ≤40 行、嵌套 ≤3 层、单函数输入 ≤4（位置参数 + options 字段合计，超了按职责拆）。
- 主题化不涉及（本批无 UI 改动）。

## 文件结构

| 层 | 文件 | 职责 | 任务 |
|---|---|---|---|
| 夹具 | `docs/testing/browser-recorder-fixture.html`（新） | 真机判据页：加载期请求 / 三接口 / 隐藏魔法串 / CJK 按钮 / hash 守卫 / 延迟元素 | 1 |
| | `scripts/diag/serve-browser-fixture.mjs`（新） | 夹具服务（HTML + `/api/*` 四个端点，`no-store`） | 1 |
| 探针 | `agent-sidecar/src/extensions/browserTools.ts`（临时） | 步骤 0 的**临时**裸 CDP 工具，验完删 | 2 |
| recorder | `agent-sidecar/src/extensions/browser/recorder.ts`（新） | **源码字符串**（唯一事实源）+ 注册（CDP）+ 读（求值）+ 信封归一 | 3 |
| 渲染 | `agent-sidecar/src/extensions/browser/network.ts`（新） | `reqs` → 紧凑行（失败摘要 / pending / 截断标记） | 4 |
| | `agent-sidecar/src/extensions/browser/console.ts`（新） | `logs` → 紧凑行（uncaught 与 console.error 分开） | 5 |
| 工具面 | `agent-sidecar/src/extensions/browserTools.ts` | 两个 builder + 表加两项 | 4 / 5 |
| | `agent-sidecar/src/extensions/browserMcp.ts` | 放行规则加两条 + INSTRUCTIONS 加一节 | 4 / 5 |
| | `agent-sidecar/src/extensions/browserSkill.ts` | reference 补两条契约 | 5 |
| gap | `agent-sidecar/src/extensions/browser/tab.ts` | navigate 回报观测落点 | 6 |
| | `agent-sidecar/src/extensions/browser/wait.ts` | 文档身份 + 真实耗时 | 7 |
| | `agent-sidecar/src/extensions/browser/projection.ts` + `format.ts` | Raw text 过可见性 + 旁注 | 8 |
| | `agent-sidecar/src/extensions/browser/actions.ts` | CJK 空白容错 | 9 |
| | `agent-sidecar/src/extensions/browser/act.ts` | 命中歧义报数 | 10 |
| | `agent-sidecar/src/extensions/browser/screenshot.ts` + `actions.ts` | 元素级截图（`clip`） | 11 |
| 量尺 | `scripts/diag/measure-builtin-mcp.ts` | `schemaChars()` 换成真 JSON Schema | 5 |
| 验收 | `docs/browser-observability-test-checklist.md`（新） | 真机验收清单 | 12 |
| 兜底 | `src-tauri/src/browser/**`（条件） | CDP 注入不通时的 Rust 落点 | 13 |

---

### Task 1: 夹具页 + 夹具服务

**Files:**
- Create: `docs/testing/browser-recorder-fixture.html`
- Create: `scripts/diag/serve-browser-fixture.mjs`

**Interfaces:**
- Produces: `http://127.0.0.1:8780/`（HTML）+ `/api/ok`（200 JSON）、`/api/fail`（500 + `No enum constant …` 体）、`/api/hang`（**永不回包**）、`/api/big`（约 300KB，验体积闸门）。页面暴露 `window.__expect()` 自报判据。

- [ ] **Step 1: 写夹具服务**

`scripts/diag/serve-browser-fixture.mjs`：

```js
// 内置浏览器 recorder 夹具服务（跨平台，纯 node，无 shell）。
// 用法：node scripts/diag/serve-browser-fixture.mjs [port]     默认 8780
//
// 为什么不是一个内联 one-liner：本夹具要四个端点——其中一个**永不回包**（验 pending），
// 一个约 300KB（验响应体闸门）。静态一行命令服务不了这些。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.argv[2] ?? 8780);
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "testing", "browser-recorder-fixture.html");

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  if (pathname === "/api/ok") return json(res, 200, { ok: true, rows: [1, 2, 3] });
  if (pathname === "/api/fail")
    return json(res, 500, { error: "No enum constant com.demo.EQUIPMENT_MAINTENANCE_TASK_AUDIT" });
  // 永不回包：不 end、不 writeHead —— 客户端停在 pending，正是要验的形态
  if (pathname === "/api/hang") return;
  if (pathname === "/api/big") {
    const pad = "x".repeat(300 * 1024);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: true, pad }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(PAGE));
}).listen(PORT, "127.0.0.1", () => console.log(`fixture → http://127.0.0.1:${PORT}/`));
```

`no-store` 是硬要求：2026-09-22 做 wait 探针时**页面被缓存**，服务端的延迟从没生效，白跑一轮。

- [ ] **Step 2: 写夹具页**

`docs/testing/browser-recorder-fixture.html`（结构照 `docs/testing/browser-read-fixture.html` 的形制：深色底、判据写在注释里、`window.__expect()` 自报）：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>browser recorder fixture</title>
<!--
  recorder / 可观测层 / 四条 gap 的**真机判据页**（2026-09-23）。

  起服务（仓库根）：
    node scripts/diag/serve-browser-fixture.mjs
  期望（页面自报：browser_eval("window.__expect()")）：
    ① 加载期就发过两条请求（fetch + XHR，都打 /api/ok）——探针装过之后 reload 必须看得到
    ② /api/fail → 500 + No enum constant …；/api/hang → pending；/api/big → body skipped
    ③ #magic 在 display:none 里：browser_read 的 Raw text **不许**出现 HIDDENMAGIC，且有一行 NOTE
    ④「确 定」按钮（中间是 U+3000）与「确定通过审核？」文案：act {text:"确定"} 必须命中按钮
    ⑤ 三个同 class 按钮（两个可见 + 一个 display:none）：act 的可见池里是 2 个 → 报
       (2 elements matched; used index 0)，且点到可见的那个（隐藏的不进池）
    ⑥ #late 延迟 3s 出现：browser_wait 的 condition 模式
    ⑦ #/two 的守卫把 hash 弹回 #/one：browser_tab navigate 必须**不报假成功**

  前提：改的是 sidecar → 必须先 `pnpm build:sidecar` 并让**新进程**跑起来（dev 实例开新会话 / 重启）。
-->
<style>
  body { font: 14px/1.7 system-ui, sans-serif; margin: 0; padding: 24px; background: #0f1317; color: #e6edf3 }
  h1 { margin: 0 0 8px; font-size: 20px }
  h2 { margin: 22px 0 8px; font-size: 15px; color: #9fb0c0; font-weight: 600 }
  code { background: #1b2430; padding: 1px 5px; border-radius: 4px }
  .row { display: inline-block; padding: 8px 14px; margin-right: 8px; cursor: pointer; border: 1px solid #4aa3ff; border-radius: 8px }
  #hidden-zone { display: none }
</style>
</head>
<body>
<h1 id="who">recorder 夹具</h1>
<div>页面自报判据：<code>browser_eval("window.__expect()")</code></div>

<h2>① 隐藏区（验 Raw text 过滤）</h2>
<div id="hidden-zone">HIDDENMAGIC<span>隐藏的日历 1308 208 407</span></div>

<h2>② CJK 空白（验文本匹配容错）</h2>
<!-- ⚠️ `确` 与 `定` 之间是 U+3000 全角空格（别改成半角/普通空格：容错要覆盖的正是这一种） -->
<button id="cjk-ok">确　定</button>
<p id="copyline">确定通过审核？</p>

<h2>③ 同 class 三按钮（验可见性优先 + 歧义报数）</h2>
<!-- 两个**可见** + 一个隐藏：歧义报数要的是"可见池里有多于一个"，只留一个可见的会
     count=1，那句脚注根本不出现（可见性优先先把它们滤掉了）。 -->
<button class="same" id="same-a">保存</button>
<button class="same" id="same-b">保存</button>
<button class="same" id="same-c" style="display:none">保存</button>

<h2>④ 请求 / 控制台 / 异常</h2>
<button class="row" id="btn-log">console.log</button>
<button class="row" id="btn-warn">console.warn</button>
<button class="row" id="btn-throw">抛未捕获异常</button>

<h2>⑤ 延迟元素（验 browser_wait）</h2>
<div id="late-slot">（3 秒后出现）</div>

<h2>⑥ hash 路由 + 守卫（验 navigate 落点）</h2>
<div>当前 hash：<code id="hash-now"></code></div>
<button class="row" id="btn-bounce">跳到 #/two（守卫会弹回）</button>

<script>
  // ① 加载期请求：**文档创建时就发**，探针没在文档创建前装上就会漏掉它。
  //    两条不同通道（fetch / XHR）各一条，验 recorder 的包装都生效。
  window.__loadStart = Date.now();
  fetch("/api/ok").then(function (r) { return r.json(); }).catch(function () {});
  (function () {
    var x = new XMLHttpRequest();
    x.open("GET", "/api/ok");
    x.send();
  })();

  document.getElementById("btn-log").onclick = function () { console.log("direct log", { ok: true, rows: [1, 2, 3] }); };
  document.getElementById("btn-warn").onclick = function () { console.warn("direct warn", { n: 7 }); };
  document.getElementById("btn-throw").onclick = function () { setTimeout(function () { nope(); }, 0); };

  // 打一条接口。⚠️ `hang` 那条**永不回包**，所以调用时要写成 `__probe("hang"); "fired"`
  // ——`browser_eval` 会 await 表达式的结果，只写 `__probe("hang")` 会让它一直等到 15s 超时。
  function probe(kind) {
    var url = kind === "ok" ? "/api/ok" : kind === "fail" ? "/api/fail" : kind === "hang" ? "/api/hang" : "/api/big";
    return fetch(url).then(function (r) { return r.text(); }).then(function (t) { return { status: "done", len: t.length }; },
                          function (e) { return { status: "rejected", err: String(e) }; });
  }
  window.__probe = probe;

  setTimeout(function () {
    var d = document.createElement("div");
    d.id = "late";
    d.textContent = "迟到的元素";
    document.getElementById("late-slot").appendChild(d);
  }, 3000);

  function renderHash() { document.getElementById("hash-now").textContent = location.hash || "(empty)"; }
  window.addEventListener("hashchange", function () {
    // 守卫：只允许 #/one，其它一律弹回——模拟真实 SPA 的路由守卫
    if (location.hash !== "#/one") location.hash = "#/one";
    renderHash();
  });
  document.getElementById("btn-bounce").onclick = function () { location.hash = "#/two"; };
  renderHash();

  window.__expect = function () {
    return {
      hiddenMagicVisible: document.body.innerText.indexOf("HIDDENMAGIC") >= 0,
      hiddenMagicInText: document.body.textContent.indexOf("HIDDENMAGIC") >= 0,
      hiddenMagicInClone: document.body.cloneNode(true).innerText.indexOf("HIDDENMAGIC") >= 0,
      hash: location.hash,
      latePresent: !!document.getElementById("late"),
      endpoints: ["/api/ok", "/api/fail", "/api/hang", "/api/big"],
    };
  };
</script>
</body>
</html>
```

- [ ] **Step 3: 起服务并自检**

```bash
node scripts/diag/serve-browser-fixture.mjs
# 另开一个 shell：
curl -s http://127.0.0.1:8780/ | grep -c HIDDENMAGIC      # 期望 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8780/api/fail   # 期望 500
curl -s -m 2 http://127.0.0.1:8780/api/hang ; echo "exit=$?"  # 期望超时 exit=28（永不回包）
curl -s -o /dev/null -w "%{size_download}\n" http://127.0.0.1:8780/api/big  # 期望 >300000
```

- [ ] **Step 4: Commit**

```bash
git add docs/testing/browser-recorder-fixture.html scripts/diag/serve-browser-fixture.mjs
git commit -m "test(browser): recorder 夹具页 + 夹具服务（四端点，含永不回包与超阈体）"
```

---

### Task 2: 步骤 0 探针（**先做这个，别先写实现**）

**Files:**
- Modify: `agent-sidecar/src/extensions/browserTools.ts`（**临时**加一个调试工具）
- Modify: `agent-sidecar/src/extensions/browserTools.test.ts`（**临时**同步工具名数组）
- Modify: 本文件（把实测结果写进文末「步骤 0 实测结果」）

**Interfaces:**
- Consumes: Task 1 的夹具页/服务。
- Produces: 三条结论——① 注入点走 CDP 还是 Rust；② `NAV_SETTLE_MS` 的取值依据；③ P2-3 走 `innerText`（a）还是剪枝（b）。**这三条决定 Task 3 / 6 / 8 的写法。**

**代价明示（要给用户看）**：这一任务需要用户配合——`pnpm build:sidecar`、重启 Aide、开一个浏览器面板。若用户不愿付这个代价，**跳过本任务**，按「首选 + 兜底都写」实施（Task 3 的 `ensureRegistered` 两个分支都留着，Task 13 一并做掉），验收改由实机反馈完成——那是不想走的路，但比假装测过好。

- [ ] **Step 1: 加临时探针工具**

`browserTools.ts` 里加（**注释写明临时**，验完删）：

```ts
// ⚠️ 临时（步骤 0 探针专用）：给 agent 一条发裸 CDP 的通道。**验完必须删掉**，
// 它不是能力（能力面里不该有任意 CDP 透传——那等于把内核的机制词汇直接暴露给模型）。
export function buildCdpProbeTool(env: NodeJS.ProcessEnv, emit: (e: ChatEvent) => void) {
  return tool(
    "browser_cdp_probe",
    "DEBUG ONLY — temporary step-0 probe: send one raw CDP method to a view and return the raw reply. " +
      "Delete after the probe (see docs/superpowers/plans/2026-09-23-browser-observability.md Task 2).",
    {
      view_id: viewIdArg,
      method: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) =>
      call(
        env,
        emit,
        () => ({ op: "call_cdp", view_id: args.view_id, method: args.method, params: args.params ?? {} }),
        (data) => JSON.stringify(data, null, 2),
      ),
  );
}
```

同时：`buildBrowserTools` 的表里加 `buildCdpProbeTool(env, emit)`，`browserTools.test.ts` 尾部的工具名数组加 `"browser_cdp_probe"`（**别加进 `BROWSER_ALLOW_RULES`**——那样会牵动 instructions 断言；未放行的工具会正常弹一次权限，用户点一下即可）。

- [ ] **Step 2: 构建并重启，跑探针 1（注入路）**

```bash
pnpm build:sidecar && pnpm test -- --run agent-sidecar/src/extensions/browserTools
```
重启 Aide（或 dev 实例开新会话），起夹具服务，然后：

1. `browser_tab {action:"open", url:"http://127.0.0.1:8780/"}` → 记下 `view_id`
2. `browser_cdp_probe {view_id, method:"Page.addScriptToEvaluateOnNewDocument", params:{source:"window.__aideProbe = 1"}}`
   → **逐字记下原始回包**（成功应是 `{"identifier":"1"}`；被拒是 `{"error":{"code":…,"message":…}}`）
3. `browser_tab {action:"navigate", view_id, url:"http://127.0.0.1:8780/?again=1"}`
4. `browser_eval {view_id, script:"window.__aideProbe"}`
   - 回 `1` → **首选路径成立，零 Rust**，直接进 Task 3。
   - 回 `undefined` → 记下 CDP 的原始拒绝文本，**先做 Task 13**，再回到 Task 3。

- [ ] **Step 3: 跑探针 2（生命周期：注册挂在视图上还是全局）**

1. `browser_tab {action:"open", url:"http://127.0.0.1:8780/other"}`（**新视图**）→ 拿到新 id
2. `browser_eval {view_id: 新 id, script:"window.__aideProbe"}` → 记下（预期 `undefined` = 注册**不跨视图**）
3. 在**新视图**上重复 Step 2 的注册，再 navigate，再读 → 确认新视图上同样成立。
4. 把新视图 `browser_tab {action:"close"}` 掉，再 open 一个，读 `window.__aideProbe` → 记下（注册是否随视图销毁失效）。

- [ ] **Step 4: 跑探针 3（`innerText` 在 parked 视图上可不可用）**

```
browser_eval {view_id, script:"window.__expect()"}
```

期望：`hiddenMagicVisible:false`、`hiddenMagicInText:true`、`hiddenMagicInClone:true`。

- 三条都对 → P2-3 走 **(a) `doc.body.innerText`**（Task 8 按 a 写）。
- `hiddenMagicVisible:true`（innerText 也拿得到隐藏文本）→ 走 **(b) 剪枝后再取 textContent**，Task 8 的 Step 3 换成剪枝实现（复用 `clickable.ts` 的 `isRendered`）。

- [ ] **Step 5: 跑探针 4（P2-1 的往返代价）**

在同一个视图上：先 `browser_eval {script:"Date.now()"}` 记时刻 → `browser_tab {action:"navigate", url:"http://127.0.0.1:8780/#/one"}` → 立刻 `browser_eval {script:"location.href"}`。

记下：**命令返回后到读到 href 的墙钟时间**，以及**读到的 href 是旧还是新**（这是 `NAV_SETTLE_MS` 的唯一依据：若读到的是旧文档，说明必须留 settle；若读到的是新文档，可把常量降到 100ms）。

- [ ] **Step 6: 删掉临时工具**

```bash
git revert --no-edit HEAD~1   # 若 Step 1 单独提交过；否则手动删三处（builder / 表 / 测试数组）
pnpm test -- --run agent-sidecar/src/extensions/browserTools
```
Expected: 全绿，`browser_cdp_probe` 从工具面消失。

- [ ] **Step 7: 把结果写进本文件**

在本文件末尾的「步骤 0 实测结果」节逐条填：注入路结论 + 原始回包、生命周期结论、innerText 三值、往返耗时与 `NAV_SETTLE_MS` 取值。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs(browser): 步骤 0 实测结果（注入路 / 生命周期 / innerText / 往返代价）"
```

---

### Task 3: recorder（源码 + 注册 + 读）

**Files:**
- Create: `agent-sidecar/src/extensions/browser/recorder.ts`
- Create: `agent-sidecar/src/extensions/browser/recorder.test.ts`
- Modify: `agent-sidecar/src/extensions/browser/format.ts`（导出 `cdpMethodError`，收口第三份实现）
- Modify: `agent-sidecar/src/extensions/browser/act.ts` / `screenshot.ts`（改调那一个）

**Interfaces:**
- Consumes: `runEval`（`browser/runEval.ts`）、`queryBrowser`（`browserClient.ts`）。
- Produces:
  - `RECORDER_SOURCE: string` —— 注入页面的 IIFE 源码（幂等，返回 `'armed'` / `'already armed'`）
  - `RECORDER_CAP = 100` / `RECORDER_TEXT_CAP = 300` / `RECORDER_BODY_GATE = 262144`
  - `readRecorder(opts, viewId, emit): Promise<RecorderOutcome>`，其中
    `RecorderReadOptions = { kind: "reqs" | "logs"; limit: number; match?: string }`（`match`：网络=URL 子串；console=`all`/`error`/`warn`），
    `RecorderOutcome = { ok: true; value: Record<string, unknown>; registered: boolean; registerError?: string } | { ok: false; error: string }`
  - 信封 `value` 形状（Task 4/5 渲染它）：`{ ok, armedBefore, cap, total, matched, failed: {n, first}, items: Item[] }`

- [ ] **Step 1: 写失败测试**

`recorder.test.ts`（真跑源码，桩掉 `window`/`console`/`performance`）：

```ts
// @vitest-environment node
//
// recorder 是**注入进页面的源码字符串**，vitest 没有 DOM —— 这里用最小桩把源码跑起来，
// 断言的是 recorder 自己的契约（幂等 / 不改页面行为 / 有界 / 如实标截断），
// 真实页面上的行为由真机夹具（docs/testing/browser-recorder-fixture.html）验。
//
// ⚠️ 桩 console 必须传进去：源码里是裸 `console[lvl] = …`，不 shadow 就会改到 vitest 自己的 console。
import { describe, it, expect } from "vitest";
import { RECORDER_SOURCE, RECORDER_CAP, RECORDER_TEXT_CAP } from "./recorder.js";

type Stub = { window: any; console: any; performance: any; handlers: Record<string, Function[]> };

function makeWindow(over: Record<string, unknown> = {}) {
  const handlers: Record<string, Function[]> = {};
  const win: any = {
    addEventListener: (t: string, fn: Function) => { (handlers[t] ||= []).push(fn); },
    ...over,
  };
  return { win, handlers };
}

function run(source: string, win: any, consoleStub: any, perf: any = { now: () => 42 }) {
  const factory = new Function("window", "console", "performance", "return " + source);
  return factory(win, consoleStub, perf);
}

function fetchStub(opts: { status?: number; body?: string; len?: string | null; reject?: string }) {
  return () => {
    if (opts.reject) return Promise.reject(new Error(opts.reject));
    const res = {
      status: opts.status ?? 200,
      headers: { get: (h: string) => (h === "content-length" ? opts.len ?? null : null) },
      clone: () => ({ text: () => Promise.resolve(opts.body ?? "") }),
    };
    return Promise.resolve(res);
  };
}

describe("recorder 源码：语法与转义", () => {
  it("是可解析的表达式，且模板占位符已求值", () => {
    expect(() => new Function("return " + RECORDER_SOURCE)).not.toThrow();
    expect(RECORDER_SOURCE).not.toContain("${");
    expect(RECORDER_SOURCE).toContain(`cap: ${RECORDER_CAP}`);
  });
});

describe("recorder：幂等与不改页面行为", () => {
  it("装两次只有一个缓冲（第二次不套娃）", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ body: "{}" }) });
    const c = { log: () => {} };
    expect(run(RECORDER_SOURCE, win, c)).toBe("armed");
    const first = win.__aideRec;
    expect(run(RECORDER_SOURCE, win, c)).toBe("already armed");
    expect(win.__aideRec).toBe(first);
  });

  it("fetch 失败仍然抛给调用方（recorder 不改页面行为）", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ reject: "boom" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await expect(win.fetch("http://x/api")).rejects.toThrow("boom");
    expect(win.__aideRec.reqs[0].err).toBe("boom");
    expect(win.__aideRec.reqs[0].done).toBe(true);
  });

  it("console 包装仍然转发给原实现", () => {
    const seen: unknown[] = [];
    const c = { warn: (...a: unknown[]) => seen.push(a) };
    const { win } = makeWindow();
    run(RECORDER_SOURCE, win, c);
    c.warn("hi", { n: 1 });
    expect(seen).toHaveLength(1);
    expect(win.__aideRec.logs[0].text).toContain("hi");
    expect(win.__aideRec.logs[0].lvl).toBe("warn");
  });
});

describe("recorder：有界与如实标截断", () => {
  it("响应体被 slice 时如实标 cut 与原始长度", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ body: "z".repeat(RECORDER_TEXT_CAP + 50) }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://x/api");
    await new Promise((r) => setTimeout(r, 0));
    const rec = win.__aideRec.reqs[0];
    expect(rec.bodyCut).toBe(true);
    expect(rec.body).toHaveLength(RECORDER_TEXT_CAP);
    expect(rec.bodyLen).toBe(RECORDER_TEXT_CAP + 50);
  });

  it("content-length 超闸门 → 不读体，如实标 skipped", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ len: String(300 * 1024), body: "z" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://x/api");
    await new Promise((r) => setTimeout(r, 0));
    expect(win.__aideRec.reqs[0].body).toBeNull();
    expect(String(win.__aideRec.reqs[0].err)).toContain("body skipped");
  });

  it("未结束的请求 done=false（渲染层据此报 pending）", async () => {
    const { win } = makeWindow({ fetch: () => new Promise(() => {}) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    win.fetch("http://x/slow");
    expect(win.__aideRec.reqs[0].done).toBe(false);
  });

  it("环形缓冲不超 cap", () => {
    const { win } = makeWindow({ fetch: () => new Promise(() => {}) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    for (let i = 0; i < RECORDER_CAP + 10; i++) win.fetch("http://x/" + i);
    expect(win.__aideRec.reqs).toHaveLength(RECORDER_CAP);
    expect(win.__aideRec.reqs[RECORDER_CAP - 1].url).toBe("http://x/" + (RECORDER_CAP + 9));
  });

  it("未捕获异常与未处理拒绝各进一条 logs（lvl 分开）", () => {
    const { win, handlers } = makeWindow();
    run(RECORDER_SOURCE, win, { log: () => {} });
    handlers["error"][0]({ message: "Uncaught ReferenceError: nope is not defined" });
    handlers["unhandledrejection"][0]({ reason: { message: "nope" } });
    expect(win.__aideRec.logs.map((l: any) => l.lvl)).toEqual(["uncaught", "unhandled"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/recorder.test.ts
```
Expected: FAIL — `Failed to resolve import "./recorder.js"`。

- [ ] **Step 3: 写 `recorder.ts`**

```ts
/**
 * 页面内 recorder：**源码字符串**（唯一事实源）+ 装/读编排。
 *
 * # 为什么是"文档创建那一刻"装（懒装就白做了）
 *
 * 本批最值钱的场景是「页面打开就是空白，其实是后端返回了 `No enum constant …`」——那是
 * **页面加载期**自己的 XHR。等工具被调用才注入探针，恰好漏掉它，等于把最想要的场景做没了。
 * 所以注入走 CDP `Page.addScriptToEvaluateOnNewDocument`（注册一次，之后**每份新文档**在
 * 页面脚本之前被装上），当前文档用一次普通求值补上。
 *
 * # 为什么读取走求值而不是新通道
 *
 * 读一次 = 一次 `Runtime.evaluate`，与 `browser_read` 的投影脚本同一个出口、同一份幂等保证、
 * 同一个降级路径。新增通道（Rust 事件 → sidecar）在这一批里是纯粹的复杂度。
 *
 * # 生命周期（必须如实告诉模型）
 *
 * `window.__aideRec` 挂在页面的 JS 世界上：**导航（含 reload）→ 新文档 → 缓冲清零**。
 * 对本批的核心场景这是**对的**（要看的就是那个新文档自己加载期的请求），但"点了个按钮 →
 * 请求失败 → 页面跳走了"这种跨导航追查拿不到——见 spec §5.1 的明确决策。
 *
 * # 落地必须守的四条（改源码时容易丢）
 *
 * 1. **幂等**：`if (window.__aideRec) return` —— 注册会重发（每个视图一次），重复包装会套娃。
 * 2. **不改页面行为**：fetch 的失败分支继续 `throw`；`res.clone()` 不动原响应；console 转发原实现。
 * 3. **有界**：`cap: 100` + 每条文本 `slice(0, 300)`。
 * 4. **如实标截断**：`bodyCut` / `bodyLen` / `err: 'body skipped (N bytes)'` 都要带出来。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { cdpMethodError, formatBridgeFailure } from "./format.js";
import { runEval } from "./runEval.js";

/** 环形缓冲的条目上限。 */
export const RECORDER_CAP = 100;
/** 单条文本（响应体片段 / console 行）的字符上限。 */
export const RECORDER_TEXT_CAP = 300;
/** 读体闸门：`content-length` 超过它就整段跳过（`res.clone().text()` 会把整份体复制进内存）。 */
export const RECORDER_BODY_GATE = 262144;

export const RECORDER_SOURCE = `(function () {
  if (window.__aideRec) return 'already armed';
  var R = window.__aideRec = { reqs: [], logs: [], cap: ${RECORDER_CAP} };
  var TEXT = ${RECORDER_TEXT_CAP};
  var GATE = ${RECORDER_BODY_GATE};
  function push(arr, item) { arr.push(item); if (arr.length > R.cap) arr.shift(); }
  function now() { return Math.round(performance.now()); }
  function clip(s, n) {
    var t = String(s === null || s === undefined ? '' : s);
    return t.length > n ? { text: t.slice(0, n), cut: true, len: t.length } : { text: t, cut: false, len: t.length };
  }
  function gate(raw) { var n = Number(raw); return raw !== null && raw !== undefined && raw !== '' && n > GATE ? n : null; }

  var of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      var method = (init && init.method) || (input && input.method) || 'GET';
      var t0 = now();
      var rec = { kind: 'fetch', method: String(method).toUpperCase(),
                  url: clip((typeof input === 'string') ? input : ((input && input.url) || ''), 400).text,
                  t: t0, status: null, ms: null, body: null, bodyCut: false, bodyLen: 0, err: null, done: false };
      push(R.reqs, rec);
      return of.apply(this, arguments).then(function (res) {
        rec.status = res.status; rec.ms = now() - t0;
        var len = null;
        try { len = res.headers && res.headers.get ? res.headers.get('content-length') : null; } catch (e) { len = null; }
        var big = gate(len);
        if (big !== null) { rec.err = 'body skipped (' + big + ' bytes)'; rec.done = true; }
        else {
          try {
            // 克隆一份读体：原响应照样交给页面，我们只是旁听
            res.clone().text().then(function (txt) {
              var c = clip(txt, TEXT); rec.body = c.text; rec.bodyCut = c.cut; rec.bodyLen = c.len; rec.done = true;
            }, function () { rec.err = 'body unreadable'; rec.done = true; });
          } catch (e) { rec.err = String((e && e.message) || e); rec.done = true; }
        }
        return res;
      }, function (e) {
        rec.ms = now() - t0; rec.err = String((e && e.message) || e); rec.done = true;
        throw e;
      });
    };
  }

  var OX = window.XMLHttpRequest;
  if (OX && OX.prototype) {
    var open = OX.prototype.open, send = OX.prototype.send;
    OX.prototype.open = function (m, u) { this.__m = m; this.__u = u; return open.apply(this, arguments); };
    OX.prototype.send = function () {
      var x = this, t0 = now();
      var rec = { kind: 'xhr', method: String(x.__m || 'GET').toUpperCase(),
                  url: clip(x.__u || '', 400).text,
                  t: t0, status: null, ms: null, body: null, bodyCut: false, bodyLen: 0, err: null, done: false };
      push(R.reqs, rec);
      x.addEventListener('loadend', function () {
        rec.status = x.status; rec.ms = now() - t0;
        var len = null;
        try { len = x.getResponseHeader && x.getResponseHeader('content-length'); } catch (e) { len = null; }
        var big = gate(len);
        if (big !== null) { rec.err = 'body skipped (' + big + ' bytes)'; }
        else {
          try {
            var c = clip(x.responseText || '', TEXT);
            rec.body = c.text; rec.bodyCut = c.cut; rec.bodyLen = c.len;
          } catch (e) { rec.err = 'body unreadable'; }
        }
        rec.done = true;
      });
      return send.apply(this, arguments);
    };
  }

  function logLine(lvl, s) {
    var c = clip(s, TEXT);
    push(R.logs, { lvl: lvl, t: now(), text: c.text, cut: c.cut, len: c.len });
  }

  ;['log', 'warn', 'error', 'info', 'debug'].forEach(function (lvl) {
    var orig = console[lvl];
    if (!orig) return;
    console[lvl] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        try { parts.push(typeof a === 'string' ? a : JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
      }
      logLine(lvl, parts.join(' '));
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    logLine('uncaught', (e && e.message) || e);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    logLine('unhandled', (r && r.message) || r);
  });

  return 'armed';
})()`;

/** 读取选项：取哪一类、怎么筛、取多少。 */
export interface RecorderReadOptions {
  kind: "reqs" | "logs";
  /** 从最近往前取多少条。 */
  limit: number;
  /** 网络：URL 子串；console：`all` / `error`（含 uncaught+unhandled）/ `warn`。省略 = 不过滤。 */
  match?: string;
}

export type RecorderOutcome =
  | { ok: true; value: Record<string, unknown>; registered: boolean; registerError?: string }
  | { ok: false; error: string };
```

**读脚本**（同一个 `RECORDER_SOURCE` 内插进来——装与读一次往返做完，且**天然知道"这次才装上"**）：

```ts
/**
 * 读脚本：先确保本文档装上（幂等），再按筛选与条数上限取回。
 *
 * `armedBefore` 是这次调用的关键信息：false = 探针是**这次**才装上的，这之前的请求看不到。
 * 不报它，模型会把"空"读成"没发请求"（v2 立下的「空 ≠ 没有」纪律同款）。
 */
export function buildRecorderReadScript(opts: RecorderReadOptions): string {
  return `(() => {
  'use strict';
  var BEFORE = !!window.__aideRec;
  var ARMED = ${RECORDER_SOURCE};
  var R = window.__aideRec;
  if (!R) return { ok: false, error: 'the recorder could not be armed in this document: ' + ARMED };
  var KIND = ${JSON.stringify(opts.kind)};
  var LIMIT = ${JSON.stringify(opts.limit)};
  var MATCH = ${JSON.stringify(opts.match ?? null)};
  var nowMs = Math.round(performance.now());
  var all = KIND === 'reqs' ? R.reqs : R.logs;

  function keep(e) {
    if (KIND === 'reqs') return !MATCH || String(e.url).indexOf(MATCH) >= 0;
    if (!MATCH || MATCH === 'all') return true;
    if (MATCH === 'error') return e.lvl === 'error' || e.lvl === 'uncaught' || e.lvl === 'unhandled';
    return e.lvl === MATCH;
  }

  var matched = [];
  for (var i = 0; i < all.length; i++) { if (keep(all[i])) matched.push(all[i]); }

  var failed = 0, firstFailed = null;
  if (KIND === 'reqs') {
    for (var j = 0; j < matched.length; j++) {
      var e2 = matched[j];
      var bad = e2.done === true && ((typeof e2.status === 'number' && e2.status >= 400) || !!e2.err);
      if (bad) { failed += 1; if (firstFailed === null) firstFailed = j + 1; }
    }
  }

  var items = matched.slice(Math.max(0, matched.length - LIMIT)).map(function (e) {
    if (KIND === 'reqs') {
      return { kind: e.kind, method: e.method, url: e.url, status: e.status, done: e.done === true,
               ms: e.done === true ? e.ms : (nowMs - e.t), body: e.body, bodyCut: e.bodyCut === true,
               bodyLen: e.bodyLen, err: e.err };
    }
    return { lvl: e.lvl, t: e.t, text: e.text, cut: e.cut === true, len: e.len };
  });

  return { ok: true, armedBefore: BEFORE, cap: R.cap, total: all.length, matched: matched.length,
           failed: { n: failed, first: firstFailed }, items: items };
})()`;
}
```

**注册（CDP）+ 读**：

```ts
/** 已经注册过「新文档自动装」的视图 id —— **每个视图只注册一次**（注册是累积的，重发 N 次
 *  就让每份新文档跑 N 遍 no-op IIFE）。`view_id` 缺省时用 Rust 解析回来的真实 id 记账。 */
const registeredViews = new Set<string>();

/**
 * 给**未来的文档**装上（CDP `Page.addScriptToEvaluateOnNewDocument`，走既有的 `call_cdp`
 * 透传，Rust 一行不动）。注册挂在视图上，故同一视图只发一次；失败**如实带出**，不吞。
 */
async function ensureRegistered(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (viewId && registeredViews.has(viewId)) return { ok: true };

  const resp = await queryBrowser(
    {
      op: "call_cdp",
      view_id: viewId,
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: RECORDER_SOURCE },
    },
    emit,
  );
  if (!resp.ok) return { ok: false, error: formatBridgeFailure(resp) };

  const rejected = cdpMethodError(resp.data);
  if (rejected) {
    return {
      ok: false,
      error:
        `the recorder could not be registered for future page loads: ` +
        `Page.addScriptToEvaluateOnNewDocument was rejected by the runtime (${rejected}). ` +
        `This is a WebView2 runtime capability, not a page problem.`,
    };
  }
  // 记账用 Rust 解析回来的**真实 id**（调用方可能省略 view_id）——省了它下次还会重发一遍。
  const id = asRecord(resp.data)?.["view_id"];
  if (typeof id === "string") registeredViews.add(id);
  else if (viewId) registeredViews.add(viewId);
  return { ok: true };
}

/**
 * 读一次缓冲。两步：给未来文档注册（失败只记原因，**不阻断**当前的读）→ 求值取回。
 * **永不抛**，失败折成 `{ok:false, error}`（工具层红线）。
 */
export async function readRecorder(
  opts: RecorderReadOptions,
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<RecorderOutcome> {
  const reg = await ensureRegistered(viewId, emit);
  const r = await runEval(buildRecorderReadScript(opts), { viewId }, emit);
  if (!r.ok) return { ok: false, error: r.error };

  const value = asRecord(r.value);
  if (!value || value["ok"] !== true) {
    return { ok: false, error: String(value?.["error"] ?? "the recorder read script returned no usable value") };
  }
  return reg.ok
    ? { ok: true, value, registered: true }
    : { ok: true, value, registered: false, registerError: reg.error };
}
```

配套：`asRecord` 是本仓各处都有的三行小工具，本文件自己加一份（与 `wait.ts` / `format.ts` 同款，**别**为它开共享模块）。`format.ts` 导出：

```ts
/**
 * CDP 回包里的**方法级错误**——`{error:{code,message}}`。返回 null = 这次调用真的成了。
 *
 * ⚠️ 方法级拒绝是一个**合法 JSON 响应体**，桥只做 JSON 解析 → 它带着 `ok:true` 一路回来。
 * 不看它的调用点都会**报假成功**（2026-09-20 走查发现，`act.ts` 的注释有完整来龙去脉）。
 * 原先 `act.ts` / `screenshot.ts` 各写了一份，这里收口成唯一一份。
 */
export function cdpMethodError(data: unknown): string | null {
  const e = asRecord(asRecord(asRecord(data)?.["value"])?.["error"]);
  return e ? String(e["message"] ?? e["code"] ?? "unknown") : null;
}
```

并把 `act.ts:100-105` 的 `cdpMethodError` 与 `screenshot.ts:99-101` 的 `cdpError` 改成调它（删掉两份本地实现）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/recorder.test.ts
```
Expected: PASS（8 条）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
pnpm test -- --run 2>&1 | tail -5
git add agent-sidecar/src/extensions/browser/recorder.ts agent-sidecar/src/extensions/browser/recorder.test.ts \
        agent-sidecar/src/extensions/browser/format.ts agent-sidecar/src/extensions/browser/act.ts \
        agent-sidecar/src/extensions/browser/screenshot.ts
git commit -m "feat(browser): 页面内 recorder（fetch/XHR/console/未捕获异常）+ CDP 注册装、runEval 读"
```

---

### Task 4: `browser_network`（纵向切片：机制 → 工具 → 登记点）

**Files:**
- Create: `agent-sidecar/src/extensions/browser/network.ts`
- Create: `agent-sidecar/src/extensions/browser/network.test.ts`
- Modify: `agent-sidecar/src/extensions/browserTools.ts`（builder + 表）
- Modify: `agent-sidecar/src/extensions/browserTools.test.ts`（工具名数组 + headless 清单 + 新用例）
- Modify: `agent-sidecar/src/extensions/browserMcp.ts`（放行规则 + INSTRUCTIONS）
- Modify: `agent-sidecar/src/extensions/__snapshots__/browserMcp.test.ts.snap`（`-u`）
- Modify: `packages/aide-sdk/src/composables/useCustomizations.ts`

**Interfaces:**
- Consumes: `readRecorder` / `RecorderOutcome`（Task 3）。
- Produces: `renderNetwork(value: unknown, notes: NetworkNotes): string`，其中 `NetworkNotes = { filter?: string; registered: boolean; registerError?: string }`；工具 `browser_network(view_id?, filter?, limit?, frame?)` → **无 `frame`**（见「四处修正」第 1 条）：`browser_network(view_id?, filter?, limit?)`。默认 limit 20、上限 100（schema `.max(100)`）。

- [ ] **Step 1: 写失败测试**

`network.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderNetwork } from "./network.js";

/** 一条请求的最小形状（与页面侧信封一致）。 */
const req = (over: Record<string, unknown> = {}) => ({
  kind: "fetch", method: "GET", url: "http://127.0.0.1:8780/api/ok", status: 200, done: true,
  ms: 95, body: '{"ok":true}', bodyCut: false, bodyLen: 11, err: null, ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  ok: true, armedBefore: true, cap: 100, total: 3, matched: 3,
  failed: { n: 0, first: null }, items: [req()], ...over,
});

const notes = (over: Record<string, unknown> = {}) => ({ registered: true, ...over });

describe("renderNetwork", () => {
  it("一行一条：序号 / 方法 / URL / 状态 / 耗时 / 响应片段", () => {
    const s = renderNetwork(envelope(), notes());
    expect(s).toContain("Network requests (last 1 of 3, newest last):");
    expect(s).toContain("#1 GET  http://127.0.0.1:8780/api/ok");
    expect(s).toContain("→ 200  95ms");
    expect(s).toContain('{"ok":true}');
  });

  /** "审批没推进"经常就是卡在一条永不返回的请求上——而这恰恰是最难自己发现的一条。 */
  it("未结束的请求如实报 pending + 已等待时长", () => {
    const s = renderNetwork(
      envelope({ items: [req({ done: false, status: null, ms: 2400, body: null })] }),
      notes(),
    );
    expect(s).toContain("(pending, 2400ms so far)");
  });

  it("失败前置一行摘要（first 在窗口内）", () => {
    const s = renderNetwork(
      envelope({
        total: 12, matched: 12, failed: { n: 2, first: 10 },
        items: [req({ status: 500, body: '{"error":"No enum constant"}' }), req({ url: "http://x/api/approve" })],
      }),
      notes(),
    );
    expect(s).toContain("2 of 12 failed — first failure #10");
  });

  it("first failure 在窗口之前 → 摘要里说明它不在下面这段里", () => {
    const s = renderNetwork(
      envelope({ total: 40, matched: 40, failed: { n: 3, first: 2 }, items: [req(), req()] }),
      notes(),
    );
    expect(s).toContain("first failure #2 (not in the window below)");
  });

  it("status 为 0 / null 且无 err → 如实说「没有状态码」，不当成 200", () => {
    const s = renderNetwork(
      envelope({ items: [req({ status: 0, done: true, ms: 3, body: null })] }),
      notes(),
    );
    expect(s).toContain("(no status code)");
  });

  it("body 被 slice → 标出原始长度，不假装就是全部", () => {
    const s = renderNetwork(
      envelope({ items: [req({ body: "a".repeat(300), bodyCut: true, bodyLen: 5120 })] }),
      notes(),
    );
    expect(s).toContain("…(5120 chars)");
  });

  it("filter 生效时表头说清「匹配了多少 / 总共多少」", () => {
    const s = renderNetwork(envelope({ total: 40, matched: 7 }), notes({ filter: "/api/" }));
    expect(s).toContain('matching "/api/"');
    expect(s).toContain("last 1 of 7 matches, 40 total");
  });

  /** 空 ≠ 没有：这次才装上的那次调用，必须明说之前的看不到。 */
  it("armedBefore=false → 明说探针是这次才装上的", () => {
    const s = renderNetwork(envelope({ armedBefore: false, total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("armed in this document by this call");
    expect(s).toContain("not in the buffer");
  });

  it("装了但一条没有 → 与「没装」区分开", () => {
    const s = renderNetwork(envelope({ total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("no requests recorded");
    expect(s).not.toContain("by this call");
  });

  it("注册未来文档失败 → 如实带出原因（不静默）", () => {
    const s = renderNetwork(envelope(), notes({ registered: false, registerError: "…was rejected by the runtime" }));
    expect(s).toContain("rejected by the runtime");
  });

  it("没有状态码但有 err（fetch 被拒）→ 报失败并带原因", () => {
    const s = renderNetwork(
      envelope({ items: [req({ status: null, done: true, err: "Failed to fetch", body: null })], failed: { n: 1, first: 1 } }),
      notes(),
    );
    expect(s).toContain("1 of 3 failed — first failure #1");
    expect(s).toContain("Failed to fetch");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/network.test.ts
```
Expected: FAIL — 找不到 `./network.js`。

- [ ] **Step 3: 写 `network.ts`**

```ts
/**
 * `browser_network` 的渲染：`reqs[]` → 紧凑行。
 *
 * 形态由反馈决定：「紧凑地贴表格行」正是 agent 说 `browser_eval` 好用的理由，所以一条请求一行，
 * 不摊平成多段。三条硬约定（都来自实测痛点）：
 * - **未结束要看得出来**（`(pending, Nms so far)`）——"审批没推进"经常就是卡在一条永不返回的请求上；
 * - **失败前置一行摘要**——agent 十次里有九次是冲着失败来的；
 * - **没读到的东西如实说**（截断 / 无状态码 / 这次才装上 / 注册失败），不静默。
 */
import { asArray, asRecord, str } from "./format.js";
```

（`format.ts` 已有私有的 `asRecord` / `asArray` / `str`：本任务把它们**改成导出**，另加一个 `pad(s, n)` 助手，供 `network.ts` / `console.ts` 用——**不要在自己的模块里再复制一份**。）

```ts
/** 渲染选项：过滤串（表头要说）、注册结果（失败要说）。 */
export interface NetworkNotes {
  filter?: string;
  registered: boolean;
  registerError?: string;
}

/** 一行请求。字段缺失一律按"可能缺"写，**永不抛**（格式化器铁律）。 */
function renderRow(item: Record<string, unknown>, n: number): string {
  const method = str(item["method"]) || "?";
  const url = str(item["url"]) || "(no url)";
  const ms = Number(item["ms"]);
  const timing = Number.isFinite(ms) ? `${Math.round(ms)}ms` : "?ms";
  const status = statusText(item);
  return `#${n} ${method} ${url}  → ${status}  ${timing}${bodyText(item)}`;
}

/** 状态那一列：pending / 真状态码 / 没有状态码（CORS、中止、未结束），三者不许混。 */
function statusText(item: Record<string, unknown>): string {
  if (item["done"] !== true) return `(pending, ${Math.round(Number(item["ms"]) || 0)}ms so far)`;
  const status = Number(item["status"]);
  if (Number.isFinite(status) && status > 0) return String(status);
  return item["err"] ? "(failed)" : "(no status code)";
}

/** 响应体片段（含截断标记与失败原因）。 */
function bodyText(item: Record<string, unknown>): string {
  const bits: string[] = [];
  const body = str(item["body"]);
  if (body) bits.push(item["bodyCut"] === true ? `${body}…(${Number(item["bodyLen"]) || 0} chars)` : body);
  const err = str(item["err"]);
  if (err) bits.push(err);
  return bits.length ? `  ${bits.join("  ")}` : "";
}

/** 表头：说清窗口（取了最近多少条 / 匹配多少 / 总共多少）。 */
function header(value: Record<string, unknown>, filter: string | undefined): string {
  const shown = asArray(value["items"]).length;
  const matched = Number(value["matched"]) || 0;
  const total = Number(value["total"]) || 0;
  if (!filter) return `Network requests (last ${shown} of ${total}, newest last):`;
  return `Network requests matching ${JSON.stringify(filter)} (last ${shown} of ${matched} matches, ${total} total, newest last):`;
}

/** 失败摘要行：只统计**已结束**的请求（pending 不是失败）。 */
function failureLine(value: Record<string, unknown>): string | null {
  const failed = asRecord(value["failed"]);
  const n = Number(failed?.["n"]) || 0;
  if (n <= 0) return null;
  const total = Number(value["total"]) || 0;
  const first = Number(failed?.["first"]);
  const from = (Number(value["matched"]) || 0) - asArray(value["items"]).length + 1;
  const where = first < from ? ` #${first} (not in the window below)` : ` #${first}`;
  return `⚠ ${n} of ${total} failed — first failure${where}`;
}

/** 旁注：这次才装上 / 注册失败（都不许静默）。 */
function notesText(value: Record<string, unknown>, notes: NetworkNotes): string[] {
  const out: string[] = [];
  if (value["armedBefore"] !== true) {
    out.push(
      "NOTE: the recorder was armed in this document by this call, so nothing the page did before now " +
        "(including its load-time requests) is in the buffer. Navigate or reload to capture a fresh " +
        "document from its first request.",
    );
  }
  if (!notes.registered && notes.registerError) out.push(`NOTE: ${notes.registerError}`);
  return out;
}

/** 渲染。**永不抛**：入参是 `unknown`，逐字段判型。 */
export function renderNetwork(value: unknown, notes: NetworkNotes): string {
  const v = asRecord(value) ?? {};
  const items = asArray(v["items"]).map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
  const head = header(v, notes.filter);
  if (!items.length) {
    return [head, emptyText(v, notes), ...notesText(v, notes)].filter(Boolean).join("\n");
  }
  const from = (Number(v["matched"]) || items.length) - items.length + 1;
  const lines = items.map((item, i) => renderRow(item, from + i));
  return [head, failureLine(v), ...lines, ...notesText(v, notes)].filter((l): l is string => !!l).join("\n");
}

/** 两种空必须可辨：这次才装（附注里说了）/ 装了但没请求 / 有请求但全被 filter 滤掉。 */
function emptyText(value: Record<string, unknown>, notes: NetworkNotes): string {
  if (value["armedBefore"] !== true) return "No requests recorded yet.";
  if ((Number(value["total"]) || 0) > 0) {
    return `No request matched ${JSON.stringify(notes.filter ?? "")} — ${Number(value["total"])} were recorded in total.`;
  }
  return (
    "No requests recorded: this document has made no fetch/XHR call since the recorder was armed. " +
    "(If you expected a page-load request, reload — the recorder covers every document from the moment it is registered.)"
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/network.test.ts
```
Expected: PASS（11 条）。

- [ ] **Step 5: 接工具（`browserTools.ts`）**

```ts
export function buildBrowserNetworkTool(env: NodeJS.ProcessEnv, emit: (e: ChatEvent) => void) {
  return tool(
    "browser_network",
    "List the XHR/fetch requests the page has made — method, URL, status, duration and a clipped response body, " +
      "newest last. This is how you answer \"what did that request actually return?\": a blank page, an action that " +
      "never advanced, a 500 behind a swallowed error. Unfinished requests show as pending. The recorder is installed " +
      "on demand and lives in the CURRENT document only (it is cleared by any navigation); if this call installs it, " +
      "a note says so — navigate or reload to capture a fresh load from its first request. " +
      "Use browser_console for console messages and uncaught errors.",
    {
      view_id: viewIdArg,
      filter: z.string().optional().describe("Only requests whose URL contains this substring. Omit for all."),
      limit: z.number().int().min(1).max(NETWORK_LIMIT_MAX).optional()
        .describe(`How many of the most recent requests to show (default ${NETWORK_LIMIT_DEFAULT}, max ${NETWORK_LIMIT_MAX}).`),
    },
    async (args) => {
      if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
      try {
        const r = await readRecorder(
          { kind: "reqs", limit: args.limit ?? NETWORK_LIMIT_DEFAULT, match: args.filter },
          args.view_id,
          emit,
        );
        if (!r.ok) return textResult(r.error);
        return textResult(renderNetwork(r.value, {
          filter: args.filter,
          registered: r.registered,
          registerError: r.registerError,
        }));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}
```

常量与 import（文件顶部）：`NETWORK_LIMIT_DEFAULT = 20` / `NETWORK_LIMIT_MAX = 100`；`readRecorder` 从 `./browser/recorder.js`、`renderNetwork` 从 `./browser/network.js`。表里加 `buildBrowserNetworkTool(env, emit)`。

- [ ] **Step 6: 登记（五处，一处都不能少）**

1. `browserMcp.ts` 的 `BROWSER_ALLOW_RULES` 追加 `"mcp__aide-browser__browser_network"`（**工具级**，别写成 server 级）。
2. `browserMcp.ts` 的 `BROWSER_INSTRUCTIONS` 加一条（编号 12 之前，插在 6/7 附近更自然；**新工具名必须出现在这一句里**，`browserMcp.test.ts:59-61` 的循环会验）：
   ```
   12. WHEN THE PAGE IS NOT DOING WHAT YOU EXPECT, LOOK AT WHAT IT SAID. browser_network lists the XHR/fetch calls with status, duration and a response snippet — the fastest answer to "why is this page blank / why did nothing happen". browser_console lists console messages AND uncaught errors / unhandled rejections separately, which is where an error swallowed by the page's own try/catch shows up. Both read a buffer that lives in the CURRENT document only (a navigation resets it); if a call has to install the recorder first, the result says so — reload if you need the load-time requests.
   ```
3. `browserMcp.test.ts:40-49` 的精确数组断言补一条；跑 `cd agent-sidecar && npx vitest run src/extensions/browserMcp.test.ts -u` 更新快照。
4. `browserTools.test.ts`：工具名数组加 `"browser_network"`；headless 短路用例的清单加 `"browser_network"`（顺带把漏掉的 `"browser_tab"` 补上——那份清单的名字就叫"六个工具都短路"，加完是九个）。
5. `packages/aide-sdk/src/composables/useCustomizations.ts` 的 `aide-browser` purpose 串里补一句：`browser_network 列最近的 XHR/fetch（方法/URL/状态/耗时/响应片段）/ browser_console 列 console 与未捕获异常`。

- [ ] **Step 7: 补工具层用例（`browserTools.test.ts`）**

```ts
describe("browser_network", () => {
  it("先注册新文档（call_cdp）再读（求值），并把缓冲渲染出来", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_network").handler({ view_id: "browser-2" }, {});

    const reg = await waitForQuery(events, 0);
    expect(reg.op).toBe("call_cdp");
    expect(reg.method).toBe("Page.addScriptToEvaluateOnNewDocument");

    const read = await waitForQuery(events, 1);
    expect(read.op).toBe("call_cdp");
    expect(read.method).toBe("Runtime.evaluate");
    expect(read.params.expression).toContain("__aideRec");

    reply(reg, { ok: true, data: { view_id: "browser-2", value: { identifier: "1" } } });
    reply(read, { ok: true, data: { view_id: "browser-2", value: { result: { type: "object", value: {
      ok: true, armedBefore: true, cap: 100, total: 1, matched: 1, failed: { n: 1, first: 1 },
      items: [{ kind: "fetch", method: "GET", url: "http://x/api/fail", status: 500, done: true, ms: 12,
                body: '{"error":"No enum constant"}', bodyCut: false, bodyLen: 28, err: null }],
    } } } } });

    const r = await p;
    expect(r.content[0].text).toContain("Network requests");
    expect(r.content[0].text).toContain("500");
    expect(r.content[0].text).toContain("No enum constant");
  });

  /** 注册是**每个视图一次**：第二次读不该再发注册（重发 = 每份新文档跑 N 遍 no-op）。 */
  it("同一视图第二次调用不再重发注册", async () => {
    const { events, emit } = emitCollector();
    const tool = toolByName({} as NodeJS.ProcessEnv, emit, "browser_network");
    // 第一次：注册 + 读
    const p1 = tool.handler({ view_id: "browser-9" }, {});
    reply(await waitForQuery(events, 0), { ok: true, data: { view_id: "browser-9", value: { identifier: "1" } } });
    reply(await waitForQuery(events, 1), evalOk({ ok: true, armedBefore: false, total: 0, matched: 0, items: [], failed: { n: 0, first: null } }));
    await p1;

    // 第二次：只有读
    const before = events.length;
    const p2 = tool.handler({ view_id: "browser-9" }, {});
    const q = await waitForQuery(events, before);
    expect(q.method).toBe("Runtime.evaluate");
    reply(q, evalOk({ ok: true, armedBefore: true, total: 0, matched: 0, items: [], failed: { n: 0, first: null } }));
    const r = await p2;
    expect(r.content[0].text).toContain("No requests recorded");
  });

  it("注册被运行时拒绝 → **照样能读**，但如实说未来文档没覆盖", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_network").handler({}, {});
    reply(await waitForQuery(events, 0), { ok: true, data: { view_id: "browser-1", value: { error: { code: -32601, message: "'Page.addScriptToEvaluateOnNewDocument' wasn't found" } } } });
    reply(await waitForQuery(events, 1), evalOk({ ok: true, armedBefore: false, total: 0, matched: 0, items: [], failed: { n: 0, first: null } }));
    const r = await p;
    expect(r.content[0].text).toContain("rejected by the runtime");
  });
});
```

（`evalOk` / `reply` / `waitForQuery` / `toolByName` 都是 `browserTools.test.ts` 已有的助手，直接用。）

- [ ] **Step 8: 全量回归 + 提交**

```bash
cd agent-sidecar && npx vitest run src/extensions/ 2>&1 | tail -8
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "feat(browser): browser_network 工具（XHR/fetch 状态·耗时·响应片段，含 pending 与失败摘要）"
```

---

### Task 5: `browser_console` + token 预算量尺

**Files:**
- Create: `agent-sidecar/src/extensions/browser/console.ts`
- Create: `agent-sidecar/src/extensions/browser/console.test.ts`
- Modify: `agent-sidecar/src/extensions/browserTools.ts` / `browserTools.test.ts` / `browserMcp.ts` / `__snapshots__/browserMcp.test.ts.snap` / `useCustomizations.ts`（同上五处）
- Modify: `agent-sidecar/src/extensions/browserSkill.ts`
- Modify: `scripts/diag/measure-builtin-mcp.ts`（量尺修正）

**Interfaces:**
- Consumes: `readRecorder`（Task 3）、`asRecord`/`asArray`/`str`（Task 4 已在 `format.ts` 导出）。
- Produces: `renderConsole(value: unknown, notes: ConsoleNotes): string`，`ConsoleNotes = { level?: string; registered: boolean; registerError?: string }`；工具 `browser_console(view_id?, level?, limit?)`，默认 limit 30、上限 100。

- [ ] **Step 1: 写失败测试**

`console.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderConsole } from "./console.js";

const line = (over: Record<string, unknown> = {}) => ({
  lvl: "log", t: 12, text: 'fast done {"ok":true,"rows":[1,2,3]}', cut: false, len: 33, ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  ok: true, armedBefore: true, cap: 100, total: 1, matched: 1,
  failed: { n: 0, first: null }, items: [line()], ...over,
});

const notes = (over: Record<string, unknown> = {}) => ({ registered: true, ...over });

describe("renderConsole", () => {
  /** uncaught / unhandled 是页面**没接住**的错误——合成 [error] 就把"谁吞了它"抹掉了。 */
  it("uncaught / unhandled 与 console.error 分开显示、按列对齐", () => {
    const s = renderConsole(
      envelope({
        total: 3, matched: 3,
        items: [
          line({ lvl: "uncaught", text: "Uncaught ReferenceError: nope is not defined" }),
          line({ lvl: "error", text: "slow failed NetworkError" }),
          line({ lvl: "warn", text: 'direct warn {"n":7}' }),
        ],
      }),
      notes(),
    );
    expect(s).toContain("Console (last 3 of 3):");
    expect(s).toContain("[uncaught] Uncaught ReferenceError: nope is not defined");
    expect(s).toContain("[error]    slow failed NetworkError");
    expect(s).toContain('[warn]     direct warn {"n":7}');
  });

  it("级别过滤生效时表头说清窗口", () => {
    const s = renderConsole(envelope({ total: 9, matched: 4 }), notes({ level: "error" }));
    expect(s).toContain("Console (error only, last 1 of 4 matches, 9 total):");
  });

  it("被 slice 的一行如实标原始长度", () => {
    const s = renderConsole(envelope({ items: [line({ text: "a".repeat(300), cut: true, len: 5120 })] }), notes());
    expect(s).toContain("…(5120 chars)");
  });

  /** 空 ≠ 没有：这次才装上的那次调用，必须明说之前的看不到。 */
  it("armedBefore=false → 明说探针是这次才装上的", () => {
    const s = renderConsole(envelope({ armedBefore: false, total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("armed in this document by this call");
    expect(s).toContain("not in the buffer");
  });

  it("装了但页面没写过 → 与「没装」区分开", () => {
    const s = renderConsole(envelope({ total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("Nothing has been written to the console");
    expect(s).not.toContain("by this call");
  });

  it("有记录但全被级别滤掉 → 报出总数，不假装页面是安静的", () => {
    const s = renderConsole(envelope({ total: 9, matched: 0, items: [] }), notes({ level: "warn" }));
    expect(s).toContain('9 entries recorded, none at level "warn"');
  });

  it("注册未来文档失败 → 如实带出原因", () => {
    const s = renderConsole(envelope(), notes({ registered: false, registerError: "…was rejected by the runtime" }));
    expect(s).toContain("rejected by the runtime");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd agent-sidecar && npx vitest run src/extensions/browser/console.test.ts`，Expected: FAIL。

- [ ] **Step 3: 写 `console.ts`**

```ts
/**
 * `browser_console` 的渲染：`logs[]` → 紧凑行。
 *
 * 一条硬约定：**`uncaught` / `unhandled` 必须与 `console.error` 分开显示**。它们不是"页面主动
 * 打印的错误"，而是页面**没接住**的错误——反馈里的现场（后端返回 `No enum constant …` 被前端
 * try/catch 吞掉）正是这一类。合成一行 `[error]` 就把"谁吞了它"这条线索抹掉了。
 */
import { asArray, asRecord, pad, str } from "./format.js";

/** 级别标签的**总宽度**（含方括号）——对齐是为了让模型一眼扫列。 */
const LEVEL_WIDTH = 11;

/** 渲染选项：级别过滤（表头要说）、注册结果（失败要说）。 */
export interface ConsoleNotes {
  level?: string;
  registered: boolean;
  registerError?: string;
}

function levelTag(lvl: string): string {
  return pad(`[${lvl || "?"}]`, LEVEL_WIDTH);
}

/** 表头：说清窗口与过滤（`error` 的语义含 uncaught/unhandled，表头照实写）。 */
function header(value: Record<string, unknown>, level: string | undefined): string {
  const shown = asArray(value["items"]).length;
  const matched = Number(value["matched"]) || 0;
  const total = Number(value["total"]) || 0;
  if (!level || level === "all") return `Console (last ${shown} of ${total}):`;
  return `Console (${level} only, last ${shown} of ${matched} matches, ${total} total):`;
}

/** 旁注：这次才装上 / 注册失败（都不许静默）。 */
function notesText(value: Record<string, unknown>, notes: ConsoleNotes): string[] {
  const out: string[] = [];
  if (value["armedBefore"] !== true) {
    out.push(
      "NOTE: the recorder was armed in this document by this call, so anything the page logged before now " +
        "is not in the buffer. Reload or navigate to capture a fresh document from its first line.",
    );
  }
  if (!notes.registered && notes.registerError) out.push(`NOTE: ${notes.registerError}`);
  return out;
}

/** 三种空必须可辨：这次才装 / 装了但页面没写过 / 有记录但全被级别滤掉。 */
function emptyText(value: Record<string, unknown>, notes: ConsoleNotes): string {
  if (value["armedBefore"] !== true) return "Nothing recorded yet.";
  const total = Number(value["total"]) || 0;
  if (total > 0) return `${total} entries recorded, none at level ${JSON.stringify(notes.level ?? "")}.`;
  return "Nothing has been written to the console since the recorder was armed — no console.* call and no uncaught error.";
}

/** 一行：级别标签 + 文本 +（截断时）原始长度。 */
function renderLine(item: Record<string, unknown>): string {
  const suffix = item["cut"] === true ? `…(${Number(item["len"]) || 0} chars)` : "";
  return `${levelTag(str(item["lvl"]))}${str(item["text"])}${suffix}`;
}

/** 渲染。**永不抛**：入参是 `unknown`，逐字段判型。 */
export function renderConsole(value: unknown, notes: ConsoleNotes): string {
  const v = asRecord(value) ?? {};
  const items = asArray(v["items"]).map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
  const head = header(v, notes.level);
  const tail = notesText(v, notes);
  if (!items.length) return [head, emptyText(v, notes), ...tail].filter(Boolean).join("\n");
  return [head, ...items.map(renderLine), ...tail].join("\n");
}
```

（`pad` 在 `format.ts` 里是 `(s: string, n: number) => s.padEnd(n)`——`[uncaught]` 与 `[error]` 因此同宽。）

- [ ] **Step 4: 工具定义 + 五处登记**

`browser_console` 的 description（要点：与 network 的分工、uncaught 与 console.error 分开、级别语义）：

```ts
"browser_console",
"List what the page logged: console.* calls AND the errors it never caught (uncaught exceptions, unhandled promise " +
  "rejections — shown separately, because those are exactly the ones the page's own error handling did not swallow). " +
  "Reach for it when something failed silently — an API error caught by the app and never surfaced, a blank panel. " +
  "Same buffer rules as browser_network: it lives in the CURRENT document only and a call that has to install the " +
  "recorder first says so.",
{
  view_id: viewIdArg,
  level: z
    .enum(["error", "warn", "all"])
    .optional()
    .describe(
      "error = console.error plus uncaught exceptions and unhandled rejections; warn = console.warn only; " +
        "all (default) = everything.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONSOLE_LIMIT_MAX)
    .optional()
    .describe(`How many of the most recent entries to show (default ${CONSOLE_LIMIT_DEFAULT}, max ${CONSOLE_LIMIT_MAX}).`),
},
async (args) => {
  if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
  try {
    const level = args.level ?? "all";
    const r = await readRecorder(
      { kind: "logs", limit: args.limit ?? CONSOLE_LIMIT_DEFAULT, match: level },
      args.view_id,
      emit,
    );
    if (!r.ok) return textResult(r.error);
    return textResult(renderConsole(r.value, {
      level,
      registered: r.registered,
      registerError: r.registerError,
    }));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return textResult(`Browser tool failed unexpectedly: ${detail}`);
  }
},
```
（常量 `CONSOLE_LIMIT_DEFAULT = 30` / `CONSOLE_LIMIT_MAX = 100` 加在 `browserTools.ts` 顶部，与 `NETWORK_LIMIT_*` 并排。）

五处登记同 Task 4 Step 6；`BROWSER_INSTRUCTIONS` 那条 12 已经同时点名了两个工具（若执行顺序不同，确认两个名字都在）。

- [ ] **Step 5: `browserSkill.ts` 补两条契约**

在 `PAGE_EXTRACTION_REFERENCE` 末尾加一节（**别写站点名**——`browserSkill.test.ts` 有守卫词表）：

```md
## Diagnosing a page that is not doing what you expect

Two buffers answer most of it, without a single round trip through the app's own logs:

- **`browser_network`** — the XHR/fetch calls with status, duration and a clipped response body. A page that came up blank is very often a request that returned 500 with the real reason in the body. Unfinished requests show as `pending`, which is how you catch a call that never returns.
- **`browser_console`** — the console messages, and separately the errors the page never caught. An error swallowed by the app's own `try/catch` shows up here and nowhere else.

Both read a buffer that lives in the **current document only**: navigating or reloading clears it, and the first call that has to install the recorder says so in its result. If you need the requests a page made *while loading*, arm the recorder (any `browser_network` / `browser_console` call does it) and then navigate or reload — the new document is recorded from its first request.
```

- [ ] **Step 6: 修量尺并量预算**

`scripts/diag/measure-builtin-mcp.ts` 的 `schemaChars()` 换成真 JSON Schema（**它现在的注释写着"schema 实为小头"，实测低估 1.55×**——留着它，以后每个人都拿着偏小的尺做预算）：

```ts
import { z } from "zod";
/** 工具在 wire 上的形态 = {name, description, inputSchema(JSON Schema)}（SDK 发出去的就是这个）。 */
function schemaChars(t: any): number {
  const raw = t?.inputSchema;
  if (!raw || typeof raw !== "object") return 0;
  try {
    return JSON.stringify(z.toJSONSchema(z.object(raw))).length;
  } catch {
    // 非 zod raw shape（理论上不该有）——退化成字段名 + 描述长度，并让数字明显偏小
    return Object.entries(raw as Record<string, any>).reduce(
      (n, [k, v]) => n + k.length + (typeof (v as any)?.description === "string" ? (v as any).description.length : 0),
      0,
    );
  }
}
```

跑：

```bash
cd agent-sidecar && npx tsx ../scripts/diag/measure-builtin-mcp.ts
```

**预算红线（用相对值判）**：`browser_network` + `browser_console` 两条的 `desc + schema` 合计 ≤ **600 token**（约 +16%）。

- 超了 → 把两个合成一个 `browser_observe{what:"network"|"console", ...}`（用户的备选方案，写进 spec 未决问题）。
- 没超 → 把新的基线数字记进本文件（**旧基线是按低估 1.55× 的尺量的，别与新数字并列比较**）。

**实测（2026-09-23，Task 5 落地后，新尺）**：

| server | tools | toolPayload | instructions | 合计 |
|---|---|---|---|---|
| **aide-browser** | 9 | ≈3319 tok | ≈1750 tok | **≈5069 tok** |
| 内建四 server 总计 | — | — | — | **≈9565 tok** |

两条新工具（description + 真 JSON Schema）分别 **299** 与 **295** tok，合计 **594 ≤ 600** ⇒ **不做 `browser_observe` 合并**。
⚠️ 只剩 6 token 余量：**再加第三个工具之前必须重测，且任何对这两条描述的润色都可能顶破红线**。
（量尺本身仍偏保守：ASCII 按 3.6 字/tok 折算，`$schema` 用的是 2020-12 而 SDK 实发 draft-7。）

- [ ] **Step 7: 全量回归 + 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "feat(browser): browser_console 工具 + 量尺修正（真 JSON Schema）与预算实测"
```

---

### Task 6: P2-1 navigate 回报**观测到的**落点

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/tab.ts`
- Modify: `agent-sidecar/src/extensions/browser/tab.test.ts`

**Interfaces:**
- Consumes: `runEval`（`browser/runEval.js`）、`queryBrowser`。
- Produces: `performTabAction("navigate", …)` 的文本改为「请求值 + 观测值」两段式；`renderTabResult` 增加 `observedUrl?: string` 参数（第 5 个参数——**超 4，改成 options**：`renderTabResult(action, data, observed?: { url?: string; error?: string })`）。

- [ ] **Step 1: 写失败测试**

`tab.test.ts` 目前是纯函数文件；新用例要走桥，故文件里自带一份**最小**应答器（与 `wait.test.ts` 同形，但**不引那个文件的私有助手**）：

```ts
import { afterEach } from "vitest";
import { performTabAction } from "./tab.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../browserClient.js";
import type { ChatEvent } from "../../engine/types.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

/** 等第 n 条桥请求出现——navigate 的落点回读在 `NAV_SETTLE_MS` 之后才发，不能假设已到齐。 */
async function waitForQuery(events: ChatEvent[], n: number, budgetMs = 3000): Promise<any> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && events.length <= n) await new Promise((r) => setTimeout(r, 5));
  const q = events[n];
  if (!q) throw new Error(`bridge query #${n} never arrived (got ${events.length})`);
  return q as any;
}

const evalOk = (value: unknown) => ({
  ok: true,
  data: { view_id: "browser-7", value: { result: { type: "string", value } } },
});

afterEach(() => cancelAllBrowserQueries("test cleanup"));

describe("navigate：回报**观测到的**落点，不是请求值", () => {
  // navigate 的命令回包里 nav.url 由 `begin_nav` 写成**请求值**——那正是反馈第 1 条里
  // "工具说到了新地址、页面还在旧地址"的来源。
  const navOk = {
    ok: true,
    data: {
      view_id: "browser-7",
      view: { id: "browser-7", nav: { state: "loading", url: "http://a/#/two", title: "" } },
    },
  };

  it("落点与请求一致 → 说「文档确认」", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("navigate", { viewId: "browser-7", url: "http://a/#/two" }, emit);
    const nav = await waitForQuery(events, 0);
    resolveBrowserResult({ request_id: nav.request_id, ...navOk });

    const read = await waitForQuery(events, 1);
    expect(read.method).toBe("Runtime.evaluate");
    expect(read.params.expression).toBe("location.href");
    resolveBrowserResult({ request_id: read.request_id, ...evalOk("http://a/#/two") });

    const text = await p;
    expect(text).toContain("document confirms");
    expect(text).toContain("http://a/#/two");
  });

  it("落点与请求不一致（守卫把 hash 弹回）→ 两边都给出来 + 说明两种成因", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("navigate", { viewId: "browser-7", url: "http://a/#/two" }, emit);
    const nav = await waitForQuery(events, 0);
    resolveBrowserResult({ request_id: nav.request_id, ...navOk });
    const read = await waitForQuery(events, 1);
    resolveBrowserResult({ request_id: read.request_id, ...evalOk("http://a/#/one") });

    const text = await p;
    expect(text).toContain("http://a/#/one");
    expect(text).toContain("http://a/#/two");
    expect(text).toContain("redirected");
    expect(text).not.toContain("document confirms");
  });

  it("读不到落点 → 退回请求值 + 明说未能确认，不假装成功", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("navigate", { viewId: "browser-7", url: "http://a/#/two" }, emit);
    const nav = await waitForQuery(events, 0);
    resolveBrowserResult({ request_id: nav.request_id, ...navOk });
    const read = await waitForQuery(events, 1);
    resolveBrowserResult({ request_id: read.request_id, ok: false, error: "the view browser-7 is gone" });

    const text = await p;
    expect(text).toContain("could not be read");
    expect(text).toContain("the view browser-7 is gone");
    expect(text).not.toContain("document confirms");
  });

  it("非 navigate 的动作不读落点（back / forward 一条直路，不多一次往返）", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("focus", { viewId: "browser-7" }, emit);
    const q = await waitForQuery(events, 0);
    expect(q.op).toBe("focus");
    resolveBrowserResult({ request_id: q.request_id, ok: true, data: { view_id: "browser-7", requested: true } });
    await p;
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd agent-sidecar && npx vitest run src/extensions/browser/tab.test.ts`，Expected: FAIL（`performTabAction` 还不读落点，第 2/3 条的断言无从满足）。

- [ ] **Step 3: 改 `tab.ts`**

顶部 import 补两条（`runEval` 来自 `./runEval.js`；`str` 是 Task 4 在 `format.ts` 里导出的小助手，
`tab.ts` 现有那行改成 `import { formatBridgeFailure, str } from "./format.js";`），然后加：

```ts
/**
 * 导航后让页面起跳（或让守卫把 hash 弹回）的一小段固定等待。
 *
 * ⚠️ **不能省**：WebView2 的 `Navigate()` 是**异步投递**，命令一返回立刻读 `location.href`
 * 多半读到**旧文档**——那会让每一次正常的跨文档导航都报"落点不符"，把真信号淹掉。
 * 取值依据见实现计划 Task 2 Step 5 的实测（spec 修法 (b) 的往返代价）。
 */
export const NAV_SETTLE_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 读一次页面**实际**所在的位置。**永不抛**：失败折成 `{error}` 由渲染层如实带出。
 * `viewId` 用 navigate 回包里的**已解析 id**（不是调用方给的原始参数），多视图下才指得准。
 */
async function readLandingUrl(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ url?: string; error?: string }> {
  const r = await runEval("location.href", { viewId }, emit);
  if (!r.ok) return { error: r.error };
  const url = typeof r.value === "string" ? r.value : undefined;
  return url ? { url } : { error: "the page returned no location.href" };
}

/**
 * 导航：发命令 → 让出 `NAV_SETTLE_MS` → 读**观测到的**落点 → 两者一起回报。
 *
 * 反馈里那条"报成功但没生效"的根因就是**只回报请求值**：hash 导航被路由守卫弹回时，
 * 工具说"已导航到新地址"，页面还在原处。**观测值才是事实**。
 */
async function performNavigate(
  args: TabArgs,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const call = buildTabCall("navigate", args);
  const resp = await queryBrowser(call, emit);
  if (!resp.ok) return formatBridgeFailure(resp);

  const resolved = asRecord(resp.data)?.["view_id"];
  await sleep(NAV_SETTLE_MS);
  const observed = await readLandingUrl(typeof resolved === "string" ? resolved : args.viewId, emit);
  return renderTabResult("navigate", resp.data, observed);
}

/** 非 navigate 的 tab 动作：一条直路（发桥 → 渲染）。 */
async function performSimpleTabAction(
  action: TabAction,
  args: TabArgs,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const resp = await queryBrowser(buildTabCall(action, args), emit);
  if (!resp.ok) return formatBridgeFailure(resp);
  return renderTabResult(action, resp.data);
}

/** 编排：navigate 有落点回读这一步，其余动作一条直路。 */
export async function performTabAction(
  action: TabAction,
  args: TabArgs,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  return action === "navigate"
    ? performNavigate(args, emit)
    : performSimpleTabAction(action, args, emit);
}
```

`renderTabResult` 的 navigate 分支（`observed` 是新增的第三个入参，缺省不认识就说请求值）：

```ts
    case "navigate": {
      const where = view ? describeView(view) : String(d["view_id"] ?? "?");
      const want = view ? str(asRecord(view["nav"])?.["url"]) : "";
      if (!observed?.url) {
        return (
          `Navigated view ${where} (requested${want ? ` ${want}` : ""}; the landing URL could not be read` +
          `${observed?.error ? `: ${observed.error}` : ""}). ` +
          `Use browser_eval \`location.href\` to confirm where the page actually ended up.`
        );
      }
      if (observed.url === want) {
        return `Navigated view ${where} — the document confirms it is at ${observed.url}.`;
      }
      return (
        `Requested ${want || "(unknown url)"} for view ${String(d["view_id"] ?? "?")}, but the document reports ` +
        `${observed.url} instead. Two causes look the same here: the navigation had not committed yet, or the page ` +
        `redirected / a router guard bounced it back. Re-read with browser_eval \`location.href\`, or wait for the ` +
        `content you expect with browser_wait until:"condition".`
      );
    }
```

`renderTabResult` 的签名改为 `(action: TabAction, data: unknown, observed?: { url?: string; error?: string })`——已知 3 个入参，未超红线。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/tab.test.ts src/extensions/browserTools.test.ts
```
Expected: PASS。

- [ ] **Step 5: 同文档导航的文案（`wait.ts` 的 `load` 模式）**

`waitForLoad` 里"本来就没在加载"那一支（`wait.ts:241-245`）末尾补一句：

```
If you just made a SAME-DOCUMENT navigation (a hash change or history.pushState), it does not trigger a load
and will never show up here — use until:"condition" on the content you expect, or read location.href.
```

`wait.test.ts` 的 "already ready" 用例补一条断言：`expect(text).toContain("SAME-DOCUMENT")`。

- [ ] **Step 6: 全量回归 + 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "fix(browser): navigate 回报观测到的落点（不再把请求值当事实）+ 同文档导航明说"
```

---

### Task 7: P2-2 `browser_wait` 的文档身份 + 真实耗时

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/wait.ts`
- Modify: `agent-sidecar/src/extensions/browser/wait.test.ts`

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `conditionTick` 的观察值多一个 `timeOrigin`；成功/超时文案里的毫秒数改为 **`Date.now()` 差值**；文档被替换时多一行 NOTE。

- [ ] **Step 1: 写失败测试**

`wait.test.ts` 补（现有助手直接用；`tick()` 需要能带 `to`）：

```ts
/** ① 那个毫秒数必须是**测出来的**，不是 `attempts × intervalMs` 算出来的。
 *  2026-09-22 实测：agent 正是照抄了那个合成值（"第一次轮询 200ms 就成立"），据此建立了因果推理。
 *  构造：intervalMs 50、第一次就满足 → 合成值恒为 50ms，实测值必然远小于它。 */
it("成功文案里的耗时是实测值（< intervalMs 的合成值）", async () => {
  const { events, emit } = emitCollector();
  const p = waitForBrowser(fast({ intervalMs: 50, timeoutMs: 1000 }), emit);
  reply(await waitForQuery(events, 0), evalOk(0));
  tick(await waitForQuery(events, 1), { met: true, value: true, to: 111 });
  const m = /Condition met after 1 poll \(([0-9]+)ms\)/.exec(await p);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeLessThan(50);
});

it("条件求值里带出 performance.timeOrigin（免费的文档指纹）", async () => {
  const { events, emit } = emitCollector();
  const p = waitForBrowser(fast({}), emit);
  reply(await waitForQuery(events, 0), evalOk(0));
  const q1 = await waitForQuery(events, 1);
  expect(q1.params.expression).toContain("timeOrigin");
  tick(q1, { met: true, value: true, to: 1 });
  await p;
});

it("等待途中文档被替换 → 不是继续假装、也不是失败，而是如实报告并重置基准", async () => {
  const { events, emit } = emitCollector();
  const p = waitForBrowser(fast({ timeoutMs: 400, intervalMs: 5 }), emit);
  reply(await waitForQuery(events, 0), evalOk(0));
  tick(await waitForQuery(events, 1), { met: false, value: "a", to: 111 });   // 旧文档
  tick(await waitForQuery(events, 2), { met: true, value: "b", to: 222 });    // 新文档命中
  const text = await p;
  expect(text).toContain("Condition met after 2 poll");
  expect(text).toContain("the page was replaced");
  expect(text).toContain("poll #2");
});

it("同一文档内满足 → 不出现替换说明（不制造噪音）", async () => {
  ... expect(text).not.toContain("was replaced");
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd agent-sidecar && npx vitest run src/extensions/browser/wait.test.ts`，Expected: FAIL（`Condition met after 1 poll (…)` 现在写的是 50ms）。

- [ ] **Step 3: 改 `wait.ts`**

```ts
/**
 * 条件求值器。**在条件外面套一层拿两个免费信号**：
 * - `met` / `value`：条件本身（抛异常 = 尚未满足，不是错误）；
 * - `to`：`performance.timeOrigin` —— **每份文档一个值**，不需要我们注入任何东西，
 *   却能回答"我这一跳读的是哪个文档"。全浏览器模块此前**没有任何文档身份概念**，
 *   于是"旧文档先满足"这类现象（反馈第 2 条）无从分辨。
 */
function conditionScript(condition: string): string {
  return `(function () {
  try { var __v = (${condition}); return { met: !!__v, value: __v, to: (window.performance && performance.timeOrigin) || 0 }; }
  catch (e) { return { met: false, threw: String((e && e.message) || e), to: (window.performance && performance.timeOrigin) || 0 }; }
})()`;
}
```

`ConditionTick` 加 `timeOrigin: number | null`（`0`/缺省 → `null`），`conditionTick` 里 `typeof v["to"] === "number" && v["to"] > 0 ? v["to"] : null`。

新增**文档身份追踪**（把跨 tick 的状态从编排函数里挪走，主函数保持成"目录"）：

```ts
/**
 * 等待期间的文档身份追踪。
 *
 * 语义（**不是**"继续等"也**不是**"失败"）：文档被替换时**如实记下来**，把观测基准重置到
 * 新文档继续等。理由——"点一下 → 页面跳走 → 等新内容"是最常见的等待形态，为它失败是错的；
 * 而静默继续则让"我等的到底是哪个文档"永远不可观测。
 */
function trackDocument() {
  let baseline: number | null = null;
  let replaced = 0;
  let lastChangePoll = 0;

  return {
    observe(timeOrigin: number | null, poll: number): void {
      if (timeOrigin === null) return;
      if (baseline === null) baseline = timeOrigin;
      else if (timeOrigin !== baseline) {
        baseline = timeOrigin;
        replaced += 1;
        lastChangePoll = poll;
      }
    },
    note(): string | null {
      return replaced === 0
        ? null
        : `NOTE: the page was replaced ${replaced} time(s) during this wait (last at poll #${lastChangePoll}) — ` +
            `observations before that were reading a different document.`;
    },
  };
}
```

两个报文构造函数（顺带把「耗时」这件事收成一个参数对象，别再加第 5 个位置参数）：

```ts
/** 一次等待的量化事实。 */
interface PollStats {
  attempts: number;
  /** **实测**耗时（`Date.now()` 差值），不是 `attempts × intervalMs` 的合成值。 */
  elapsedMs: number;
  intervalMs: number;
  budgetMs: number;
}

/** 满足：报实测耗时 + 条件看到了什么 +（若有）文档被替换的说明。 */
function metReport(detail: string, stats: PollStats, docNote: string | null): string {
  const head = `Condition met after ${stats.attempts} poll(s) (${stats.elapsedMs}ms, polling every ${stats.intervalMs}ms): ${detail}`;
  return docNote ? `${head}\n${docNote}` : head;
}

/** 超时：**诊断，不是错误**。数字一律是实测值，预算单独标出。 */
function timeoutReport(head: string, last: string, stats: PollStats): string {
  return [
    head,
    `Polled ${stats.attempts} time(s) over ${stats.elapsedMs}ms (budget ${stats.budgetMs}ms, interval ${stats.intervalMs}ms).`,
    `Last observation: ${last}`,
  ].join("\n");
}
```

`waitForCondition` 变成：

```ts
async function waitForCondition(
  viewId: string | undefined,
  input: WaitInput,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  const doc = trackDocument();
  let attempts = 0;
  let last: ConditionTick = { met: false, detail: "(never evaluated)", timeOrigin: null };

  while (Date.now() < deadline) {
    attempts += 1;
    const r = await conditionTick(viewId, input.condition ?? "", emit);
    if (!r.ok) return r.text;
    last = r.tick;
    doc.observe(last.timeOrigin, attempts);

    const stats: PollStats = {
      attempts, elapsedMs: Date.now() - startedAt, intervalMs: input.intervalMs, budgetMs: input.timeoutMs,
    };
    if (last.met) return metReport(last.detail, stats, doc.note());
    await sleep(input.intervalMs);
  }

  return timeoutReport("Timed out — the condition never became true.", last.detail, {
    attempts, elapsedMs: Date.now() - startedAt, intervalMs: input.intervalMs, budgetMs: input.timeoutMs,
  });
}
```

`waitForLoad` 里的 `timeoutReport(...)` 调用点同步改成新签名（那里没有条件求值，故没有文档身份——**如实**：`load` 模式的身份由宿主侧 `nav.state` 承担）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/wait.test.ts
```
Expected: PASS（含新增 4 条）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "fix(browser): browser_wait 带出文档身份（timeOrigin）+ 耗时改为实测（合成值曾骗过 agent）"
```

---

### Task 8: P2-3 Raw text 过可见性判据

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/projection.ts`
- Modify: `agent-sidecar/src/extensions/browser/format.ts`
- Modify: `agent-sidecar/src/extensions/browser/projection.test.ts` / `format.test.ts` / `browserTools.test.ts`

**Interfaces:**
- Produces: 投影信封新增 `textFiltered: boolean`（`false` = 这一份 text 没过滤，只能拿 `textContent`）；
  `format.ts` 新增私有 `textFilterNote(value): string | null`，在**主文档与帧**两处都调用。

- [ ] **Step 1: 写失败测试**

`projection.test.ts` 的装配不变量那组补：

```ts
  it("Raw text 走 innerText（在原文档上取，不是游离 clone）", () => {
    const s = buildProjectionScript();
    expect(s).toContain("doc.body.innerText");
    // ⚠️ 游离节点上的 innerText 会退化成 textContent 语义——写成 clone.innerText 就是"看着改了、
    // 实际没过滤"的假修复（spec §9.3 的已知陷阱）。这条把那条岔路钉死。
    expect(s).not.toContain("clone.innerText");
  });

  it("includeHidden 打开时走老路（textContent），过滤标志随开关走", () => {
    expect(buildProjectionScript({ includeHidden: true })).toContain("var INCLUDE_HIDDEN = true;");
    // 装配不变量：取正文那段真的把结果接到了信封上（少这一行，format.ts 的旁注永远不出现）
    expect(SCRIPT).toContain("out.textFiltered = body.filtered;");
    expect(SCRIPT).toContain("function projectText(doc)");
  });
```

`format.test.ts` 补：

```ts
describe("Raw text 的旁注", () => {
  it("textFiltered:false → 明说这一份没过滤（不静默降级）", () => {
    const s = formatRead({ viewId: "browser-1", value: { ok: true, title: "T", text: "x", textFiltered: false }, probe: { pending: false } });
    expect(s).toContain("only text that is actually rendered");
  });

  it("过滤生效时不出现旁注（默认路径无噪音）", () => {
    const s = formatRead({ viewId: "browser-1", value: { ok: true, title: "T", text: "x", textFiltered: true }, probe: { pending: false } });
    expect(s).not.toContain("only text that is actually rendered");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd agent-sidecar && npx vitest run src/extensions/browser/projection.test.ts src/extensions/browser/format.test.ts`，Expected: FAIL。

- [ ] **Step 3: 改 `projection.ts`**

把 `project(doc)` 尾部那段取正文的代码（`projection.ts:264-278`）抽成一个函数（主函数是"目录"，细节下沉）：

```js
  /**
   * 正文文本。**默认只取渲染中的内容**（`innerText` 是浏览器自己的可见性感知 API——
   * 什么算可见交给浏览器自己判，就不可能与我们判得不一样）。
   *
   * ⚠️ 三条不许踩：
   * 1. 必须对**原文档**的 `doc.body` 取（`innerText` 依赖元素在文档中且有布局）；
   *    游离的 `cloneNode(true)` 上取会**退化**成 `textContent` 语义 —— 那是个"看着改了、
   *    实际没过滤"的假修复。
   * 2. `include_hidden` 打开时走老路（`textContent`，含隐藏内容）——开关与 skeleton 同义。
   * 3. 拿不到 `innerText`（老运行时 / 无 body）时**如实标** `textFiltered = false` 再退回老路，
   *    不假装过滤过了。
   */
  function projectText(doc) {
    var full = '';
    try {
      var clone = doc.body ? doc.body.cloneNode(true) : null;
      if (clone) {
        var junk = clone.querySelectorAll('script,style,noscript,template');
        for (var n = 0; n < junk.length; n++) {
          if (junk[n].parentNode) junk[n].parentNode.removeChild(junk[n]);
        }
        full = String(clone.textContent || '');
      }
    } catch (e) { full = ''; }

    if (INCLUDE_HIDDEN) return { text: cut(full, 20000), filtered: true };
    try {
      if (doc.body && typeof doc.body.innerText === 'string') {
        return { text: cut(doc.body.innerText, 20000), filtered: true };
      }
    } catch (e) { /* 下面如实标未过滤 */ }
    return { text: cut(full, 20000), filtered: false };
  }
```

调用点：

```js
    var body = projectText(doc);
    out.text = body.text;
    out.textFiltered = body.filtered;
```

（`includeHidden` 时 `filtered: true` 表达的是"这一份文本与开关一致"，`format.ts` 只在 `false` 时出旁注。）

- [ ] **Step 4: 改 `format.ts`**

```ts
/**
 * `include_hidden` 与 Raw text 的关系说明。
 *
 * **只在"没过滤成"时出现**：默认路径走 `innerText`（浏览器自己的可见性感知 API），
 * 隐藏内容本来就不在里面，说一句只是噪音；只有拿不到 `innerText` 而退回 `textContent` 的
 * 那份结果才需要承认"这一份没过滤"（不静默降级，同 `hiddenSkippedNote` 的纪律）。
 */
function textFilterNote(value: Record<string, unknown>): string | null {
  if (value["textFiltered"] !== false) return null;
  return (
    "NOTE: the raw text below comes from the document's text content, not its rendered text — hidden " +
    "(display:none) content may be included. This runtime could not produce rendered text."
  );
}
```

在主文档 `## Raw text` 之前、以及帧的 `#### Text` 之前各调一次（帧的那一处跟 `hiddenSkippedNote(fr.value)` 并排）。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/ src/extensions/browserTools.test.ts
```
Expected: PASS。

- [ ] **Step 6: 全量回归 + 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "fix(browser): Raw text 走 innerText（与 skeleton 同一份可见性），退化时如实标"
```

---

### Task 9: P2-4 `browser_act` 文本匹配的 CJK 空白容错

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/actions.ts`
- Modify: `agent-sidecar/src/extensions/browser/actions.test.ts`

**Interfaces:**
- Produces: `byText` / `textHits` 的匹配多比一次**去空白**形态；`labelOf` 的归一化**不动**（它的单空格折叠是渲染给模型看的形态，改了会波及索引输出）。

- [ ] **Step 1: 写失败测试**

`actions.test.ts` 补：

```ts
/**
 * EP 把双字按钮渲染成「确　定」（中间是空白）——归一化把空白折成单空格后，`确定` 既不等于
 * 也不包含它。反馈第 3 条逐字一致：真按钮**从没进过候选池**，命中的是包含"确定"的文案。
 */
describe("browser_act：CJK 空白容错", () => {
  const cases: [string, string][] = [
    ["半角空格", "确 定"],
    ["全角空格 U+3000", "确　定"],
    ["换行", "确\n定"],
  ];

  for (const [name, label] of cases) {
    it(`${name}：{text:"确定"} 命中 <button>"${label}"</button>`, () => {
      const btn = el("button", { text: label, markup: true });
      const copy = el("p", { text: "确定通过审核？" });
      const out = runResolve({ text: "确定" }, stubDom({ candidates: [btn, copy] }));
      expect(out["ok"]).toBe(true);
      expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
    });
  }

  it("调用方带空白（{text:\"确 定\"}）也命中同一个按钮", () => {
    const btn = el("button", { text: "确　定", markup: true });
    const out = runResolve({ text: "确 定" }, stubDom({ candidates: [btn] }));
    expect(out["ok"]).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
  });

  /** 「找不到」分支的候选清单也要容错，否则失败信息与匹配规则自相矛盾。 */
  it("textHits 也容错（按钮不可点时报出的候选里有它）", () => {
    const plain = el("div", { text: "确　定", cls: "plain" });
    const out = runResolve({ text: "确定" }, stubDom({ candidates: [plain], textNodes: [{ data: "确　定", parentElement: plain }] }));
    expect(out["candidatesKind"]).toBe("text-hits");
    expect(JSON.stringify(out["candidates"])).toContain("确");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd agent-sidecar && npx vitest run src/extensions/browser/actions.test.ts`，Expected: FAIL（前三条：命中的是 `<p>`）。

- [ ] **Step 3: 改 `actions.ts`**

`preamble` 里加一个纯函数（**只加在比较这一处**），并让 `byText` / `textHits` 用上：

```js
  /**
   * 「去掉所有空白」的形态 —— **只给比较用**。
   *
   * 为什么：EP 把双字按钮渲染成「确　定」（中间是空白/全角空格），而模型给的是「确定」——
   * 归一化之后既不 === 也不 indexOf。JS 的 `\s` 覆盖 U+3000（全角空格）与换行，所以这一句
   * 就够了。
   *
   * ⚠️ **不许拿它去做 labelOf 的归一化**：`labelOf` 的单空格折叠是渲染给模型看的形态，
   * 改它会波及 `browser_read` 的索引输出。
   */
  function tight(s) { return String(s == null ? '' : s).replace(/\\s+/g, ''); }
```

`byText()` 里：

```js
    var want = String(TARGET.text);
    var wantTight = tight(want);
    var exact = [], partial = [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (!visible(el)) continue;
      var t = labelOf(el);
      if (!t) continue;
      var tTight = tight(t);
      if (t === want || (wantTight && tTight === wantTight)) exact.push(el);
      else if (t.indexOf(want) >= 0 || (wantTight && tTight.indexOf(wantTight) >= 0)) partial.push(el);
    }
```

`textHits(want, cap)` 里的文本节点比对同样加一句：`var wantTight = tight(want);`，循环里
`if (!n.data || (n.data.indexOf(want) < 0 && (!wantTight || tight(n.data).indexOf(wantTight) < 0))) continue;`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/actions.test.ts
```
Expected: PASS（含新增 5 条）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "fix(browser): act 文本匹配对 CJK 空白容错（「确　定」按钮终于进候选池）"
```

---

### Task 10: P3-2 命中歧义报数（**一定要简单**）

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/actions.ts`（解析结果多带 `usedIndex`）
- Modify: `agent-sidecar/src/extensions/browser/act.ts`
- Modify: `agent-sidecar/src/extensions/browser/actions.test.ts` / `browserTools.test.ts`

**Interfaces:**
- Produces: 解析成功的结果多一个 `usedIndex`；`act.ts` 的三种动作在命中数 > 1 时追加一句 `(N elements matched; used index i)`。

- [ ] **Step 1: 写失败测试**

`browserTools.test.ts` 的 `browser_act` 组补两条：

```ts
  /** 用户明确要求：命中歧义**只报一个数字**，不列候选（browser_read 已经能列元素）。 */
  it("命中多个 → 结果里带上 (N elements matched; used index i)", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "保存", index: 1 },
      {},
    );
    reply(await waitForQuery(events, 0),
      evalOk({ ok: true, hit: { tag: "button", text: "保存" }, x: 10, y: 20, matched: 3, usedIndex: 1 }));
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });   // mousePressed
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } });   // mouseReleased

    const text = (await p).content[0].text;
    expect(text).toContain("via CDP");
    expect(text).toContain("(3 elements matched; used index 1)");
  });

  it("只命中一个 → 不报数（不制造噪音）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler({ action: "click", text: "刷新" }, {});
    reply(await waitForQuery(events, 0), RESOLVED);   // RESOLVED 没有 matched 字段
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } });

    const text = (await p).content[0].text;
    expect(text).not.toContain("elements matched");
  });
```

`actions.test.ts` 补一条（解析脚本自己要把**钳制后**的序号带出来）：

```ts
  it("解析结果带出 usedIndex，且是 Math.min 钳制之后的值", () => {
    const a = el("div", { text: "保存", cursor: "pointer" });
    const b = el("div", { text: "保存", cursor: "pointer" });
    const out = runResolve({ text: "保存", index: 9 }, stubDom({ candidates: [a, b] }));
    expect(out["ok"]).toBe(true);
    expect(out["matched"]).toBe(2);
    expect(out["usedIndex"]).toBe(1);   // 请求 index 9 → 钳到最后一个，**且要说出来**
  });
```

- [ ] **Step 2: 跑测试确认失败** → `cd agent-sidecar && npx vitest run src/extensions/browserTools.test.ts src/extensions/browser/actions.test.ts`，Expected: FAIL。

- [ ] **Step 3: 改代码**

`actions.ts` 的两个解析函数把**钳制后的序号**一并带出（两处同形，别只改一处）：

```js
  // bySelector 的尾部（原为 return { el: pool[Math.min(...)], count: pool.length };）
    if (!pool.length) return { error: 'selector matched nothing: ' + TARGET.selector };
    var used = Math.min(TARGET.index || 0, pool.length - 1);
    return { el: pool[used], count: pool.length, used: used };
```
```js
  // byText 的尾部（同上；`pool` 此时已被 landable 滤过并排过序）
    var used = Math.min(TARGET.index || 0, pool.length - 1);
    return { el: pool[used], count: pool.length, used: used };
```

`buildResolveScript` 把它透出（`failure(...)` 那条路不带，失败文案本来就另有一套）：

```js
    return {
      ok: true,
      hit: describe(el),
      matched: r.count,
      usedIndex: r.used,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
```

`act.ts` 加一个三行的助手，并在 click / fill / hover 三处结果里拼接：

```ts
/**
 * 命中多个时的一句脚注。**只报数字**（用户明确要求"一定要简单"）——`browser_read` 已经能列元素。
 *
 * `index` 越界会被解析脚本钳制（`Math.min`），钳制**要说**：`used index 1` 就是那个交代。
 */
function matchNote(v: Record<string, unknown>): string {
  const n = Number(v["matched"]);
  if (!Number.isFinite(n) || n <= 1) return "";
  const used = Number(v["usedIndex"]);
  return ` (${n} elements matched; used index ${Number.isFinite(used) ? used : 0})`;
}
```

拼接（三处同形，注意把原来的句尾句号挪到脚注之后）：

```ts
  if (viaCdp.ok) {
    return `Clicked ${hit} with a real mouse event via CDP at (${x}, ${y})${matchNote(v)}.`;
  }
```
（`fill` / `hover` 同理；`fill` 的兜底行与 `hover` 的返回值也要带上。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browser/actions.test.ts src/extensions/browserTools.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "feat(browser): act 命中歧义如实报数（'N elements matched; used index i'）"
```

---

### Task 11: P3-1 元素级截图

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/actions.ts`（`buildResolveScript` 支持不滚动 + 带回页面坐标矩形）
- Modify: `agent-sidecar/src/extensions/browser/screenshot.ts`（`clip`）
- Modify: `agent-sidecar/src/extensions/browserTools.ts` + `browserTools.test.ts` + `browserMcp.ts`（**描述变了就要动 INSTRUCTIONS 与快照**）
- Modify: `agent-sidecar/src/extensions/browser/act.ts`（导出 `describeResolveFailure` 供复用）

**Interfaces:**
- Produces: `buildResolveScript(target, opts?: { scroll?: boolean })`（缺省 `scroll: true` = 既有行为），成功结果多 `rect: {x, y, w, h}`（**页面坐标**，含滚动偏移）；`captureScreenshot(viewId, opts: { fullPage; format; clip? }, emit)`；`browser_screenshot` 新增 `text?` / `selector?`（二选一）。

- [ ] **Step 1: 写失败测试**

`browserTools.test.ts` 的截图组补：

```ts
  it("给了 text → 先解析元素，再按它的矩形裁剪截图（clip 是页面坐标 + scale 1）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ text: "保存" }, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: true, hit: { tag: "button", text: "保存" }, rect: { x: 40, y: 120, w: 88, h: 32 }, matched: 1, usedIndex: 0 }));
    reply(await waitForQuery(events, 1), { ok: true, data: { value: { data: "QUJD" } } });

    const shot = events[1] as any;
    expect(shot.method).toBe("Page.captureScreenshot");
    expect(shot.params.clip).toEqual({ x: 40, y: 120, width: 88, height: 32, scale: 1 });
    expect(shot.params.captureBeyondViewport).toBe(true);
    expect((await p).content[1].type).toBe("image");
  });

  it("元素找不到 / 零尺寸 → **如实失败，不退化成整页截图**", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ text: "没有这个" }, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: false, error: 'no element on the page contains that text "没有这个"' }));
    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("Could not find the target");
    expect(events).toHaveLength(1);          // 关键：**没有再发一次整页截图**
  });
```

- [ ] **Step 2: 跑测试确认失败** → Expected: FAIL。

- [ ] **Step 3: 改 `actions.ts`**

`buildResolveScript` 签名与负载：

```ts
/**
 * 解析目标并**算好屏幕坐标**（点击用）与**页面坐标矩形**（截图裁剪用）。
 *
 * `opts.scroll` 缺省 true（点击必须滚进视口；`smooth` 是动画，同一次脚本里读到的 rect 会是
 * 滚动前的旧值，所以必须 `instant`）。截图时传 `false`——**别动用户正在看的滚动位置**，
 * 裁剪靠 CDP 的 `captureBeyondViewport`。
 */
export function buildResolveScript(target: ActTarget, opts: { scroll?: boolean } = {}): string {
```
```js
    var r = resolve();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    var SCROLL = ${opts.scroll === false ? "false" : "true"};
    if (SCROLL) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
      catch (e) { el.scrollIntoView(); }
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { ok: false, error: 'matched element has zero size (hidden or not laid out)', hit: describe(el) };
    }
    // 截图裁剪要**页面坐标**（`Page.captureScreenshot` 的 clip 相对文档原点，不是视口）
    var sx = window.pageXOffset || document.documentElement.scrollLeft || 0;
    var sy = window.pageYOffset || document.documentElement.scrollTop || 0;
    return {
      ok: true,
      hit: describe(el),
      matched: r.count,
      usedIndex: r.used,
      rect: { x: Math.round(rect.left + sx), y: Math.round(rect.top + sy),
              w: Math.round(rect.width), h: Math.round(rect.height) },
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
```

`act.ts`：把 `describeResolveFailure` 改成 `export`（截图复用同一份"找不到"文案，**不写第二份**）。

- [ ] **Step 4: 改 `screenshot.ts`**

```ts
export interface ScreenshotClip { x: number; y: number; width: number; height: number }

export async function captureScreenshot(
  viewId: string | undefined,
  opts: { fullPage: boolean; format: ScreenshotFormat; clip?: ScreenshotClip },
  emit: (e: ChatEvent) => void,
): Promise<ScreenshotOutcome> {
  const params: Record<string, unknown> = { format: opts.format };
  if (opts.format === "jpeg") params["quality"] = JPEG_QUALITY;
  if (opts.clip) {
    params["clip"] = { ...opts.clip, scale: 1 };
    // 元素在视口外时，不带这个开关会得到一张空白裁剪——而"只截这个按钮"恰恰常在滚动之外。
    params["captureBeyondViewport"] = true;
  } else if (opts.fullPage) {
    params["captureBeyondViewport"] = true;
  }
  …
}
```

- [ ] **Step 5: 改 `browserTools.ts`**

截图工具加两个参数与一段分支：

```ts
      text: z.string().optional().describe(
        "Crop the shot to this element's box, matched by its visible label (e.g. the 保存 button). " +
          "Use this instead of a full screenshot when you only need one control.",
      ),
      selector: z.string().optional().describe("Crop to the element matching this CSS selector. Takes precedence over `text`."),
```

新函数（同文件底部，三行职责：解析 → 报错 → 给 clip）：

```ts
/**
 * 元素截图的目标：**判别式联合**，不是可选字段——可选字段会让"解析失败"与"没给 text"
 * 在类型上长得一样（本项目禁 `boolean | undefined` 假三态的同一款理由）。
 */
type ShotTarget =
  | { ok: true; clip: ScreenshotClip; hit: string }
  | { ok: false; error: string };

/**
 * 元素截图的坐标解析：复用 `browser_act` 的解析脚本（**不写第二份元素定位**——
 * 判据分家正是 f0104d22 刚治过的病），取它的页面坐标矩形当 CDP 的 `clip`。
 *
 * 找不到 / 零尺寸 → **如实失败**，**不退化成整页截图**：反馈明确说整页截图因上下文成本全程
 * 没用，退化会让模型以为拿到了局部。`scroll:false` 是为了**别动用户正在看的滚动位置**。
 */
async function resolveShotTarget(
  args: { view_id?: string; text?: string; selector?: string },
  emit: (e: ChatEvent) => void,
): Promise<ShotTarget> {
  const target: ActTarget = { selector: args.selector, text: args.text };
  const r = await runEval(buildResolveScript(target, { scroll: false }), { viewId: args.view_id }, emit);
  if (!r.ok) return { ok: false, error: r.error };

  const v = asRecord(r.value) ?? {};
  if (v["ok"] !== true) return { ok: false, error: describeResolveFailure(v) };

  const rect = asRecord(v["rect"]);
  const clip = {
    x: Number(rect?.["x"]), y: Number(rect?.["y"]),
    width: Number(rect?.["w"]), height: Number(rect?.["h"]),
  };
  if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width < 1 || clip.height < 1) {
    return { ok: false, error: `Resolved the element but got no usable box to crop (${JSON.stringify(rect)}) — it may be zero-size.` };
  }
  return { ok: true, clip, hit: String(asRecord(v["hit"])?.["text"] ?? "the element") };
}
```

handler 里改成：

```ts
        const fullPage = args.full_page === true;
        const format = args.format === "png" ? "png" : "jpeg";
        const target = args.text || args.selector ? await resolveShotTarget(args, emit) : null;
        if (target && !target.ok) return textResult(target.error);

        const shot = await captureScreenshot(
          args.view_id,
          { fullPage, format, clip: target?.ok === true ? target.clip : undefined },
          emit,
        );
        if (!shot.ok || !shot.data) return textResult(shot.error ?? "Screenshot failed.");
        return {
          content: [
            { type: "text" as const, text: screenshotCaption({ fullPage, format, element: target?.ok === true ? target.hit : undefined }) },
            { type: "image" as const, data: shot.data, mimeType: shot.mimeType ?? `image/${format}` },
          ],
        };
```

`screenshotCaption` 加一个可省字段（裁剪时说明这是**元素的裁剪**，不是整页）：

```ts
function screenshotCaption(opts: { fullPage: boolean; format: ScreenshotFormat; element?: string }): string {
  const what = opts.element ? `of ${opts.element}` : opts.fullPage ? "page (full)" : "visible viewport";
  return (
    `Screenshot ${what} in the embedded browser as ${opts.format.toUpperCase()}. ` +
    `Reminder: this is the visual fallback — use browser_read / browser_eval when the question is ` +
    `about content or structure.`
  );
}
```

`browserTools.ts` 的 import 相应加 `buildResolveScript` / `describeResolveFailure` / `type ScreenshotClip`。`describeResolveFailure` 由 `act.ts` 导出（Step 3 已交代）。

**同时**：`browser_screenshot` 的描述变了 → 若 `BROWSER_INSTRUCTIONS` 第 7 条需要提一句"可以只截一个元素"，就补；**快照必须 `-u`**（`browserMcp.test.ts`）。

- [ ] **Step 6: 跑测试确认通过**

```bash
cd agent-sidecar && npx vitest run src/extensions/browserTools.test.ts src/extensions/browserMcp.test.ts -u
```
Expected: PASS。

- [ ] **Step 7: 全量回归 + 提交**

```bash
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "feat(browser): 元素级截图（browser_screenshot 的 text/selector → CDP clip）"
```

---

### Task 12: 真机验收清单

**Files:**
- Create: `docs/browser-observability-test-checklist.md`

**Interfaces:**
- Consumes: Task 1 的夹具页/服务、Task 2 的探针结论、Task 3–11 的全部能力。

- [ ] **Step 1: 写清单**

照 `docs/browser-parking-test-checklist.md` 的形制（前置 / 判据表 / 机器可判定的断言）。前置必须包含：

```bash
pnpm build:sidecar            # dev 实例：sidecar → agent-sidecar/dist/
node scripts/diag/serve-browser-fixture.mjs
curl -s http://127.0.0.1:8780/ | grep -c HIDDENMAGIC    # 期望 1（0 = 端口上蹲着别的服务或夹具是旧的）
```
以及**新构建判据**：让 agent 跑 `browser_tabs`，输出里应有 `parked` 用词；跑 `browser_network` 应能回包而不是"unknown op"。

判据表（**逐条对应 spec §12 的真机验收表**，把每条的调用序列写全）：

| # | 判据 | 调用 | 期望 |
|---|---|---|---|
| 1 | 加载期请求可见 | `browser_network`（装探针）→ `browser_tab navigate` 到夹具 → `browser_network` | 能看到**加载期**那两条（`/api/ok` 各一条 fetch + XHR） |
| 2 | 失败可诊断 | 先 `browser_eval {script:'__probe("fail")'}` → `browser_network {filter:"/api/fail"}` | 报 500 + `No enum constant …` 片段 |
| 3 | 未结束可辨 | `browser_eval {script:'__probe("hang"); "fired"'}`（**别只写 `__probe("hang")`**——eval 会 await 它到 15s 超时）→ `browser_network` | `(pending, …ms so far)` |
| 4 | 体积闸门 | `browser_eval {script:'__probe("big")'}` → `browser_network {filter:"/api/big"}` | `body skipped (307220 bytes)`，不是 300KB 正文（夹具现在显式发 `content-length`，数字是定值） |
| 5 | 控制台吞错可查 | 点 `#btn-throw` → `browser_console` | `[uncaught]` 一条，且与 `[error]` 分行 |
| 6 | 未装的如实说明 | **新开视图**后第一次 `browser_console` | 明说"探针是这次调用才装上的" |
| 7 | navigate 落点 | `browser_tab navigate` 到 `#/two`（守卫会弹回） | **不报假成功**：报出文档实际在 `#/one` |
| 8 | 同文档导航提示 | `browser_wait until:"load"` 紧跟一次 hash 导航 | 文案里带 `SAME-DOCUMENT` |
| 9 | wait 实测耗时 | `browser_wait` 一次立刻成立的条件（interval 200） | 括号里的毫秒数**远小于** 200 |
| 10 | Raw text 过滤 | `browser_read` | `HIDDENMAGIC` **不出现**在 `## Raw text`；skeleton 照旧 |
| 11 | CJK 空白 | `browser_act {text:"确定", action:"click"}` | 命中 `<button>确　定</button>`（`#cjk-ok`），不报"不像可点击" |
| 12 | 歧义报数 | `browser_act {selector:".same", action:"click"}` | 带 `(2 elements matched; used index 0)`（**隐藏的那个不进池**），点到 `#same-a` |
| 13 | 元素截图 | `browser_screenshot {selector:"#cjk-ok"}` | 只截到那个按钮 |
| 14 | 元素截图失败不退化 | `browser_screenshot {text:"不存在的按钮"}` | 回"找不到"，**不**回整页图 |

- [ ] **Step 2: 跑一轮并把结论回写**

清单里留「验收台账」区（每条的实测输出片段 + PASS/FAIL），照 parking 清单的做法，**跑完当天回写**（`2af88a35` 的先例：验收结论写回文档、spec 状态跟着改）。

- [ ] **Step 3: 回写 spec 状态**

`docs/superpowers/specs/2026-09-22-browser-observability-design.md` 头部状态行改为「已实现并真机验收通过（N/N）」；第 16 节未决问题里补：`frame` 参数为何不做（隔离世界观察不到主世界，见本计划「四处修正」1）；Raw text 为何用布尔旁注而非计数（同 2）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs(browser): 可观测层真机验收清单 + 首轮台账（N/N）"
```

---

### Task 13（**条件任务**：仅当 Task 2 的探针 1 回"CDP 路不通"）

**Files:**
- Modify: `src-tauri/src/browser/adapter/webview2/native.rs`（**全仓唯一**允许 `use webview2_com` 的文件）
- Modify: `src-tauri/src/browser/adapter/webview2/mod.rs` / `adapter/unsupported.rs` / `port/engine.rs`
- Modify: `src-tauri/src/browser/facade.rs`
- Modify: `src-tauri/src/browser/agent_bridge.rs` + `src-tauri/src/runtime/browser_agent.rs`
- Modify: `agent-sidecar/src/extensions/browserClient.ts` + `browser/recorder.ts`

**Interfaces:**
- Produces: 新 op `init_script`（`{op:"init_script", view_id?, script}`）；recorder 的 `ensureRegistered` 在这一条路上改调它（**只有一个接缝**，其余代码一行不动）。

- [ ] **Step 1: native.rs 加一个下钻函数**

```rust
/// 给**后续所有文档**注入启动脚本（WebView2 `AddScriptToExecuteOnDocumentCreated`）。
///
/// 与 `call_cdp` 的 `Page.addScriptToEvaluateOnNewDocument` 是同一件事的两条路：那条走 CDP
/// （运行期可用性随 WebView2 版本变），这条是**宿主 API**，`ICoreWebView2` 上就有
/// （`webview2-com-sys-0.38.2/src/bindings.rs:1325`）。步骤 0 探针证明 CDP 路不通时才落到这里。
pub fn add_init_script(wv: &Webview<Wry>, script: &str) -> Result<serde_json::Value, EngineError> {
    let script = script.to_string();
    drill(wv, EngineError::EvalFailed, move |core, tx| {
        let tx_handler = tx.clone();
        let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(
            move |result, id| {
                let _ = tx_handler.send(match result {
                    Ok(()) => Ok(match id {
                        Some(id) => format!("{{\"identifier\":\"{}\"}}", id.to_string()),
                        None => "{}".to_string(),
                    }),
                    Err(e) => Err(format!("AddScriptToExecuteOnDocumentCreated: {e}")),
                });
                Ok(())
            },
        ));
        let js = wide(&script);
        if let Err(e) = unsafe { core.AddScriptToExecuteOnDocumentCreated(PCWSTR::from_raw(js.as_ptr()), &handler) } {
            let _ = tx.send(Err(format!("AddScriptToExecuteOnDocumentCreated call: {e}")));
        }
    })
}
```
（import 那一行加 `AddScriptToExecuteOnDocumentCreatedCompletedHandler`；`HSTRING` 转 String 的写法按 `webview2_com` 版本对齐——本仓 `Cargo.lock` 是 0.38.2。）

- [ ] **Step 2: 端口 → 适配器 → 门面 → 桥 → 执行体**

逐层加 `fn add_init_script(&self, id: &BrowserViewId, script: &str) -> Result<serde_json::Value, EngineError>`（`unsupported.rs` 里同样加一个"本平台不支持"的实现，保持 trait 完整），门面加 `pub fn add_init_script(&self, id_raw: &str, script: &str) -> Result<(), FacadeError>`，`agent_bridge.rs` 的 `parse_query` 加 `"init_script" => …`，`browser_agent.rs` 的 `exec` 加一支。

- [ ] **Step 3: sidecar 侧只改一个接缝**

`browserClient.ts` 的 `BrowserCall` 联合加 `| { op: "init_script"; view_id?: string; script: string }`；`recorder.ts` 的 `ensureRegistered` 里 `queryBrowser({op:"call_cdp", …})` 换成 `queryBrowser({op:"init_script", view_id: viewId, script: RECORDER_SOURCE})`（错误分支保持同形）。

- [ ] **Step 4: 验证 + 提交**

```bash
cd src-tauri && cargo test --lib browser:: 2>&1 | tail -5
cd .. && pnpm test -- --run 2>&1 | tail -5
git add -A && git commit -m "feat(browser): 注入走宿主 API（CDP 路在真机上不可用时的兜底）"
```
然后回到 Task 3 Step 3 / Task 12 的判据 1 复验。

---

## 步骤 0 实测结果（2026-09-23，dev 实例真机）

**探针 1（注入路）：CDP `Page.addScriptToEvaluateOnNewDocument` —— 被接受，但不交货。** ⇒ **走兜底（Task 13，Rust 宿主 API）**。

证据链（全部是工具返回原文，不是转述）：

1. `browser_tab {action:"open", url:"…:8780/", label:"gate"}` → `browser-1`
2. `browser_network {view_id:"browser-1"}`（该视图第一次 recorder 调用）→
   `Network requests (last 0 of 0, newest last):` + `No requests recorded yet.` +
   `NOTE: the recorder was armed in this document by this call, …` —— **没有** `could not be registered` 那句
   ⇒ 注册这一步在桥上是 **ok**（`resp.ok:true` 且无方法级 error），即 WebView2 **收下了**这个方法。
3. `browser_tab {action:"navigate", view_id:"browser-1", url:"…:8780/?gate=1"}` →
   `Navigated view browser-1 "gate" http://127.0.0.1:8780/?gate=1 — the document confirms it is at http://127.0.0.1:8780/?gate=1.`
   （顺带：**落点一致分支** ⇒ 普通跨文档导航对得上，`NAV_SETTLE_MS = 250` **够用**。）
4. 等 1 秒后 `browser_network {view_id:"browser-1"}` → **又是空表 + 又是那句 "armed … by this call"**。
5. 决定性的一发（`browser_eval` **不会**顺手补装探针）：再 `navigate` 到 `?gate=2`，然后
   `browser_eval {script:"({ hasRec: !!window.__aideRec, href: location.href, to: performance.timeOrigin })"}` →
   `{ "hasRec": false, "href": "http://127.0.0.1:8780/?gate=2", "to": 1790138965492.8 }`

⇒ 新文档里**没有** `window.__aideRec` ⇒ 注册的脚本从未在新文档执行。判定：**注册被接受但没交货**（门禁表第三行）。

**探针 3（`innerText` 三值）：PASS，走 (a) 是正确的。** `browser_eval {script:"window.__expect()"}` 在真机 parked 视图上回
`{ hiddenMagicVisible: false, hiddenMagicInText: true, hiddenMagicInClone: true }` —— 页面自己的 `innerText`
**确实**把隐藏的 `HIDDENMAGIC` 滤掉了，而 DOM 里确实有这个字符串（否则这条判据是空的），
游离 clone 上的 `innerText` **确实**退化成 `textContent` 语义（陷阱坐实）。配套的 `browser_read` 也验了：
`## Raw text` 里没有 `HIDDENMAGIC`，隐藏区那句"隐藏的日历 1308 208 407"同样不在，NOTE 逐字符合，`#same-c` 没进可点清单。
⇒ 不需要退回剪枝路（b）。

**探针 4（往返代价 → `NAV_SETTLE_MS`）：250ms 够用。** 普通跨文档导航（`?plain=1`、`?plain=2`、`?gate=1`、`?t=1`）
**每一次**都走"落点一致"分支，没有一次误报不符 ⇒ 不需要调大。

**顺带实证的两条（原属"按构造未验"，现已量到）**：

- **CDP `Page.captureScreenshot` 的 `clip` 确为文档坐标**：造一个 `scrollY=1500` 的长页，把元素放在视口外
  （视口内 `top=1567` ⇒ 页面坐标 3067），裁出来**正是那个元素**（绿色 `STATICMARK`）。
- **滚动页上的 `position: fixed` 元素也裁对了**（红色 `FIXEDMARK`）——这**证伪**了终审给的修法
  （"检测 fixed 就不加滚动偏移"）：真按它改，这一格反而会坏。当时拒绝在未验证的运行时模型上改已上线逻辑是对的。

**结论**：注入路改走 Rust 宿主 API `AddScriptToExecuteOnDocumentCreated`（计划 Task 13），落地后**必须重跑**验收清单。
在此之前，判据 1–16 都不作数——那验的是"懒装"，而懒装恰好漏掉本批最想要的加载期请求。

---

## 自检（写完计划后对 spec 的覆盖核对）

| spec 条目 | 落在哪个任务 |
|---|---|
| P0 注入点（文档创建那一刻） | Task 2（定路）→ Task 3 |
| P1 `browser_network` | Task 4 |
| P1 `browser_console` | Task 5 |
| P2-1 navigate 观测落点 + 同文档导航文案 | Task 6 |
| P2-2 wait 文档身份 + 真实耗时 | Task 7 |
| P2-3 Raw text 过可见性 | Task 8 |
| P2-4 CJK 空白容错 | Task 9 |
| P3-1 元素级截图 | Task 11 |
| P3-2 命中歧义报数 | Task 10 |
| 体积闸门（risk 2，P1 就要做） | Task 3（源码内） |
| 降级与错误处理（spec §11） | Task 3（装不上 / 注册失败）、Task 4（两种空）、Task 5（两种空）、Task 4/5（headless 短路，已由既有用例覆盖） |
| 单测（spec §12） | 各任务自带；`browserMcp.test.ts.snap` 在 Task 4/5/11 |
| 成本量尺 + 预算红线 | Task 5 Step 6 |
| 真机验收（spec 的 10 条 → 拆成 14 条可机器判定的断言）+ 夹具页 | Task 1 + Task 12 |
| 兜底注入路（risk 1） | Task 13（条件） |
| `schemaChars()` 修正 | Task 5 Step 6 |
| 未决问题（frame 不做 / 请求体不做 / sessionStorage 不做 / 页面自己包装 console） | 见「四处修正」1 与 Task 12 Step 3 的回写 |
