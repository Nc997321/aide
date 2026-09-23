/**
 * `browser_wait`：agent 的**时序原语**。
 *
 * # 为什么必须有，以及为什么轮询在主机侧
 *
 * 没它的时候，agent 验证"点了保存之后弹窗出来没有"只能写一句 eval 手搓轮询——这是它反馈里
 * 最烦的模式。更要命的是那种轮询**写在页面里**：`setTimeout` 在隐藏视图里会被降频（后台
 * 几分钟后低至每分钟一次），"等 5 秒"实际只轮询了 4 次，于是超时成了假阴性，agent 据此
 * 宣布"没反应"。这里的轮询跑在 Node 侧（见 `loop.ts`），对这个病免疫。
 *
 * # 两种模式，`load` 不是"顺手加的"
 *
 * `document.readyState` 在跨导航时由**旧文档**回答（永远是 `complete`），所以"点了链接等新页面
 * 到位"**无法用页面内表达式表达**，只能从宿主侧看 `nav.state`。这是最高频的场景之一，
 * 值得为它开一个模式。
 *
 * # 超时是诊断，不是错误
 *
 * 超时**不算工具失败**（守 `browserTools.ts` 的"永不抛"红线）：它回一段带可见性、最后观察到
 * 的值、轮询次数的说明，让模型判断是改条件还是改判据。尤其是隐藏视图——那里依赖渲染的条件
 * **永远不会成立**，不说这句，模型会把引擎的限制当成页面的行为。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { runEval } from "./runEval.js";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 把观察到的一个值说成一行短文本——超时诊断里用，**不许把整个 DOM 拖进来**。 */
