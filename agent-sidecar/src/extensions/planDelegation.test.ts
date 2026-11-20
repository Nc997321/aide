import { describe, it, expect, vi } from "vitest";
import { PlanDelegation } from "./planDelegation.js";
import { querySubsession, resolveSubsessionResult, subsessionMcpRegistration } from "./subsessions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../engine/types.js";

const args = {
  title: "Implement outline fix", task: "Change only outline.ts; verify the timeout case.", model: "other-model",
  exploration: { findings: "outline.ts:42 discards timeout; preserve UNVERIFIED.", files: ["outline.ts:42"],
    checks: "Baseline: 3 tests passed. No UI test run.", open_questions: "Desktop result is unverified." },
};

describe("approved plan delegation", () => {
  it("real MCP call carries exploration through the registered host policy and bridge", async () => {
    let acceptQuery!: (e: Extract<ChatEvent, { type: "subsession_query" }>) => void;
    const incoming = new Promise<Extract<ChatEvent, { type: "subsession_query" }>>(resolve => { acceptQuery = resolve; });
    const emit = (e: ChatEvent) => { if (e.type === "subsession_query") acceptQuery(e); };
    const d = new PlanDelegation(emit);
    d.begin("Approved exact plan");
    const registration = subsessionMcpRegistration({ isChild: false, automation: false, trusted: true, env: {} }, {
      emit, context: () => ({ permissionMode: "plan", model: "parent-model", effort: "high" }),
      spawn: (a, run) => d.spawn(a, run),
    });
    const server = (registration!["aide-sessions"] as McpSdkServerConfigWithInstance).instance;
    const client = new Client({ name: "plan-delegation-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const call = client.callTool({ name: "session_spawn", arguments: args });
      const event = await incoming;
      expect(event).toMatchObject({ permission_mode: "auto", model: "parent-model", args: { new: true } });
      expect(event.args.task).toContain(args.exploration.findings);
      expect(event.args.task).toContain("Approved exact plan");
      resolveSubsessionResult({ request_id: event.request_id, ok: true, data: { child_id: "child", title: "Fix" } });
      expect((await call).content).toEqual([{ type: "text", text: expect.stringContaining('Started sub-session "Fix"') }]);
    } finally { await client.close(); await server.close(); }
  });
  it("ordinary session_spawn keeps existing behavior", async () => {
    const d = new PlanDelegation(vi.fn());
    const run = vi.fn().mockResolvedValue({ ok: true });
    await d.spawn({ task: "ordinary" }, run);
    expect(run).toHaveBeenCalledExactlyOnceWith({ task: "ordinary" });
  });

  it("hands off the exact approved plan and existing findings through the Host bridge, once", async () => {
    const emit = vi.fn();
    const d = new PlanDelegation(emit);
    expect(d.begin("# Approved\nFix timeout, do not change other files.")).toContain("EXISTING conversation context");
    const run = vi.fn((a, permissionMode) => querySubsession("spawn", a, {
      emit, context: () => ({ permissionMode, model: "parent-model", effort: "high" }),
    }));
    const first = d.spawn(args, run);
    const second = await d.spawn(args, run);
    expect(second.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    const q = emit.mock.calls.map(([e]) => e).find(e => e.type === "subsession_query");
    expect(q).toMatchObject({ permission_mode: "auto", model: "parent-model", effort: "high", args: { new: true } });
    expect(q.args.model).toBeUndefined();
    expect(q.args.task).toContain("# Approved\nFix timeout, do not change other files.");
    for (const text of Object.values(args.exploration).flat()) expect(q.args.task).toContain(text);
    expect(q.args.task).toContain("Use your judgment");
    resolveSubsessionResult({ request_id: q.request_id, ok: true, data: { child_id: "child", title: "Fix" } });
    await first;
    expect(emit).toHaveBeenLastCalledWith({ type: "plan_delegation", status: "spawned", childId: "child" });
    expect((await d.spawn(args, run)).ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("missing handoff does not start a child; the parent can fill it from existing context", async () => {
    const d = new PlanDelegation(vi.fn());
    d.begin("approved");
    const run = vi.fn().mockResolvedValue({ ok: true, data: { child_id: "child" } });
    expect((await d.spawn({ task: "plan only" }, run)).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect((await d.spawn(args, run)).ok).toBe(true);
  });

  it("steering during handoff preserves the exact approved plan", async () => {
    const d = new PlanDelegation(vi.fn());
    d.begin("Do X, not Y");
    d.noteUserMessage();
    const run = vi.fn().mockResolvedValue({ ok: true, data: { child_id: "child" } });
    await d.spawn(args, run);
    expect(run.mock.calls[0][0].task).toContain("Do X, not Y");
    expect(run.mock.calls[0][1]).toBe("auto");
  });

  it("failed or ambiguous startup is reported, without automatic retry or duplicate children", async () => {
    const emit = vi.fn();
    const d = new PlanDelegation(emit);
    d.begin("approved");
    const run = vi.fn().mockRejectedValue(new Error("Host timeout"));
    expect((await d.spawn(args, run)).ok).toBe(false);
    expect(emit).toHaveBeenLastCalledWith({ type: "plan_delegation", status: "failed" });
    expect((await d.spawn(args, run)).ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    d.clear();
    expect(emit).toHaveBeenLastCalledWith({ type: "plan_delegation", status: "cleared" });
  });

  it("ending without dispatch stops showing preparing", () => {
    const emit = vi.fn();
    const d = new PlanDelegation(emit);
    d.begin("approved");
    d.turnEnded();
    expect(emit).toHaveBeenCalledWith({ type: "plan_delegation", status: "failed" });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "notification" }));
  });
});
