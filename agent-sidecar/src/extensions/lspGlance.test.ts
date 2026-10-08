import { describe, it, expect } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  identifiersFromBash,
  identifiersFromGrepTool,
  identifiersInPattern,
  looksLikeCodeSymbol,
  makeLspGlanceHook,
} from "./lspGlance.js";
import type { LspQueryResponse, LspTool } from "./lspClient.js";

describe("从搜索里认出代码标识符", () => {
  it("像代码符号的才算：snake / camel / 多峰 Pascal / 常量", () => {
    for (const t of ["run_jump", "useInlineMention", "SubagentCallBlock", "HYDRATE_PAGE_BYTES"]) {
      expect(looksLikeCodeSymbol(t), t).toBe(true);
    }
    for (const t of ["count", "text", "unchanged", "Subagent", "get", "_x", "a_"]) {
      expect(looksLikeCodeSymbol(t), t).toBe(false);
    }
  });

  /// 以下模式全部取自真实转录（2026-09-29 统计的 1667 次 grep 类搜索）。
  it("正则分支、关键字前缀、转义都处理", () => {
    expect(identifiersInPattern("workspacePath|workspaceOf|getProjectInfo|activeKey")).toEqual([
      "workspacePath",
      "workspaceOf",
      "getProjectInfo",
      "activeKey",
    ]);
    expect(identifiersInPattern("pub (async )?fn list_sessions_for_workspace")).toEqual([
      "list_sessions_for_workspace",
    ]);
    expect(identifiersInPattern("startRound\\|prompt\\s*=\\|roundCounter\\|rewindTo")).toEqual([
      "startRound",
      "roundCounter",
      "rewindTo",
    ]);
    expect(identifiersInPattern("\\bensureWorkspaceKnown\\b")).toEqual(["ensureWorkspaceKnown"]);
    expect(identifiersInPattern("matches failed|No request matched")).toEqual([]);
  });

  it("Grep 工具：指向非代码文件时不附", () => {
    expect(identifiersFromGrepTool({ pattern: "fn resolve_view" })).toEqual(["resolve_view"]);
    expect(identifiersFromGrepTool({ pattern: "useChatSession", glob: "*.md" })).toEqual([]);
  });

  it("Bash：grep / rg / git grep 的模式；flag 的值不当模式", () => {
    expect(
      identifiersFromBash('cd "C:/x/aide" && grep -rn "fn our_session_workspace" -A 25 src-tauri/src/commands/mod.rs | head -35'),
    ).toEqual(["our_session_workspace"]);
    expect(identifiersFromBash("rg -n -g '*.ts' 'finalFlush|startTail' agent-sidecar/src")).toEqual([
      "finalFlush",
      "startTail",
    ]);
    expect(identifiersFromBash("git grep -e buildUserDisplay -- src")).toEqual(["buildUserDisplay"]);
    expect(
      identifiersFromBash('grep -n "TailPool\\|finalFlush" session-worker.ts; echo "=== x ==="; grep -rn -A 18 "outputTailHooks" tailPool.ts'),
    ).toEqual(["TailPool", "finalFlush", "outputTailHooks"]);
  });

  /// 管道后段的 grep 读 stdin，是在过滤命令输出（测试结果、日志），不是搜代码。
  it("Bash：管道里过滤输出的 grep、非代码目标都不算", () => {
    expect(identifiersFromBash('npx vitest run 2>&1 | grep -E "Test Files|AssertionError"')).toEqual([]);
    expect(identifiersFromBash('grep -rn "knowledge_server" CLAUDE.md')).toEqual([]);
    expect(identifiersFromBash('grep -rn "wsPath" --include=*.json ~/.aide/sessions')).toEqual([]);
    expect(identifiersFromBash("ls -la src && cat package.json")).toEqual([]);
  });
});

function input(tool_name: string, tool_input: unknown): HookInput {
  return {
    hook_event_name: "PostToolUse",
    tool_name,
    tool_input,
    tool_response: "",
    tool_use_id: "t1",
    session_id: "s",
    transcript_path: "",
    cwd: "/proj",
  } as unknown as HookInput;
}

function hook(script: (tool: LspTool, args: Record<string, unknown>) => LspQueryResponse, warm = true) {
  const calls: string[] = [];
  const h = makeLspGlanceHook({
    cwd: "/proj",
    isWarm: () => warm,
    query: async (tool, args) => {
      calls.push(`${tool}:${String(args.name)}`);
      return script(tool, args);
    },
  });
  return { h, calls };
}

const run = (h: ReturnType<typeof hook>["h"], i: HookInput) =>
  h(i, "t1", { signal: new AbortController().signal }) as Promise<Record<string, any>>;

