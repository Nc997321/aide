// 内置 LSP 导航提示：唯一一处由 Aide 自己撰写、而非来自用户文件的指令块。
//
// **这段文本只讲 Claude Code 内置的 LSP 工具**（`workspaceSymbol` 要坐标、
// `findReferences` 冷窗口返空、tsserver 看不见 .vue），所以它只在**那个工具真的在场**
// 时才注入——见 loadLspHint 的两道闸。aide-lsp 接管后（C3 退役内置通道）这套语义由
// extensions/lspTools.ts 的 server instructions 承担，这段文本整篇作废。
//
// 成因（2026-09-19 实测，基线见 docs/superpowers/spikes/2026-09-19-lsp-agent-tools/）：
// agent 有内置 LSP 工具却退回 Grep，不是不知道工具存在（装插件 6 天用了 29 次），
// 是四类缺陷让它「试过、失望、放弃」：
//   ① `workspaceSymbol` 是名字查询，工具却强制要 line/character —— 每次按名找符号
//      第一发必被拒（历史实录 InputValidationError）；
//   ② 语言服务器懒启动，冷窗口 ~40-60s 内语义查询返回**空数组**而非错误，agent 无法
//      区分「真的没有引用」和「还没索引好」；
//   ③ 预判失误就没机会预热；
//   ④ tsserver 看不见 .vue 内部 —— 本仓库前端是 Vue，漏报是常态。
// ①②③ 提示词能治，④ 只能让它「别信 + 用 Grep 兜底」。根治 ④ 是结构性工作。
//
// **每一轮请求都会重发这段文本**，所以它是基座成本：改动前先看 lspHint.test.ts 的
// 长度闸，别让它长成第二个 CLAUDE.md。

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { lspToolsMounted, type LspGate } from "../extensions/lspGate.js";

const LSP_USAGE_HINT = `## Code navigation: reach for the LSP tool on semantic questions

"Who defines X", "who references X", "what implements X" are LSP questions, not Grep
ones. The tool misleads silently, so mind these:

- \`workspaceSymbol\` searches by NAME yet the tool still REQUIRES \`line\` and
  \`character\`. Pass any position in the same file; without them the call is rejected.
- The server starts lazily on your first LSP call and needs ~40-60s to index. Until then
  \`findReferences\` and \`workspaceSymbol\` return EMPTY. Empty is not "no references" —
  never conclude from it: retry later, or use Grep and say the result is unverified.
- Expecting several rounds of exploration? Warm the server up front with one cheap
  \`documentSymbol\` call on any file.
- In a project containing \`.vue\`: TS reference queries cannot see usages inside \`.vue\`
  files — cover those with Grep. Plain text, config and log lookups stay Grep's job.`;

/**
 * 本会话要不要注入内置工具的 LSP 提示。返回 null = 不注入。
 *
 * 两道闸，都必要：
 * 1. `lspToolsMounted(gate)` —— aide-lsp 接管时内置工具**已被退役**（lspRetire.ts），
 *    对不存在的工具讲这些是纯噪音，且那套语义已由 aide-lsp 的 server instructions
 *    承担。顺带把这段每轮重发的文本省掉。
 * 2. 没有插件提供 `.lsp.json` —— 没有内置通道可讲，同样别讲。
 *
 * 两道都不满足时返回文本：**内置通道在场，且替代品不在**——正是这个提示被写出来的
 * 那个世界（未信任工作区、detector 没认出的工作区）。
 */
export async function loadLspHint(configDir: string, gate: LspGate): Promise<string | null> {
  if (lspToolsMounted(gate)) return null;
  if (!(await hasAgentLspPlugin(configDir))) return null;
  return LSP_USAGE_HINT;
}

/** 启用中的插件里，有没有一个随包提供 `.lsp.json`？
 *  判据取 CLI 自己的 enabled-plugins.json（真值），不猜目录布局；读不到、格式不对、
 *  条目缺 path 一律按「没有」处理——少注入一条提示是可接受的降级，注入错才是。 */
async function hasAgentLspPlugin(configDir: string): Promise<boolean> {
  for (const dir of await readEnabledPluginDirs(configDir)) {
    if (await fileExists(join(dir, ".lsp.json"))) return true;
  }
  return false;
}

/** enabled-plugins.json 里各插件的安装目录；任何读取/解析失败都是空数组。 */
async function readEnabledPluginDirs(configDir: string): Promise<string[]> {
  const manifest = join(configDir, "plugins", "enabled-plugins.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) => (typeof (e as { path?: unknown })?.path === "string" ? (e as { path: string }).path : null))
      .filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
