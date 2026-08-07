/**
 * 滚动诊断环：回答「滚轮定格那一瞬——滚轮事件落在谁头上、scrollTop 被谁写了」。
 *
 * 背景：间歇性「对话区滚轮失效」（定格在上方某位置、『回到底部』按钮可用、
 * 切会话再切回自愈）。嵌套滚动陷阱 / 弹窗布局挤压 / 程序化 scrollTop 写入，
 * 三条嫌疑线的静态分析都已挖尽仍无法定案——病灶是状态性的，必须在用户日常
 * 使用中抓活现场。本模块就是那个现场采集器。
 *
 * 与 breadcrumbs 同构（环形缓冲 + 详情截断 + 捕获期监听，诊断永不影响业务）：
 * - wheel：document 捕获期全量记录——方向 dy + 目标描述符 tgt + 最近手势可滚
 *   祖先描述符 sa（Chromium 滚轮链式派发的实际消费者；对话区外的弹窗/dock
 *   死区也会留痕，sa=none 即滚轮落进了死区）；
 * - scroll / write / expand / ro / session / perm：由 useChatScroll 与 ChatPanel
 *   在关键路径显式 trail()——程序化 scrollTop 写入必留名（谁写的、写成多少）。
 *
 * 快照出口两个：window.__aideScrollTrail()（dev 控制台）与 App.vue 热键
 * Ctrl+Shift+D → diag_scroll_trail 落盘（release 无控制台，走这条）。
 */

export interface ScrollTrailEntry {
  /** epoch ms */
  t: number;
  kind: string;
  detail: string;
}

/** wheel/scroll 是高频事件（活跃滚动每秒数十~上百条），ring 给足 3000 ≈ 定格前
 *  约 30s 的现场；纯内存推送，无序列化。 */
const MAX_RING = 3000;
const MAX_DETAIL_LEN = 96;

const ring: ScrollTrailEntry[] = [];
let started = false;

/** 记录一条滚动轨迹。采集器与滚动主控（useChatScroll）共用此入口。 */
export function trail(kind: string, detail: string): void {
  ring.push({
    t: Date.now(),
    kind,
    detail: detail.length > MAX_DETAIL_LEN ? detail.slice(0, MAX_DETAIL_LEN) + "…" : detail,
  });
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
}

/** 元素 → "tag.首个类名" 简述（够认组件即可；SVG 的 className 非字符串，防御）。 */
function describeEl(el: Element | null): string {
  if (!el) return "?";
  const tag = (el.tagName ?? "?").toLowerCase();
  const first =
    typeof el.className === "string" ? (el.className.trim().split(/\s+/)[0] ?? "") : "";
  return first ? `${tag}.${first}` : tag;
}

/** 从事件目标向上找第一个用户手势可滚的元素（overflow-y: auto|scroll）——
 *  即 Chromium 滚轮链式派发的实际消费者。一路到顶都没有 → "none"：滚轮落进
 *  死区（如对话区外的 inline 弹窗），对话区永远收不到这个增量。 */
export function nearestGestureScroller(target: EventTarget | null): string {
  let el = target as Element | null;
  for (let hop = 0; el && hop < 12; hop++) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return describeEl(el);
    el = el.parentElement;
  }
  return "none";
}

/** 启动滚动采集。幂等；随窗口生命周期常驻，无需停止。 */
export function startScrollTrail(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  document.addEventListener(
    "wheel",
    (e) => {
      trail(
        "wheel",
        `dy=${Math.round(e.deltaY)} tgt=${describeEl(e.target as Element | null)} sa=${nearestGestureScroller(e.target)}`,
      );
    },
    { capture: true, passive: true }, // 纯观察：永不 preventDefault
  );
  if (typeof window !== "undefined") {
    (window as unknown as { __aideScrollTrail?: unknown }).__aideScrollTrail = () =>
      JSON.stringify(snapshotScrollTrail());
  }
}

/** 全量快照（落盘 / dev 控制台用）。返回拷贝，调用方随意处置。 */
export function snapshotScrollTrail(): ScrollTrailEntry[] {
  return ring.slice();
}

/** 测试辅助：重置模块状态。 */
export function resetScrollTrailForTest(): void {
  ring.length = 0;
}
