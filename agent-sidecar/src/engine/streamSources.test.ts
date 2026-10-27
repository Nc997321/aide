import { describe, it, expect } from "vitest";
import { StreamSources } from "./streamSources.js";
import { mapSdkMessage } from "./mapper.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import type { ChatEvent } from "./types.js";

describe("SDK block coordinates", () => {
  it("partial events and separately persisted assistant rows share block ids, including skipped task blocks", () => {
    const sources = new StreamSources();
    const events: ChatEvent[] = [];
    const deps = { sources, tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker(), partialMode: true };
    const map = (message: unknown) => mapSdkMessage(message, e => events.push(e), deps);
    map({ type: "stream_event", event: { type: "message_start", message: { id: "api" } } });
    map({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你😀" } } });
    map({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } } });
    map({ type: "assistant", message: { id: "api", content: [{ type: "text", text: "你😀好" }] } });
    map({ type: "assistant", message: { id: "api", content: [{ type: "tool_use", id: "task", name: "TaskList", input: {} }] } });
    map({ type: "assistant", message: { id: "api", content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] } });
    expect(events.filter(e => e.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "你😀", sourceId: "api:0", sourceOffset: 0 },
      { type: "text_delta", delta: "好", sourceId: "api:0", sourceOffset: 3 },
      { type: "text_delta", delta: "", sourceId: "api:0", sourceOffset: 0 },
    ]);
    expect(events.find(e => e.type === "block_snapshot")).toEqual({ type: "block_snapshot", kind: "text", text: "你😀好", sourceId: "api:0", sourceOffset: 0 });
    expect(events.find(e => e.type === "tool_use_start")).toMatchObject({ id: "tool", sourceId: "api:2" });
  });

  it("coalescing respects block boundaries, offsets and offset-zero completed snapshots", () => {
    const events: ChatEvent[] = [];
    const coalescer = new DeltaCoalescer(e => events.push(e));
    coalescer.push({ type: "text_delta", delta: "a", sourceId: "a:0", sourceOffset: 0 });
    coalescer.push({ type: "text_delta", delta: "b", sourceId: "a:0", sourceOffset: 1 });
    coalescer.push({ type: "text_delta", delta: "ab", sourceId: "a:0", sourceOffset: 0 });
    coalescer.push({ type: "text_delta", delta: "c", sourceId: "a:1", sourceOffset: 0 });
    coalescer.flush();
    expect(events).toEqual([
      { type: "text_delta", delta: "ab", sourceId: "a:0", sourceOffset: 0 },
      { type: "text_delta", delta: "ab", sourceId: "a:0", sourceOffset: 0 },
      { type: "text_delta", delta: "c", sourceId: "a:1", sourceOffset: 0 },
    ]);
  });
});
