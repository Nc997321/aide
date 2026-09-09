import { describe, expect, it } from "vitest";
import { annotateReadRelay, judgeReadRelay, lastLspContextInMessages, readRangeLabel } from "./lspRelay";
import type { ChatMessage, ContentBlock, ToolCallBlock } from "../types/chat";

function tool(name: string, input: unknown, result?: string): ToolCallBlock {
  // result 缺席 = 未完成（pending）；有值 = 已完成
  return { type: "tool_call", id: `t-${name}-${Math.random()}`, name, input, result, isPending: result === undefined };
}

function msg(role: "user" | "assistant", ...blocks: ContentBlock[]): ChatMessage {
  return { id: `m-${Math.random()}`, role, blocks, timestamp: "" };
}

const HOVER_OK = "Hover info at 13:9:\n\n```rust\nlet count: u32\n```";
const HOVER_FAIL = "No hover information available. This may occur if the cursor is not on a symbol.";

describe("judgeReadRelay", () => {
  const lsp = { filePath: "C:\\repo\\src-tauri\\src\\commands\\chat.rs", result: HOVER_OK };

  it("同一文件 + offset ⇒ hit", () => {
    expect(judgeReadRelay({ file_path: "src-tauri/src/commands/chat.rs", offset: 140, limit: 7 }, lsp)).toBe("hit");
  });

  it("同一文件 + 无 offset ⇒ miss（整文件读）", () => {
    expect(judgeReadRelay({ file_path: "C:\\repo\\src-tauri\\src\\commands\\chat.rs" }, lsp)).toBe("miss");
  });

  it("不同文件 ⇒ null（中性）", () => {
    expect(judgeReadRelay({ file_path: "src/other.ts", offset: 1 }, lsp)).toBeNull();
  });

  it("LSP 结果为失败文本 ⇒ null", () => {
    const failed = { filePath: lsp.filePath, result: "No hover information available." };
    expect(judgeReadRelay({ file_path: "chat.rs", offset: 5 }, failed)).toBeNull();
  });

  it("无 LSP 上下文 ⇒ null", () => {
    expect(judgeReadRelay({ file_path: "chat.rs", offset: 5 }, null)).toBeNull();
  });

  it("input 缺 file_path ⇒ null", () => {
    expect(judgeReadRelay({ offset: 5 }, lsp)).toBeNull();
  });

  it("offset 非数字（字符串）⇒ miss", () => {
    expect(judgeReadRelay({ file_path: "chat.rs", offset: "140" }, lsp)).toBe("miss");
  });

  it("LSP 结果为 Error/Failed 前缀 ⇒ null", () => {
    const err = { filePath: lsp.filePath, result: "Error performing hover: server is starting" };
    expect(judgeReadRelay({ file_path: "chat.rs", offset: 5 }, err)).toBeNull();
  });
});

