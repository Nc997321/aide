// 远程工作区的扩展投影（send.extensions）：桌面是插件 / 用户 skills·agents·commands /
// 全局 CLAUDE.md / settings 的 mcpServers·hooks 的唯一真相源，Rust 把它们按内容哈希同步到
// 目标机（remote_workspace/mirror.rs），再把**目标机路径**随每条 send 递到这里。
//
// 本地车道永远不带这个字段——本模块只在远程车道生效，本地行为逐字节不变。
//
// 另一半职责：在**本机**（= 目标机）上检查这些扩展要跑的命令在不在，缺的如实报出来
// （notification），不让插件在远程静默少一半。

import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface SendExtensions {
  /** 已同步的插件版本目录（目标机路径）。 */
  plugins: { path: string }[];
  /** 用户扩展单元（skills / agents / commands / hooks / CLAUDE.md），同步失败时 null。 */
  userDir: string | null;
  /** settings.json 的可下发子集（只有 mcpServers / hooks）。 */
  settings: { mcpServers?: Record<string, any>; hooks?: Record<string, any> };
  /** 桌面侧已判定这台主机用不了的条目。 */
  unavailable: string[];
}

/** 宽容解析：形状不对的字段按缺席处理（不因为一个坏字段丢掉整份投影）。 */
export function parseSendExtensions(raw: unknown): SendExtensions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const plugins = Array.isArray(r.plugins)
    ? r.plugins
        .map((p) => (p && typeof (p as any).path === "string" ? { path: (p as any).path as string } : null))
        .filter((p): p is { path: string } => p !== null)
    : [];
  const settings = r.settings && typeof r.settings === "object" ? (r.settings as SendExtensions["settings"]) : {};
  const unavailable = Array.isArray(r.unavailable) ? r.unavailable.filter((s): s is string => typeof s === "string") : [];
  return {
    plugins,
    userDir: typeof r.user_dir === "string" && r.user_dir ? r.user_dir : null,
    settings,
    unavailable,
  };
}

/** 命令的第一个词（去引号，展开 `${CLAUDE_PLUGIN_ROOT}`）。 */
export function commandHead(command: string, pluginRoot?: string): string {
  const t = command.trim();
  const q = t[0] === '"' || t[0] === "'" ? t[0] : null;
  const word = q ? t.slice(1).split(q)[0] : t.split(/\s+/)[0];
  return pluginRoot ? word.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot) : word;
}

/** 本机能不能跑这个命令头：路径 → 文件存在；裸名 → PATH 上找得到。 */
export function resolvable(head: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!head) return true;
  if (head.includes("/") || isAbsolute(head)) return existsSync(head);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      if (statSync(join(dir, head)).isFile()) return true;
    } catch {
      // 不在这个目录
    }
  }
  return false;
}

interface CommandSite {
  what: string;
  command: string;
  /** 带 `shell` 的 hook 由该 shell 执行——shell 本身也得在。 */
  shell?: string;
  pluginRoot?: string;
}

function hookSites(hooks: unknown, owner: string, pluginRoot?: string): CommandSite[] {
  if (!hooks || typeof hooks !== "object") return [];
  const out: CommandSite[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of Array.isArray((g as any)?.hooks) ? (g as any).hooks : []) {
        if (h?.type === "command" && typeof h.command === "string") {
          out.push({ what: `${owner} ${event} hook`, command: h.command, shell: h.shell, pluginRoot });
        }
      }
    }
  }
  return out;
}

function mcpSites(servers: unknown, owner: string, pluginRoot?: string): CommandSite[] {
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, any>)
    .filter(([, cfg]) => cfg && typeof cfg.command === "string" && cfg.disabled !== true)
    .map(([name, cfg]) => ({ what: `${owner} MCP server \`${name}\``, command: cfg.command, pluginRoot }));
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pluginName(dir: string): string {
  return readJson(join(dir, ".claude-plugin", "plugin.json"))?.name ?? dir;
}

/**
 * 这台机器上用不了的扩展（一条一句话）：桌面侧已判定的 + 镜像目录丢了的 +
 * 插件 / settings 里的命令在本机找不到的。空数组 = 全部可用。
 */
export function preflightExtensions(ext: SendExtensions, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...ext.unavailable];
  const sites: CommandSite[] = [];
  for (const p of ext.plugins) {
    if (!existsSync(p.path)) {
      out.push(`plugin at ${p.path}: its copy on this machine is missing (it is re-copied when Aide restarts)`);
      continue;
    }
    const name = `plugin \`${pluginName(p.path)}\``;
    sites.push(...hookSites(readJson(join(p.path, "hooks", "hooks.json"))?.hooks, name, p.path));
    const mcp = readJson(join(p.path, ".mcp.json"));
    sites.push(...mcpSites(mcp?.mcpServers ?? mcp, name, p.path));
  }
  if (ext.userDir) sites.push(...hookSites(readJson(join(ext.userDir, "hooks", "hooks.json"))?.hooks, "your", ext.userDir));
  sites.push(...hookSites(ext.settings.hooks, "your"));
  sites.push(...mcpSites(ext.settings.mcpServers, "your"));
  for (const s of sites) {
    if (s.shell && !resolvable(s.shell, env)) {
      out.push(`${s.what}: needs \`${s.shell}\`, which is not installed on this machine`);
      continue;
    }
    const head = commandHead(s.command, s.pluginRoot);
    if (!resolvable(head, env)) {
      out.push(`${s.what}: \`${head}\` was not found on this machine`);
    }
  }
  return [...new Set(out)];
}

/** 给用户看的一条通知正文。 */
export function unavailableNotice(items: string[], hostHint = "this remote workspace"): string {
  return `Some of your extensions are unavailable in ${hostHint}:\n${items.map((i) => `- ${i}`).join("\n")}`;
}