function jsonBrief(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return "undefined";
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 默认与上限。上限存在的理由：一次工具调用不该能把会话挂住超过半分钟。 */
export const WAIT_TIMEOUT_DEFAULT_MS = 5_000;
export const WAIT_TIMEOUT_MAX_MS = 30_000;
export const WAIT_INTERVAL_DEFAULT_MS = 200;
/** 下限：再密就是空转，一次轮询好歹是一次跨进程往返。 */
export const WAIT_INTERVAL_MIN_MS = 10;

export type WaitMode = "condition" | "load";

export interface WaitInput {
  viewId?: string;
  mode: WaitMode;
  /** `mode === "condition"` 时必填。**同步表达式**，真值即满足。 */
  condition?: string;
  timeoutMs: number;
  intervalMs: number;
}

/**
 * 条件求值器。**在条件外面套一层拿两个免费信号**：
 * - `met` / `value`：条件本身（抛异常 = 尚未满足，不是错误）；
 * - `to`：`performance.timeOrigin` —— **每份文档一个值**，不需要我们注入任何东西，
 *   却能回答"我这一跳读的是哪个文档"。全浏览器模块此前**没有任何文档身份概念**，
 *   于是"旧文档先满足"这类现象（反馈第 2 条）无从分辨。
 *
 * 断言里没有 await：降级通道 await 不了 Promise，而两条通道**行为必须一致**——否则同一句
 * 条件在有的机器上成立、有的永远不成立，正是本批要消灭的那类病。
 */
function conditionScript(condition: string): string {
  return `(function () {
  try { var __v = (${condition}); return { met: !!__v, value: __v, to: (window.performance && performance.timeOrigin) || 0 }; }
  catch (e) { return { met: false, threw: String((e && e.message) || e), to: (window.performance && performance.timeOrigin) || 0 }; }
})()`;
}

/** 一次条件轮询的观察。 */
interface ConditionTick {
  met: boolean;
  /** 面向模型的"看到了什么"。 */
  detail: string;
  /**
   * 这一跳读的是**哪一份文档**（`performance.timeOrigin`，每份文档一个值）。
   * 拿不到（引擎没有 / 字段缺失 / 折叠成 `0`）为 `null`——**空 ≠ 没有**，不假装知道。
   */
  timeOrigin: number | null;
}

/**
 * 把 `view_id` 解析成确定的那个视图。
 *
 * **不自己实现解析规则**：显式 id → 唯一可见 → 唯一存在，这条规则住在
 * `runtime/browser_agent.rs:111-152`（那句 "none is uniquely visible" 也在那儿）。复刻一份
 * 就是等着漂移。这里借一次最廉价的求值让 Rust 替我们解析，顺带白拿它的失败文案。
 */
async function resolveView(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true; viewId?: string } | { ok: false; text: string }> {
  const r = await runEval("0", { viewId }, emit);
  if (!r.ok) return { ok: false, text: r.error };
  return { ok: true, viewId: r.viewId };
}

/**
 * 条件模式的一跳。桥层失败**直接放弃**——理由见函数内那句注释（能走到这一层就说明
 * 问题不在条件成不成立上）。
 */
async function conditionTick(
  viewId: string | undefined,
  condition: string,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true; tick: ConditionTick } | { ok: false; text: string }> {
  const r = await runEval(conditionScript(condition), { viewId }, emit);
  // 求值器自己的 throw 已被包装器兜住，所以走不到这一步；**能走到说明条件本身有问题**
  // （语法错误、视图没了、两条通道都不可用）——没有一种会靠等待变好。
  if (!r.ok) return { ok: false, text: `The condition could not be evaluated at all: ${r.error}` };

  const v = asRecord(r.value);
  const to = v?.["to"];
  return {
    ok: true,
    tick: {
      met: v?.["met"] === true,
      detail:
        typeof v?.["threw"] === "string"
          ? `the condition threw: ${v["threw"]}`
          : `the condition evaluated to ${jsonBrief(v?.["value"])}`,
      timeOrigin: typeof to === "number" && to > 0 ? to : null,
    },
  };
}

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

/** 一次等待的量化事实。 */
interface PollStats {
  attempts: number;
  /** **实测**耗时（`Date.now()` 差值），不是 `attempts × intervalMs` 的合成值。 */
  elapsedMs: number;
  intervalMs: number;
  budgetMs: number;
}

/**
 * 到**此刻**为止的量化事实。耗时只在这一个地方产生——每个出口各自算一次，
 * 早晚会有人顺手写成 `attempts × intervalMs`，而这个数字是会骗人的那一个。
 */
function pollStats(attempts: number, startedAt: number, input: WaitInput): PollStats {
  return {
    attempts,
    elapsedMs: Date.now() - startedAt,
    intervalMs: input.intervalMs,
    budgetMs: input.timeoutMs,
  };
}

/**
 * 把"文档被替换过"的说明挂到报文末尾——**两条终局出口共用**（满足、超时）。
 *
 * 只在一条出口上说的话，另一条就把"我等的到底是哪个文档"重新变回不可观测，而超时恰恰是
 * 最需要它的地方："它一直不满足"有两种成因，其中一种是**我其实在数另一份文档**。
 */
function withNote(text: string, note: string | null): string {
  return note ? `${text}\n${note}` : text;
}

/** 满足：报**实测**耗时 + 条件看到了什么 +（若有）文档被替换的说明。 */
function metReport(detail: string, stats: PollStats, docNote: string | null): string {
  return withNote(
    `Condition met after ${stats.attempts} poll(s) (${stats.elapsedMs}ms, polling every ${stats.intervalMs}ms): ${detail}`,
    docNote,
  );
}

/** 超时说明——**诊断，不是错误**。数字一律是实测值，预算单独标出。 */
function timeoutReport(head: string, last: string, stats: PollStats): string {
  const lines = [
    head,
    `Polled ${stats.attempts} time(s) over ${stats.elapsedMs}ms (budget ${stats.budgetMs}ms, interval ${stats.intervalMs}ms).`,
    `Last observation: ${last}`,
  ];
  return lines.join("\n");
}

/** 条件模式：轮询一句表达式直到它为真。 */
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

    if (last.met) return metReport(last.detail, pollStats(attempts, startedAt, input), doc.note());
    await sleep(input.intervalMs);
  }

  return withNote(
    timeoutReport("Timed out — the condition never became true.", last.detail, pollStats(attempts, startedAt, input)),
    doc.note(),
  );
}

/** 视图的导航快照（宿主侧，来自 `list_views`）。 */
interface NavSnapshot {
  state: string;
  url: string;
  title: string;
}