describe("lastLspContextInMessages", () => {
  it("取最近一个已完成的 LSP 调用（同消息内后者优先）", () => {
    const m = msg(
      "assistant",
      tool("LSP", { operation: "hover", filePath: "a.rs" }, HOVER_FAIL),
      tool("LSP", { operation: "hover", filePath: "b.rs" }, HOVER_OK),
      tool("Read", { file_path: "b.rs", offset: 1 }),
    );
    const ctx = lastLspContextInMessages([m]);
    expect(ctx).toEqual({ filePath: "b.rs", result: HOVER_OK });
  });

  it("跨消息回看：上一条 assistant 的 LSP 也算", () => {
    const m1 = msg("assistant", tool("LSP", { operation: "workspaceSymbol", filePath: "a.rs" }, "Found: a.rs:10"));
    const m2 = msg("user", tool("Read", { file_path: "a.rs" })); // mention 合成卡
    const m3 = msg("assistant", tool("Read", { file_path: "a.rs", offset: 10, limit: 5 }));
    expect(lastLspContextInMessages([m1, m2, m3])?.filePath).toBe("a.rs");
  });

  it("pending（无结果）的 LSP 不构成上下文", () => {
    const m = msg("assistant", tool("LSP", { filePath: "a.rs" }, undefined));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  it("结果为空串的 LSP 不构成上下文", () => {
    const m = msg("assistant", tool("LSP", { filePath: "a.rs" }, ""));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  it("LSP input 无 filePath（畸形）⇒ 跳过继续扫", () => {
    const m = msg(
      "assistant",
      tool("LSP", { operation: "hover" }, HOVER_OK), // 缺 filePath
      tool("LSP", { filePath: "a.rs" }, HOVER_OK),
    );
    expect(lastLspContextInMessages([m])?.filePath).toBe("a.rs");
  });

  it("LSP input 非对象（边界收窄）⇒ 跳过继续扫", () => {
    const m = msg("assistant", tool("LSP", "garbage", HOVER_OK));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  it("text/thinking 块不计入扫描", () => {
    const m = msg("assistant", { type: "text", text: "hello" }, tool("LSP", { filePath: "a.rs" }, HOVER_OK));
    expect(lastLspContextInMessages([m])?.filePath).toBe("a.rs");
  });

  it("cap 命中：扫描量耗尽即返回 null（不再向更旧消息找）", () => {
    // LSP 在更旧侧：倒序扫描先耗尽 cap，LSP 永远轮不到
    const filler = Array.from({ length: 3 }, () => tool("Read", { file_path: "a.rs", offset: 1 }));
    const m = msg("assistant", tool("LSP", { filePath: "a.rs" }, HOVER_OK), ...filler);
    expect(lastLspContextInMessages([m], 2)).toBeNull();
    expect(lastLspContextInMessages([m], 4)?.filePath).toBe("a.rs");
  });
});

describe("annotateReadRelay", () => {
  it("assistant 的 Read 被标注；user mention 合成卡不动", () => {
    const messages = [
      msg("assistant", tool("LSP", { filePath: "a.rs" }, HOVER_OK)),
      msg("user", tool("Read", { file_path: "a.rs" })), // mention 卡：不应标注
      msg("assistant", tool("Read", { file_path: "a.rs", offset: 13 })), // hit
      msg("assistant", tool("Read", { file_path: "a.rs" })), // miss
    ];
    annotateReadRelay(messages);
    const userBlocks = messages[1]!.blocks as ToolCallBlock[];
    expect(userBlocks[0]!.lspRelay).toBeUndefined();
    const assistantReads = [messages[2]!.blocks[0], messages[3]!.blocks[0]] as ToolCallBlock[];
    expect(assistantReads[0]!.lspRelay).toBe("hit");
    expect(assistantReads[1]!.lspRelay).toBe("miss");
  });

  it("LSP 在 Read 之后到达时，Read 用的是之前的上下文（顺序语义）", () => {
    const messages = [
      msg("assistant", tool("Read", { file_path: "a.rs", offset: 3 })),
      msg("assistant", tool("LSP", { filePath: "a.rs" }, HOVER_OK)),
      msg("assistant", tool("Read", { file_path: "a.rs", offset: 3 })),
    ];
    annotateReadRelay(messages);
    expect((messages[0]!.blocks[0] as ToolCallBlock).lspRelay).toBeUndefined();
    expect((messages[2]!.blocks[0] as ToolCallBlock).lspRelay).toBe("hit");
  });

  it("LSP 之前已标注的 Read 不被覆盖", () => {
    const read = tool("Read", { file_path: "a.rs", offset: 1 });
    read.lspRelay = "hit";
    const messages = [msg("assistant", read)];
    annotateReadRelay(messages);
    expect((messages[0]!.blocks[0] as ToolCallBlock).lspRelay).toBe("hit");
  });

  it("text 块与失败/缺 filePath 的 LSP 不更新追踪器", () => {
    const messages = [
      msg("assistant", { type: "text", text: "hi" }),
      msg("assistant", tool("LSP", { operation: "hover" }, HOVER_OK)), // 缺 filePath → 不入追踪器
      msg("assistant", tool("Read", { file_path: "a.rs", offset: 1 })),
    ];
    annotateReadRelay(messages);
    expect((messages[2]!.blocks[0] as ToolCallBlock).lspRelay).toBeUndefined();
  });
});

describe("readRangeLabel", () => {
  it("offset+limit ⇒ 闭区间文案", () => {
    expect(readRangeLabel({ file_path: "a.rs", offset: 140, limit: 7 })).toBe("140–146 行 · 7 行");
  });

  it("仅 offset ⇒ 起点文案", () => {
    expect(readRangeLabel({ offset: 140 })).toBe("自 140 行");
  });

  it("仅 limit ⇒ 前缀行数文案", () => {
    expect(readRangeLabel({ limit: 40 })).toBe("前 40 行");
  });

  it("无 offset/limit ⇒ null", () => {
    expect(readRangeLabel({ file_path: "a.rs" })).toBeNull();
  });

  it("非数字 offset/limit ⇒ null", () => {
    expect(readRangeLabel({ offset: "1", limit: null })).toBeNull();
  });
});