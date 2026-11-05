import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { splitBashSegments } from "../engine/policy/matchers.js";

/** Make direct rustfmt invocations non-recursive by default. This only narrows
 * their write footprint; compound/opaque shell programs are never rewritten. */
export function boundFormatter(command: string): string | undefined {
  const segments = splitBashSegments(command);
  if (!segments) return undefined;
  let updated = command;
  for (const segment of segments) {
    if (!/^rustfmt(?:\.exe)?\s/i.test(segment) || /--check\b/.test(segment)) continue;
    if (/--config(?:\s|=)/.test(segment)) continue;
    updated = updated.replace(segment, segment.replace(/^(rustfmt(?:\.exe)?)/i, "$1 --config skip_children=true"));
  }
  return updated === command ? undefined : updated;
}

export function makeBoundedEditsHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const args = input.tool_input as Record<string, unknown>;
    if (typeof args.command !== "string") return {};
    const command = boundFormatter(args.command);
    return command ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...args, command },
      additionalContext: "Aide limited rustfmt to the explicitly listed files (skip_children=true), preventing recursive formatting of unrelated modules." } } : {};
  };
}
