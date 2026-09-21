/**
 * 求值出口：**全仓唯一**把脚本送进页面并取回值的地方。
 *
 * `browser_eval` / `browser_read`（投影脚本）/ `browser_act`（解析、设值、兜底点击）
 * / 帧级读取，四条路径原先各自直调桥、各写一遍信封解析。这里收口。
 *
 * # 主路径：CDP，**原样**送脚本 + `awaitPromise`
 *
 * `Runtime.evaluate {expression: 调用方的原脚本, awaitPromise: true, returnByValue: true}`
 * （经 `call_cdp` op，Rust 一行不动）。选它不是为了"更高级"，是为了**语义无歧义**：
 * `awaitPromise` 是 CDP 的显式参数，不随 WebView2（Evergreen）版本漂移；而 `ExecuteScript`
 * 的 promise 行为我们实测过——**它不 await**，`(async () => 42)()` 回 `{}`（2026-09-20 本机）。
 *
 * **不加任何包装器**（这是踩过两次坑之后定的，别再加回来）：
 *
 * 1. `await (${script})` 这个形状只接受**表达式**，而裸通道接受**脚本**——两者都回脚本的
 *    **完成值**，`var x = 1; x + 2` 回 `3`（实测）。加包装就把多语句这个既有用法弄坏了。
 * 2. 想靠"错误文本里有没有 `SyntaxError`"来兜这个坏，**兜不住**：CDP 对解析错误只回一个
 *    光秃秃的 `Uncaught`，不含类型名（2026-09-20 dev 实例实测，`var x = 1; x + 2` 报的
 *    就是 `The page script threw: Uncaught`）。
 *
 * `awaitPromise` 自己就能解掉调用方的 Promise，包装器在 CDP 路径上**没有任何收益**。
 * 唯一曾经由它带来的东西是页面自述状态，那个改用一次**独立的廉价求值**拿（见 `runEval`），
 * 代价是一次本地往返，换来的是零语义偏移。
 *
 * 失败的形状也顺带干净了：不加包装时 `nope()` 报 `Uncaught ReferenceError: …`；
 * 加了包装它会被报成 `Uncaught (in promise) ReferenceError: …`——多出来的那截是我们自己
 * 制造的噪音，不是页面的性质。
 *
 * # 降级路径：ExecuteScript
 *
 * CDP 域名可用性是**运行期变量**（WebView2 是 Evergreen 运行时），这是既有的架构前提。
 * 降级时**必须**加同步包装：那条通道 await 不了 Promise，不包就分不清"脚本返回了 Promise
 * 拿不到"和"脚本确实返回了个对象"——正是这个模块要消灭的那类静默错误答案。
 *
 * # 一条不许违反的纪律：脚本异常**不降级**
 *
 * 降级意味着把脚本**在页面上再跑一遍**。脚本有副作用（点击、发请求），重跑一次就是
 * 两次副作用。所以只有「CDP 自己不认这条方法」才降级；脚本抛异常一律就地返回。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { formatBridgeFailure } from "./format.js";

/** 求值实际走通的通道。 */
export type EvalVia = "cdp" | "executescript";

/**
 * 失败的三种性质——**指向不同的下一步**，所以不许糊成一个字符串：
 * `exception` 改脚本；`unserializable` 改返回形状；`bridge` 是环境问题。
 */
export type EvalFailureKind = "exception" | "unserializable" | "bridge";

/**
 * 求值的附带信号。
 *
 * ⚠️ 曾经这里还有 `visibility`（页面侧面 `document.visibilityState`，用来判断"渲染类断言可不可信"）。
 * parking 落地后**不显示的视图引擎照样活着**（合成、输入、截图全在），所以那个信号恒为
 * `visible`——留着它只会骗人，连同每次求值多出来的一次 CDP 往返一起删了。
 * 现在"有没有人在看"这个问题由 **host 侧**的 `displayed / parked` 回答（`browser_tabs`）。
 */
export interface EvalProbe {
  /** true = 脚本返回了 Promise 而这条通道 await 不了它（只可能出现在降级路径）。**不许当成功。** */
  pending: boolean;
}

export type EvalResult =
  | { ok: true; value: unknown; via: EvalVia; probe: EvalProbe; viewId?: string }
  | { ok: false; kind: EvalFailureKind; error: string; via?: EvalVia };

export interface EvalOptions {
  viewId?: string;
  /** 帧级读取用：在指定执行上下文里求值（由 `Page.createIsolatedWorld` 得到）。 */
  contextId?: number;
}

