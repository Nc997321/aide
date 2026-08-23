import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function settingsFile(): string {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".aide", "claude");
  return join(home, "settings.json");
}

function readSettings(): Record<string, any> {
  const p = settingsFile();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) ?? {}; }
  catch { return {}; } // 损坏 → 空，不阻断会话
}

/** 过滤 disabled:true 的 mcpServer，原样透传 config（stdio/sse/http）。 */
export function loadUserMcpServers(): Record<string, any> {
  const servers = readSettings().mcpServers;
  if (!servers || typeof servers !== "object") return {};
  const out: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(servers as Record<string, any>)) {
    if (cfg && cfg.disabled === true) continue; // sidecar 过滤，SDK 不认 disabled
    out[name] = cfg;
  }
  return out;
}

type HookEntry = { matcher?: string; hooks: any[]; disabled?: boolean };
type HooksByEvent = Record<string, { matcher?: string; hooks: any[] }[]>;

/** 过滤 disabled 的 hook 条目，按事件分组（SDK hooks option 形状）。 */
export function loadUserHooks(): HooksByEvent {
  const hooks = readSettings().hooks;
  if (!hooks || typeof hooks !== "object") return {};
  const out: HooksByEvent = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, HookEntry[]>)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => e && e.disabled !== true && Array.isArray(e.hooks) && e.hooks.length > 0);
    if (kept.length > 0) out[event] = kept.map((e) => ({ matcher: e.matcher, hooks: e.hooks }));
  }
  return out;
}

/** 合并 codegraph（in-process）与用户 mcpServers（stdio/sse/http），name 不冲突即可。 */
export function assembleMcpServers(codegraph: Record<string, any> | null, user: Record<string, any>): Record<string, any> {
  return { ...(codegraph ?? {}), ...user };
}

/** 合并内建 hook（前）与用户 hook（后），按事件分组。内建不可被越过。 */
export function assembleHooks(builtin: { PreToolUse: any[]; Stop: any[] }, user: Record<string, any>): Record<string, any> {
  const events = new Set<string>(["PreToolUse", "Stop", ...Object.keys(user)]);
  const out: Record<string, any> = {};
  for (const ev of events) {
    const b = (builtin as Record<string, unknown[]>)[ev] ?? [];
    const u = user[ev] ?? [];
    const merged = [...b, ...u];
    if (merged.length > 0) out[ev] = merged;
  }
  return out;
}
