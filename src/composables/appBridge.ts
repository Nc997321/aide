// 应用桥的外层一半：把沙箱 iframe 里的应用发来的消息变成一次调用，再把结果包成回信。
// 纯逻辑（不碰 DOM / IPC），宿主能力经 `BridgeHost` 注入，便于单测。
// 协议与 src-tauri/src/commands/aide_app.js 成对；设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md §3。

export interface ThemePayload {
  /** `--aide-*` 变量名 → 值。 */
  vars: Record<string, string>;
  colorScheme: string;
}

export interface BridgeHost {
  theme(): ThemePayload;
  toast(text: string): void;
  setBadge(count: number): void;
  /** 清单里申请了这项权限吗（只用于 GUI 自己答的方法；其余方法的权限在 Host 判）。 */
  hasPermission(permission: string): boolean;
  /** 往选中会话的输入框里填一段文字。只填不发。 */
  fillComposer(text: string): void;
  /** 在编辑器里打开面板所在工作区里的一个文件（路径相对工作区根），可带行号。 */
  openFile(path: string, line?: number): Promise<void>;
  /** 本窗口连着的 Host 是哪一种（窗口的属性，Host 自己不知道别人怎么连它）。 */
  hostKind(): Promise<HostKind>;
  /** 交给 Host（`app_call`）：权限在那边按清单裁决。 */
  hostCall(method: string, params: unknown): Promise<unknown>;
}

export type HostKind = "local" | "wsl" | "ssh";

/** 窗口 Host 的 key（`local` / `wsl:Debian` / `ssh:devbox`）→ 给应用看的种类。 */
export function hostKindOf(key: string): HostKind {
  return key.startsWith("wsl") ? "wsl" : key.startsWith("ssh") ? "ssh" : "local";
}

/** 应用给的工作区内相对路径：正斜杠、不许往上走、不许是绝对路径。与 Host 的 `safe_rel` 同一口径。 */
function isSafeRelPath(path: string): boolean {
  if (!path || path.length > 512 || path.startsWith("/") || /[\\:]/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * 文件树监听报来的「这些目录变了」（绝对路径）→ 给应用的 `fs` 事件（相对工作区根）。
 * 空数组 = 监听器说不清具体哪里变了，让应用全部重读；工作区之外的目录不给；
 * 一个都不剩（变的都在别处）就不打扰应用。
 */
export function projectTreeChange(dirs: string[], root: string): { dirs: string[] } | { full: true } | null {
  if (!root) return null;
  if (dirs.length === 0) return { full: true };
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const inside = new Set<string>();
  for (const dir of dirs.map(norm)) {
    if (dir === base) inside.add("");
    else if (dir.startsWith(`${base}/`)) inside.add(dir.slice(base.length + 1));
  }
  return inside.size ? { dirs: [...inside] } : null;
}

export type BridgeReply =
  | { aideApp: 1; id: number; ok: true; result: unknown }
  | { aideApp: 1; id: number; ok: false; error: string };

/** 给应用看的会话事件：只有「发生了什么」，**不带内容**（工具入参、输出、对话文本都不给）。 */
export type AppSessionEvent =
  | { type: "turn.start" | "turn.end"; sessionId: string }
  | { type: "tool.start"; sessionId: string; id: string; name: string }
  | { type: "tool.end"; sessionId: string; id: string; isError: boolean }
  | { type: "subagent.start" | "subagent.end"; sessionId: string; id: string }
  | { type: "subagent.tool"; sessionId: string; id: string; name: string };

/**
 * sidecar 的 `chat-event` → 给应用的事件。认不出的、不该给的一律 `null`。
 * 这是对外的稳定面：内部事件怎么改名加字段，应用看到的形状不跟着变。
 */
export function projectSessionEvent(raw: unknown): AppSessionEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const sessionId = typeof e.session_id === "string" ? e.session_id : "";
  const id = typeof e.id === "string" ? e.id : "";
  switch (e.type) {
    case "user_message":
      return { type: "turn.start", sessionId };
    case "message_stop":
      return { type: "turn.end", sessionId };
    case "tool_use_start":
      return typeof e.name === "string" ? { type: "tool.start", sessionId, id, name: e.name } : null;
    case "tool_result":
      return { type: "tool.end", sessionId, id, isError: e.is_error === true };
    case "subagent_start":
      return { type: "subagent.start", sessionId, id };
    case "subagent_end":
      return { type: "subagent.end", sessionId, id };
    case "subagent_progress":
      return typeof e.toolName === "string" ? { type: "subagent.tool", sessionId, id, name: e.toolName } : null;
    default:
      return null;
  }
}

const MAX_TOAST_CHARS = 300;
const MAX_BADGE = 999;
const MAX_COMPOSER_CHARS = 20_000;

/**
 * 处理一条来自应用的消息。不是桥消息（别的 postMessage）返回 `null`，调用方忽略即可。
 * 主题、通知、角标、往输入框填字在 GUI 这边答（都是「屏幕」的事）；其余一律转给 Host。
 */
export async function handleBridgeMessage(data: unknown, host: BridgeHost): Promise<BridgeReply | null> {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.aideApp !== 1 || typeof msg.id !== "number" || typeof msg.method !== "string") return null;
  const { id, method } = msg;
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Record<string, unknown>;
  try {
    return { aideApp: 1, id, ok: true, result: await dispatch(method, params, host) };
  } catch (e) {
    return { aideApp: 1, id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function dispatch(method: string, params: Record<string, unknown>, host: BridgeHost): Promise<unknown> {
  switch (method) {
    case "theme.get":
      return host.theme();
    case "ui.toast": {
      const text = String(params.text ?? "").trim();
      if (!text) throw new Error("ui.toast 需要 text");
      host.toast(text.slice(0, MAX_TOAST_CHARS));
      return null;
    }
    case "ui.setBadge": {
      const count = Number(params.count);
      host.setBadge(Number.isFinite(count) ? Math.max(0, Math.min(MAX_BADGE, Math.floor(count))) : 0);
      return null;
    }
    case "composer.fill": {
      if (!host.hasPermission("composer")) throw new Error("应用没有申请权限「composer」，不能调用 composer.fill");
      const text = typeof params.text === "string" ? params.text : "";
      if (!text.trim()) throw new Error("composer.fill 需要 text");
      host.fillComposer(text.slice(0, MAX_COMPOSER_CHARS));
      return null;
    }
    case "editor.open": {
      if (!host.hasPermission("workspace:read")) throw new Error("应用没有申请权限「workspace:read」，不能调用 editor.open");
      const path = typeof params.path === "string" ? params.path : "";
      if (!isSafeRelPath(path)) throw new Error("editor.open 需要 path（工作区内的相对路径）");
      const line = Number(params.line);
      await host.openFile(path, Number.isInteger(line) && line > 0 ? line : undefined);
      return null;
    }
    // Host 答它知道的；「这扇窗口怎么连着它」只有 GUI 知道，在这里补上
    case "host.info":
    case "workspace.info": {
      const info = await host.hostCall(method, params);
      return typeof info === "object" && info !== null ? { ...info, host: await host.hostKind() } : info;
    }
    default:
      return host.hostCall(method, params);
  }
}
