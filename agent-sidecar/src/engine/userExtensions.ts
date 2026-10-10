import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { compileCommandHook } from "./commandHooks.js";

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

/** 路径比较用的归一：分隔符统一、去尾斜杠；Windows 上不分大小写。 */
function normPath(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/**
 * 侧栏应用的后端（MCP server）：Host 把「已同意、已启用、带后端」的应用算好，落在
 * `~/.aide/app-data/mcp-servers.json`，这里只读结果——**同意与否只在 Host 判**，不在 TS 里
 * 再实现一遍。开发态应用（工作区 `.aide/apps`）的条目带 `workspace`，只挂给那个工作区的会话。
 * 设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md §5。
 */
export function loadAppMcpServers(cwd: string | undefined): Record<string, any> {
  return loadAppMcp(cwd).servers;
}

/** 权限规则里的名字段：server 名与工具名都只认这些字符（规则是字符串拼出来的）。 */
const RULE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 同上，外加**免确认的工具级规则**（`mcp__app-<id>__<工具>`）：Host 认定的只读工具——
 * 只有安装版应用自己标了 `readOnlyHint` 的才会出现在 `readOnlyTools` 里，开发态一律为空。
 * 其余工具照常走权限确认。
 */
export function loadAppMcp(cwd: string | undefined): { servers: Record<string, any>; allowRules: string[] } {
  const aideHome = process.env.CLAUDE_CONFIG_DIR ? dirname(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".aide");
  const file = join(aideHome, "app-data", "mcp-servers.json");
  const none = { servers: {}, allowRules: [] };
  if (!existsSync(file)) return none;
  let entries: unknown;
  try { entries = JSON.parse(readFileSync(file, "utf8")); }
  catch { return none; } // 损坏 → 空，不阻断会话
  if (!Array.isArray(entries)) return none;
  const servers: Record<string, any> = {};
  const allowRules: string[] = [];
  for (const e of entries as { name?: unknown; workspace?: unknown; config?: unknown; readOnlyTools?: unknown }[]) {
    if (!e || typeof e.name !== "string" || !e.config || typeof e.config !== "object") continue;
    if (typeof e.workspace === "string" && (!cwd || normPath(e.workspace) !== normPath(cwd))) continue;
    servers[e.name] = e.config;
    if (!RULE_NAME.test(e.name) || !Array.isArray(e.readOnlyTools)) continue;
    for (const tool of e.readOnlyTools) {
      if (typeof tool === "string" && RULE_NAME.test(tool)) allowRules.push(`mcp__${e.name}__${tool}`);
    }
  }
  return { servers, allowRules };
}

type HookEntry = { matcher?: string; hooks: unknown[]; disabled?: boolean };
export type CompiledHooksByEvent = Record<string, { matcher?: string; hooks: HookCallback[] }[]>;

/** loadUserHooks 的编译上下文（cwd = 会话工作目录，hook 子进程的工作目录）。 */
export interface UserHooksContext {
  cwd: string | undefined;
}

/** 过滤 disabled 条目、把 command 型条目编译成 SDK HookCallback（F4：options.hooks
 *  只认函数，纯数据条目直接透传会在 hook 触发时 TypeError 断掉工具管线），按事件
 *  分组（SDK hooks option 形状）。编译失败的条目丢弃（compileCommandHook 内部已
 *  记日志；命令原文不落日志，N5）。 */
export function loadUserHooks(ctx: UserHooksContext): CompiledHooksByEvent {
  const hooks = readSettings().hooks;
  if (!hooks || typeof hooks !== "object") return {};
  const out: CompiledHooksByEvent = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, HookEntry[]>)) {
    if (!Array.isArray(entries)) continue;
    const groups: { matcher?: string; hooks: HookCallback[] }[] = [];
    for (const e of entries) {
      if (!e || e.disabled === true || !Array.isArray(e.hooks) || e.hooks.length === 0) continue;
      const compiled = e.hooks
        .map((h) => compileCommandHook(h, { event, cwd: ctx.cwd }))
        .filter((h): h is HookCallback => h !== null);
      if (compiled.length > 0) groups.push({ matcher: e.matcher, hooks: compiled });
    }
    if (groups.length > 0) out[event] = groups;
  }
  return out;
}

/** 合并内建（in-process）与用户 mcpServers（stdio/sse/http），name 不冲突即可。 */
export function assembleMcpServers(builtin: Record<string, any> | null, user: Record<string, any>): Record<string, any> {
  return { ...(builtin ?? {}), ...user };
}

/** 合并内建 hook（前）与用户 hook（后），按事件分组。内建不可被越过。
 *  事件集合必须覆盖内建侧已用的全部事件——漏列会让该事件的内建 hook 静默丢失。
 *  末道守卫（F4 根因红线）：进 options.hooks 的条目必须是函数——SDK 把条目
 *  原样注册进 hookCallbacks 并在触发时按函数调用，非函数 = TypeError = 工具
 *  管线断流。上游（loadUserHooks 编译）已保证，这里防未来形状漂移。 */
export function assembleHooks(
  builtin: { PreToolUse: any[]; Stop: any[]; PostToolUse?: any[] },
  user: Record<string, { matcher?: string; hooks: unknown[] }[]>,
): Record<string, any> {
  // 事件顺序守恒：PreToolUse → Stop 固定在前（既有契约），内建新增事件随后，
  // 用户事件最后；同一事件组内内建 hook 不可被越过。
  const events = new Set<string>([
    "PreToolUse",
    "Stop",
    ...Object.keys(builtin),
    ...Object.keys(user),
  ]);
  const out: Record<string, any> = {};
  for (const ev of events) {
    const b = (builtin as Record<string, unknown[]>)[ev] ?? [];
    const u = user[ev] ?? [];
    const merged = [...b, ...u]
      .map((g) => {
        const group = g as { matcher?: string; hooks?: unknown[] };
        const fns = (group.hooks ?? []).filter((h) => typeof h === "function");
        if (fns.length !== (group.hooks ?? []).length) {
          console.error(`[hooks] ${ev} 发现非函数 hook 条目，已剔除（非函数进 SDK hooks 会断掉工具管线，F4）`);
        }
        return { matcher: group.matcher, hooks: fns as HookCallback[] };
      })
      .filter((g) => g.hooks.length > 0);
    if (merged.length > 0) out[ev] = merged;
  }
  return out;
}
