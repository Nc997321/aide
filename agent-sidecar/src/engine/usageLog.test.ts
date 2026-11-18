import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLog } from "./usageLog.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "aide-usage-"));
  dirs.push(dir);
  const log = new UsageLog({ configDir: dir, routingId: "pending/unsafe", parentSessionId: "parent" });
  const records = async () => {
    await log.flush();
    const base = join(dir, "logs", "usage");
    const files = await readdir(base);
    return (await readFile(join(base, files[0]), "utf8")).trim().split("\n").map(s => JSON.parse(s));
  };
  return { log, records, dir };
}

describe("UsageLog", () => {
  it("keeps request snapshots separate from agent totals and SDK aggregates; never logs prompts/results", async () => {
    const { log, records } = await setup();
    log.observe({ type: "system", subtype: "init", session_id: "child" });
    log.observe({ type: "assistant", message: { id: "main-msg", model: "model", usage: { input_tokens: 120 },
      content: [{ type: "tool_use", id: "call", name: "Agent", input: { prompt: "SECRET", subagent_type: "fork" } }] } });
    log.observe({ type: "assistant", session_id: "agent-session", parent_tool_use_id: "call", message: {
      id: "agent-msg", model: "model", usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 100 },
      content: [{ type: "text", text: "SECRET" }],
    } });
    log.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "SECRET" }] },
      tool_use_result: { status: "completed", agentId: "agent", resolvedModel: "model", content: "SECRET",
        totalTokens: 124, usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: null } } });
    log.observe({ type: "result", uuid: "result", subtype: "success", num_turns: 2,
      modelUsage: { model: { inputTokens: 140, costUSD: 0.01 } } });
    const rows = await records();
    expect(rows.map(r => r.kind)).toEqual(["assistant_usage", "agent_dispatch", "assistant_usage", "agent_result", "query_result"]);
    expect(rows[2]).toMatchObject({ session_id: "child", sdk_session_id: "agent-session", parent_session_id: "parent", parent_tool_use_id: "call", scope: "subagent_request" });
    expect(rows[1]).toMatchObject({ agent_type: "fork", prompt_characters: 6 });
    expect(rows[3].usage.cache_creation_input_tokens).toBeNull();
    expect(rows[4].scope).toBe("sdk_aggregate_snapshot");
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  it("retains repeated message ids as snapshots, absent counters stay absent, async references and task totals stay separate", async () => {
    const { log, records } = await setup();
    for (const output_tokens of [1, 5]) log.observe({ type: "assistant", session_id: "s", message: {
      id: "same", usage: { output_tokens }, content: [],
    } });
    log.observe({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "a", input: {} }] } });
    log.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] },
      tool_use_result: { status: "async_launched", agentId: "bg", outputFile: "bg.output" } });
    log.observe({ type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "a", run_id: "run",
      usage: { total_tokens: 300, duration_ms: 100 }, summary: "SECRET" });
    const rows = await records();
    expect(rows.slice(0, 2).map(r => r.message_id)).toEqual(["same", "same"]);
    expect(rows[0].usage).toEqual({ output_tokens: 1 });
    expect(rows[3]).toMatchObject({ scope: "agent_run_reference", output_file: "bg.output" });
    expect(rows[4]).toMatchObject({ task_run_id: "run", usage: { total_tokens: 300 } });
  });

  it("fails open on a bad log directory and warns only once", async () => {
    const { dir } = await setup();
    const bad = join(dir, "file");
    await writeFile(bad, "x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new UsageLog({ configDir: bad, routingId: "r" });
    const msg = { type: "assistant", message: { usage: { input_tokens: 1 } } };
    log.observe(msg);
    await expect(log.flush()).resolves.toBeUndefined();
    log.observe(msg);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("bounds pending writes and marks data loss in the next accepted observation", async () => {
    const { log, records } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg = { type: "assistant", message: { id: "snapshot", usage: { input_tokens: 1 } } };
    for (let i = 0; i < 300; i++) log.observe(msg);
    await log.flush();
    log.observe(msg);
    const rows = await records();
    expect(rows).toHaveLength(257);
    expect(rows.at(-1).dropped_before).toBe(44);
  });
});
