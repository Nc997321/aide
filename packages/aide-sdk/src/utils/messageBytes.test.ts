import { describe, it, expect } from "vitest";
import {
  estimateBlockBytes,
  computeStoreBytes,
  summarizeText,
  truncatedLabel,
  SUMMARY_HEAD,
  SUMMARY_TAIL,
} from "./messageBytes";
import type { ContentBlock, ChatMessage } from "@/types/chat";

function msg(blocks: ContentBlock[]): ChatMessage {
  return { id: "m1", role: "assistant", blocks, timestamp: 0 };
}

describe("estimateBlockBytes", () => {
  it("text / thinking = text.length × 2", () => {
    expect(estimateBlockBytes({ type: "text", text: "abc" })).toBe(6);
    expect(estimateBlockBytes({ type: "thinking", text: "ab" })).toBe(4);
  });

  it("tool_call = input 字节 + result 字节（input 为 string 走快速路径）", () => {
    expect(
      estimateBlockBytes({ type: "tool_call", id: "t", name: "Read", input: "x.txt", isPending: false }),
    ).toBe("x.txt".length * 2);
    expect(
      estimateBlockBytes({ type: "tool_call", id: "t", name: "Bash", input: "cmd", isPending: false, result: "ok" }),
    ).toBe("cmd".length * 2 + "ok".length * 2);
  });

  it("tool_call input 为对象走 JSON.stringify", () => {
    const input = { command: "ls" };
    const b = estimateBlockBytes({
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input,
      isPending: false,
      result: "ok",
    });
    expect(b).toBe(JSON.stringify(input).length * 2 + "ok".length * 2);
  });

  it("image = data.length × 2", () => {
    expect(estimateBlockBytes({ type: "image", data: "abcd", mediaType: "image/png" })).toBe(8);
  });

  it("subagent = prompt + entries + result 合计", () => {
    const toolInput = { c: "ls" };
    const b = estimateBlockBytes({
      type: "subagent",
      id: "a1",
      agentName: "general-purpose",
      description: "d",
      prompt: "p",
      entries: [
        { type: "text", text: "hi" },
        { type: "tool", toolUseId: "tu1", toolName: "Bash", input: toolInput, result: "out" },
      ],
      isPending: false,
      result: "final",
    });
    const expected =
      "p".length * 2 +
      "final".length * 2 +
      "hi".length * 2 +
      JSON.stringify(toolInput).length * 2 +
      "out".length * 2;
    expect(b).toBe(expected);
  });

  it("action = 0（纯展示无大载荷）", () => {
    expect(estimateBlockBytes({ type: "action", actionId: "compact", label: "压缩" })).toBe(0);
  });
});

describe("computeStoreBytes", () => {
  it("跨消息 × block 求和", () => {
    const store = {
      messages: [
        msg([{ type: "text", text: "ab" }, { type: "thinking", text: "c" }]),
        msg([{ type: "image", data: "de", mediaType: "image/png" }]),
      ],
    };
    expect(computeStoreBytes(store)).toBe(4 + 2 + 4);
  });

  it("空 store = 0", () => {
    expect(computeStoreBytes({ messages: [] })).toBe(0);
  });
});

describe("summarizeText", () => {
  it("短文本原样返回（≤ 头+尾）", () => {
    expect(summarizeText("short")).toBe("short");
    expect(summarizeText("x".repeat(SUMMARY_HEAD + SUMMARY_TAIL))).toBe("x".repeat(SUMMARY_HEAD + SUMMARY_TAIL));
  });

  it("长文本保留头尾 + 中段省略标记 + 原字数", () => {
    const head = "H".repeat(SUMMARY_HEAD);
    const mid = "M".repeat(100);
    const tail = "T".repeat(SUMMARY_TAIL);
    const text = head + mid + tail;
    const out = summarizeText(text);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain(`原 ${text.length} 字`);
    expect(out).toContain("内容已省略");
    expect(out.length).toBeLessThan(text.length);
  });
});

describe("truncatedLabel", () => {
  it("文案含「内容已省略」+ 原字数（originalBytes/2 四舍五入）", () => {
    expect(truncatedLabel(2000)).toBe("内容已省略,原 1000 字");
    // Math.round(999/2) = Math.round(499.5) = 500
    expect(truncatedLabel(999)).toBe("内容已省略,原 500 字");
  });
});