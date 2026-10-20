import { describe, expect, it } from "vitest";
import { buildWatchTools, watchMcpRegistration, WATCH_ALLOW_RULES } from "./watchMcp.js";
import { WatchManager, type WatchSpec } from "./watch/manager.js";
import { runCommand } from "./watch/sources.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;

function tools() {
  const started: WatchSpec[] = [];
  const fake = {
    start: async (s: WatchSpec) => {
      started.push(s);
      return { ok: true as const, id: "w1", baseline: 3 };
    },
    stop: (id: string) => id === "w1",
    list: () => [],
  } as unknown as WatchManager;
  const ts = buildWatchTools(fake) as unknown as { name: string; handler: Handler }[];
  return { started, call: (n: string, a: Record<string, unknown>) => ts.find((t) => t.name === n)!.handler(a, {}) };
}

describe("watch tools", () => {
  it("窗口来源：组装规格，默认 120 分钟", async () => {
    const t = tools();
    const r = await t.call("watch_start", { title: "QQ", focus: "新消息", window_id: "0x1", scope: "e5", every_seconds: 10, mode: "on_change" });
    expect(r.content[0].text).toContain("Watch w1 started");
    expect(t.started[0]).toMatchObject({ source: { kind: "window", windowId: "0x1", scope: "e5" }, maxMinutes: 120 });
  });

  it("来源必须恰好一个；命令最快 10 秒一次", async () => {
    const t = tools();
    expect((await t.call("watch_start", { title: "x", focus: "y", every_seconds: 10, mode: "every" })).content[0].text).toContain("exactly one");
    expect(
      (await t.call("watch_start", { title: "x", focus: "y", window_id: "0x1", command: "ls", every_seconds: 10, mode: "every" })).content[0].text,
    ).toContain("exactly one");
    expect((await t.call("watch_start", { title: "x", focus: "y", command: "ls", every_seconds: 5, mode: "every" })).content[0].text).toContain("10 seconds");
    expect(t.started).toHaveLength(0);
  });

  it("只有列出 / 停止免确认；自动化运行与不受信任工作区不挂", () => {
    expect(WATCH_ALLOW_RULES).toEqual(["mcp__aide-watch__watch_list", "mcp__aide-watch__watch_stop"]);
    const m = {} as WatchManager;
    expect(watchMcpRegistration(m, { trusted: true, automation: true, env: {} })).toBeNull();
    expect(watchMcpRegistration(m, { trusted: false, automation: false, env: {} })).toBeNull();
    expect(watchMcpRegistration(m, { trusted: true, automation: false, env: { AIDE_WATCH_TOOLS: "off" } })).toBeNull();
    expect(watchMcpRegistration(m, { trusted: true, automation: false, env: {} })).toHaveProperty("aide-watch");
  });

  it("命令来源：取合并输出，非零退出码附在末尾，超时会杀掉", async () => {
    const ok = await runCommand("echo hello && echo oops 1>&2", undefined, 5000);
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("hello");
    expect(ok.text).toContain("oops");
    const bad = await runCommand("exit 3", undefined, 5000);
    expect(bad.text).toContain("[exit code 3]");
    const slow = await runCommand(process.platform === "win32" ? "ping -n 5 127.0.0.1" : "sleep 5", undefined, 300);
    expect(slow.ok).toBe(false);
  });
});