describe("grep 顺带作答", () => {
  it("附上定义位置与真实引用数（路径相对化）", async () => {
    const { h } = hook((tool) =>
      tool === "symbols"
        ? { ok: true, status: "ready", results: [{ symbol: { file: "/proj/src/a.rs", line: 548, column: 10 } }] }
        : {
            ok: true,
            status: "ready",
            results: [
              { symbol: { file: "/proj/src/b.rs", line: 1, column: 1 } },
              { symbol: { file: "/proj/src/b.rs", line: 9, column: 1 } },
            ],
          },
    );
    const out = await run(h, input("Grep", { pattern: "run_jump" }));
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(ctx).toContain("- `run_jump`: defined at src/a.rs:548 · 2 real references in 1 file");
    expect(ctx).toMatch(/lsp_references/);
  });

  /// 行区间让模型 Read 精确取段——grep 之后整文件读是最常见的浪费。
  it("取得到结构时带上种类与行区间", async () => {
    const { h } = hook((tool) =>
      tool === "symbols"
        ? { ok: true, status: "ready", results: [{ symbol: { file: "/proj/src/a.rs", line: 548, column: 10 } }] }
        : tool === "outline"
          ? {
              ok: true,
              status: "ready",
              symbols: [{ name: "run_jump", kind: 12, line: 548, column: 10, start_line: 547, end_line: 610, depth: 0 }],
            }
          : { ok: true, status: "ready", results: [] },
    );
    const out = await run(h, input("Grep", { pattern: "fn run_jump" }));
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "- `run_jump`: function defined at src/a.rs:548, lines 547-610 · no references anywhere (confirmed)",
    );
  });

  it("没被引用：说出来（这是 grep 给不了的确定信息）", async () => {
    const { h } = hook((tool) =>
      tool === "symbols"
        ? { ok: true, status: "ready", results: [{ symbol: { file: "/proj/a.ts", line: 3, column: 1 } }] }
        : { ok: true, status: "ready", results: [] },
    );
    const out = await run(h, input("Grep", { pattern: "deadHelper" }));
    expect(out.hookSpecificOutput.additionalContext).toContain("no references anywhere (confirmed)");
  });

  it("同名多义：给出个数和消歧办法", async () => {
    const { h } = hook(() => ({ ok: true, status: "ready", ambiguous: true, count: 5, candidates: [] }));
    const out = await run(h, input("Grep", { pattern: "resolve_project_dirs" }));
    expect(out.hookSpecificOutput.additionalContext).toContain("5 symbols share this name");
  });

  it("同名不多时直接列出在哪", async () => {
    const { h } = hook(() => ({
      ok: true,
      status: "ready",
      ambiguous: true,
      count: 2,
      candidates: [
        { file_path: "/proj/src/api.ts", line: 163, kind: 6 },
        { file_path: "/proj/src/useChat.ts", line: 297, kind: 12 },
      ],
    }));
    const out = await run(h, input("Grep", { pattern: "sendMessage" }));
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "2 symbols share this name: method src/api.ts:163, function src/useChat.ts:297",
    );
  });

  /// 宁缺毋滥：非 ready 的「没答上」写进 grep 结果只是噪音。
  it("非 ready 一律不附", async () => {
    const { h } = hook(() => ({ ok: false, status: "indexing" }));
    expect(await run(h, input("Grep", { pattern: "run_jump" }))).toEqual({});
  });

  it("语言服务器没热：不问（不给 grep 加等待）", async () => {
    const { h, calls } = hook(() => ({ ok: true, status: "ready", results: [] }), false);
    expect(await run(h, input("Grep", { pattern: "run_jump" }))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("没有代码标识符：不问", async () => {
    const { h, calls } = hook(() => ({ ok: true, status: "ready", results: [] }));
    expect(await run(h, input("Bash", { command: "git status" }))).toEqual({});
    expect(await run(h, input("Grep", { pattern: "matches failed" }))).toEqual({});
    expect(calls).toEqual([]);
  });

  it("同一批名字重复搜：只附一次", async () => {
    const { h } = hook((tool) =>
      tool === "symbols"
        ? { ok: true, status: "ready", results: [{ symbol: { file: "/proj/a.ts", line: 3, column: 1 } }] }
        : { ok: true, status: "ready", results: [] },
    );
    expect((await run(h, input("Grep", { pattern: "useThing" }))).hookSpecificOutput).toBeDefined();
    expect(await run(h, input("Grep", { pattern: "useThing" }))).toEqual({});
  });

  /// 没命中的代价必须小：注释里的词、别的语言的名字，问两次没答上就别再问。
  it("同一个名字两次没答上，之后不再问", async () => {
    const { h, calls } = hook(() => ({ ok: false, status: "indexing" }));
    await run(h, input("Grep", { pattern: "someName_x" }));
    await run(h, input("Grep", { pattern: "someName_x\\|other_name" }));
    calls.length = 0;
    await run(h, input("Grep", { pattern: "someName_x" }));
    expect(calls).toEqual([]);
  });

  it("最多看三个标识符", async () => {
    const { h, calls } = hook(() => ({ ok: false, status: "indexing" }));
    await run(h, input("Grep", { pattern: "aaaA|bbbB|cccC|dddD|eeeE" }));
    expect(new Set(calls.map((c) => c.split(":")[1]))).toEqual(new Set(["aaaA", "bbbB", "cccC"]));
  });
});
