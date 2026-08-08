// Policy evaluation: per-scope winner selection, deny override, and the
// explanation chain. Provider-agnostic — the only Claude-specific behavior
// (canUseTool mapping, AskUserQuestion reshaping) lives in the agent sidecar.

import type {
  PermissionPolicySnapshot,
  PermissionRule,
  PolicyDecision,
  ChainEntry,
} from "./types.js";
import { hasUnquotedShellControl, matcherMatches, specificity, splitBashSegments } from "./matchers.js";

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

/** Winner ordering shared by composite evaluation: highest-priority scope,
 * then specificity DESC, then order ASC. Must stay identical to the Rust
 * mirror in src-tauri/src/policy/evaluate.rs. */
function compareByPriority(a: PermissionRule, b: PermissionRule): number {
  const scopeDiff =
    SCOPE_PRIORITY.indexOf(a.scope) - SCOPE_PRIORITY.indexOf(b.scope);
  if (scopeDiff !== 0) return scopeDiff;
  const specDiff = specificity(b.matcher) - specificity(a.matcher);
  if (specDiff !== 0) return specDiff;
  return a.order - b.order;
}

/** Evaluate `invocation` against `snapshot`. The decision is `defer` when no
 * rule matches, leaving the caller to fall back to the provider's existing
 * permission mode. Filesystem access happens only for path-folder matchers
 * (symlink safety); Bash/field/tool matchers are pure.
 *
 * Chained Bash commands (`a | b`, `a && b`, …) take the composite path: the
 * command is split into verifiable segments (see `splitBashSegments`) and
 * every segment must independently match an allow rule — a prefix allow never
 * silently widens across a separator into an unvetted command. deny/ask rules
 * are checked against the raw command AND each segment, so a `deny rm -rf`
 * still fires on `echo hi | rm -rf /`. Commands the analyzer cannot verify
 * (file redirects, `$(…)`, backticks, unbalanced quotes) fall through to the
 * classic path where the allow shell-gate blocks them. */
export async function evaluatePolicy(
  snapshot: PermissionPolicySnapshot,
  invocation: { tool: string; input: Record<string, unknown>; cwd?: string },
): Promise<PolicyDecision> {
  const { tool, input, cwd } = invocation;

  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (command && hasUnquotedShellControl(command)) {
      const segments = splitBashSegments(command);
      if (segments !== null) {
        return evaluateBashComposite(snapshot, invocation, segments);
      }
    }
  }

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
// Chained Bash command evaluation
// ---------------------------------------------------------------------------

/** Composite evaluation for a chained Bash command already split into
 * verifiable segments by `splitBashSegments`. Mirror of the Rust
 * `evaluate_bash_composite` — decision semantics and winner ordering must
 * stay identical (locked by the shared JSON fixture). */
async function evaluateBashComposite(
  snapshot: PermissionPolicySnapshot,
  invocation: { tool: string; input: Record<string, unknown>; cwd?: string },
  segments: string[],
): Promise<PolicyDecision> {
  const { input, cwd } = invocation;
  const rules = snapshot.rules.filter((r) => r.tool === "Bash");
  const segmentInputs = segments.map((s) => ({ ...input, command: s }));

  /** Highest-priority rule with `effect` matching ANY of the given inputs
   * (raw command first, then segments in order). deny/ask only. */
  const bestMatch = async (
    effect: "deny" | "ask",
  ): Promise<{ rule: PermissionRule; matchedInput: Record<string, unknown> } | null> => {
    for (const scope of SCOPE_PRIORITY) {
      const scoped = rules.filter((r) => r.scope === scope && r.effect === effect);
      if (scoped.length === 0) continue;
      for (const candidateInput of [input, ...segmentInputs]) {
        const matched: PermissionRule[] = [];
        for (const r of scoped) {
          if (await matcherMatches(r.matcher, candidateInput, cwd, effect)) {
            matched.push(r);
          }
        }
        if (matched.length > 0) {
          matched.sort(compareByPriority);
          return { rule: matched[0], matchedInput: candidateInput };
        }
      }
    }
    return null;
  };

  const segmentNote = (matchedInput: Record<string, unknown>): string =>
    matchedInput === input
      ? ""
      : ` — matched segment ${JSON.stringify(matchedInput.command)} of the chained command`;

  const deny = await bestMatch("deny");
  if (deny !== null) {
    return {
      disposition: "deny",
      winner: deny.rule,
      chain: [compositeChainEntry(deny.rule, "selected")],
      reason: summarizeRule(deny.rule) + segmentNote(deny.matchedInput),
    };
  }

  const ask = await bestMatch("ask");
  if (ask !== null) {
    return {
      disposition: "ask",
      winner: ask.rule,
      chain: [compositeChainEntry(ask.rule, "selected")],
      reason: summarizeRule(ask.rule) + segmentNote(ask.matchedInput),
    };
  }

  // Allow: EVERY segment must match at least one allow rule. Per-segment
  // winners are all marked selected — each one vouches for its segment.
  const perSegmentWinners: PermissionRule[] = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const matched: PermissionRule[] = [];
    for (const r of rules) {
      if (r.effect === "allow" && (await matcherMatches(r.matcher, segmentInputs[idx], cwd, "allow"))) {
        matched.push(r);
      }
    }
    if (matched.length === 0) {
      return {
        disposition: "defer",
        winner: null,
        chain: [],
        reason:
          `segment ${idx + 1}/${segments.length} ${JSON.stringify(segments[idx])} of the chained command ` +
          "matched no allow rule; deferring to provider permission mode",
      };
    }
    matched.sort(compareByPriority);
    perSegmentWinners.push(matched[0]);
  }

  const winner = [...perSegmentWinners].sort(compareByPriority)[0];
  // Dedupe by rule id — one rule may vouch for several segments.
  const chainRules = [...new Map(perSegmentWinners.map((r) => [r.id, r])).values()];
  const chain = chainRules.map((r) => compositeChainEntry(r, "selected"));
  const suffix =
    segments.length > 1
      ? ` — all ${segments.length} segments of the chained command matched allow rules`
      : "";
  return {
    disposition: "allow",
    winner,
    chain,
    reason: summarizeRule(winner) + suffix,
  };
}

function compositeChainEntry(rule: PermissionRule, status: ChainEntry["status"]): ChainEntry {
  return {
    ruleId: rule.id,
    scope: rule.scope,
    matched: true,
    specificity: specificity(rule.matcher),
    status,
  };
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
