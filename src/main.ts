import { createApp } from "vue";
import App from "./App.vue";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/global.css";
import { installTitleTooltips, vTooltip } from "./directives/tooltip";
import { vScrollMemory } from "./directives/scrollMemory";
import { initPlatform } from "./utils/platform";
import { startDiagnostics } from "./composables/useDiagnostics";
import { useNotifications } from "./composables/useNotifications";
import { pushKnowledgeRuntime } from "./components/KnowledgeBase/kbRuntime";

// Detect Windows build number early for xterm.js ConPTY integration.
// Async but non-blocking — terminal creation happens later.
initPlatform();

// ── Global error capture → Rust tracing log ──

async function captureError(kind: string, msg: string, info: { source?: string; lineno?: number; colno?: number; err?: unknown } = {}) {
    const { source, lineno, colno, err } = info;
    const detail = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err ?? "");
    const line = `[${kind}] ${msg} | ${source ?? ""}:${lineno ?? 0}:${colno ?? 0} | ${detail}`;
    try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("log_frontend_error", { message: line });
    } catch {
        // Can't even invoke — write to localStorage as fallback
        try {
            const prev = localStorage.getItem("aide-errors") || "";
            localStorage.setItem("aide-errors", prev + line + "\n");
        } catch { /* nothing we can do */ }
    }
}

window.addEventListener("error", (e) => {
    captureError("ONERROR", e.message, { source: e.filename, lineno: e.lineno, colno: e.colno, err: e.error });
});

window.addEventListener("unhandledrejection", (e) => {
    captureError("UNHANDLED_REJECTION", String(e.reason), { err: e.reason });
});

const app = createApp(App);
app.directive("tooltip", vTooltip);
app.directive("scroll-memory", vScrollMemory);
app.mount("#app");

// 原生 title 提示统一换成主题化提示（与 v-tooltip 同外观），见 installTitleTooltips
installTitleTooltips();

// 卡死诊断黑匣子：心跳 + 指标采集（Rust watchdog 检测断流落盘报告）
startDiagnostics();

// 通知中心：启动时从盘注入历史 error/warning 通知（未读）。
useNotifications().hydrate();

// 知识库凭据镜像到主进程（agent 侧 aide-knowledge 工具每次调用现读该文件）
void pushKnowledgeRuntime();
