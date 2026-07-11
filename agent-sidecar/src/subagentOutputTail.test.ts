import { describe, it, expect, beforeEach } from "vitest";
import { parseOutputLine } from "./subagentOutputTail.js";
import type { ChatEvent } from "./types.js";

describe("subagentOutputTail parseOutputLine", () => {
  const id = "a1";
  let modelClaimed = false;
  const claimModel = () => { if (!modelClaimed) { modelClaimed = true; return true; } return false; };

  function run(line: string): ChatEvent[] {
    const events: ChatEvent[] = [];
    parseOutputLine(line, id, (e) => events.push(e), claimModel);
    return events;
  }

  beforeEach(() => { modelClaimed = false; });

  it("assistant tool_use 行 → subagent_progress（首行带 model）", () => {
    const ev = run(JSON.stringify({
      type: "assistant", isSidechain: true, agentId: "ab99",
      message: { role: "assistant", model: "glm-5.2", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } }] },
    }));
    expect(ev).toEqual([{ type: "subagent_progress", id: "a1", toolUseId: "t1", toolName: "Read", input: { file_path: "x.ts" }, model: "glm-5.2" }]);
  });

  it("第二条 assistant tool_use 不再带 model（claimModel once）", () => {
    run(JSON.stringify({ type: "assistant", message: { model: "glm-5.2", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }));
    const ev = run(JSON.stringify({ type: "assistant", message: { model: "glm-5.2", content: [{ type: "tool_use", id: "t2", name: "Grep", input: {} }] } }));
    expect(ev).toEqual([{ type: "subagent_progress", id: "a1", toolUseId: "t2", toolName: "Grep", input: {} }]);
  });

  it("user tool_result 行 → subagent_tool_result 回填", () => {
    const ev = run(JSON.stringify({
      type: "user", isSidechain: true, agentId: "ab99",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容…", is_error: false }] },
    }));
    expect(ev).toEqual([{ type: "subagent_tool_result", id: "a1", toolUseId: "t1", content: "文件内容…", is_error: false }]);
  });

  it("assistant 纯文本行 → subagent_text_delta", () => {
    const ev = run(JSON.stringify({ type: "assistant", message: { model: "glm-5.2", content: [{ type: "text", text: "我先看看" }] } }));
    expect(ev).toEqual([{ type: "subagent_text_delta", id: "a1", delta: "我先看看" }]);
  });

  it("空行/非法 JSON → 不发事件，不抛", () => {
    expect(run("")).toEqual([]);
    expect(run("not json")).toEqual([]);
  });
});
