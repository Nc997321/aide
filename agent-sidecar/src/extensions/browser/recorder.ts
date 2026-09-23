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
 *
 * # 这一层不认识"页面语义"
 *
 * 它只搬运 `reqs[]` / `logs[]` 两个数组，不判断哪条失败、哪条该前置——那是 `network.ts` /
 * `console.ts` 的事。这样换一个渲染口径不需要碰注入源码。
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
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

/** 已经注册过「新文档自动装」的视图 id —— **每个视图只注册一次**（注册是累积的，重发 N 次
 *  就让每份新文档跑 N 遍 no-op IIFE）。`view_id` 缺省时用 Rust 解析回来的真实 id 记账。 */
const registeredViews = new Set<string>();

/**
 * 给**未来的文档**装上（CDP `Page.addScriptToEvaluateOnNewDocument`，走既有的 `call_cdp`
 * 透传，Rust 一行不动）。注册挂在视图上，故同一视图只发一次；失败**如实带出**，不吞。
 *
 * 这一处是**唯一的注入接缝**：若真机上 CDP 路不通，只需把这里的 `call_cdp` 换成走宿主
 * `AddScriptToExecuteOnDocumentCreated` 的那个 op（见实现计划 Task 13），其余代码一行不动。
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

  // 方法级拒绝是一个合法 JSON 响应体，桥只看 JSON 解析 → 它会带着 ok:true 回来。
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
    return {
      ok: false,
      error: String(value?.["error"] ?? "the recorder read script returned no usable value"),
    };
  }
  return reg.ok
    ? { ok: true, value, registered: true }
    : { ok: true, value, registered: false, registerError: reg.error };
}
