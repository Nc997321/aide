import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../../../engine/types.js";
import { performBrowserOperation } from "./operation.js";
import { actSchema } from "./schema.js";

export function buildBrowserActTool(emit: (event: ChatEvent) => void) {
  return tool("browser_act", DESCRIPTION, actSchema, async (args) => textResult(await runSafely(args, emit)));
}

const DESCRIPTION = "Click, fill, hover or press a key; action=batch runs 1–8 explicit steps sequentially on one view. " +
  "Use visible text (fill uses field labels) or a CSS selector; selector ambiguity requires index. " +
  "Returns input delivery, declared wait_for results, and bounded before/after page changes (optional scope). " +
  "Use wait_for on an async dependency instead of a separate act/wait/read round trip. " +
  "Stops on failure, unmet wait, cancellation or uncertain delivery; no rollback/replay. " +
  "Real CDP vs synthetic input is reported; delivered input alone is not business success. " +
  "Submit/delete/send or an Enter that submits only when the user authorized that action.";

async function runSafely(args: unknown, emit: (event: ChatEvent) => void): Promise<string> {
  try {
    return await performBrowserOperation(args, emit);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Browser action failed unexpectedly: ${detail}. Earlier actions may have executed; inspect before retrying. No replay.`;
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
