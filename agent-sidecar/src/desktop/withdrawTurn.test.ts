import { describe, it, expect } from "vitest";
import { messageLineOffset } from "./withdrawTurn.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("messageLineOffset（撤回截断点）", () => {
  it("从这条消息的入队日志起截（那行带原文），之前的对话原样保留", () => {
    const kept = line({ type: "assistant", uuid: "a0" }) + line({ type: "last-prompt" });
    const buf = Buffer.from(
      kept +
        line({ type: "queue-operation", operation: "enqueue", content: "秘密" }) +
        line({ type: "queue-operation", operation: "dequeue" }) +
        line({ type: "user", uuid: "u1", message: { content: "秘密" } }) +
        line({ type: "user", uuid: "x", message: { content: "[Request interrupted by user]" } }),
    );
    expect(messageLineOffset(buf, "u1")).toBe(Buffer.byteLength(kept));
  });

  it("入队日志和这条消息之间隔着别的对话行：只从消息本身截", () => {
    const before = line({ type: "queue-operation", operation: "enqueue", content: "别的" }) + line({ type: "assistant", uuid: "a1" });
    const buf = Buffer.from(before + line({ type: "user", uuid: "u2" }));
    expect(messageLineOffset(buf, "u2")).toBe(Buffer.byteLength(before));
  });

  it("uuid 出现在别的行里（如 parentUuid）不算；找不到 = null", () => {
    const buf = Buffer.from(line({ type: "assistant", uuid: "a", parentUuid: "u3" }));
    expect(messageLineOffset(buf, "u3")).toBeNull();
  });
});
