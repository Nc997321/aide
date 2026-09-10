import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOutputLine, startOutputTail, stopOutputTail } from "./subagentOutputTail.js";
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

// OutputTail 的有状态逻辑（offset 跨轮推进、半行 leftover 拼接、截断重置）此前完全
// 没有测试覆盖——只测了纯函数 parseOutputLine。这里对着真实临时文件驱动
// startOutputTail/stopOutputTail，用 fake timers 精确推进 600ms 轮询间隔。
describe("OutputTail 状态机（真实临时文件 + fake timers）", () => {
  const id = "tail-test";
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    // 只 fake setInterval（600ms 轮询），保留真实 setTimeout——异步 tick 的 fs
    // 回调需要真实事件循环轮转才能落地（fake timers 不代跑 libuv，2026-08-23 实测）。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    dir = mkdtempSync(join(tmpdir(), "aide-output-tail-"));
    filePath = join(dir, "agent.output");
  });

  afterEach(() => {
    stopOutputTail(id);
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 推进一次 600ms 轮询并等异步 tick 的 fs 链落地。tick 的 await 链
   *  （stat→open→read→close）每步跨一次 libuv 轮转，单个真实 setTimeout(0)
   *   只给一步——多轮 0ms 定时器把整条链走完，否则下轮 tick 被 ticking 守卫
   *   跳过（在途读未完成），事件永远到不了。 */
  async function tickOnce(): Promise<void> {
    vi.advanceTimersByTime(600);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it("JSONL 行跨两次轮询写入（半行 leftover 拼接）：第一次 tick 无事件，补全后第二次 tick 恰好产出一条，不重复", async () => {
    const events: ChatEvent[] = [];
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "跨轮拼接测试" }] } });
    const splitAt = Math.floor(line.length / 2);
    const half = line.slice(0, splitAt);
    const rest = line.slice(splitAt);

    writeFileSync(filePath, half); // 没有换行——一条不完整的行
    startOutputTail(id, filePath, (e) => events.push(e), () => {});

    await tickOnce();
    expect(events).toEqual([]); // 半行应被缓冲为 leftover，本轮不产出任何事件

    appendFileSync(filePath, rest + "\n");
    await tickOnce();
    expect(events).toEqual([{ type: "subagent_text_delta", id, delta: "跨轮拼接测试" }]); // 恰好一条，不多不少
  });

  it("文件截断后重新写入：截断前的行先产出一次，截断后的新行产出且 offset/leftover 已正确重置", async () => {
    const events: ChatEvent[] = [];
    // line1 明显比 line2 长，确保截断+重写后的文件大小 < 截断前的 offset，
    // 从而真正命中 tick() 里的 `st.size < this.offset` 重置分支。
    const line1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "A".repeat(200) }] } });
    const line2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "B" }] } });

    writeFileSync(filePath, line1 + "\n");
    startOutputTail(id, filePath, (e) => events.push(e), () => {});

    await tickOnce();
    expect(events).toEqual([{ type: "subagent_text_delta", id, delta: "A".repeat(200) }]);

    events.length = 0;
    writeFileSync(filePath, ""); // 截断
    writeFileSync(filePath, line2 + "\n"); // 换新内容，体积明显小于截断前的 offset

    await tickOnce();
    expect(events).toEqual([{ type: "subagent_text_delta", id, delta: "B" }]); // 新行被正确读到，没有卡死或重复读旧内容
  });

  it("单次 tick 最多读 1MB：超限截断、剩余下次续读（大输出文件防 OOM/事件循环卡死）", async () => {
    const events: ChatEvent[] = [];
    const bigText = "x".repeat(1024 * 1024); // 1MB 整行
    const tailLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: bigText }] } });
    // 尾部再补一条短行：文件总量 1MB+，第一次 tick 被钳在 1MB——截断点落在
    // 行长 x 串中间（行尾 "}]}" 与换行都在 1MB 之外），半行整体进 leftover。
    // 若钳制失效（一次读完）第一次 tick 就会产出完整行长 → 0 事件即钳制实锤。
    const shortLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tail" }] } });
    writeFileSync(filePath, tailLine + "\n" + shortLine + "\n");

    startOutputTail(id, filePath, (e) => events.push(e), () => {});
    await tickOnce();
    // 第一次 tick：读量被钳在 1MB（未一次 allocUnsafe 全量），截断的半行
    // 无换行 → leftover 缓冲，本轮零事件
    expect(events).toEqual([]);

    await tickOnce();
    // 第二次 tick：剩余部分续读完成，短行完整产出
    expect(events.some((e) => e.type === "subagent_text_delta" && (e as { delta: string }).delta === "tail")).toBe(true);
  });
});
