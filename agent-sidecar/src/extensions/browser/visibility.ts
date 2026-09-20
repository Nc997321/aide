/**
 * 页面可见性的判读与文案。
 *
 * # 为什么这是 agent 必须看到的信号
 *
 * 面板关闭、切标签、**任何 HTML 浮层盖上来**（权限弹窗也算），都会让这个视图
 * `SetIsVisible(false)`（`facade.rs:193` → `adapter/webview2/mod.rs:149`）。而 WebView2 对
 * 隐藏页面的处理是**内核级**的：不合成、rAF 停摆、timer 降频。
 *
 * 于是「等到某个过渡结束」「动画跑完再取样式」这类断言在隐藏视图里**永远不会成立**——
 * 不是页面没反应，是引擎根本不推进。这个信号以前完全不可观测，假阴性就被当成了结论
 * （2026-09-20 agent 实测反馈）。现在每次求值顺带取回它（`runEval` 的 `EvalProbe`）。
 *
 * # 输出纪律：只在隐藏时说
 *
 * `visible` 不必说；`unknown`（求值没跑到包装器的返回那一步，拿不到页面自述）
 * **也不说**——没有依据时说一句"可能不可见"，正是本模块要消灭的那种噪音。
 */
import type { PageVisibility } from "./runEval.js";

/**
 * 归一化 `document.visibilityState`。认不出的值（`prerender`、缺字段、类型错乱）一律 `unknown`
 * ——**不猜**。放在这里而不是各消费点：判据只有一处，漂移不了。
 */
export function readVisibility(raw: unknown): PageVisibility {
  return raw === "visible" || raw === "hidden" ? raw : "unknown";
}

/**
 * 隐藏视图的告警句。`consequence` = 对这个工具而言「隐藏」意味着什么（各调用点自己写，
 * 因为后果随工具而变：读是"内容可能没渲染完"，点是"点可能生效但后续过渡不推进"）。
 */
export function hiddenNote(visibility: PageVisibility, consequence: string): string | null {
  if (visibility !== "hidden") return null;
  return (
    `NOTE: this view is currently hidden from the engine (document.visibilityState = "hidden"). ` +
    consequence
  );
}

/** 结果文本 + 隐藏时的告警行（`visible`/`unknown` 原样返回）。 */
export function appendHiddenNote(
  text: string,
  visibility: PageVisibility,
  consequence: string,
): string {
  const note = hiddenNote(visibility, consequence);
  return note ? `${text}\n\n${note}` : text;
}
