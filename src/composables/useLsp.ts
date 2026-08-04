import { ref, type Ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { useNotifications } from "./useNotifications";

/** LSP 诊断（最小字段，cmLsp 映射成 CM Diagnostic）。 */
export interface LspDiagnostic {
  fromLine: number; toLine: number;       // 0-based
  fromCol: number; toCol: number;         // 0-based
  severity: "error" | "warning" | "info";
  message: string;
}

// ── 模块单例 ──
/** 已开启 LSP 的工作区根集合（前端缓存；权威值在后端 state JSON）。 */
const lspEnabledWorkspaces = ref<Set<string>>(new Set());
/** filePath → 该文件当前诊断（来自 lsp-diagnostics 事件，按 uri 过滤）。 */
const diagnostics = ref<Map<string, LspDiagnostic[]>>(new Map());

let listening = false;
let unlistenDiag: UnlistenFn | null = null;
let unlistenDead: UnlistenFn | null = null;
let unlistenShowMsg: UnlistenFn | null = null;

async function ensureListening() {
  if (listening) return;
  listening = true;
  unlistenDiag = await listen<{
    workspaceRoot: string; uri: string; diagnostics: any[]; version?: number | null; clear?: boolean;
  }>("lsp-diagnostics", (ev) => {
    const p = ev.payload;
    if (p.clear) {
      // 清该工作区全部诊断（关区/关 LSP）
      const next = new Map(diagnostics.value);
      for (const k of [...next.keys()]) next.delete(k);
      diagnostics.value = next;
      return;
    }
    const filePath = uriToPath(p.uri);
    if (!filePath) return;
    const next = new Map(diagnostics.value);
    next.set(filePath, (p.diagnostics || []).map(mapDiag));
    diagnostics.value = next;
  });
  // spec §8：server 死 → toast 提示（诊断保留，下次 did_open 重拉）。
  // dedupKey 用全局键——事件无 payload，重复 dead 经 dedup 合并不刷屏。
  unlistenDead = await listen("lsp-server-dead", () => {
    useNotifications().push({
      severity: "warning",
      source: "lsp",
      title: "LSP server exited",
      body: "Will respawn on next file open.",
      timestamp: Date.now(),
      dedupKey: "lsp:server-dead",
    });
  });
  // spec §8：window/showMessage（server 主动弹消息）→ toast。
  // dedupKey 带消息内容，相同消息重复合并，不同消息各自一条。
  unlistenShowMsg = await listen<string>("lsp-show-message", (ev) => {
    const msg = (ev.payload as string) || "";
    useNotifications().push({
      severity: "info",
      source: "lsp",
      title: "LSP message",
      body: msg,
      timestamp: Date.now(),
      dedupKey: `lsp:show-message:${msg}`,
    });
  });
}

function uriToPath(uri: string): string | null {
  if (uri.startsWith("file:///")) return uri.slice("file:///".length);
  if (uri.startsWith("file://")) return uri.slice("file://".length);
  return null;
}

function mapDiag(d: any): LspDiagnostic {
  const start = d.range?.start ?? { line: 0, character: 0 };
  const end = d.range?.end ?? start;
  const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
  return {
    fromLine: start.line, toLine: end.line,
    fromCol: start.character, toCol: end.character,
    severity: sev, message: d.message ?? "",
  };
}

export function useLsp() {
  async function enableLsp(workspaceRoot: string) {
    if (!workspaceRoot) return;
    await api.workspaceSetLspEnabled(workspaceRoot, true);
    lspEnabledWorkspaces.value = new Set(lspEnabledWorkspaces.value).add(workspaceRoot);
    await ensureListening();
  }

  async function disableLsp(workspaceRoot: string) {
    if (!workspaceRoot) return;
    await api.lspShutdownWorkspace(workspaceRoot);
    await api.workspaceSetLspEnabled(workspaceRoot, false);
    const next = new Set(lspEnabledWorkspaces.value);
    next.delete(workspaceRoot);
    lspEnabledWorkspaces.value = next;
    // 清该工作区诊断（lsp_shutdown_workspace 后端已 emit clear）
  }

  function isLspOn(workspaceRoot: string): boolean {
    return lspEnabledWorkspaces.value.has(workspaceRoot);
  }

  function diagnosticsFor(filePath: string): LspDiagnostic[] {
    return diagnostics.value.get(filePath) ?? [];
  }

  function clearDiagnostics() {
    diagnostics.value = new Map();
  }

  function __resetForTest() {
    lspEnabledWorkspaces.value = new Set();
    diagnostics.value = new Map();
    listening = false;
    unlistenDiag?.();
    unlistenDead?.();
    unlistenShowMsg?.();
    unlistenDiag = null;
    unlistenDead = null;
    unlistenShowMsg = null;
  }

  return {
    lspEnabledWorkspaces,
    diagnostics,
    enableLsp, disableLsp, isLspOn, diagnosticsFor, clearDiagnostics,
    __resetForTest,
  };
}
