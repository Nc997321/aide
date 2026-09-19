// C3：退役 Claude Code 内置 LSP 通道。
//
// `--plugin-dir` 那份列表是 aide 自己拼的（`buildPluginsOption` 读 Rust 维护的
// enabled-plugins.json），所以 aide 可以在拼的时候把提供 LSP 的插件剔掉——CLI 拿不到
// 插件，就不再挂它那个内置 LSP 工具，也就不会再懒启动第二个语言服务器。
//
// 为什么必须退役（2026-09-19 真机实测，见 spec § C3 与 spike README）：
//   ① **双份语言服务器**：同一仓库两份 rust-analyzer（内置那份父进程是 claude.exe），
//      各约 5GB。
//   ② **答案互相矛盾**：aide-lsp 在冷窗口回「索引未就绪，空结果不等于没有引用」，
//      内置工具在同一时刻平铺直叙回 "No references found"。模型多半采信更简洁的那个
//      ——**我们建的诚实性被并排的工具直接抵消**。
//
// 两道条件缺一不可，方向相同：**丢了东西就不退**。
//   ① 替代品在场（`lspToolsMounted`）：未信任的工作区、detector 没认出来的工作区
//      （如 Rust 在子目录的 monorepo）aide-lsp 不挂，内置工具必须原样留着。
//   ② 这个插件**只**提供 LSP（`isPureLspPlugin`）：剔 `--plugin-dir` 是**整目录**剔除，
//      插件若还带 skills/themes/…，退掉 LSP 的代价是连它们一起丢。
//
// 只作用在**市场插件**条目上（`buildPluginsOption` 那条链）。散装注入的 aide-user /
// aide-project 根是用户自己的 skills/agents 家，绝不能因为根目录躺着一个 `.lsp.json`
// 就把整包退掉——那正是条件 ② 存在的理由。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SdkPluginConfig } from "./dispatchPlugins.js";
import { lspToolsMounted, type LspGate } from "./lspGate.js";

/** CLI 认的插件根顶层条目：有它 = 这个插件声明了语言服务器。 */
const LSP_DECLARATION = ".lsp.json";

/** 插件根里「有它也不算这个插件提供了别的能力」的条目：SDK 清单、LSP 声明本身、
 *  CLI 的簿记文件。判定走**允许表**而非禁止表——SDK 能认的组件名是开放集合
 *  （skills / agents / commands / hooks / monitors / outputStyles / themes / workflows /
 *  `.mcp.json` …），禁止表漏一个的代价是**静默删掉用户的能力**，允许表漏一个的代价
 *  只是少退一个插件（双份 LSP 还在，症状可见、可修）。 */
const INERT_ENTRIES = new Set([".claude-plugin", LSP_DECLARATION, ".in_use", ".orphaned_at"]);

/**
 * 剔掉只提供 LSP 的市场插件。闸门不满足、或插件还带别的东西 → 原样返回。
 *
 * 真剔了会打一行日志——运行时抑制是看不见的，插件在设置页里仍显示「已启用」，
 * 没这行日志就无从解释「我开着它为什么没有」。
 */
export function retireBuiltinLspPlugins(
  plugins: SdkPluginConfig[],
  gate: LspGate,
): SdkPluginConfig[] {
  if (!lspToolsMounted(gate)) return plugins;
  const kept = plugins.filter((p) => !isPureLspPlugin(p.path));
  if (kept.length < plugins.length) {
    console.warn(
      `[lsp] 内置 LSP 通道已退役：剔除 ${plugins.length - kept.length} 个 LSP 插件（改由 aide-lsp 提供）`,
    );
  }
  return kept;
}

/** 纯 LSP 插件 = 声明了 LSP，且目录里除清单 / LSP 声明 / 说明文件外没有别的东西。
 *  任何探测失败（目录不存在、读不了）一律按「不纯」处理——保守方向是**不退**。 */
function isPureLspPlugin(pluginDir: string): boolean {
  if (!declaresLspServer(pluginDir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(pluginDir);
  } catch {
    return false;
  }
  return entries.every(isInertEntry);
}

/** 说明文件按前缀认：README.md / readme.txt / LICENSE / LICENCE / COPYING /
 *  NOTICE / CHANGELOG —— 大小写与扩展名都不定，列全不如认前缀。 */
function isInertEntry(entry: string): boolean {
  if (INERT_ENTRIES.has(entry)) return true;
  if (entry.endsWith(".lsp.json")) return true;
  return /^(readme|licen[cs]e|copying|notice|changelog)/i.test(entry);
}

/** 这个插件声明了语言服务器吗？CLI 认两条路，都要看：
 *  ① 插件根顶层的 `.lsp.json`（官方 rust-analyzer-lsp / typescript-lsp 走这条）；
 *  ② manifest 的 `lspServers` 字段——字符串路径 / 内联配置对象 / 两者混排的数组。
 *     （形状抄自打包产物里 SDK 的 zod schema，不是猜的。） */
function declaresLspServer(pluginDir: string): boolean {
  if (existsSync(join(pluginDir, LSP_DECLARATION))) return true;
  try {
    const raw = readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8");
    return hasLspServers((JSON.parse(raw) as { lspServers?: unknown })?.lspServers);
  } catch {
    return false; // 无 manifest / 坏 JSON → 当作没声明（保守：不退）
  }
}

function hasLspServers(lspServers: unknown): boolean {
  if (typeof lspServers === "string") return lspServers.length > 0;
  if (Array.isArray(lspServers)) return lspServers.length > 0;
  if (lspServers && typeof lspServers === "object") return Object.keys(lspServers).length > 0;
  return false;
}