/** 内部：`unavailable` 是**唯一**该触发降级的性质，不外泄。 */
type Attempt =
  | { ok: true; value: unknown; via: EvalVia; pending: boolean; viewId?: string }
  | { ok: false; kind: EvalFailureKind; error: string }
  | { ok: false; kind: "unavailable"; error: string };

/**
 * 降级通道的返回：**结构上不可能**是 `unavailable`——它就是"CDP 不可用"之后的去处。
 * 用类型钉住，省得 `runEval` 出口再判一次。
 */
type FallbackAttempt = Exclude<Attempt, { kind: "unavailable" }>;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * 回包里的 `view_id`——调用方省略 `view_id` 时由 Rust 解析出的那个。
 * 值得原样带回：不知道"是哪个视图答的"，多视图下就没法核对。
 */
function viewIdOf(data: unknown): string | undefined {
  const id = asRecord(data)?.["view_id"];
  return typeof id === "string" ? id : undefined;
}

/**
 * 降级路径的包装：**同步形态**（`ExecuteScript` await 不了 Promise）。
 *
 * 在包装里做两件裸 `ExecuteScript` 做不到的事：
 * - `thrown`：抛异常时把原因带回去，不再退化成"回 null 说不清"；
 * - `pending`：脚本返回 Promise 时如实标注，不假装拿到了值。
 *
 * 包不了多语句脚本（那是**表达式**形状的限制）——所以调用方拿到 `null` 时会脱壳重来一次，
 * 见 `viaExecuteScript`。
 */
function wrapForExecuteScript(script: string): string {
  return `(function () {
  var __aideProbe = {};
  try {
    var __aideValue = (${script});
    __aideProbe.value = __aideValue;
    __aideProbe.pending = !!(__aideValue && typeof __aideValue.then === 'function');
  } catch (e) {
    __aideProbe.thrown = String((e && e.message) || e);
  }
  return __aideProbe;
})()`;
}

/** 降级路径的包装结果 → 值 / 失败。 */
function readWrappedResult(raw: Record<string, unknown>, viewId?: string): FallbackAttempt {
  if (typeof raw["thrown"] === "string") {
    return { ok: false, kind: "exception", error: `The page script threw: ${raw["thrown"]}` };
  }
  return {
    ok: true,
    value: raw["value"],
    via: "executescript",
    pending: raw["pending"] === true,
    viewId,
  };
}

/**
 * 异常的人话版本。
 *
 * ⚠️ **不能只读 `exceptionDetails.text`**：脚本**同步抛出**时它只有 `"Uncaught"` 一个词，
 * 真正的原因在 `exception.description` 里（2026-09-20 实测：`nope()` 报出来就是光秃秃的
 * `The page script threw: Uncaught`，agent 拿不到任何可行动信息）。
 * 取 description 的第一行——后面是栈，对模型是噪音。
 */
function describeThrow(exception: Record<string, unknown>): string {
  const err = asRecord(exception["exception"]);
  const description = err?.["description"];
  if (typeof description === "string" && description) {
    return description.split("\n")[0] ?? description;
  }
  // 非 Error 对象（`throw "boom"`）走这里：text 仍是唯一的信息源。
  return String(exception["text"] ?? "unknown");
}

/** CDP `Runtime.evaluate` 的结果体 → 值 / 失败。**脚本原样求值，没有包装层要剥。** */
function readCdpResult(body: Record<string, unknown> | null, viewId?: string): Attempt {
  const exception = asRecord(body?.["exceptionDetails"]);
  if (exception) {
    return { ok: false, kind: "exception", error: `The page script threw: ${describeThrow(exception)}` };
  }

  const result = asRecord(body?.["result"]);
  if (!result) {
    return { ok: false, kind: "unserializable", error: "Runtime.evaluate returned no result object." };
  }
  // `undefined` 是**合法结果**：CDP 只给 type，不给 value 字段。
  if (!("value" in result)) {
    if (result["type"] === "undefined") {
      return { ok: true, value: undefined, via: "cdp", pending: false, viewId };
    }
    return {
      ok: false,
      kind: "unserializable",
      error:
        `The value could not be serialised back to the host (${String(result["description"] ?? result["type"] ?? "unknown type")}). ` +
        `Return a plain JSON-serialisable object instead.`,
    };
  }
  return { ok: true, value: result["value"], via: "cdp", pending: false, viewId };
}

