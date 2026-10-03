import { describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { KbScopeStore } from "./scope.js";
import { isMemoryFilePath, makeKbMemoryGuardHook, MEMORY_GUARD_REASON } from "./memoryGuard.js";
import type { UserMessageBlock } from "../../engine/types.js";

const CFG = "/home/u/.aide/claude";
const kbref = { type: "kbref", selectionId: "s1", documentId: "d", title: "t", baseVersion: 1, start: 0, end: 2, text: "ab", comment: "", lineStart: 1, lineEnd: 1, precise: true };

function pre(tool: string, tool_input: unknown): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input } as unknown as HookInput;
}
const run = (hook: NonNullable<ReturnType<typeof makeKbMemoryGuardHook>>, input: HookInput) =>
  hook(input, undefined, { signal: new AbortController().signal }) as Promise<Record<string, unknown>>;

describe("isMemoryFilePath", () => {
  it.each([
    [`${CFG}/projects/-home-u-proj/memory/MEMORY.md`, true],
    [`${CFG}/projects/-home-u-proj/memory/sub/x.md`, true],
    [`${CFG}/projects/-home-u-proj/other.md`, false],
    [`${CFG}/projects/-home-u-proj/memory`, false], // 目录本身不是文件
    [`${CFG}/settings.json`, false],
    [`/home/u/proj/memory/x.md`, false], // 不在配置目录下
    [`${CFG}/projects//memory/x.md`, false], // 工作区 key 为空
  ])("%s → %s", (p, want) => {
    expect(isMemoryFilePath(CFG, p)).toBe(want);
  });

  it("Windows：反斜杠与盘符大小写都认", () => {
    expect(isMemoryFilePath("C:\\Users\\u\\.aide\\claude", "c:/users/u/.aide/claude/projects/C--proj/memory/a.md")).toBe(true);
    expect(isMemoryFilePath("C:\\Users\\u\\.aide\\claude", "C:\\Users\\u\\.aide\\claude\\projects\\C--proj\\memory\\a.md")).toBe(true);
  });
});

describe("makeKbMemoryGuardHook", () => {
  const mem = `${CFG}/projects/-home-u-proj/memory/feedback.md`;

  it("没有登记簿 / 没有配置目录 → 不挂", () => {
    expect(makeKbMemoryGuardHook({ configDir: CFG, scopes: undefined })).toBeNull();
    expect(makeKbMemoryGuardHook({ configDir: "", scopes: new KbScopeStore() })).toBeNull();
  });

  it("本轮带圈选：写记忆被拒（Write / Edit / MultiEdit / NotebookEdit），理由写明为什么", async () => {
    const scopes = new KbScopeStore();
    scopes.replaceFromDisplay([kbref] as unknown as UserMessageBlock[]);
    const hook = makeKbMemoryGuardHook({ configDir: CFG, scopes })!;
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      const out = await run(hook, pre(tool, { file_path: mem }));
      expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: MEMORY_GUARD_REASON });
    }
    const nb = await run(hook, pre("NotebookEdit", { notebook_path: mem }));
    expect((nb.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe("deny");
  });

  it("本轮带圈选：别的文件照常（只拦记忆）；读记忆也不拦", async () => {
    const scopes = new KbScopeStore();
    scopes.replaceFromDisplay([kbref] as unknown as UserMessageBlock[]);
    const hook = makeKbMemoryGuardHook({ configDir: CFG, scopes })!;
    expect(await run(hook, pre("Write", { file_path: "/home/u/proj/a.ts" }))).toEqual({});
    expect(await run(hook, pre("Read", { file_path: mem }))).toEqual({});
  });

  it("下一条不带圈选的用户消息到达后自动恢复：普通对话里「记住…」照常写", async () => {
    const scopes = new KbScopeStore();
    const hook = makeKbMemoryGuardHook({ configDir: CFG, scopes })!;
    scopes.replaceFromDisplay([kbref] as unknown as UserMessageBlock[]);
    expect(await run(hook, pre("Write", { file_path: mem }))).not.toEqual({});
    scopes.replaceFromDisplay([{ type: "text", text: "记住这个" }]);
    expect(await run(hook, pre("Write", { file_path: mem }))).toEqual({});
  });

  it("入参畸形不抛、不拦", async () => {
    const scopes = new KbScopeStore();
    scopes.replaceFromDisplay([kbref] as unknown as UserMessageBlock[]);
    const hook = makeKbMemoryGuardHook({ configDir: CFG, scopes })!;
    expect(await run(hook, pre("Write", null))).toEqual({});
    expect(await run(hook, pre("Write", { file_path: 3 }))).toEqual({});
    // 不是 PreToolUse 事件：不处理
    const post = { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: mem } } as unknown as HookInput;
    expect(await run(hook, post)).toEqual({});
  });
});
