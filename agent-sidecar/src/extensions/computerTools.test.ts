import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../engine/types.js";
import { buildComputerTools } from "./computerTools.js";
import { COMPUTER_ALLOW_RULES, computerMcpRegistration } from "./computerMcp.js";
import { cancelAllComputerQueries, resolveComputerResult, timeoutFor } from "./computer/client.js";
import { formatAct, formatRead, formatWait, formatWindows } from "./computer/format.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text?: string; data?: string }[] }>;

function toolsWith(reply: (e: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string }) {
  const sent: Record<string, unknown>[] = [];
  const emit = (e: ChatEvent) => {
    const ev = e as unknown as Record<string, unknown>;
    sent.push(ev);
    // 模拟桌面进程异步回包
    queueMicrotask(() => resolveComputerResult({ request_id: ev.request_id as string, ...reply(ev) }));
  };
  const tools = buildComputerTools(emit) as unknown as { name: string; handler: Handler }[];
  const byName = (n: string) => tools.find((t) => t.name === n)!.handler;
  return { sent, byName };
}

describe("computer tools", () => {
  it("exposes five tools; only the read-only ones are auto-allowed", () => {
    const { byName } = toolsWith(() => ({ ok: true }));
    for (const n of ["computer_windows", "computer_read", "computer_act", "computer_wait", "computer_window"]) {
      expect(byName(n)).toBeTypeOf("function");
    }
    expect(COMPUTER_ALLOW_RULES).toEqual([
      "mcp__aide-computer__computer_windows",
      "mcp__aide-computer__computer_read",
      "mcp__aide-computer__computer_wait",
    ]);
  });

  it("sends computer_query over the bridge and renders the reply", async () => {
    const { sent, byName } = toolsWith(() => ({
      ok: true,
      data: { windows: [{ id: "0x1", title: "无标题 - 记事本", process: "Notepad.exe", foreground: true, accessible: true }] },
    }));
    const res = await byName("computer_windows")({}, {});
    expect(sent[0]).toMatchObject({ type: "computer_query", op: "windows" });
    expect(res.content[0].text).toContain('0x1  "无标题 - 记事本"  Notepad.exe  [foreground]');
  });

  it("returns executor errors as text, never throws", async () => {
    const { byName } = toolsWith(() => ({ ok: false, error: "Another Aide session is operating the computer right now." }));
    const res = await byName("computer_act")({ window_id: "0x1", intent: "x", steps: [{ do: "press", keys: "enter" }] }, {});
    expect(res.content[0].text).toContain("Another Aide session");
  });

  it("attaches the screenshot as an image block", async () => {
    const { byName } = toolsWith(() => ({
      ok: true,
      data: { obs: 3, window: { id: "0x1", title: "w", process: "p" }, elements: [], screenshot: { png_base64: "AAAA", width: 10, height: 5 } },
    }));
    const res = await byName("computer_read")({ window_id: "0x1", screenshot: true }, {});
    expect(res.content[1]).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(res.content[0].text).toContain("{x, y, obs: 3}");
  });

  it("cancel resolves pending queries", async () => {
    const tools = buildComputerTools(() => {}) as unknown as { name: string; handler: Handler }[];
    const p = tools.find((t) => t.name === "computer_windows")!.handler({}, {});
    cancelAllComputerQueries("interrupted");
    expect((await p).content[0].text).toBe("interrupted");
  });

  it("client timeout outlasts the executor's own wait limit", () => {
    expect(timeoutFor({ op: "wait", condition: {}, timeout_ms: 60_000 })).toBeGreaterThan(60_000);
    expect(timeoutFor({ op: "act", window_id: "0x1", intent: "x", steps: [] })).toBeGreaterThan(60_000);
  });

  it("is not mounted for untrusted workspaces or when switched off", () => {
    expect(computerMcpRegistration(() => {}, {}, false)).toBeNull();
    expect(computerMcpRegistration(() => {}, { AIDE_COMPUTER_TOOLS: "off" }, true)).toBeNull();
    expect(computerMcpRegistration(() => {}, {}, true)).toHaveProperty("aide-computer");
  });
});

describe("computer result formatting", () => {
  it("renders the control tree with refs, values, states and text", () => {
    const out = formatRead({
      obs: 2,
      focused: "e3",
      window: { id: "0x1", title: "终端", process: "WindowsTerminal.exe", foreground: true },
      elements: [
        { ref: "e1", role: "Window", name: "终端", depth: 0 },
        { ref: "e3", role: "Edit", name: "文件名", value: "a.txt", states: ["focused"], depth: 1 },
        { ref: "e4", role: "Text", name: "", text: "$ ls\nfoo", depth: 1 },
      ],
      truncated: "12 more elements not listed.",
    });
    expect(out).toContain("obs 2 · focused e3");
    expect(out).toContain('  [e3] Edit "文件名" = "a.txt" (focused)');
    expect(out).toContain("      | $ ls\n      | foo");
    expect(out).toContain("(12 more elements not listed.)");
  });

  it("marks a scoped read", () => {
    const out = formatRead({ obs: 1, scope: "e7", window: { id: "0x1", title: "w", process: "p" }, elements: [] });
    expect(out).toContain("only inside e7");
  });

  it("renders act results with stop reason and changes", () => {
    const out = formatAct({
      executed: 1,
      of: 2,
      steps: [{ step: 1, done: 'invoked [e3] Button "保存"' }],
      stopped: "Step 2 was not executed: e9 is no longer there",
      after: {
        foreground: { id: "0x2", title: "另存为", process: "Notepad.exe", foreground: true },
        obs: 5,
        opened_windows: [{ id: "0x2", title: "另存为", process: "Notepad.exe" }],
        changes: {
          added: [{ ref: "e20", role: "Button", name: "确定", depth: 0 }],
          removed: [{ ref: "e3", role: "Button", name: "保存" }],
          changed: [{ ref: "e5", role: "Edit", name: "x", fields: [["value", "a", "b"]], text_added: "hi" }],
        },
      },
    });
    expect(out).toContain("Executed 1 of 2 steps.");
    expect(out).toContain("STOPPED: Step 2 was not executed");
    expect(out).toContain('Opened window: 0x2  "另存为"');
    expect(out).toContain(' + [e20] Button "确定"');
    expect(out).toContain(' - [e3] Button "保存"');
    expect(out).toContain(' ~ [e5] Edit "x": value "a" → "b" new text:');
  });

  it("renders waits and window lists", () => {
    expect(formatWait({ met: false, waited_ms: 10000, note: "Timed out" })).toContain("Timed out after 10000 ms.");
    expect(formatWait({ met: true, waited_ms: 300, changes: "nothing changed" })).toContain("Changes in this window: nothing changed.");
    expect(formatWindows({ windows: [{ id: "0x9", title: "任务管理器", process: "Taskmgr.exe", accessible: false }] })).toContain(
      "runs as administrator — cannot operate",
    );
  });
});
