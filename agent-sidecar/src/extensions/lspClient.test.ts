import { describe, it, expect } from "vitest";
import {
  queryLsp,
  resolveLspResult,
  cancelAllLspQueries,
  isLspWarm,
  _resetLspWarmForTest,
  LSP_QUERY_TIMEOUT_MS,
} from "./lspClient.js";
import type { ChatEvent } from "../engine/types.js";

describe("lspClient", () => {
  it("emit 出带 request_id 的 lsp_query 事件，并按 id 结算", async () => {
    const events: ChatEvent[] = [];
    const p = queryLsp("references", { name: "get" }, "/proj", (e) => events.push(e));

    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev.type).toBe("lsp_query");
    expect(ev.tool).toBe("references");
    expect(ev.workspace_root).toBe("/proj");
    expect(typeof ev.request_id).toBe("string");

    resolveLspResult({
      request_id: ev.request_id as string,
      ok: true,
      status: "ready",
      results: [{ file_path: "/a.rs", line: 1 }],
    });
    await expect(p).resolves.toMatchObject({ ok: true, status: "ready" });
  });

  it("未知 request_id 静默丢弃（超时/取消后迟到的回包）", () => {
    expect(() =>
      resolveLspResult({ request_id: "nope", ok: true, status: "ready" })
    ).not.toThrow();
  });

  it("cancelAll 让挂起查询立刻以 cancelled 结算", async () => {
    const p = queryLsp("symbols", { name: "x" }, "/proj", () => {});
    cancelAllLspQueries("session stopped");
    await expect(p).resolves.toMatchObject({
      ok: false,
      cancelled: true,
      error: "session stopped",
    });
  });

  /// 冷启动实测 46–73s（见 docs/superpowers/spikes/2026-09-19-lsp-agent-tools/），
  /// 超时预算必须显著高于它——10s会让每次冷启动查询都超时，
  /// 正好复现本设计要消灭的失败模式。
  it("超时预算显著高于冷启动上界 73s", () => {
    expect(LSP_QUERY_TIMEOUT_MS).toBeGreaterThan(73_000);
  });

  /// 各工具载荷键不同（outline 的 symbols、text 的 matches、warm 的 languages）：
  /// 逐键抄写会漏，整包透传。
  it("回包整包透传（不止 results）", async () => {
    const events: ChatEvent[] = [];
    const p = queryLsp("outline", { file: "/a.rs" }, "/proj", (e) => events.push(e));
    const id = (events[0] as unknown as { request_id: string }).request_id;
    resolveLspResult({ cmd: "lsp_result", request_id: id, ok: true, status: "ready", symbols: [{ name: "x" }] });
    const r = await p;
    expect(r.symbols).toEqual([{ name: "x" }]);
    expect((r as unknown as Record<string, unknown>).cmd).toBeUndefined();
  });

  /// 给模型的查询带预算：本端超时，同时把 budget_ms 递给主进程让后端也收口。
  it("timeoutMs：本端按时结算，并把略短的 budget_ms 递下去", async () => {
    const events: ChatEvent[] = [];
    const p = queryLsp("references", { name: "get" }, "/proj", (e) => events.push(e), { timeoutMs: 20 });
    const ev = events[0] as unknown as { args: Record<string, unknown> };
    expect(ev.args.name).toBe("get");
    expect(ev.args.budget_ms).toBe(500);
    await expect(p).resolves.toMatchObject({ ok: false, status: "timeout", timedOut: true });
  });

  it("答过 ready 的工作区记为已热（grep 顺带作答的开关），按根区分", async () => {
    _resetLspWarmForTest();
    const events: ChatEvent[] = [];
    const p = queryLsp("warm", {}, "/proj", (e) => events.push(e));
    expect(isLspWarm("/proj")).toBe(false);
    const id = (events[0] as unknown as { request_id: string }).request_id;
    resolveLspResult({ request_id: id, ok: true, status: "ready" });
    await p;
    expect(isLspWarm("/proj")).toBe(true);
    expect(isLspWarm("/other")).toBe(false);
  });
});