/** 主路径。任何 `ok:false` 都带 `kind`，调用方据此决定要不要降级。 */
async function viaCdp(
  script: string,
  opts: EvalOptions,
  emit: (e: ChatEvent) => void,
): Promise<Attempt> {
  const params: Record<string, unknown> = {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  };
  if (opts.contextId !== undefined) params["contextId"] = opts.contextId;

  const resp = await queryBrowser(
    { op: "call_cdp", view_id: opts.viewId, method: "Runtime.evaluate", params },
    emit,
  );
  if (!resp.ok) return { ok: false, kind: "bridge", error: formatBridgeFailure(resp) };

  const body = asRecord(asRecord(resp.data)?.["value"]);
  const methodError = asRecord(body?.["error"]);
  if (methodError) {
    // CDP 自己拒绝了这条方法（Evergreen 运行时差异）——**唯一**该降级的情形。
    return {
      ok: false,
      kind: "unavailable",
      error: `Runtime.evaluate was rejected by the runtime: ${String(methodError["message"] ?? methodError["code"] ?? "unknown")}`,
    };
  }
  return readCdpResult(body, viewIdOf(resp.data));
}

/** 降级路径。`ExecuteScript` 认不了 `contextId`（见 `runEval` 的守卫），故只跑主文档。 */
async function viaExecuteScript(
  script: string,
  opts: EvalOptions,
  emit: (e: ChatEvent) => void,
): Promise<FallbackAttempt> {
  const wrapped = await queryBrowser(
    { op: "eval", view_id: opts.viewId, script: wrapForExecuteScript(script) },
    emit,
  );
  if (!wrapped.ok) return { ok: false, kind: "bridge", error: formatBridgeFailure(wrapped) };

  const raw = asRecord(asRecord(wrapped.data)?.["value"]);
  if (raw) return readWrappedResult(raw, viewIdOf(wrapped.data));

  // 包装器**总是**返回对象，所以拿到 null 只有一个解释：整段表达式没法解析。
  // 这多半是多语句脚本——裸通道本来是支持的，**脱壳再送一次**。解析期就失败 ⇒ 页面上一行
  // 都没执行，重试没有副作用。代价是这条脚本拿不到 pending 判定（异步脚本在这条通道上
  // 本来也 await 不了），如实标 unknown 由调用方决定怎么办。
  const bare = await queryBrowser({ op: "eval", view_id: opts.viewId, script }, emit);
  if (!bare.ok) return { ok: false, kind: "bridge", error: formatBridgeFailure(bare) };
  const bareValue = asRecord(bare.data)?.["value"] ?? null;
  if (bareValue === null) {
    return {
      ok: false,
      kind: "exception",
      error:
        "The page could not evaluate the script at all (this runtime's fallback channel returns null for a syntax " +
        "error, and cannot tell that apart from a script that returned null).",
    };
  }
  return {
    ok: true,
    value: bareValue,
    via: "executescript",
    pending: false,
    viewId: viewIdOf(bare.data),
  };
}

/** 求值本体：CDP 主路径 → 不可用则降级。 */
async function evalAttempt(
  script: string,
  opts: EvalOptions,
  emit: (e: ChatEvent) => void,
): Promise<FallbackAttempt> {
  const cdp = await viaCdp(script, opts, emit);
  if (cdp.ok) return cdp;
  // 脚本抛异常 / 不可序列化 / 桥失败——**都不降级**，理由见文件头。
  if (cdp.kind !== "unavailable") return cdp;
  // ExecuteScript 只跑主文档，退过去等于**在错的上下文里求值**——那比失败更糟。
  if (opts.contextId !== undefined) return { ok: false, kind: "bridge", error: cdp.error };
  return viaExecuteScript(script, opts, emit);
}

/**
 * 求值。
 *
 * **永不抛**——失败一律折成 `{ok:false, kind, error}` 由调用方转成文本（MCP 会把抛出的
 * handler 变成 isError，是本模块的红线）。
 */
export async function runEval(
  script: string,
  opts: EvalOptions,
  emit: (e: ChatEvent) => void,
): Promise<EvalResult> {
  const attempt = await evalAttempt(script, opts, emit);
  if (!attempt.ok) return { ok: false, kind: attempt.kind, error: attempt.error };

  return {
    ok: true,
    value: attempt.value,
    via: attempt.via,
    viewId: attempt.viewId ?? opts.viewId,
    probe: { pending: attempt.pending },
  };
}