/** 取一跳导航快照。视图消失如实报出来，不当成"还在加载"。 */
async function navTick(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true; nav: NavSnapshot } | { ok: false; text: string }> {
  const resp = await queryBrowser({ op: "list_views" }, emit);
  if (!resp.ok) return { ok: false, text: resp.error ?? "could not list browser views" };

  const views = asArray(asRecord(resp.data)?.["views"]).map(asRecord);
  const hit = views.find((v) => v && v["id"] === viewId);
  if (!hit) {
    return {
      ok: false,
      text: `The view ${viewId ?? "(unresolved)"} is gone — it was closed while waiting.`,
    };
  }
  const nav = asRecord(hit["nav"]) ?? {};
  return {
    ok: true,
    nav: {
      state: typeof nav["state"] === "string" ? nav["state"] : "unknown",
      url: typeof nav["url"] === "string" ? nav["url"] : "",
      title: typeof nav["title"] === "string" ? nav["title"] : "",
    },
  };
}

/**
 * 一跳导航快照 → **终局报文**；`null` = 还没到终局，继续轮询。
 *
 * ⚠️ **`nav.state` 没有历史**：刚点完链接、导航还没起跳时，它会说 `ready`——那是**旧页面**。
 * 直接信它就制造了一个静默假阳性（等待立即返回，agent 以为新页面到位了）。所以：
 * - 先观察到过 `loading` → 之后必须等到 `ready`/`failed`；
 * - 从没观察到 → 如实报告"调用开始时它本来就没在加载"，把判断留给模型。
 *
 * `failed` 与 `idle` **立即结束**：把一个明确的失败或"压根没导航过"拖到超时，是把两种不同的
 * 情况伪装成同一个"慢"。
 */
function loadVerdict(nav: NavSnapshot, sawLoading: boolean): string | null {
  const where = `${nav.url}${nav.title ? ` — ${nav.title}` : ""}`;

  if (nav.state === "failed") return `Navigation failed at ${where}. (Reason is not carried by this build.)`;
  if (nav.state === "idle") {
    return (
      `The view has not navigated anywhere yet, so there is nothing to wait for. ` +
      `Use browser_tabs to confirm you are targeting the right view, or browser_act to get it there first.`
    );
  }
  if (nav.state !== "ready") return null;
  if (sawLoading) return `Page finished loading: ${where}`;
  return (
    `Nothing was loading when this call started — the view was already ready at ${where}. ` +
    `If you expected a navigation to be in flight, it had not started yet: call again, or wait ` +
    `for the page to change with a \`condition\` instead. If you just made a SAME-DOCUMENT ` +
    `navigation (a hash change or history.pushState), it does not trigger a load and will never ` +
    `show up here — use \`until:"condition"\` on the content you expect, or read \`location.href\`.`
  );
}

/** 加载模式：轮询宿主侧的 `nav.state`，直到 `loadVerdict` 给出终局。 */
async function waitForLoad(
  viewId: string | undefined,
  input: WaitInput,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  let attempts = 0;
  let sawLoading = false;
  let last: NavSnapshot = { state: "(never polled)", url: "", title: "" };

  while (Date.now() < deadline) {
    attempts += 1;
    const r = await navTick(viewId, emit);
    if (!r.ok) return r.text;
    last = r.nav;
    if (last.state === "loading") sawLoading = true;

    const verdict = loadVerdict(last, sawLoading);
    if (verdict) return verdict;
    await sleep(input.intervalMs);
  }

  // 这里没有 `withNote`，**是如实，不是漏了**：`load` 模式一个条件都没求值，拿不到
  // `performance.timeOrigin`，这份等待的"文档身份"由宿主侧的 `nav.state` 承担。
  // 别为了对称去发明一个指纹。
  return timeoutReport(
    "Timed out — the view never finished loading.",
    `nav.state = ${last.state} at ${last.url || "(no url)"}`,
    pollStats(attempts, startedAt, input),
  );
}

/**
 * 等一个条件成立。返回**给模型看的文本**（成功、终止、超时都走这里）。
 *
 * 本函数只做编排：解析视图 → 按模式分发。两个模式的差别大到值得各自成篇，见它们各自的注释。
 */
export async function waitForBrowser(input: WaitInput, emit: (e: ChatEvent) => void): Promise<string> {
  const resolved = await resolveView(input.viewId, emit);
  if (!resolved.ok) return resolved.text;
  return input.mode === "load"
    ? waitForLoad(resolved.viewId, input, emit)
    : waitForCondition(resolved.viewId, input, emit);
}
