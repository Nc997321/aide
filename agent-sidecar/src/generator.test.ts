import { describe, expect, it } from "vitest";
import { MessageQueue } from "./generator.js";

// 2026-08-21 竞态实锤（场景 B 注入丢失的根因）：abort 后第一轮迭代器还挂在
// resolveNext 上（SDK 已 abort 不再调 next），此时 push 的消息会被旧迭代器
// shift 走、卡死在 yield 挂起点——下一轮新迭代器永远拿不到。
// 修复：注入消息不走共享 queue（session-worker 预置到每轮 query 私有迭代器），
// 本测试钉住 MessageQueue 的原始语义（旧迭代器优先消费），防止有人把注入
// 改回 queue.push。
describe("MessageQueue", () => {
  it("aborted round's hung iterator steals push()ed messages (rollback injection lost)", async () => {
    const q = new MessageQueue();
    // 第一轮 query 的迭代器：SDK 等待输入，挂在 resolveNext 上
    const it1 = q[Symbol.asyncIterator]();
    const pending1 = it1.next();
    // 场景 B 注入消息走 queue.push（旧代码路径）
    q.push({
      type: "user",
      message: { role: "user", content: "ROLLBACK_TOOL_CONTINUE" },
      parent_tool_use_id: null,
    } as any);
    // 旧迭代器被唤醒，把注入消息 shift 走（调用方已 abort，这轮没人再 next）
    const stolen = await pending1;
    expect((stolen.value as any).message.content).toBe("ROLLBACK_TOOL_CONTINUE");
    // 下一轮 query 的新迭代器：queue 已空，挂起等新消息
    const it2 = q[Symbol.asyncIterator]();
    const pending2 = it2.next();
    // 用户随后发消息 → push 唤醒的是 it2（resolveNext 单槽已被覆盖）
    q.push({
      type: "user",
      message: { role: "user", content: "user's next message" },
      parent_tool_use_id: null,
    } as any);
    const got = await pending2;
    // 新迭代器拿到的不是注入，而是用户消息——注入已丢失
    expect((got.value as any).message.content).toBe("user's next message");
    expect(((q as any).queue as unknown[]).length).toBe(0);
  });

  it("pending iterator stays resolvable until replaced by the next iterator", async () => {
    const q = new MessageQueue();
    const it1 = q[Symbol.asyncIterator]();
    const p1 = it1.next();
    q.push({ type: "user", message: { role: "user", content: "a" } } as any);
    expect((await p1).value).toBeTruthy();
    // it1 停在 yield 后，下一次 next() 会挂起在 resolveNext——新迭代器覆盖后
    // 旧迭代器的 promise 永远 pending（无害泄漏，resolveNext 单槽语义）
    const it2 = q[Symbol.asyncIterator]();
    const p2 = it2.next();
    q.push({ type: "user", message: { role: "user", content: "b" } } as any);
    expect(((await p2).value as any).message.content).toBe("b");
  });
});
