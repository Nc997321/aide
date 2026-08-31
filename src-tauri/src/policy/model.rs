//! Provider-agnostic permission policy data model.
//!
//! These types are the canonical wire contract between Rust, the agent sidecar
//! and the Vue UI. They intentionally carry no Claude/Anthropic-specific
//! semantics — only `allow | ask | deny`, a tool name, and an explainable
//! matcher. The storage form (`StoredPermissionRule` in `settings::schema`)
//! keeps the matcher as an opaque JSON value; this module owns the typed shape.

use serde::{Deserialize, Serialize};

use crate::settings::{PermissionEffect, SettingsScope};

/// Explainable matcher union. Serialized as an internally-tagged enum on
/// `kind` so the JSON shape matches the TypeScript `PermissionMatcher` union
/// exactly (`{ "kind": "bash", "mode": "prefix", "value": "rm" }`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PermissionMatcher {
    /// Matches any invocation of the rule's tool (lowest specificity, 0).
    Tool,
    /// Bash command matcher. `contains` is forbidden for `allow` (see
    /// `validate_rule`); `prefix` allow is gated against unquoted shell control
    /// tokens so chaining cannot widen it.
    Bash {
        mode: BashMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    /// File-system path matcher. Absent `folder`/`file` means "any path"
    /// (specificity 1); a `folder` requires normalized component containment
    /// with symlink resolution (specificity 3); a `file` requires normalized
    /// component equality with symlink resolution (specificity 3). `folder`
    /// and `file` are mutually exclusive (validated in `validate_rule`).
    Path {
        field: PathField,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<String>,
    },
    /// Exact equality on an approved scalar input field (specificity 3).
    Field { field: FieldName, equals: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BashMode {
    All,
    Prefix,
    Contains,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PathField {
    FilePath,
    Path,
    NotebookPath,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldName {
    Url,
    Query,
    Command,
}

/// A fully-resolved rule (typed matcher, assigned scope/source). This is the
/// shape carried in a `PermissionPolicySnapshot` and returned to the UI; it is
/// NOT the storage shape (which keeps the matcher as `serde_json::Value`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub id: String,
    pub scope: SettingsScope,
    pub order: i64,
    pub effect: PermissionEffect,
    pub tool: String,
    pub matcher: PermissionMatcher,
    #[serde(default)]
    pub source: PermissionSource,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSource {
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

/// The sole authorization input pushed Rust→sidecar. `revision` is monotonic;
/// the sidecar only accepts snapshots with `revision >= current`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicySnapshot {
    pub revision: u64,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
}

/// A tool invocation to evaluate against a snapshot. `input` is the tool's
/// argument object; `cwd` is used only by path matchers for relative
/// resolution and symlink safety.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocation {
    pub tool: String,
    pub input: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PolicyDisposition {
    Allow,
    Deny,
    Ask,
    /// No rule matched; defer to the provider's existing permission mode.
    Defer,
}

impl PolicyDisposition {
    pub fn as_str(&self) -> &'static str {
        match self {
            PolicyDisposition::Allow => "allow",
            PolicyDisposition::Deny => "deny",
            PolicyDisposition::Ask => "ask",
            PolicyDisposition::Defer => "defer",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChainStatus {
    Selected,
    ShadowedBySpecificity,
    OverriddenByDeny,
    OverriddenByLowerScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainEntry {
    pub rule_id: String,
    pub scope: SettingsScope,
    pub matched: bool,
    pub specificity: u32,
    pub status: ChainStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub disposition: PolicyDisposition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub winner: Option<PermissionRule>,
    #[serde(default)]
    pub chain: Vec<ChainEntry>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyValidationError {
    EmptyId,
    EmptyTool,
    EmptyPrefix,
    EmptyContains,
    EmptyFolder,
    EmptyFile,
    /// `path` matcher set both `folder` and `file` — the two modes are
    /// mutually exclusive (containment vs exact equality).
    FolderAndFileExclusive,
    EmptyEquals,
    /// `effect=allow && matcher=bash contains` is forbidden — `contains` is too
    /// permissive for an always-allow (a malicious command could embed the
    /// substring as an argument).
    BashContainsAllow,
    /// Matcher failed to deserialize from the stored JSON value.
    InvalidMatcher(String),
}

impl std::fmt::Display for PolicyValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyValidationError::EmptyId => write!(f, "rule id must not be empty"),
            PolicyValidationError::EmptyTool => write!(f, "tool must not be empty"),
            PolicyValidationError::EmptyPrefix => write!(f, "bash prefix value must not be empty"),
            PolicyValidationError::EmptyContains => {
                write!(f, "bash contains value must not be empty")
            }
            PolicyValidationError::EmptyFolder => write!(f, "path folder must not be empty"),
            PolicyValidationError::EmptyFile => write!(f, "path file must not be empty"),
            PolicyValidationError::FolderAndFileExclusive => write!(
                f,
                "path matcher cannot set both folder and file (containment vs exact equality)"
            ),
            PolicyValidationError::EmptyEquals => write!(f, "field equals value must not be empty"),
            PolicyValidationError::BashContainsAllow => write!(
                f,
                "bash \u{201c}contains\u{201d} cannot be used to always-allow a command"
            ),
            PolicyValidationError::InvalidMatcher(detail) => {
                write!(f, "invalid permission matcher: {detail}")
            }
        }
    }
}

impl std::error::Error for PolicyValidationError {}
