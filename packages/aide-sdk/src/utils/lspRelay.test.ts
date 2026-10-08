import { describe, expect, it } from "vitest";
import { annotateReadRelay, judgeReadRelay, lastLspContextInMessages, readRangeLabel } from "./lspRelay";
import type { ChatMessage, ContentBlock, ToolCallBlock } from "../types/chat";

function tool(name: string, input: unknown, result?: string): ToolCallBlock {
  // result 缺席 = 未完成（pending）；有值 = 已完成
  return { type: "tool_call", id: `t-${name}-${Math.random()}`, name, input, result, isPending: result === undefined };
}

function msg(role: "user" | "assistant", ...blocks: ContentBlock[]): ChatMessage {
  return { id: `m-${Math.random()}`, role, blocks, timestamp: 0 };
}

const HOVER_OK = "Hover info at 13:9:\n\n```rust\nlet count: u32\n```";
const HOVER_FAIL = "No hover information available. This may occur if the cursor is not on a symbol.";

// ── aide-lsp（C3 之后 agent 唯一走的通道）的结果文本 ──
// 这些常量照 agent-sidecar/src/extensions/lspFormat.ts 的输出**抄**的，不是编的：
// 格式漂移时这里会先红，比徽章在真机上莫名其妙消失好查。
const AIDE_OK =
  "2 references of `get` in 1 file (compiler-precise: no comments, strings or same-named symbols):\n" +
  "src-tauri/src/lsp/manager.rs\n" +
  "  80:12  [in LspManager › ensure]  let h = self.get(root, lang);\n" +
  "  112:13  [in LspManager › kill]  self.get(r, l)";
const AIDE_INDEXING =
  "The query for `get` was not answered — the language server is still building its index. An empty result does NOT mean the symbol is unused; nobody looked yet. Use Grep for now and say the result is unverified.";
const AIDE_CONFIRMED_EMPTY =
  "No references of `get` — the language server's index is ready, so this is a confirmed negative (not a missing answer). Note: files outside the language project (e.g. excluded test files) are not searched.";
const AIDE_TEXT_FALLBACK =
  "The language server could not answer this yet (it is still indexing). Plain-text occurrences of `get` instead — UNVERIFIED: they may include comments, strings and unrelated same-named symbols, and an absence here is not proof:\n" +
  "src-tauri/src/lsp/manager.rs\n  80:12  let h = self.get(root, lang);";
const AIDE_DEFINITION =
  "method LspManager.get — src-tauri/src/lsp/manager.rs:216:18\n216\tpub async fn get(&self) {\n217\t}";
const AIDE_OUTLINE =
  "Structure of src/App.vue (2 declarations; L<start>-<end> are line ranges):\nfunction applyTheme  L8-20\nconstant api  L30";

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

describe("两代 LSP 通道（C3 退役内置后，agent 只走 aide-lsp）", () => {
  const AIDE_TOOL = "mcp__aide-lsp__lsp_references";
  const AIDE_INPUT = { name: "get", file: "C:\\repo\\src-tauri\\src\\lsp\\manager.rs" };

  it("aide-lsp 的调用被认作 LSP 上下文（此前硬编码 === \"LSP\" 会整块漏掉）", () => {
    const m = msg("assistant", tool(AIDE_TOOL, AIDE_INPUT, AIDE_OK));
    expect(lastLspContextInMessages([m])).toEqual({ filePath: AIDE_INPUT.file, result: AIDE_OK });
  });

  it("目标文件从 `file` 取，不是内置那代的 `filePath`", () => {
    const m = msg("assistant", tool(AIDE_TOOL, { name: "get", file: "C:\\repo\\a.rs" }, AIDE_OK));
    expect(lastLspContextInMessages([m])?.filePath).toBe("C:\\repo\\a.rs");
  });

  /// 红线在徽章上的体现：索引没就绪的那次调用**什么都没答**，不能拿它当接力上下文。
  /// 注意前缀判据在这一代是失效的（文案开头是 "The"），拦下它的是「结果里没有坐标」。
  it("非 ready（indexing）不算上下文——否则会白送一枚「✓ LSP 接力」", () => {
    const m = msg("assistant", tool(AIDE_TOOL, AIDE_INPUT, AIDE_INDEXING));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  it("ready + 空（已确认的否定）也不算上下文——它没给出任何坐标可沿", () => {
    const m = msg("assistant", tool(AIDE_TOOL, AIDE_INPUT, AIDE_CONFIRMED_EMPTY));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  /// 语义层没答上时，同一发里给的是**文本兜底**——带坐标，但不是 LSP 的答案。
  it("文本兜底（UNVERIFIED）不算上下文，哪怕它带着坐标", () => {
    const m = msg("assistant", tool(AIDE_TOOL, AIDE_INPUT, AIDE_TEXT_FALLBACK));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  /// 按名查定义（没有入参文件）：结果只指向一个文件 ⇒ 那就是接力目标。
  it("按名的定义查询：结果里唯一的文件成为上下文", () => {
    const m = msg("assistant", tool("mcp__aide-lsp__lsp_definition", { name: "get" }, AIDE_DEFINITION));
    expect(lastLspContextInMessages([m])?.filePath).toBe("src-tauri/src/lsp/manager.rs");
  });

  /// 先看结构、再按行区间 Read——最典型的接力。
  it("lsp_outline 之后按区间 Read 同一文件 ⇒ hit", () => {
    const messages = [
      msg("assistant", tool("mcp__aide-lsp__lsp_outline", { file: "src/App.vue" }, AIDE_OUTLINE)),
      msg("assistant", tool("Read", { file_path: "C:\\repo\\src\\App.vue", offset: 8, limit: 13 })),
    ];
    annotateReadRelay(messages);
    expect((messages[1]!.blocks[0] as ToolCallBlock).lspRelay).toBe("hit");
  });

  it("只带 name、没带 file 的调用不构成上下文（没有「那一个坐标」）", () => {
    const m = msg("assistant", tool("mcp__aide-lsp__lsp_symbols", { name: "get" }, AIDE_OK));
    expect(lastLspContextInMessages([m])).toBeNull();
  });

  /// 内置那代的行为**不得**被新判据波及：hover 结果是纯文档、没有路径坐标，
  /// 给它也套上「必须有坐标」会把 hover 构成的上下文整片杀掉。
  it("内置 hover 的成功结果仍算上下文（新判据只作用于 aide-lsp 那代）", () => {
    const m = msg("assistant", tool("LSP", { operation: "hover", filePath: "a.rs" }, HOVER_OK));
    expect(lastLspContextInMessages([m])?.filePath).toBe("a.rs");
  });

  it("两代混用时最近的那次说了算", () => {
    const m = msg(
      "assistant",
      tool("LSP", { operation: "hover", filePath: "a.rs" }, HOVER_OK),
      tool(AIDE_TOOL, { name: "get", file: "b.rs" }, AIDE_OK),
    );
    expect(lastLspContextInMessages([m])?.filePath).toBe("b.rs");
  });

  it("annotateReadRelay（历史回看路径）同样认 aide-lsp：Read 拿得到徽章", () => {
    const messages = [
      msg("assistant", tool(AIDE_TOOL, AIDE_INPUT, AIDE_OK)),
      msg("assistant", tool("Read", { file_path: "manager.rs", offset: 80, limit: 5 })),
    ];
    annotateReadRelay(messages);
    expect((messages[1]!.blocks[0] as ToolCallBlock).lspRelay).toBe("hit");
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