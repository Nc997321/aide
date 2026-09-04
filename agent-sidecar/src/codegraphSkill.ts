import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toForwardSlashes, safeDirname } from "./winPaths.js";

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

## Tracing a chain across the codebase

1. **Entry point**: start from the most distinctive single point on the chain — a UI component if UI is involved, otherwise a named handler/manager. Find it with \`semantic_search\`, verify, then expand outward on both sides with \`find_symbol\` / \`call_graph\`.
2. **Symbols, not strings**: event names and command names are string literals the call graph cannot see. Find the named symbol behind the string first, then chain from it. (In this workspace a Tauri invoke name usually equals its Rust fn name, so \`find_symbol\` can catch it.)
3. **\`call_graph\` is a verifier, not a discovery tool** — confirm each hop, don't spray. When same-name candidates > 1, Read to disambiguate.
4. **Stop when you have enough**: each hop carries file:line; confirm each IPC boundary once on each side and stop — do not expand internal implementations of intermediate nodes.
5. **For source, prefer \`find_symbol\`** (it returns the full body) over reading whole files.

## Known blind spots — go straight to Grep, note "blind spot: <which>"

- Vue template component refs \`<X/>\`, custom events \`emit\` / \`@xxx\` — no symbol edges.
- Tauri event/command string literals like \`app.emit("xxx")\` — no symbol edges.
- Cross-language IPC boundaries (Rust↔sidecar stdin/stdout, sidecar→frontend, invoke→Rust) — the symbol chain breaks.
- Anonymous switch cases, structural tags like \`</script>\` — not symbols.
- \`call_graph\` same-name join noise — Read to disambiguate.

## Trace-task output contract (only when the task asks for a full chain trace)

1. **Bidirectional chain graph** — every node labeled with file:line.
2. **Tool contribution report** — codegraph vs Grep+Read share. Counting rules: source bodies returned by \`find_symbol\` count as find_symbol; verification Reads after codegraph pointed the way count as codegraph; the Grep bucket holds only blind-spot fallbacks.
3. **Blind-spot log** — which nodes codegraph could not reach and why, classified against the list above.

## Anti-gaming

Never skip codegraph and Grep the whole chain directly. Before any Grep, state why codegraph cannot answer (a blind-spot shorthand is fine). If you catch yourself using Grep to find a definition or a call relation, stop and switch to \`find_symbol\` / \`call_graph\`.
`;

type Env = Record<string, string | undefined>;

/** SKILL.md 落地路径：$CLAUDE_CONFIG_DIR/skills/codegraph-explore/SKILL.md（正斜杠形式，规避 bun path 缺陷）。 */
export function skillPath(env: Env): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
  return toForwardSlashes(
    path.join(toForwardSlashes(dir), "skills", "codegraph-explore", "SKILL.md"),
  );
}

/**
 * 确保 skill 文件存在且内容最新。写盘失败静默跳过（永不阻塞会话启动）。
 *
 * 路径用 winPaths 兜底（toForwardSlashes + safeDirname）：aide-agent.exe 内嵌 bun 的
 * path.dirname 对 Windows 反斜杠盘符路径返回 "C:"，mkdirSync 会落到错处；中文用户目录
 * 叠加该缺陷会导致 skill 不落地 → codegraph-explore 内建 skill 不生效。正斜杠化 + safeDirname 规避。
 */
export function ensureCodegraphSkill(env: Env): void {
  try {
    const file = skillPath(env);
    // mkdirSync 独立 try：bun 的 recursive mkdir 对已存在目录抛 EEXIST（Node 是 no-op），
    // 不让它中断后续内容比对/写入（已装机器重跑也会更新漂移内容）。
    try {
      mkdirSync(safeDirname(file), { recursive: true });
    } catch {
      /* 父目录已存在(bun EEXIST) 或不可创建，继续尝试写 */
    }
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
