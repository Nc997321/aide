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
  /** 交给 Host（`app_call`）：权限在那边按清单裁决。 */
  hostCall(method: string, params: unknown): Promise<unknown>;
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
    default:
      return host.hostCall(method, params);
  }
}
