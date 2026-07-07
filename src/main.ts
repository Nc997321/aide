import { createApp } from "vue";
import App from "./App.vue";
import "./styles/global.css";
import { vTooltip } from "./directives/tooltip";
import { vScrollMemory } from "./directives/scrollMemory";

// ── Global error capture → Rust tracing log ──

async function captureError(kind: string, msg: string, source?: string, lineno?: number, colno?: number, err?: unknown) {
    const detail = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err || "");
    const line = `[${kind}] ${msg} | ${source || ""}:${lineno || 0}:${colno || 0} | ${detail}`;
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
    captureError("ONERROR", e.message, e.filename, e.lineno, e.colno, e.error);
});

window.addEventListener("unhandledrejection", (e) => {
    captureError("UNHANDLED_REJECTION", String(e.reason), "", 0, 0, e.reason);
});

const app = createApp(App);
app.directive("tooltip", vTooltip);
app.directive("scroll-memory", vScrollMemory);
app.mount("#app");
