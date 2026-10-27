import { beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("../engine/claudeExe.js", () => ({ resolveClaudeExe: () => undefined }));
import { handoffChunks, summarizeHandoff, HANDOFF_CHUNK_CHARS, type HandoffCommand } from "./handoff.js";

function command(text: string): HandoffCommand {
  return { cmd: "summarize_handoff", session_id: "source", request_id: "draft", transcript: text,
    focus: "完成测试", cwd: process.cwd(), env: { ANTHROPIC_BASE_URL: "https://provider.example", ANTHROPIC_MODEL: "source-model" } };
}
function response(result: string, subtype = "success") {
  return Object.assign((async function* () { yield { type: "result", subtype, result }; })(), { close: vi.fn() });
}
beforeEach(() => queryMock.mockReset());
describe("会话交接摘要", () => {
  it("完整覆盖多段 Unicode 历史，不切坏字符", () => {
    const text = "文🚀".repeat(HANDOFF_CHUNK_CHARS);
    const chunks = handoffChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => Array.from(c).length <= HANDOFF_CHUNK_CHARS)).toBe(true);
  });
  it("使用 Host 指定的新供应商和档位，禁用工具、持久化和 resume；逐段合并摘要", async () => {
    queryMock.mockImplementationOnce(() => response("第一段摘要")).mockImplementationOnce(() => response("最终摘要"));
    expect(await summarizeHandoff({ ...command("a".repeat(HANDOFF_CHUNK_CHARS + 1)), effort: "low" })).toBe("最终摘要");
    const first = queryMock.mock.calls[0][0];
    expect(first.options.tools).toEqual([]);
    expect(first.options.persistSession).toBe(false);
    expect(first.options.resume).toBeUndefined();
    expect(first.options.env.ANTHROPIC_BASE_URL).toBe("https://provider.example");
    expect(first.options.env.ANTHROPIC_MODEL).toBe("source-model");
    expect(first.options.effort).toBe("low");
    expect(queryMock.mock.calls[1][0].prompt).toContain("第一段摘要");
  });
  it("任一分段失败就拒绝，不拿部分摘要冒充完整交接", async () => {
    queryMock.mockImplementationOnce(() => response("第一段摘要")).mockImplementationOnce(() => response("", "error_during_execution"));
    await expect(summarizeHandoff(command("a".repeat(HANDOFF_CHUNK_CHARS + 1)))).rejects.toThrow("生成失败");
  });
});
