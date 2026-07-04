import { describe, it, expect } from "vitest";
import { PermissionManager } from "./permissions.js";
import type { ChatEvent } from "./types.js";

describe("PermissionManager — AskUserQuestion answers 重组", () => {
  it("approving AskUserQuestion rebuilds updatedInput as {questions, answers} instead of echoing input", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { questions: [{ question: "用什么颜色？", header: "配色", options: [{ label: "蓝色", description: "冷色调" }] }] };
    const resultPromise = callback("AskUserQuestion", input, {});

    const id = (events[0] as any).id;
    mgr.resolve(id, true, undefined, { "用什么颜色？": "蓝色" });

    const result = await resultPromise;
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { questions: input.questions, answers: { "用什么颜色？": "蓝色" } },
    });
  });

  it("still echoes raw input unchanged for ordinary tools (no regression)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { command: "ls" };
    const resultPromise = callback("Bash", input, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, true, undefined, undefined);

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("denying AskUserQuestion returns deny, ignoring any stray answers", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("AskUserQuestion", { questions: [] }, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, false);

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "deny", message: "用户拒绝" });
  });

  it("approving a non-AskUserQuestion tool ignores an answers payload (defensive: no accidental reshape)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { file_path: "x.ts" };
    const resultPromise = callback("Write", input, {});
    const id = (events[0] as any).id;
    // 即便前端误传了 answers，非 AskUserQuestion 工具也不该被重塑
    mgr.resolve(id, true, undefined, { "some question": "some answer" });

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });
});
