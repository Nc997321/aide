// 内嵌浏览器面板的纯逻辑（无 DOM、无 IPC）：URL 归一、标签标题、事件载荷还原。
//
// 抽出来的理由与其它 utils 一致：组件只留接线，判定规则可单测（`browser.test.ts`）。
import type { NavEventDto, NavStateDto } from "../composables/useEmbeddedBrowser";

/**
 * 地址栏输入归一：裸域名补 `https://`（UX 便利）；带 scheme 的原样交给后端 `url_guard` 守门
 * —— scheme 白名单在 Rust 侧是唯一真相，前端不复制一份（否则两处规则会漂移）。
 */
export function normalizeBrowserUrl(raw: string): string {
  const t = raw.trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`;
}

/** 从导航状态里取当前 URL（`idle` 没有 URL）。 */
export function urlOfNav(nav: NavStateDto | null): string {
  return nav && "url" in nav ? nav.url : "";
}

/**
 * 标签页标题。
 *
 * v1 用**主机名**：真标题要 WebView2 `DocumentTitleChanged`（下一批 webview2-com），当前
 * tauri/wry 都没有暴露取标题的接口（已核实）——所以这里不编造标题，只展示 URL 里真实存在的部分。
 */
export function tabLabelOf(url: string): string {
  if (!url) return "新标签页";
  try {
    return new URL(url).host || url;
  } catch {
    return url; // 未归一/畸形输入：原样显示，不猜
  }
}

/**
 * 事件载荷 → 纯导航状态。事件是 `{id, can_go_*, ...NavStateDto}` 的**拍平**形态（Rust
 * `#[serde(flatten)]`），这里按 `state` 判别式还原成判别联合——显式分支，不用 rest 解构，
 * 免掉类型断言（形状契约由 Rust 侧 `nav_event_serializes_flat_for_frontend` 钉住）。
 */
export function navOfEvent(e: NavEventDto): NavStateDto {
  switch (e.state) {
    case "idle":
      return { state: "idle" };
    case "loading":
      return { state: "loading", url: e.url };
    case "ready":
      return { state: "ready", url: e.url, title: e.title };
    case "failed":
      return { state: "failed", url: e.url, reason: e.reason };
  }
}
