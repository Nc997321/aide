import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

// ── Tauri mocks（复用 pagination.test.ts 模式）──
let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => {
      chatEventHandler = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useChatSession, __resetForTest, loadOlderPage, hasMoreOlder } from "./useChatSession";
import { useSessionState } from "./useSessionState";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

/**
 * 模拟后端 load_messages 的「字节预算反向分页」契约（与 session.rs
 * read_page_backwards / trim_to_bytes 同语义）：
 * - 文件 = N 回合（每回合 user + assistant 两行，最早在前）
 * - 从 offset（null = 文件尾）往前累计行字节 ≤ limit 截一页；页首裁到 user 行
 * - 返回 { messages, nextOffsetBytes = 页首行起始字节（0 = 文件头） }
 */
function buildBackend(rounds: number, bytesPerRound: number) {
  const lines: string[] = [];
  for (let r = 0; r < rounds; r++) {
    lines.push(JSON.stringify({ type: "user", message: { content: `q${r}` } }));
    lines.push(JSON.stringify({ type: "assistant", message: { content: `a${r}-${"x".repeat(Math.max(1, bytesPerRound / 2 - 16))}` } }));
  }
  const lineBytes = lines.map((l) => l.length + 1); // 含 \n
  const starts: number[] = [];
  let acc = 0;
  for (const b of lineBytes) {
    starts.push(acc);
    acc += b;
  }
  const endBytes = acc;

  function pageForOffset(offset: number | null, limitBytes: number) {
    const end = offset === null ? endBytes : Math.min(offset, endBytes);
    // 收集 [start..lines.len()) 中「行起始 < end」的行（end 之后的行丢弃）
    let collectedStart = lines.length;
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (starts[i] >= end) continue; // 该行起点在收集区（end）之后 → 丢弃
      bytes += lineBytes[i];
      collectedStart = i;
      if (bytes >= limitBytes) break;
    }
    if (process.env.DEBUG_PAGE) {
      console.log(`MOCK end=${end} limit=${limitBytes} collectedStart=${collectedStart} bytes=${bytes}`);
    }
    // 收集区止于「第一个起点 ≥ end 的行」（起点 ≥ end 的行 = 后缀，真实后端在字节块上
    // split 天然不含它们）
    const endFirstIdx = lines.findIndex((_, i) => starts[i] >= end);
    const collectEnd = endFirstIdx === -1 ? lines.length : endFirstIdx;
    // 解析为 items（user/assistant）
    const items = lines.slice(collectedStart, collectEnd).map((l) => {
      const v = JSON.parse(l) as { type: string; message: { content: string } };
      return { role: v.type === "assistant" ? "claude" : "user", text: v.message.content };
    });
    // 页首裁到 user（完整回合起点）
    let pageStart = 0;
    while (pageStart < items.length && items[pageStart].role !== "user") pageStart++;
    const page = items.slice(pageStart);
    const firstLineIdx = collectedStart + pageStart;
    return {
      messages: page.map((m, i) => ({
        role: m.role,
        timestamp: firstLineIdx + i,
        blocks: [{ type: "text" as const, text: m.text }],
      })),
      nextOffsetBytes: firstLineIdx >= lines.length ? 0 : starts[firstLineIdx],
    };
  }

  return { pageForOffset };
}

function loadMessagesCalls() {
  return invokeMock.mock.calls.filter((c) => c[0] === "load_messages");
}

describe("P1 字节分页：长会话逐页翻到底（后端契约闭环）", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("hydrate 尾部一页 → 连续 loadOlderPage 翻到底，无重复无遗漏", async () => {
    // 200 回合 × 每回合 ~3KB ≈ 600KB 文件（> hydrate 预算 256KB → 必有更早页）；
    // 翻页预算 64KB ≈ 21 回合/页 → ~10 页翻完
    const backend = buildBackend(200, 3000);
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "load_messages") {
        return Promise.resolve(backend.pageForOffset(args.offsetBytes as number | null, args.limit as number));
      }
      return Promise.resolve(undefined);
    });
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await flush();
    expect(chat.messages.value.length).toBeGreaterThan(0);
    expect(hasMoreOlder("uuid-a")).toBe(true);

    const seen = new Set<string>();
    chat.messages.value.forEach((m) => seen.add((m.blocks[0] as { text: string }).text));
    console.log(
      "HYDRATE first=",
      (chat.messages.value[0].blocks[0] as { text: string }).text,
      "last=",
      (chat.messages.value[chat.messages.value.length - 1].blocks[0] as { text: string }).text,
      "count=",
      chat.messages.value.length,
    );
    let pages = 0;
    while (hasMoreOlder("uuid-a")) {
      const n = await loadOlderPage("uuid-a", 64 * 1024);
      expect(n).toBeGreaterThan(0); // 每页必须取到内容
      console.log(
        `PAGE ${pages}: n=${n} first=${(chat.messages.value[0].blocks[0] as { text: string }).text}`,
      );
      for (const m of chat.messages.value.slice(0, n)) {
        const t = (m.blocks[0] as { text: string }).text;
        if (seen.has(t)) console.log(`DUP page=${pages} text=${t}`);
        expect(seen.has(t)).toBe(false); // 无重复
        seen.add(t);
      }
      pages += 1;
      expect(pages).toBeLessThan(100); // 防死循环
    }
    // 全部 200 回合（400 条消息）都被取回且无重复
    expect(seen.size).toBe(400);
    expect(hasMoreOlder("uuid-a")).toBe(false);
  });

  it("hydrate 页字节内切 user 行：连续翻页游标单调前进到 0", async () => {
    const backend = buildBackend(200, 3000); // 600KB > hydrate 256KB
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "load_messages") {
        return Promise.resolve(backend.pageForOffset(args.offsetBytes as number | null, args.limit as number));
      }
      return Promise.resolve(undefined);
    });
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    expect(hasMoreOlder("uuid-a")).toBe(true);
    let prevOffset: number | null = null;
    let guard = 0;
    while (hasMoreOlder("uuid-a") && guard++ < 50) {
      await loadOlderPage("uuid-a", 4 * 1024);
      const call = loadMessagesCalls().pop()!;
      const off = call[1].offsetBytes as number | null;
      if (prevOffset !== null) {
        expect(off).toBeLessThan(prevOffset); // 游标单调向文件头前进
      }
      prevOffset = off;
    }
    expect(hasMoreOlder("uuid-a")).toBe(false);
  });
});
