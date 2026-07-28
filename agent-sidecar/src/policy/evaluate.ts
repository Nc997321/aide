// Policy evaluation: per-scope winner selection, deny override, and the
// explanation chain. Provider-agnostic — the only Claude-specific behavior
// (canUseTool mapping, AskUserQuestion reshaping) lives in the agent sidecar.

import type {
  PermissionPolicySnapshot,
  PermissionRule,
  PolicyDecision,
  ChainEntry,
} from "./types.js";
import { matcherMatches, specificity } from "./matchers.js";

// Scope priority, highest first. Used both to pick the cross-scope winner and
// to order per-scope evaluation. `Session` is in-memory only and never
// persisted, but a snapshot may carry session rules.
const SCOPE_PRIORITY: PermissionRule["scope"][] = [
  "session",
  "local",
  "project",
  "user",
  "managed",
];

/** Evaluate `invocation` against `snapshot`. The decision is `defer` when no
 * rule matches, leaving the caller to fall back to the provider's existing
 * permission mode. Filesystem access happens only for path-folder matchers
 * (symlink safety); Bash/field/tool matchers are pure. */
export async function evaluatePolicy(
  snapshot: PermissionPolicySnapshot,
  invocation: { tool: string; input: Record<string, unknown>; cwd?: string },
): Promise<PolicyDecision> {
  const { tool, input, cwd } = invocation;

  // Per scope: collect matched rules, pick the winner by
  // (specificity DESC, order ASC). Losers in the same scope are recorded for
  // the chain as `shadowed_by_specificity`.
  const scopeWinners: PermissionRule[] = [];
  const sameScopeLosers: PermissionRule[] = [];

  for (const scope of SCOPE_PRIORITY) {
    const candidates: PermissionRule[] = [];

    for (const rule of snapshot.rules) {
      if (rule.scope !== scope || rule.tool !== tool) {
        continue;
      }
      const matched = await matcherMatches(rule.matcher, input, cwd, rule.effect);
      if (matched) {
        candidates.push(rule);
      }
    }

    if (candidates.length === 0) {
      continue;
    }

    // Sort by (specificity DESC, order ASC)
    candidates.sort((a, b) => {
      const specDiff = specificity(b.matcher) - specificity(a.matcher);
      if (specDiff !== 0) return specDiff;
      return a.order - b.order;
    });

    scopeWinners.push(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      sameScopeLosers.push(candidates[i]);
    }
  }

  // Any deny among scope winners → final deny. The reported deny is the
  // highest-priority one (SCOPE_PRIORITY order, so the first deny found).
  const denyWinner = scopeWinners.find((r) => r.effect === "deny") ?? null;

  let disposition: PolicyDecision["disposition"];
  let selected: PermissionRule | null;

  if (denyWinner !== null) {
    disposition = "deny";
    selected = denyWinner;
  } else if (scopeWinners.length > 0) {
    const winner = scopeWinners[0];
    disposition = winner.effect === "allow" ? "allow" : "ask";
    selected = winner;
  } else {
    disposition = "defer";
    selected = null;
  }

  // Build the explanation chain. Same-scope losers first, then scope winners
  // so the selected rule and its overrides are visible.
  const chain: ChainEntry[] = [];

  for (const loser of sameScopeLosers) {
    chain.push({
      ruleId: loser.id,
      scope: loser.scope,
      matched: true,
      specificity: specificity(loser.matcher),
      status: "shadowed_by_specificity",
    });
  }

  for (const winner of scopeWinners) {
    let status: ChainEntry["status"];
    if (winner === selected) {
      status = "selected";
    } else if (denyWinner !== null) {
      // A deny won. Non-deny winners were overridden by it; a deny winner
      // that wasn't selected was shadowed by a higher-priority deny.
      if (winner.effect === "deny") {
        status = "overridden_by_lower_scope";
      } else {
        status = "overridden_by_deny";
      }
    } else {
      // No deny: a non-selected winner sits in a lower-priority scope than
      // the selected winner.
      status = "overridden_by_lower_scope";
    }
    chain.push({
      ruleId: winner.id,
      scope: winner.scope,
      matched: true,
      specificity: specificity(winner.matcher),
      status,
    });
  }

  const reason = selected !== null ? summarizeRule(selected) : "no matching permission rule; deferring to provider permission mode";

  return { disposition, winner: selected, chain, reason };
}

// ---------------------------------------------------------------------------
// Reason / summary helpers
// ---------------------------------------------------------------------------

function summarizeRule(rule: PermissionRule): string {
  const scopeWord = scopeWordFor(rule.scope);
  const action = rule.effect === "allow"
    ? "Allowed"
    : rule.effect === "deny"
      ? "Denied"
      : "Confirmation required";
  return `${action} by ${scopeWord} rule ‘${rule.id}’ (${rule.tool}: ${matcherSummary(rule.matcher)})`;
}

function scopeWordFor(scope: PermissionRule["scope"]): string {
  switch (scope) {
    case "managed": return "managed";
    case "user": return "user";
    case "project": return "project";
    case "local": return "local";
    case "session": return "session";
  }
}

function matcherSummary(matcher: PermissionRule["matcher"]): string {
  switch (matcher.kind) {
    case "tool":
      return "any invocation";
    case "bash": {
      const modeWord =
        matcher.mode === "all" ? "all commands"
          : matcher.mode === "prefix" ? "prefix"
            : "contains";
      if (matcher.value !== undefined) {
        return `bash ${modeWord} ${JSON.stringify(matcher.value)}`;
      }
      return `bash ${modeWord}`;
    }
    case "path": {
      const fieldStr = JSON.stringify(matcher.field);
      if (matcher.folder !== undefined) {
        return `path ${fieldStr} under ${JSON.stringify(matcher.folder)}`;
      }
      return `path ${fieldStr} (any)`;
    }
    case "field": {
      return `field ${JSON.stringify(matcher.field)} equals ${JSON.stringify(matcher.equals)}`;
    }
  }
}
