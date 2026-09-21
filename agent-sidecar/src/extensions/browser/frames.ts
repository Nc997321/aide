/**
 * 跨域 iframe 的读取——走 CDP **帧级求值**。
 *
 * # 问题
 *
 * 注入到父页面的脚本只能碰 `iframe.contentDocument`，跨域时拿不到。而设计交付类网站
 * 恰恰把原型本体放在跨域 iframe 里——于是 `browser_read` 在真正要看的内容前止步，只能报
 * 「CROSS-ORIGIN, contents are NOT readable」。这是**真边界**，不是 bug。
 *
 * # 解
 *
 * CDP 能在**任意帧**里建执行上下文，绕过同源策略（它本来就是浏览器自己的调试通道）：
 *
 * ```
 * Page.getFrameTree         → 列出所有帧的 frameId + url
 * Page.createIsolatedWorld  → 在该帧建隔离世界，拿 executionContextId
 * Runtime.evaluate          → 在那个上下文里跑投影脚本（document 就是该帧的 document）
 * ```
 *
 * **全程走已有的 `call_cdp` op，Rust 一行不动**——这正是当初把 op 面收窄成
 * 「三个机制词汇 + 编排留在 sidecar」的回报。
 *
 * # 降级纪律（重要）
 *
 * CDP 域名可用性是**运行期变量**（WebView2 是 Evergreen 运行时），任一步失败都**不许**
 * 让整个 `browser_read` 挂掉：保留原本的「跨域不可读」结论，并把**失败原因**如实带出去。
 * 「读不到」与「帧里是空的」是两回事，混为一谈会让模型据此宣布"这页没内容"。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { buildProjectionScript, type ProjectionOptions } from "./projection.js";
import { runEval, type EvalProbe } from "./runEval.js";

/** 一帧的读取结果。 */
export interface FrameRead {
  url: string;
  /** 读到的投影（形同 `buildProjectionScript()` 的返回）；失败为 null。 */
  value: Record<string, unknown> | null;
  /** 失败原因（CDP 不可用 / 帧已消失 / 求值抛异常）。**如实**带出，不吞。 */
  error?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 从 CDP 回包里取 `value`（`{view_id, method, value}` 的第三项）。 */
function cdpValue(data: unknown): unknown {
  return asRecord(data)?.["value"];
}

interface CdpFrame {
  id: string;
  url: string;
}

/**
 * 从 `Page.getFrameTree` 的根节点收集**子帧**（主帧自身不在结果里）。
 *
 * ⚠️ **不能用 URL 排除主帧**（2026-09-16 实测踩过）：CDP 给的帧 URL **不含 fragment**，
 * 而投影脚本给的是 `location.href`（带 `#/item/...`）——两者永不相等，主帧会被当成子帧
 * 白读一次，还会在输出里排到最前面冒充内容。按**树结构**排除才可靠：根节点就是主帧。
 */
function childFrames(node: unknown, out: CdpFrame[] = []): CdpFrame[] {
  const n = asRecord(node);
  if (!n) return out;
  for (const child of asArray(n["childFrames"])) {
    const frame = asRecord(asRecord(child)?.["frame"]);
    if (frame && typeof frame["id"] === "string") {
      out.push({
        id: frame["id"],
        url: typeof frame["url"] === "string" ? frame["url"] : "",
      });
    }
    childFrames(child, out);
  }
  return out;
}

/** 与 `childFrames` 同源，但保留主帧 id——`browser_eval` 定位帧时要用它列候选。 */
function allFrames(node: unknown): CdpFrame[] {
  const n = asRecord(node);
  if (!n) return [];
  const frame = asRecord(n["frame"]);
  const self: CdpFrame[] =
    frame && typeof frame["id"] === "string"
      ? [{ id: frame["id"], url: typeof frame["url"] === "string" ? frame["url"] : "" }]
      : [];
  return [...self, ...childFrames(node)];
}

/**
 * 取帧表。**两个视图刻意分开**，混用会出错（2026-09-16 实测踩过）：
 * - `children` **不含主帧**——`browser_read` 用它选要补读的帧（主帧投影已经覆盖了）；
 * - `all` 含主帧——`browser_eval` 定位帧时要把它列进候选，否则 agent 看到"可用帧"里
 *   少了当前页会困惑。
 *
 * 空 URL 与 `about:blank` 不算帧。
 */
async function frameTree(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ all: CdpFrame[]; children: CdpFrame[]; error?: string }> {
  const tree = await queryBrowser(
    { op: "call_cdp", view_id: viewId, method: "Page.getFrameTree", params: {} },
    emit,
  );
  if (!tree.ok) {
    return { all: [], children: [], error: `Page.getFrameTree failed: ${tree.error ?? "unknown"}` };
  }
  const root = asRecord(cdpValue(tree.data))?.["frameTree"];
  const real = (f: CdpFrame): boolean => Boolean(f.url) && f.url !== "about:blank";
  return { all: allFrames(root).filter(real), children: childFrames(root).filter(real) };
}

/**
 * 在指定帧的隔离世界里求值。**任何一步失败都折成 `error`，不抛。**
 *
 * 求值本体交给 `runEval`（同一个出口，同一套失败判据）——这里只负责**先把上下文建出来**：
 * 跨域帧够不着，CDP 得为它开一个隔离世界。`runEval` 认得 `contextId`，所以帧内求值也
 * 自动获得 `awaitPromise`（调用方的 async 脚本在帧里同样能 await）与 `probe`（该帧的可见性）。
 */
async function evalInContext(
  viewId: string | undefined,
  frameId: string,
  script: string,
  worldName: string,
  emit: (e: ChatEvent) => void,
): Promise<{ value: unknown; probe?: EvalProbe; error?: string }> {
  // 只传 frameId + worldName：`grantUniveralAccess` 那个历史拼写（CDP 规范原文如此）不必碰，
  // 省一个版本差异面。
  const world = await queryBrowser(
    {
      op: "call_cdp",
      view_id: viewId,
      method: "Page.createIsolatedWorld",
      params: { frameId, worldName },
    },
    emit,
  );
  if (!world.ok) return { value: null, error: `createIsolatedWorld failed: ${world.error ?? "unknown"}` };

  const contextId = Number(asRecord(cdpValue(world.data))?.["executionContextId"]);
  if (!Number.isFinite(contextId)) {
    return { value: null, error: "createIsolatedWorld returned no executionContextId" };
  }

  const r = await runEval(script, { viewId, contextId }, emit);
  // 不额外加前缀：调用方本来就按帧渲染（"- frame N <url> — …: <error>"），再加一层只是啰嗦。
  if (!r.ok) return { value: null, error: r.error };
  return { value: r.value, probe: r.probe };
}

/** 单帧：建隔离世界 → 跑投影脚本。任何一步失败都回成一个 `error`，不抛。 */
async function readOneFrame(
  viewId: string | undefined,
  frame: CdpFrame,
  opts: ProjectionOptions,
  emit: (e: ChatEvent) => void,
): Promise<FrameRead> {
  const r = await evalInContext(viewId, frame.id, buildProjectionScript(opts), "aide-read", emit);
  const value = asRecord(r.value);
  if (!value) {
    return {
      url: frame.url,
      value: null,
      error: r.error ?? "frame script returned no object (threw, or returned a non-object)",
    };
  }
  return { url: frame.url, value };
}

/**
 * 读取**骨架没能读到**的帧。
 *
 * `alreadyRead` = 骨架里已成功读取的帧 URL（同源那些，投影脚本自己递归过了）——
 * 跳过它们，避免把同一份内容读两遍。主帧**不由 URL 排除**（见 `childFrames` 的注释），
 * 它在结构上就不在候选里。
 *
 * 任何前置步骤失败 → 回一个带原因的空结果，让调用方保留「跨域不可读」的原结论。
 */
export async function readCrossOriginFrames(
  viewId: string | undefined,
  alreadyRead: string[],
  opts: ProjectionOptions,
  emit: (e: ChatEvent) => void,
): Promise<{ frames: FrameRead[]; error?: string }> {
  const t = await frameTree(viewId, emit);
  if (t.error) {
    return {
      frames: [],
      error:
        `frame-level reading is unavailable (${t.error}). ` +
        `This is a WebView2 runtime capability, not a page problem.`,
    };
  }

  const skip = new Set(alreadyRead.filter(Boolean));
  const targets = t.children.filter((f) => !skip.has(f.url));
  if (targets.length === 0) return { frames: [] };

  const frames: FrameRead[] = [];
  for (const frame of targets) {
    frames.push(await readOneFrame(viewId, frame, opts, emit));
  }
  return { frames };
}

/**
 * 从 `browser_read` 的骨架结果判断"要不要再走一趟 CDP"，要就顺手读了。
 *
 * **只在真有读不到的帧时才走**——简单页面（无 iframe 或全同源）不做多余的往返，
 * 这也让 CDP 不可用的机器在多数页面上完全感觉不到这条路径的存在。
 *
 * 返回 `undefined` = 不需要；返回 `{frames:[], error}` = 需要但整体不可用（如实带出）。
 */
export async function readFramesFromResult(
  viewId: string | undefined,
  projection: unknown,
  opts: ProjectionOptions,
  emit: (e: ChatEvent) => void,
): Promise<{ frames: FrameRead[]; error?: string } | undefined> {
  const value = asRecord(projection);
  if (!value || value["ok"] !== true) return undefined;

  const frames = asArray(value["frames"]).map(asRecord).filter((f): f is Record<string, unknown> => f !== null);
  if (frames.length === 0) return undefined;

  const alreadyRead: string[] = [];
  let unread = 0;
  for (const f of frames) {
    const src = typeof f["src"] === "string" ? f["src"] : "";
    if (f["sameOrigin"] === true && f["content"]) {
      if (src) alreadyRead.push(src);
    } else {
      unread += 1;
    }
  }
  if (unread === 0) return undefined;

  return readCrossOriginFrames(viewId, alreadyRead, opts, emit);
}

/** `browser_eval` 在帧里跑脚本的结果。 */
export type FrameEvalOutcome =
  | { ok: true; url: string; value: unknown; probe?: EvalProbe }
  | { ok: false; error: string; available: string[] };

/**
 * 在**指定的跨域帧**里跑一段自定义脚本——`browser_eval` 的 `frame` 参数走这里。
 *
 * # 为什么必须有这个入口
 *
 * `browser_read` 给的是**通用**骨架（表格/表单/按钮）。有些页面的内容它表达不了——典型是
 * 设计工具导出的原型：整页是绝对定位的 `<div>`，一个 `<table>`/`<input>` 都没有，通用抽取器
 * 只会读到一个标题。这时唯一的出路是让 agent **在这个帧里跑自己写的脚本**，而 `browser_eval`
 * 默认跑在父页面上下文，够不到跨域帧。
 *
 * 2026-09-16 实测：agent 写了 walk 脚本、跑了、拿不到东西，最后转去 curl 那个帧 URL——不是它
 * 不会做，是**没有入口**。
 *
 * `urlContains` 用 URL 子串而不是 frameId：agent 手里只有 `browser_read` 给的帧 URL，
 * 那是它唯一能可靠指认一帧的东西。找不到时把可用帧列出来，让它改口径。
 */
export async function evalInFrame(
  viewId: string | undefined,
  urlContains: string,
  script: string,
  emit: (e: ChatEvent) => void,
): Promise<FrameEvalOutcome> {
  const t = await frameTree(viewId, emit);
  if (t.error) return { ok: false, error: t.error, available: [] };

  const hit = t.all.find((f) => f.url.includes(urlContains));
  if (!hit) {
    return {
      ok: false,
      error: `no frame whose URL contains ${JSON.stringify(urlContains)}`,
      available: t.all.map((f) => f.url),
    };
  }

  const r = await evalInContext(viewId, hit.id, script, "aide-eval", emit);
  if (r.error) return { ok: false, error: r.error, available: [hit.url] };
  return { ok: true, url: hit.url, value: r.value, probe: r.probe };
}
