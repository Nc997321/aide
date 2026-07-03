import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { ChatEvent, ImageAttachment, TurnUsage } from "./types.js";
import { TaskTracker } from "./tasks.js";

/**
 * Build a Claude-SDK MessageParam from a prompt + optional image attachments.
 *
 * This is the ONLY place in the codebase that knows about Anthropic's
 * ImageBlockParam format. To add a new AI provider, create a new sidecar
 * with its own buildUserMessage — the Rust layer and Vue frontend are
 * provider-agnostic.
 */
export function buildUserMessage(
  prompt: string,
  images: ImageAttachment[],
): MessageParam {
  if (images.length === 0) {
    return { role: "user", content: prompt };
  }
  const blocks: Array<Record<string, unknown>> = images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType,
      data: img.data,
    },
  }));
  if (prompt) {
    blocks.push({ type: "text", text: prompt });
  }
  return { role: "user", content: blocks as any };
}

export function mapSdkMessage(msg: any, emit: (e: ChatEvent) => void, tasks: TaskTracker) {
  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    return;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        emit({ type: "text_delta", delta: block.text });
      } else if (block.type === "tool_use") {
        if (TaskTracker.isTaskTool(block.name)) {
          if (tasks.handleToolUse(block.id, block.name, block.input)) {
            emit({ type: "tasks_update", tasks: tasks.snapshot() });
          }
        } else {
          emit({ type: "tool_use_start", id: block.id, name: block.name, input: block.input });
        }
      }
    }
    return;
  }

  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? "").join("")
          : String(block.content ?? "");
        const outcome = tasks.handleToolResult(block.tool_use_id, content);
        if (outcome.changed) {
          emit({ type: "tasks_update", tasks: tasks.snapshot() });
        }
        if (!outcome.tracked) {
          emit({ type: "tool_result", id: block.tool_use_id, content, is_error: block.is_error ?? false });
        }
      }
    }
    return;
  }

  if (msg.type === "result") {
    const modelUsage = msg.modelUsage as Record<string, {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }> | undefined;
    const entries = modelUsage ? Object.values(modelUsage) : [];
    let usage: TurnUsage | null = null;
    if (entries.length > 0) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
      for (const m of entries) {
        usage.inputTokens += m.inputTokens ?? 0;
        usage.outputTokens += m.outputTokens ?? 0;
        usage.cacheReadInputTokens += m.cacheReadInputTokens ?? 0;
        usage.cacheCreationInputTokens += m.cacheCreationInputTokens ?? 0;
        usage.costUsd += m.costUSD ?? 0;
      }
    }
    emit({
      type: "message_stop",
      stop_reason: msg.subtype === "success" ? "end_turn" : msg.subtype,
      total_cost_usd: msg.total_cost_usd ?? null,
      usage,
    });
    return;
  }
}
