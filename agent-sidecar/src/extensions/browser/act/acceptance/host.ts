import type { ChatEvent } from "../../../../engine/types.js";
import { resolveBrowserResult } from "../../../browserClient.js";
import { buildBrowserTools } from "../../../browserTools.js";
import { asRecord } from "../../format.js";
import type { Cdp } from "./cdp.js";

type Query = Extract<ChatEvent, { type: "browser_query" }>;
type Reply = { ok: boolean; data?: unknown; error?: string };
type Tool = { name: string; handler: (input: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[] }> };

export class FixtureHost {
  bridgeCalls = 0;
  toolCalls = 0;
  fault?: "release-result-lost" | "input-unavailable";

  constructor(readonly cdp: Cdp) {}

  emit = (event: ChatEvent): void => {
    if (event.type !== "browser_query") return;
    this.bridgeCalls += 1;
    void this.answer(event).then((reply) => resolveBrowserResult({ request_id: event.request_id, ...reply }))
      .catch((error: unknown) => resolveBrowserResult({ request_id: event.request_id, ok: false, error: String(error) }));
  };

  async tool(name: string, input: unknown): Promise<string> {
    const tool = (buildBrowserTools(this.emit) as unknown as Tool[]).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Fixture tool missing: ${name}`);
    this.toolCalls += 1;
    const reply = await tool.handler(input, {});
    return reply.content.map((block) => block.text ?? "").join("\n");
  }

  async reset(url: string): Promise<void> {
    this.fault = undefined;
    await this.cdp.command("Page.navigate", { url });
    await this.ready(url);
    this.bridgeCalls = 0;
    this.toolCalls = 0;
    this.cdp.calls = 0;
  }

  async state(): Promise<Record<string, unknown>> {
    const state = asRecord(await this.cdp.evaluate("window.__operationState()"));
    if (!state) throw new Error("Fixture returned no state");
    return state;
  }

  private async ready(url: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await this.cdp.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && typeof window.__operationState === 'function'`);
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Isolated fixture failed to load");
  }

  private async answer(query: Query): Promise<Reply> {
    if (query.view_id !== undefined && query.view_id !== "fixture-view") return { ok: false, error: "fixture view not found" };
    if (query.op === "list_views") {
      return { ok: true, data: { views: [{ id: "fixture-view", nav: { ...this.cdp.navigation } }] } };
    }
    if (query.op === "call_cdp") return this.cdpQuery(query);
    if (query.op === "eval") {
      return { ok: true, data: { view_id: "fixture-view", value: await this.cdp.evaluate(query.script ?? "") } };
    }
    return { ok: false, error: `Unsupported fixture bridge operation: ${query.op}` };
  }

  private async cdpQuery(query: Query): Promise<Reply> {
    if (this.fault === "input-unavailable" && query.method?.startsWith("Input.")) {
      return { ok: true, data: { view_id: "fixture-view", value: { error: { code: -32601, message: "fixture: input method unavailable" } } } };
    }
    const params = asRecord(query.params) ?? {};
    const value = await this.cdp.command(query.method ?? "", params);
    if (this.fault === "release-result-lost" && params["type"] === "mouseReleased") {
      return { ok: false, error: "fixture: response lost AFTER actual release" };
    }
    return { ok: true, data: { view_id: "fixture-view", value } };
  }
}
