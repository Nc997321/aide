// 复跑：pnpm exec vite --host 127.0.0.1 --port 5199
// /docs/prototypes/_harness/browser-start-live.html?theme=warm-dark&width=380
// 只替换宿主边界，页面、菜单、收藏和最近使用均为正式组件；使用独立的 fixture Host 存储键。
import { createApp } from "vue";
import { setTransport } from "@aide/sdk";
import { applyTheme, themes } from "../../../src/themes";
import { vTooltip } from "../../../src/directives/tooltip";
import { useRightPanel } from "../../../src/composables/useRightPanel";
import BrowserPanel from "../../../src/components/Browser/BrowserPanel.vue";
import "../../../src/styles/global.css";
import type { BrowserRecent } from "../../../src/composables/browser/useBrowserHistory";

const parameters = new URLSearchParams(location.search);
applyTheme(themes[parameters.get("theme") ?? "smoky-pink-glass"] ?? themes.glass);
const requestedWidth = Number(parameters.get("width") ?? 1100);
if (Number.isFinite(requestedWidth)) document.documentElement.style.setProperty("--fixture-width", `${Math.max(320, Math.min(1180, requestedWidth))}px`);

const bookmarks = [
  { id: "f1", title: "DSSAT · 农业系统模型", url: "https://dssat.net/", folders: ["工作资料"], added_at: 1 },
  { id: "f2", title: "GitHub", url: "https://github.com/", folders: [], added_at: 2 },
];
function mockCommand(command: string): unknown {
  if (command === "window_host") return { key: "fixture:browser-start", label: "示例 Host" };
  if (command === "browser_views_list") return [];
  if (command === "browser_bookmarks_list") return bookmarks;
  if (command === "browser_favicons") return {};
  if (command === "plugin:event|listen") return 1;
  throw new Error(`夹具未实现宿主命令：${command}`);
}

Reflect.set(window, "__TAURI_INTERNALS__", {
  invoke: async (command: string) => mockCommand(command),
  transformCallback: () => 1,
  unregisterCallback: () => {},
});
setTransport({
  invoke: async <T>(command: string): Promise<T> => mockCommand(command) as T,
  listen: async () => () => {},
});

const now = Date.now();
const records: BrowserRecent[] = [
  { kind: "creation", mode: "create", title: "Aide 功能介绍短片", visitedAt: now, target: { kind: "session", key: "fixture-session" } },
  { kind: "web", title: "DSSAT · 农业系统模型", url: "https://dssat.net/", visitedAt: now - 600000 },
  { kind: "media", title: "产品演示录屏.mp4", path: "/demo/product-recording.mp4", visitedAt: now - 1200000, target: { kind: "session", key: "fixture-session" } },
  { kind: "creation", mode: "edit", title: "产品录屏 · 节奏与字幕", visitedAt: now - 1800000, target: { kind: "session", key: "fixture-session" } },
  { kind: "web", title: "FAO · Training materials", url: "https://www.fao.org/", visitedAt: now - 86400000 },
];
localStorage.setItem("aide:browser-history:v1:fixture:browser-start", JSON.stringify({ version: 1, records, showBookmarkBar: false }));
useRightPanel().ensureBrowserShown();
createApp(BrowserPanel).directive("tooltip", vTooltip).mount("#app");
