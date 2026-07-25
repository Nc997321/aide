import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * codegraph-explore skill 自动落地（内建，免用户配置）。
 *
 * 动机（2026-07-26 两轮 A/B 实锤）：MCP 工具光注册 + instructions 只能把模型
 * 对 codegraph 工具的采纳率从 0 拉到 ~10%，自然语言探索任务里 Grep 仍是主力。
 * 而 skill 是这套 harness 已验证的任务级触发机制（skill_listing + SessionStart
 * 的「匹配必须调用」纪律）——把「什么时候该用索引工具」写成 skill，触发率
 * 接近 100%。与 MCP instructions 互补：instructions 管工具存在时的即时选择，
 * skill 管任务级工作流。
 *
 * 文件由 sidecar 启动时落地到 `$CLAUDE_CONFIG_DIR/skills/codegraph-explore/`
 * （用户级 skill，settingSources 含 user，全局工作区生效）；内容漂移自动重写，
 * 写盘失败静默跳过不阻塞会话。随 app 分发，换机器自带。
 */

export const SKILL_CONTENT = `---
name: codegraph-explore
description: Use when exploring or understanding code in this workspace - tracing call flows, finding where a symbol is defined, mapping module structure, or answering "how does X work" - BEFORE fanning out Grep/Read calls. This workspace has a pre-built code index (aide-codegraph MCP tools) that answers code-navigation questions instantly and exactly.
---

# Codegraph-Guided Code Exploration

This workspace is pre-indexed. The \`aide-codegraph\` MCP tools answer code-navigation questions exactly and instantly — one call replaces a grep-then-read fan-out.

## Mandatory workflow

1. **Finding a definition** (function / class / method / interface / enum) → call \`mcp__aide-codegraph__find_symbol\` FIRST. Never use Grep to locate a definition.
2. **Tracing a flow** (who calls X / what does X call) → call \`mcp__aide-codegraph__call_graph\` with direction \`"callers"\` or \`"callees"\`, then walk hop by hop.
3. **You know what the code does but not its name** → call \`mcp__aide-codegraph__semantic_search\` with a short natural-language description.
4. **Read files only AFTER the index tells you where to look** — read the specific file:line the index returned instead of whole files speculatively.

## When Grep IS correct

- Text patterns that are not symbols: log messages, error strings, TODO comments, config keys.
- The index tools report \`no_index\` / \`structure_only\` or time out → fall back to Grep and tell the user the code index needs (re)building (Settings → 代码索引).

## Ambiguity

\`call_graph\` and \`semantic_search\` are name-level / similarity-level: when candidates > 1, Read the listed locations to disambiguate instead of guessing.
`;

type Env = Record<string, string | undefined>;

/** SKILL.md 落地路径：$CLAUDE_CONFIG_DIR/skills/codegraph-explore/SKILL.md。 */
export function skillPath(env: Env): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
  return path.join(dir, "skills", "codegraph-explore", "SKILL.md");
}

/** 确保 skill 文件存在且内容最新。写盘失败静默跳过（永不阻塞会话启动）。 */
export function ensureCodegraphSkill(env: Env): void {
  try {
    const file = skillPath(env);
    mkdirSync(path.dirname(file), { recursive: true });
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* 不存在，下面写 */
    }
    if (current !== SKILL_CONTENT) writeFileSync(file, SKILL_CONTENT, "utf8");
  } catch {
    /* 配置目录不可写等情况：跳过，不影响会话 */
  }
}
