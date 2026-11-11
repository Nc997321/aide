import { describe, expect, it, vi } from "vitest";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { SessionWorker } from "./session-worker.js";
import type { ChatEvent } from "./types.js";

const models = [
  { value: "opus", displayName: "main-model", resolvedModel: "main-model" },
  { value: "fable", displayName: "Fable 5.1", resolvedModel: "claude-fable-5-1" },
];

function fakeQuery() {
  const messages = (async function* () {
    yield { type: "system", subtype: "init", session_id: "models-test" };
  })();
  return Object.assign(messages, { initializationResult: async () => ({ models }) });
}

async function availableModels(allowlist?: string[]) {
  const events: ChatEvent[] = [];
  const worker = new SessionWorker("models-test", (event) => events.push(event), {
    // 最小 Query 桩只模拟 init 与模型清单，不会创建 CLI 进程或调用模型。
    queryFn: fakeQuery as unknown as typeof query,
  });
  try {
    worker.handleCommand({
      cmd: "send", session_id: "models-test", prompt: "test", trusted: false,
      env: { ANTHROPIC_MODEL: "main-model" }, model_allowlist: allowlist,
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "models_available")).toBe(true));
    const event = events.find((item) => item.type === "models_available");
    if (!event || event.type !== "models_available") throw new Error("missing models_available event");
    return event;
  } finally {
    worker.stop();
  }
}

describe("SessionWorker 模型名单接线", () => {
  it("send 的宿主名单在广播前筛选 SDK 列表", async () => {
    const event = await availableModels(["main-model"]);
    expect(event.models).toEqual([{ value: "main-model", displayName: "main-model" }]);
    expect(event.sdk_roster).toEqual([{ value: "opus", displayName: "main-model" }]);
  });

  it("不带名单兼容官方/旧调用，Fable 仍可见", async () => {
    const event = await availableModels();
    expect(event.models.map((model) => model.value)).toEqual(["main-model", "claude-fable-5-1"]);
  });
});
