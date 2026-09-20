/**
 * 页面截图（agent 的**视觉兜底**，不是读页面的主通道）。
 *
 * # 为什么是兜底而不是主通道
 *
 * 截图给的是**像素**，不是结构：一张图占的上下文远超等量的结构化文本，而且坐标、字重、层级
 * 都要靠眼睛估。读页面永远优先 `browser_read`（骨架）→ `browser_eval`（自定义抽取）。
 *
 * 但有一类问题 DOM 答不了：**「用户此刻看到的到底是哪一块」**。绝对定位堆叠的画布
 * （设计工具导出的原型就是）里，元素都在 DOM 里、但只有一个面板是可见的——`getBoundingClientRect`
 * 能反推，只是慢且易错。这种视觉判断正是截图该上场的地方。
 * （2026-09-16 agent 实测原话："我是靠 getBoundingClientRect 反推版面坐标才确认用户看到的
 * 到底是哪一块，有截图会快很多。"）
 *
 * # 实现选择：走 CDP，不走端口的 `capture`
 *
 * 端口上声明了 `capture`（Windows 侧对应 `ICoreWebView2::CapturePreview`），但那条路要新建
 * `IStream`、加 `windows` feature、读流——全是未验证的新代码。而 `Page.captureScreenshot` 走的是
 * **已有的 `call_cdp` op**：端口能力本身，本机已证明可用，还白得 `captureBeyondViewport`（整页）。
 *
 * 所以这里不是绕过端口，是**组合端口**——和 `browser_read` 组合 `eval` 同一个范式。
 * 端口上的 `capture` 留作 CDP 不可用时的兜底实现（尚未实现，如实标注）。
 *
 * # 先判可见，再截图（2026-09-20）
 *
 * 隐藏的视图**截不了图**：WebView2 的隐藏是内核级的（不合成、rAF 停摆），`Page.captureScreenshot`
 * 等不到帧就是 10s 超时（`native.rs` 的 `NATIVE_TIMEOUT`），而那条超时文案还说 `view closed`——
 * 真机实测（rAF 一帧不跑、JS 上下文却活着）之后，改成本模块**先探可见性**：隐藏 → 立即如实失败。
 * 探测结果顺带交给调用方做 caption，**同一轮不再二次探测**。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { probeVisibility } from "./runEval.js";
import type { PageVisibility } from "./runEval.js";

/**
 * 图像格式。默认 **jpeg**。
 *
 * UI 截图用 jpeg q80 通常比 PNG 小 **5–10 倍**——PNG 无损，但在大面积纯色与文字上并不省，
 * 而截图会进**会话历史**（每次调用给转录加一份 base64，且后续每轮重发给模型），所以体积
 * 是实打实的成本。代价是压缩伪影：对「用户此刻看到哪一块」这类判断完全够用，
 * 要像素级保真时再显式要 `png`。
 */
export type ScreenshotFormat = "jpeg" | "png";

/** jpeg 质量。80 是"肉眼几乎无差 + 体积骤降"的常用折中。 */
const JPEG_QUALITY = 80;

export interface ScreenshotOutcome {
  ok: boolean;
  /** base64 图像（`ok` 时必有）。 */
  data?: string;
  /** 与 `data` 匹配的 MIME——**必须回给模型**，猜错会让图像被当成坏数据丢掉。 */
  mimeType?: string;
  error?: string;
  /**
   * 截图**之前**探到的页面可见性。caption 直接复用它——同一轮里再探一次没有新信息，
   * 白多一发往返（这条路径本来就是最贵的那条）。
   */
  visibility: PageVisibility;
}

/**
 * 隐藏视图的失败文案：**不试**。
 *
 * 说清三件事，缺一条模型就会去猜：① 原因（视图隐藏、引擎不合成帧，不是页面问题）；
 * ② 谁把它藏了（右栏折叠 / 别的 tab 在前 / 有浮层）；③ 出路（让用户把浏览器 tab 切到前台，
 * 或改用对隐藏视图同样有效的 `browser_read` / `browser_eval`）。
 */
const HIDDEN_ERROR =
  'Not taken: this browser view is hidden from the engine (document.visibilityState = "hidden"), and a ' +
  "hidden WebView2 stops compositing — Page.captureScreenshot cannot get a frame, so the call would hang " +
  "until it timed out. This is an Aide/engine state, not a page problem. The view is hidden whenever its " +
  "panel is not showing: the right panel is collapsed, another right-panel tab (Files / Changes / Git / …) " +
  "is active, or an overlay (settings, command palette, permission dialog) is up. Ask the user to bring the " +
  "Browser tab to the front, or use browser_read / browser_eval — both work on hidden views.";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** CDP 回包形状：`{view_id, method, value}`，value 即 CDP 的响应体（成功 `{data}`，失败 `{error}`）。 */
function cdpValue(data: unknown): unknown {
  return asRecord(data)?.["value"];
}

/**
 * 截图。`fullPage` = 整页（`captureBeyondViewport`），否则只截**视口**（用户实际看到的那一块）。
 *
 * 默认视口是有意的：agent 要回答的大多是"用户现在看到什么"，整页反而引入屏幕外的噪音。
 */
export async function captureScreenshot(
  viewId: string | undefined,
  opts: { fullPage: boolean; format: ScreenshotFormat },
  emit: (e: ChatEvent) => void,
): Promise<ScreenshotOutcome> {
  // 先判可见：隐藏视图的截图注定超时，不如立刻如实失败（见文件头「先判可见，再截图」）。
  const visibility = await probeVisibility(viewId, emit);
  if (visibility === "hidden") return { ok: false, error: HIDDEN_ERROR, visibility };

  const params: Record<string, unknown> = { format: opts.format };
  // `quality` 只对 jpeg 有意义（CDP 对 png 传它会报错，别顺手带上）。
  if (opts.format === "jpeg") params["quality"] = JPEG_QUALITY;
  if (opts.fullPage) params["captureBeyondViewport"] = true;

  const resp = await queryBrowser(
    { op: "call_cdp", view_id: viewId, method: "Page.captureScreenshot", params },
    emit,
  );
  if (!resp.ok) {
    return {
      ok: false,
      visibility,
      error: resp.timedOut
        ? "Screenshot timed out — the desktop host did not reply. A view hidden mid-call cannot produce a " +
          "frame; the view may also have been closed."
        : `Screenshot failed: ${resp.error ?? "unknown error"}`,
    };
  }

  const value = asRecord(cdpValue(resp.data));
  // CDP 的约定：方法级错误**不算调用失败**，而是回一个 `{error: {code, message}}` 响应体。
  const cdpError = asRecord(value?.["error"]);
  if (cdpError) {
    return {
      ok: false,
      visibility,
      error:
        `Page.captureScreenshot was rejected by the runtime: ${String(cdpError["message"] ?? cdpError["code"] ?? "unknown")}. ` +
        `This is a WebView2 runtime capability, not a page problem — fall back to browser_read / browser_eval.`,
    };
  }

  const data = value?.["data"];
  if (typeof data !== "string" || data.length === 0) {
    return {
      ok: false,
      visibility,
      error: "Page.captureScreenshot returned no image data (the runtime accepted the call but sent nothing back).",
    };
  }
  return { ok: true, data, mimeType: `image/${opts.format}`, visibility };
}
