// Provider-agnostic permission policy data model.
//
// These types mirror the Rust contracts in src-tauri/src/policy/model.rs exactly.
// They intentionally carry no Claude/Anthropic-specific semantics — only
// allow | ask | deny, a tool name, and an explainable matcher.

export interface PermissionPolicySnapshot {
  revision: number;
  rules: PermissionRule[];
}

export interface PermissionRule {
  id: string;
  scope: "managed" | "user" | "project" | "local" | "session";
  order: number;
  effect: "allow" | "ask" | "deny";
  tool: string;
  matcher: PermissionMatcher;
  source?: { label: string; path?: string; readOnly: boolean };
}

export type PermissionMatcher =
  | { kind: "tool" }
  | { kind: "bash"; mode: "all" | "prefix" | "contains"; value?: string }
  | {
      kind: "path";
      field: "file_path" | "path" | "notebook_path";
      /** Directory containment (symlink-safe). Mutually exclusive with `file`. */
      folder?: string;
      /** Exact-file equality (symlink-safe). Mutually exclusive with `folder`. */
      file?: string;
    }
  | { kind: "field"; field: "url" | "query" | "command"; equals: string };

export type PolicyDisposition = "allow" | "deny" | "ask" | "defer";

export type ChainStatus =
  | "selected"
  | "shadowed_by_specificity"
  | "overridden_by_deny"
  | "overridden_by_lower_scope";

export interface ChainEntry {
  ruleId: string;
  scope: PermissionRule["scope"];
  matched: boolean;
  specificity: number;
  status: ChainStatus;
}

export interface PolicyDecision {
  disposition: PolicyDisposition;
  winner: PermissionRule | null;
  chain: ChainEntry[];
  reason: string;
}
