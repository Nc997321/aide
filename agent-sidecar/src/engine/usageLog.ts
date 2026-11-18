// Host-local diagnostics only: never emit these records to the UI or model.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const text = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;

/** Preserve only reported numeric counters, including null (unavailable), never prompt content. */
function counters(value: unknown): RecordValue {
  const out: RecordValue = {};
  for (const [key, v] of Object.entries(object(value))) {
    if ((typeof v === "number" && Number.isFinite(v) && v >= 0) || v === null) out[key] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = counters(v);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

/** One file per SDK query connection; session_id links resumed queries and child sessions.
 * Records are observations/snapshots, NOT additive accounting entries. In particular,
 * result.modelUsage and Agent run totals can overlap assistant-level usage.
 */
export class UsageLog {
  private pending = Promise.resolve();
  private queued = 0;
  private failed = false;
  private dropped = 0;
  private directoryReady = false;
  private sessionId?: string;
  private readonly agents = new Map<string, string>();
  private readonly queryId = randomUUID();
  private readonly file: string;

  constructor(private readonly options: {
    configDir: string;
    routingId: string;
    parentSessionId?: string;
  }) {
    this.file = join(options.configDir, "logs", "usage", `${this.queryId}.jsonl`);
  }

  /** Non-blocking and fail-open. A slow disk has a bounded queue; loss is explicit. */
  observe(value: unknown): void {
    if (this.failed) return;
    try {
      const msg = object(value);
      const session = text(msg.session_id);
      const parentTool = text(msg.parent_tool_use_id);
      if (session && !parentTool) this.sessionId = session;
      const message = object(msg.message);
      const content = Array.isArray(message.content) ? message.content.map(object) : [];
      if (msg.type === "assistant") {
        if (Object.keys(object(message.usage)).length) this.write({
          kind: "assistant_usage", scope: parentTool ? "subagent_request" : "main_request",
          message_id: text(message.id), message_uuid: text(msg.uuid),
          sdk_session_id: session,
          parent_tool_use_id: parentTool, model: text(message.model), usage: counters(message.usage),
        });
        for (const block of content) {
          if (block.type !== "tool_use" || !["Agent", "Task"].includes(String(block.name))) continue;
          const id = text(block.id);
          if (!id) continue;
          this.agents.set(id, parentTool ?? "");
          const input = object(block.input);
          this.write({ kind: "agent_dispatch", tool_use_id: id, parent_tool_use_id: parentTool,
            agent_type: text(input.subagent_type), requested_model: text(input.model),
            resumed_agent_id: text(input.resume),
            prompt_characters: text(input.prompt)?.length,
          });
        }
      } else if (msg.type === "user") {
        const output = object(msg.tool_use_result);
        const results = content.filter(b => b.type === "tool_result");
        const completed = results.filter(b => this.agents.has(String(b.tool_use_id)));
        // Structured output belongs to the message. Do not guess its owner for a batch.
        if (results.length === 1 && completed.length === 1 && (output.agentId || output.usage || output.totalTokens !== undefined)) {
          this.write({ kind: "agent_result", scope: output.status === "completed" ? "agent_run_total" : "agent_run_reference",
            tool_use_id: text(completed[0].tool_use_id), agent_id: text(output.agentId),
            parent_tool_use_id: parentTool, model: text(output.resolvedModel),
            status: text(output.status), output_file: text(output.outputFile),
            usage: counters(output.usage),
            totals: counters({ total_tokens: output.totalTokens, tool_uses: output.totalToolUseCount,
              duration_ms: output.totalDurationMs }),
          });
        }
      } else if (msg.type === "system" && ["task_started", "task_progress", "task_notification"].includes(String(msg.subtype))) {
        this.write({ kind: String(msg.subtype), scope: "task_run_snapshot",
          task_id: text(msg.task_id), task_run_id: text(msg.run_id), tool_use_id: text(msg.tool_use_id),
          task_type: text(msg.task_type), status: text(msg.status), output_file: text(msg.output_file),
          usage: counters(msg.usage),
        });
      } else if (msg.type === "result") {
        const byModel: RecordValue = {};
        for (const [model, usage] of Object.entries(object(msg.modelUsage))) byModel[model] = counters(usage);
        this.write({ kind: "query_result", scope: "sdk_aggregate_snapshot", result_id: text(msg.uuid),
          status: text(msg.subtype), usage: counters(msg.usage), model_usage: byModel,
          totals: counters({ cost_usd: msg.total_cost_usd, api_turns: msg.num_turns, duration_ms: msg.duration_ms }),
        });
      }
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    if (!this.failed) console.warn("[usage-log] diagnostics unavailable; conversation continues");
    this.failed = true;
  }

  private write(record: RecordValue): void {
    if (this.queued >= 256) {
      if (!this.dropped) console.warn("[usage-log] slow disk; diagnostic records dropped");
      this.dropped++;
      return;
    }
    const line = JSON.stringify({ schema_version: 1, timestamp: new Date().toISOString(),
      query_id: this.queryId, routing_id: this.options.routingId, session_id: this.sessionId,
      parent_session_id: this.options.parentSessionId,
      dropped_before: this.dropped || undefined, ...record }) + "\n";
    this.dropped = 0;
    this.queued++;
    this.pending = this.pending.then(async () => {
      if (this.failed) return;
      if (!this.directoryReady) {
        await mkdir(join(this.options.configDir, "logs", "usage"), { recursive: true });
        this.directoryReady = true;
      }
      await appendFile(this.file, line, "utf8");
    }).catch(() => this.fail()).finally(() => { this.queued--; });
  }

  /** Shutdown/testing can wait for records already accepted without affecting model execution. */
  async flush(): Promise<void> { await this.pending; }
}
