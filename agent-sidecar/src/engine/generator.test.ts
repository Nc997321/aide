import { describe, expect, it } from "vitest";
import { MessageQueue } from "./generator.js";

// 2026-08-21 竞态实锤（场景 B 注入丢失的根因）：abort 后第一轮迭代器还挂在
// resolveNext 上（SDK 已 abort 不再调 next），此时 push 的消息会被旧迭代器
// shift 走、卡死在 yield 挂起点——下一轮新迭代器永远拿不到。
// 当年只让注入消息绕开共享 queue（预置槽），队列语义未动；2026-09-14 同一机制
// 在**正常续发**路径复现（402 错误终态 → 重发永远「正在思考」），才补上第二道
// 闸：换轮方同步调 retireIterators() 作废旧迭代器（见 session-worker startLoop）。
// 下面第一条钉住「不 retire 时旧迭代器优先消费」这一原始语义——它是换轮必须
// retire 的理由，也是注入不能改回 queue.push 的理由。
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

  it("retire 后孤儿迭代器只退场，消息留给下一轮迭代器（2026-09-14 402 事故）", async () => {
    const q = new MessageQueue();
    // 上一轮：SDK 输入泵挂着等输入，随后那轮异常终止（没人 return 这个迭代器）
    const orphan = q[Symbol.asyncIterator]();
    const orphanPending = orphan.next();
    // 换轮：新 query 建立之前先作废旧迭代器
    q.retireIterators();
    q.push({
      type: "user",
      message: { role: "user", content: "继续" },
      parent_tool_use_id: null,
    } as any);
    // 孤儿被唤醒后直接退场，不认领消息——认领了就是 UI 永远「正在思考」
    expect((await orphanPending).done).toBe(true);
    // 消息仍在队列里，交给新一轮的迭代器
    const next = q[Symbol.asyncIterator]();
    expect(((await next.next()).value as any).message.content).toBe("继续");
    expect(q.size).toBe(0);
  });

  it("retire 不影响作废之后新建的迭代器（换轮不误伤自己）", async () => {
    const q = new MessageQueue();
    q.retireIterators();
    q.retireIterators();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push({
      type: "user",
      message: { role: "user", content: "b" },
      parent_tool_use_id: null,
    } as any);
    expect(((await pending).value as any).message.content).toBe("b");
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
