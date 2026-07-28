// ── Provider-agnostic permission DTOs ──
// These mirror the Rust types in src-tauri/src/policy/model.rs and
// src-tauri/src/commands/permissions.rs exactly (camelCase serde).
// Do NOT import from agent-sidecar.

export type PermissionScope = "managed" | "user" | "project" | "local" | "session";
export type PermissionEffect = "allow" | "deny" | "ask";

export type PermissionMatcher =
  | { kind: "tool" }
  | { kind: "bash"; mode: "all" | "prefix" | "contains"; value?: string }
  | { kind: "path"; field: "file_path" | "path" | "notebook_path"; folder?: string }
  | { kind: "field"; field: "url" | "query" | "command"; equals: string };

export interface PermissionSource {
  label: string;
  path?: string;
  readOnly: boolean;
}

export interface PermissionRule {
  id: string;
  scope: PermissionScope;
  order: number;
  effect: PermissionEffect;
  tool: string;
  matcher: PermissionMatcher;
  source: PermissionSource;
}

export type ChainStatus =
  | "selected"
  | "shadowed_by_specificity"
  | "overridden_by_deny"
  | "overridden_by_lower_scope";

export interface ChainEntry {
  ruleId: string;
  scope: PermissionScope;
  matched: boolean;
  specificity: number;
  status: ChainStatus;
}

export interface PermissionPolicySnapshot {
  revision: number;
  rules: PermissionRule[];
}

// ── Tauri command DTOs ──

export interface ScopeAvailability {
  scope: PermissionScope;
  editable: boolean;
  reason: string;
  storagePath: string | null;
  description: string;
}

export interface PermissionSettingsView {
  revision: number;
  scopes: ScopeAvailability[];
  rules: PermissionRule[];
}

export interface PermissionRuleDraft {
  effect: PermissionEffect;
  tool: string;
  matcher: PermissionMatcher;
}

export interface PermissionExplanationView {
  finalDecision: string;
  winner: PermissionRule | null;
  chain: ChainEntry[];
  reason: string;
}
