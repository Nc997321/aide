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
import { probeVisibility, runEval, type PageVisibility } from "./runEval.js";
import { hiddenNote } from "./visibility.js";

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
 * 条件的求值器。
 *
 * **抛异常不算失败**：`document.querySelector('.x').textContent` 在元素尚未出现时必然抛——
 * 那是"尚未满足"，不是错误。所以包一层 try/catch，把 throw 当成一次"没到"并记下原因。
 *
 * 断言里没有 await：降级通道 await 不了 Promise，而两条通道**行为必须一致**——否则同一句
 * 条件在有的机器上成立、有的永远不成立，正是本批要消灭的那类病。
 */
function conditionScript(condition: string): string {
  return `(function () {
  try { var __v = (${condition}); return { met: !!__v, value: __v }; }
  catch (e) { return { met: false, threw: String((e && e.message) || e) }; }
})()`;
}

/** 一次条件轮询的观察。 */
interface ConditionTick {
  met: boolean;
  /** 面向模型的"看到了什么"。 */
  detail: string;
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
  // `probe: "none"`：解析只要 view_id，顺带取可见性是白花一次往返。
  const r = await runEval("0", { viewId, probe: "none" }, emit);
  if (!r.ok) return { ok: false, text: r.error };
  return { ok: true, viewId: r.viewId };
}

/**
 * 条件模式的一跳。桥层失败**直接放弃**——理由见 `waitForCondition`。
 *
 * `probe: "none"`：可见性**不在热循环里问**（每 200ms 一跳，问它是纯浪费），只在超时那一次
 * 单独取（见 `timeoutReport` 的调用点）。
 */
async function conditionTick(
  viewId: string | undefined,
  condition: string,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true; tick: ConditionTick } | { ok: false; text: string }> {
  const r = await runEval(conditionScript(condition), { viewId, probe: "none" }, emit);
  // 求值器自己的 throw 已被包装器兜住，所以走不到这一步；**能走到说明条件本身有问题**
  // （语法错误、视图没了、两条通道都不可用）——没有一种会靠等待变好。
  if (!r.ok) return { ok: false, text: `The condition could not be evaluated at all: ${r.error}` };

  const v = asRecord(r.value);
  return {
    ok: true,
    tick: {
      met: v?.["met"] === true,
      detail:
        typeof v?.["threw"] === "string"
          ? `the condition threw: ${v["threw"]}`
          : `the condition evaluated to ${jsonBrief(v?.["value"])}`,
    },
  };
}

/** 超时说明——**诊断，不是错误**。 */
function timeoutReport(head: string, last: string, attempts: number, input: WaitInput, visibility: PageVisibility): string {
  const lines = [
    head,
    `Polled ${attempts} time(s) over ${input.timeoutMs}ms at ${input.intervalMs}ms intervals.`,
    `Last observation: ${last}`,
  ];
  const note = hiddenNote(
    visibility,
    "Conditions that depend on rendering will never become true here — the engine does not " +
      "advance transitions, animations or lazy loading in a hidden view. Bring the view to the " +
      "front, or rewrite the condition to something that does not depend on rendering.",
  );
  if (note) lines.push("", note);
  return lines.join("\n");
}

/** 条件模式：轮询一句表达式直到它为真。 */
async function waitForCondition(
  viewId: string | undefined,
  input: WaitInput,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;
  let attempts = 0;
  let last: ConditionTick = { met: false, detail: "(never evaluated)" };

  while (Date.now() < deadline) {
    attempts += 1;
    const r = await conditionTick(viewId, input.condition ?? "", emit);
    if (!r.ok) return r.text;
    last = r.tick;
    if (last.met) {
      return `Condition met after ${attempts} poll(s) (${attempts * input.intervalMs}ms): ${last.detail}`;
    }
    await sleep(input.intervalMs);
  }

  // 可见性只在**这一条**路径上取：轮询循环里问它是纯浪费（见 `conditionTick`）。
  return timeoutReport(
    "Timed out — the condition never became true.",
    last.detail,
    attempts,
    input,
    await probeVisibility(viewId, emit),
  );
}

/** 视图的导航快照（宿主侧，来自 `list_views`）。 */
interface NavSnapshot {
  state: string;
  url: string;
  title: string;
  /** 宿主认为这个视图可不可见（页面侧那个在条件模式里拿，这里只有宿主这份）。 */
  visible: boolean;
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
      visible: hit["visible"] === true,
    },
  };
}

/**
 * 加载模式：等这个视图不再处于加载中。
 *
 * ⚠️ **`nav.state` 没有历史**：刚点完链接、导航还没起跳时，它会说 `ready`——那是**旧页面**。
 * 直接信它就制造了一个静默假阳性（等待立即返回，agent 以为新页面到位了）。所以：
 * - 先观察到过 `loading` → 之后必须等到 `ready`/`failed`；
 * - 从没观察到 → 如实报告"调用开始时它本来就没在加载"，把判断留给模型。
 *
 * `failed` 与 `idle` **立即结束**：把一个明确的失败或"压根没导航过"拖到超时，是把两种不同的
 * 情况伪装成同一个"慢"。
 */
async function waitForLoad(
  viewId: string | undefined,
  input: WaitInput,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;
  let attempts = 0;
  let sawLoading = false;
  let last: NavSnapshot = { state: "(never polled)", url: "", title: "", visible: false };

  while (Date.now() < deadline) {
    attempts += 1;
    const r = await navTick(viewId, emit);
    if (!r.ok) return r.text;
    last = r.nav;
    const where = `${last.url}${last.title ? ` — ${last.title}` : ""}`;

    if (last.state === "failed") return `Navigation failed at ${where}. (Reason is not carried by this build.)`;
    if (last.state === "idle") {
      return (
        `The view has not navigated anywhere yet, so there is nothing to wait for. ` +
        `Use browser_tabs to confirm you are targeting the right view, or browser_act to get it there first.`
      );
    }
    if (last.state === "loading") sawLoading = true;
    if (last.state === "ready") {
      if (sawLoading) return `Page finished loading: ${where}`;
      return (
        `Nothing was loading when this call started — the view was already ready at ${where}. ` +
        `If you expected a navigation to be in flight, it had not started yet: call again, or wait ` +
        `for the page to change with a \`condition\` instead.`
      );
    }
    await sleep(input.intervalMs);
  }

  const visibility: PageVisibility = last.visible ? "visible" : "hidden";
  return timeoutReport(
    "Timed out — the view never finished loading.",
    `nav.state = ${last.state} at ${last.url || "(no url)"}`,
    attempts,
    input,
    visibility,
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
