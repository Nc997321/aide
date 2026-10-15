import { ref, type Ref } from "vue";
import { api, listen } from "../api";
import { useNotifications } from "./useNotifications";
import type { LspCapabilities } from "../types";

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
/** `${workspaceRoot}:${lang}` → server 可选能力开关（lsp_capabilities 缓存）。
 *  server 关闭/重启后旧值作废——enable/disableLsp 清该工作区缓存。 */
const capabilities = ref<Map<string, LspCapabilities>>(new Map());

let listening = false;
let unlistenDiag: (() => void) | null = null;
let unlistenDead: (() => void) | null = null;
let unlistenShowMsg: (() => void) | null = null;
/** 已对开关做过选择的工作区（会话前询问卡片据此消失）。来源：Host 回种的 decided，或任一端改开关的事件。 */
const lspDecidedWorkspaces = ref<Set<string>>(new Set());
let switchListening = false;
let unlistenSwitch: (() => void) | null = null;

/** 工作区根比较：分隔符与 Windows 盘符大小写差异不算不同（事件里的根来自 Host，
 *  可能是会话 cwd 的拼法，与 UI 持有的根字符串不完全一致）。 */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

function markDecided(workspaceRoot: string) {
  for (const r of lspDecidedWorkspaces.value) if (sameRoot(r, workspaceRoot)) return;
  lspDecidedWorkspaces.value = new Set(lspDecidedWorkspaces.value).add(workspaceRoot);
}

/** 按 Host 的权威值更新本端缓存（事件 / 回种共用）。 */
function applySwitch(workspaceRoot: string, enabled: boolean) {
  const next = new Set<string>();
  for (const r of lspEnabledWorkspaces.value) if (!sameRoot(r, workspaceRoot)) next.add(r);
  if (enabled) next.add(workspaceRoot);
  lspEnabledWorkspaces.value = next;
  const prefix = `${workspaceRoot}:`;
  const caps = new Map<string, LspCapabilities>();
  for (const [k, v] of capabilities.value) if (!k.startsWith(prefix)) caps.set(k, v);
  capabilities.value = caps;
}

/** 开关变更事件：询问卡片、标题栏、其他客户端任一处改了开关，Host 广播 `lsp-switch-changed`，
 *  本端缓存（标题栏开关、编辑器是否接 LSP）随之同步。 */
async function ensureSwitchListening() {
  if (switchListening) return;
  switchListening = true;
  unlistenSwitch = await listen<{ workspaceRoot: string; enabled: boolean }>("lsp-switch-changed", (ev) => {
    const p = ev.payload;
    applySwitch(p.workspaceRoot, p.enabled);
    // 任何一端写过开关 = 已决定（Host 的 set_lsp_enabled 同时落 decided）。
    markDecided(p.workspaceRoot);
    if (p.enabled) void ensureListening();
  });
}

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
    await ensureSwitchListening();
    await api.workspaceSetLspEnabled(workspaceRoot, true);
    markDecided(workspaceRoot);
    lspEnabledWorkspaces.value = new Set(lspEnabledWorkspaces.value).add(workspaceRoot);
    clearCapabilitiesForWorkspace(workspaceRoot);
    await ensureListening();
  }

  async function disableLsp(workspaceRoot: string) {
    if (!workspaceRoot) return;
    await api.lspShutdownWorkspace(workspaceRoot);
    await api.workspaceSetLspEnabled(workspaceRoot, false);
    markDecided(workspaceRoot);
    const next = new Set(lspEnabledWorkspaces.value);
    next.delete(workspaceRoot);
    lspEnabledWorkspaces.value = next;
    clearCapabilitiesForWorkspace(workspaceRoot);
    // 清该工作区诊断（lsp_shutdown_workspace 后端已 emit clear）
  }

  function isLspOn(workspaceRoot: string): boolean {
    if (!workspaceRoot) return false;
    for (const r of lspEnabledWorkspaces.value) if (sameRoot(r, workspaceRoot)) return true;
    return false;
  }

  function isLspDecided(workspaceRoot: string): boolean {
    for (const r of lspDecidedWorkspaces.value) if (sameRoot(r, workspaceRoot)) return true;
    return false;
  }

  /** 从 Host 回种某工作区的开关（权威值在 Host state；本端缓存以前只在本次运行点开关时写入，
   *  重启后一律显示「关」）。标题栏挂载 / 切工作区时调。 */
  async function refreshLspSwitch(workspaceRoot: string): Promise<{ enabled: boolean; decided: boolean } | null> {
    if (!workspaceRoot) return null;
    await ensureSwitchListening();
    const sw = await api.workspaceGetLspSwitch(workspaceRoot).catch(() => null);
    if (!sw) return null;
    applySwitch(workspaceRoot, sw.enabled);
    if (sw.decided) markDecided(workspaceRoot);
    if (sw.enabled) await ensureListening();
    return sw;
  }

  function diagnosticsFor(filePath: string): LspDiagnostic[] {
    return diagnostics.value.get(filePath) ?? [];
  }

  function clearDiagnostics() {
    diagnostics.value = new Map();
  }

  /** 查某语言 server 的可选能力开关（带缓存）。server 未启动/未就绪 → 默认全 false；
   *  server 后续就绪时调用方应重查（CodeEditor 的 isLspOn watch 触发 reconfigure）。 */
  async function getCapabilities(workspaceRoot: string, lang: string): Promise<LspCapabilities> {
    if (!workspaceRoot || !lang) return { implementationProvider: false, documentSymbolProvider: false, callHierarchyProvider: false, inlayHintProvider: false };
    const key = `${workspaceRoot}:${lang}`;
    const cached = capabilities.value.get(key);
    if (cached) return cached;
    try {
      const caps = await api.lspCapabilities(workspaceRoot, lang);
      capabilities.value = new Map(capabilities.value).set(key, caps);
      return caps;
    } catch {
      return { implementationProvider: false, documentSymbolProvider: false, callHierarchyProvider: false, inlayHintProvider: false };
    }
  }

  /** 清某工作区全部语言的 capability 缓存（server 重启后旧值作废）。 */
  function clearCapabilitiesForWorkspace(workspaceRoot: string) {
    const prefix = `${workspaceRoot}:`;
    const next = new Map<string, LspCapabilities>();
    for (const [k, v] of capabilities.value) if (!k.startsWith(prefix)) next.set(k, v);
    capabilities.value = next;
  }

  function __resetForTest() {
    lspEnabledWorkspaces.value = new Set();
    lspDecidedWorkspaces.value = new Set();
    diagnostics.value = new Map();
    capabilities.value = new Map();
    listening = false;
    unlistenDiag?.();
    unlistenDead?.();
    unlistenShowMsg?.();
    unlistenDiag = null;
    unlistenDead = null;
    unlistenShowMsg = null;
    switchListening = false;
    unlistenSwitch?.();
    unlistenSwitch = null;
  }

  return {
    lspEnabledWorkspaces,
    diagnostics,
    capabilities,
    enableLsp, disableLsp, isLspOn, isLspDecided, refreshLspSwitch, diagnosticsFor, clearDiagnostics, getCapabilities, clearCapabilitiesForWorkspace,
    __resetForTest,
  };
}
