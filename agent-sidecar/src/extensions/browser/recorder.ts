/**
 * 页面内 recorder：**源码字符串**（唯一事实源）+ 装/读编排。
 *
 * # 为什么是"文档创建那一刻"装（懒装就白做了）
 *
 * 本批最值钱的场景是「页面打开就是空白，其实是后端返回了 `No enum constant …`」——那是
 * **页面加载期**自己的 XHR。等工具被调用才注入探针，恰好漏掉它，等于把最想要的场景做没了。
 * 所以注入走宿主 API `init_script` 那条 op（Rust 侧落到 WebView2
 * `AddScriptToExecuteOnDocumentCreated`：注册一次，之后**每份新文档**在页面脚本之前被装上），
 * 当前文档用一次普通求值补上。
 *
 * ⚠️ **不要**退回 CDP 的 `Page.addScriptToEvaluateOnNewDocument`：本机 WebView2（Evergreen）
 * 收下这个方法**却不执行**注册的脚本——新文档里探针不存在，回包也没有任何错误。失败是**静默**的，
 * 所以"先用 CDP、出错再退宿主 API"这种链永远退不了（2026-09-23 真机三向取证，见 Task 13）。
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
 * 4. **如实标截断**：`bodyCut` / `bodyLen` / `bodyNote: 'body skipped (N bytes)'` 都要带出来
 *    （另一种 skip 形态是事件流：`bodyNote: 'body skipped (event stream)'`）。
 *    ⚠️ skip 是**非错误的事实**，所以它有自己的字段：`err` 只留"这条请求真的失败了"
 *    （`'body unreadable'` / fetch 抛出的错误 / 拒绝的原因）。混进 `err` 会让读脚本的
 *    失败计数把一条 200 算成失败——摘要行（agent 最先看的那行）就在最要紧的路径上撒谎。
 *
 * # 这一层不认识"页面语义"
 *
 * 它只搬运 `reqs[]` / `logs[]` 两个数组。读脚本确实会数出 `failed {n, first}`——但那是**计数**：
 * 在**匹配序列**上数已结束且 `status >= 400` 或 `err` 非空的条目（见 `buildRecorderReadScript`），
 * 分母/措辞/前置与否一概不管，那是 `network.ts` / `console.ts` 的事（分母同口径这条纪律就落在
 * 渲染器那边）。这样换一个渲染口径不需要碰注入源码。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { asRecord, formatBridgeFailure } from "./format.js";
import { runEval } from "./runEval.js";

/** 环形缓冲的条目上限。 */
export const RECORDER_CAP = 100;
/** 单条文本（响应体片段 / console 行）的字符上限。 */
export const RECORDER_TEXT_CAP = 300;
/**
 * 读体闸门：`content-length` 超过它就整段跳过（`res.clone().text()` 会把整份体复制进内存）。
 *
 * 它是**有界**这一条的一半：没有 `content-length` 的响应（chunked / 流式）它看不到尺寸，
 * 所以事件流另有一条按 `content-type` 判的 skip（那种体根本没有长度，见 fetch 分支）。
 */
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
                  t: t0, status: null, ms: null, body: null, bodyCut: false, bodyLen: 0,
                  err: null, bodyNote: null, done: false };
      push(R.reqs, rec);
      return of.apply(this, arguments).then(function (res) {
        rec.status = res.status; rec.ms = now() - t0;
        var len = null, ctype = null;
        try {
          if (res.headers && res.headers.get) {
            len = res.headers.get('content-length'); ctype = res.headers.get('content-type');
          }
        } catch (e) { len = null; ctype = null; }
        var big = gate(len);
        if (big !== null) { rec.bodyNote = 'body skipped (' + big + ' bytes)'; rec.done = true; }
        else if (String(ctype || '').indexOf('event-stream') >= 0) {
          // 事件流**永不结束**：克隆一份读体等于把整条流一路攒在页面内存里（本产品自己的
          // API 就是这个形状）。读不了就如实标不读，别把"没读"伪装成"没有正文"。
          // 只有 fetch 这一路需要它：XHR 的响应体由浏览器自己收，我们读的只是它收完的那份。
          rec.bodyNote = 'body skipped (event stream)'; rec.done = true;
        } else {
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
                  t: t0, status: null, ms: null, body: null, bodyCut: false, bodyLen: 0,
                  err: null, bodyNote: null, done: false };
      push(R.reqs, rec);
      x.addEventListener('loadend', function () {
        rec.status = x.status; rec.ms = now() - t0;
        var len = null;
        try { len = x.getResponseHeader && x.getResponseHeader('content-length'); } catch (e) { len = null; }
        var big = gate(len);
        if (big !== null) { rec.bodyNote = 'body skipped (' + big + ' bytes)'; }
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

/**
 * `limit` 是模型给的自由数字，**必须先夹**：`JSON.stringify(Infinity)` 是 `null`，页面侧
 * `matched.slice(Math.max(0, matched.length - null))` 会退化成 `slice(len)` ⇒ 回 `items: []`
 * 而 `matched` 仍报 N——正是本批最恨的「空 ≠ 没有」，而且发生在最要紧的那一处。
 *
 * 夹进 `[0, RECORDER_CAP]`：缓冲本身最多就 cap 条，所以"要全部"就是 cap，代价有界。
 * `±Infinity` 由 min/max 自然收进区间；`NaN` 得单独定——`Math.min/max` 会把它一路透传成
 * `NaN`，而**非有限值在这条线上都是 `null`**（`JSON.stringify(NaN)` 同样是 `null`），
 * 不处理就回到上面那个空表。一个解释不了的数按"要全部"算。
 */
function clampLimit(limit: number): number {
  if (Number.isNaN(limit)) return RECORDER_CAP;
  return Math.min(RECORDER_CAP, Math.max(0, Math.floor(limit)));
}

/**
 * 读脚本：先确保本文档装上（幂等），再按筛选与条数上限取回。
 *
 * `armedBefore` 是这次调用的关键信息：false = 探针是**这次**才装上的，这之前的请求看不到。
 * 不报它，模型会把"空"读成"没发请求"（v2 立下的「空 ≠ 没有」纪律同款）。
 *
 * 筛选与截断都在**页面侧**做完：缓冲里最多 100 条 × 300 字符，全量搬回来再筛是白白多喂上下文。
 */
export function buildRecorderReadScript(opts: RecorderReadOptions): string {
  return `(() => {
  'use strict';
  var BEFORE = !!window.__aideRec;
  var ARMED = ${RECORDER_SOURCE};
  var R = window.__aideRec;
  if (!R) return { ok: false, error: 'the recorder could not be armed in this document: ' + ARMED };
  var KIND = ${JSON.stringify(opts.kind)};
  var LIMIT = ${JSON.stringify(clampLimit(opts.limit))};
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
      // 只数**真失败**：状态码 >= 400，或 err 非空（err 只装真错误）。**别把 bodyNote 加进来**
      // ——"我没读体"是关于读取的事实，不是这条请求的结局；算进来就会把 200 报成失败。
      var bad = e2.done === true && ((typeof e2.status === 'number' && e2.status >= 400) || !!e2.err);
      if (bad) { failed += 1; if (firstFailed === null) firstFailed = j + 1; }
    }
  }

  var items = matched.slice(Math.max(0, matched.length - LIMIT)).map(function (e) {
    if (KIND === 'reqs') {
      return { kind: e.kind, method: e.method, url: e.url, status: e.status, done: e.done === true,
               ms: e.done === true ? e.ms : (nowMs - e.t), body: e.body, bodyCut: e.bodyCut === true,
               bodyLen: e.bodyLen, err: e.err, bodyNote: e.bodyNote };
    }
    return { lvl: e.lvl, t: e.t, text: e.text, cut: e.cut === true, len: e.len };
  });

  return { ok: true, armedBefore: BEFORE, cap: R.cap, total: all.length, matched: matched.length,
           failed: { n: failed, first: firstFailed }, items: items };
})()`;
}

/** 显式 `view_id` 的注册记账 —— **每个视图只注册一次**（注册是累积的，重发 N 次就让每份新文档
 *  跑 N 遍 no-op IIFE）。显式 id 是**确切的**，没有陈旧的可能，所以进了就永久留着。 */
const registeredViews = new Set<string>();

/**
 * 缺省 `view_id` 时 Rust 解析回来的真实 id —— **刻意不进 `registeredViews`**。
 *
 * 它只是"上次解析落在哪个视图"的缓存，视图被**换掉**（关掉再开、仍只有一个）之后就陈旧，
 * 而那时 guard 会误判成"已注册"：新视图的**加载期请求**——本批的旗舰场景——就一条都收不到。
 * 所以它必须**可丢**，丢弃的信号在 `readRecorder` 里（`armedBefore === false`：刚读的这份
 * 文档压根没在创建时装上 ⇒ 缓存没在兑现）。丢掉后下一次调用真的重注册，再往后新文档就都
 * 装上了——自愈，且 happy path 上不多一次往返。
 */
let cachedResolvedId: string | undefined;

/**
 * 记账：这个视图的启动脚本**已经在创建时注册过**了——`browser_tab` 的 `open` 会把
 * `RECORDER_SOURCE` 放进载荷，Rust 侧注册在首次导航之前（见 `CreateCfg::init_script`）。
 * 不记这一笔，第一次 `browser_network` 会再补发一遍注册（白跑一趟，且每份新文档多跑一遍脚本）。
 */
export function noteRecorderRegistered(viewId: string): void {
  registeredViews.add(viewId);
}

/**
 * 给**未来的文档**装上（`init_script` op：Rust 侧落到 WebView2 宿主 API
 * `AddScriptToExecuteOnDocumentCreated`）。注册挂在视图上，故同一视图只发一次；
 * 失败**如实带出**，不吞。
 *
 * 这一处是**唯一的注入接缝**。⚠️ 别用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 换掉它：
 * 那条路在本机 WebView2 上被接受却**不交货**（静默失败，`ok:true` 也说明不了脚本真跑过），
 * 拿它当"先试这个、出错再退"的头一环是无效的——它不会出错。
 *
 * 失败只有 `ok:false` 一种来源：宿主 API 的 HRESULT 走 completed handler 回来，Rust 折成
 * 错误文本（见 `native.rs` 的 `add_init_script`），这里**不用**再看方法级错误字段。
 *
 * `registeredNow` = 这一次**真的发了**注册（false = 命中记账、复用了先前的注册）。调用方
 * 靠它决定"这份文档没装上"该记在谁头上：**复用**了记账却照样没装上，才说明记账失效了。
 */
async function ensureRegistered(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true; registeredNow: boolean } | { ok: false; error: string }> {
  const key = viewId ?? cachedResolvedId;
  // `key === cachedResolvedId`：缺省 view_id 时，缓存**本身就是**"已注册过"的凭据
  // （它不在 `registeredViews` 里——它可能陈旧，见上）。
  if (key && (key === cachedResolvedId || registeredViews.has(key))) {
    return { ok: true, registeredNow: false };
  }

  const resp = await queryBrowser(
    { op: "init_script", view_id: viewId, script: RECORDER_SOURCE },
    emit,
  );
  if (!resp.ok) return { ok: false, error: formatBridgeFailure(resp) };

  // 记账用 Rust 解析回来的**真实 id**（调用方可能省略 view_id）——省了它下次还会重发一遍。
  // 显式的进永久记账（确切）；缺省的只进缓存（可能是陈旧的落点，故可丢）。
  const id = asRecord(resp.data)?.["view_id"];
  if (typeof id === "string") {
    if (viewId) registeredViews.add(id);
    else cachedResolvedId = id;
  } else if (viewId) registeredViews.add(viewId);
  return { ok: true, registeredNow: true };
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
    return {
      ok: false,
      error: String(value?.["error"] ?? "the recorder read script returned no usable value"),
    };
  }
  // 缓存自愈：**复用**了记账（这次没重发注册）却读到一份没在创建时装上的文档 ⇒ 缓存指向的
  // 视图已经不是当前这个了。丢掉它，下一次调用真的重注册；本次不重发——读已经做完了。
  if (reg.ok && !reg.registeredNow && viewId === undefined && value["armedBefore"] === false) {
    cachedResolvedId = undefined;
  }
  return reg.ok
    ? { ok: true, value, registered: true }
    : { ok: true, value, registered: false, registerError: reg.error };
}
