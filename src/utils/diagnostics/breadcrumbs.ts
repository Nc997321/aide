/**
 * 用户操作面包屑：捕获期监听三类事件，回答「卡死前用户在干什么」。
 *
 * - click：提取最近的可交互祖先的标签文本（aria-label / title / 按钮文字）；
 * - keydown：只记 Enter / Escape（发消息、关弹窗等关键动作，不记普通打字）；
 * - visibilitychange：窗口前后台切换（watchdog 判定抑制的依据之一）。
 *
 * 双缓冲：`pending` 每次心跳被 drain 走（增量随心跳进 Rust 环形缓冲），
 * `ring` 保留最近 MAX_RING 条全量快照（冻结补交用）。
 */

export interface Crumb {
  /** epoch ms */
  t: number;
  kind: string;
  detail: string;
}

const MAX_RING = 100;
/** 单次心跳最多带走的增量条数（防 payload 膨胀），超出部分下次心跳继续带 */
const MAX_PER_DRAIN = 20;
const MAX_DETAIL_LEN = 60;

const ring: Crumb[] = [];
let pending: Crumb[] = [];
let started = false;

/** 记录一条面包屑。采集器内部使用；业务代码将来也可显式调用。 */
export function crumb(kind: string, detail: string): void {
  const c: Crumb = {
    t: Date.now(),
    kind,
    detail: detail.length > MAX_DETAIL_LEN ? detail.slice(0, MAX_DETAIL_LEN) + "…" : detail,
  };
  ring.push(c);
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
  pending.push(c);
}

/** click 目标 → 人可读标签：就近可交互祖先的 aria-label/title/文本。
 *  鸭子类型探测，不依赖 Element 全局（node 环境也可测）。 */
export function describeClickTarget(target: EventTarget | null): string {
  const el = target as unknown as {
    closest?: (sel: string) => Element | null;
    getAttribute?: (name: string) => string | null;
    textContent?: string;
    tagName?: string;
  } | null;
  if (!el || typeof el.closest !== "function") return "?";
  const interactive = el.closest("[aria-label],[title],button,a,[role=button],[role=tab]") ?? (el as Element);
  const label =
    interactive?.getAttribute?.("aria-label") ||
    interactive?.getAttribute?.("title") ||
    (interactive?.textContent ?? "").trim().replace(/\s+/g, " ");
  const tag = (interactive?.tagName ?? "").toLowerCase();
  return label ? `${tag}[${label.slice(0, 40)}]` : tag;
}

export function startBreadcrumbs(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  document.addEventListener(
    "click",
    (e) => crumb("click", describeClickTarget(e.target)),
    { capture: true, passive: true },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      const tag =
        e.target && typeof (e.target as Element).tagName === "string"
          ? (e.target as Element).tagName.toLowerCase()
          : "?";
      const mods = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt"]
        .filter(Boolean)
        .join("+");
      crumb("key", `${mods ? mods + "+" : ""}${e.key}@${tag}`);
    },
    { capture: true, passive: true },
  );
  document.addEventListener("visibilitychange", () =>
    crumb("visibility", document.hidden ? "hidden" : "visible"),
  );
}

/** 取走自上次心跳以来的增量（每次最多 MAX_PER_DRAIN 条，剩余下次带走）。 */
export function drainPending(): Crumb[] {
  const out = pending.slice(0, MAX_PER_DRAIN);
  pending = pending.slice(MAX_PER_DRAIN);
  return out;
}

/** 冻结补交用：最近 MAX_RING 条全量快照。 */
export function snapshotAll(): Crumb[] {
  return ring.slice();
}

/** 测试辅助：重置模块状态。 */
export function resetBreadcrumbsForTest(): void {
  ring.length = 0;
  pending = [];
}
