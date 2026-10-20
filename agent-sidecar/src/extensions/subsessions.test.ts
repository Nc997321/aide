import { describe, expect, it, vi } from "vitest";
import {
  formatChildren,
  formatSpawn,
  querySubsession,
  resolveSubsessionResult,
  subsessionToolsMounted,
} from "./subsessions.js";

const gate = { isChild: false, automation: false, trusted: true, env: {} as NodeJS.ProcessEnv };

describe("subsessions 工具", () => {
  it("挂载闸门：子会话（深度 1）/ 自动化 / 不受信任 / 显式关闭都不挂", () => {
    expect(subsessionToolsMounted(gate)).toBe(true);
    expect(subsessionToolsMounted({ ...gate, isChild: true })).toBe(false);
    expect(subsessionToolsMounted({ ...gate, automation: true })).toBe(false);
    expect(subsessionToolsMounted({ ...gate, trusted: false })).toBe(false);
    expect(subsessionToolsMounted({ ...gate, env: { AIDE_SUBSESSION_TOOLS: "off" } })).toBe(false);
  });

  it("请求带上父会话现状，按 request_id 结算 Host 回包", async () => {
    const emit = vi.fn();
    const p = querySubsession("spawn", { task: "t" }, {
      emit,
      context: () => ({ permissionMode: "auto", model: "opus", effort: "high" }),
    });
    const ev = emit.mock.calls[0][0];
    expect(ev).toMatchObject({ type: "subsession_query", op: "spawn", permission_mode: "auto", model: "opus", effort: "high" });
    resolveSubsessionResult({ request_id: ev.request_id, ok: true, data: { child_id: "c1", title: "T" } });
    expect(formatSpawn(await p)).toContain('Started sub-session "T" (id c1)');
  });

  it("失败与列表都是模型可读文本", () => {
    expect(formatSpawn({ ok: false, error: "已有 4 个子会话在跑" })).toContain("was not started: 已有 4 个子会话在跑");
    expect(formatChildren({ ok: true, data: { children: [] } })).toBe("This session has no sub-sessions.");
    expect(
      formatChildren({ ok: true, data: { children: [{ id: "a", title: "A", status: "waiting_approval", last_report: "41 passed" }] } }),
    ).toBe("- A (id a): waiting_approval\n  last report: 41 passed");
  });

  it("名下有空闲子会话时不新开：列出它们的上下文、缓存、动过的文件与复用判断，并说明怎么强制新开", () => {
    const text = formatSpawn({
      ok: true,
      data: {
        started: false,
        idle_children: [
          {
            id: "c1", title: "搭骨架", status: "idle", idle_minutes: 12, context_tokens: 38_400, context_pct: 19,
            cache_warm: false, reuse: "cheap", task: "在 notify-platform 搭四层骨架", area: ["notify-domain/build.gradle"], area_more: 3,
            last_report: "已完成",
          },
        ],
      },
    });
    expect(text).toContain("Nothing started yet");
    expect(text).toContain("- 搭骨架 (id c1): idle 12 min, context 38k (19%), cache cold, reuse: cheap");
    expect(text).toContain("  task: 在 notify-platform 搭四层骨架");
    expect(text).toContain("  edited: notify-domain/build.gradle (+3 more)");
    expect(text).toContain("new=true");
  });

  it("Host 不知道的事实（重启后）不写，不编", () => {
    expect(formatChildren({ ok: true, data: { children: [{ id: "a", title: "A", status: "idle", reuse: "moderate" }] } })).toBe(
      "- A (id a): idle, reuse: only if closely related",
    );
  });
});
