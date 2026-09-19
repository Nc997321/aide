import { describe, it, expect } from "vitest";
import {
  queryLsp,
  resolveLspResult,
  cancelAllLspQueries,
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
  /// 超时预算必须显著高于它——10s（codegraph 的值）会让每次冷启动查询都超时，
  /// 正好复现本设计要消灭的失败模式。
  it("超时预算显著高于冷启动上界 73s", () => {
    expect(LSP_QUERY_TIMEOUT_MS).toBeGreaterThan(73_000);
  });
});
