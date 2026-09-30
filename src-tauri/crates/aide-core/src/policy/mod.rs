//! Permission policy domain — provider-agnostic rule model, matchers,
//! evaluation, and the shared JSON fixture used for Rust↔TypeScript parity.
//!
//! Storage lives in `settings::schema` (`StoredPermissionRule` keeps the
//! matcher as an opaque JSON value). This module owns the typed `PermissionMatcher`,
//! the `evaluate` algorithm (precedence + deny override + explanation chain),
//! and `validate_rule`. No Claude/Anthropic SDK types appear here.

pub mod evaluate;
pub mod matchers;
pub mod model;
pub mod safe_rules;

// Re-exports are the policy module's public surface for the commands layer
// (Task 5) and the sidecar fixture. They are unused until Task 5 wires the
// permission commands; silence the temporary unused-import warning rather than
// churning the list across tasks.
#[allow(unused_imports)]
pub use evaluate::{evaluate, parse_stored_rule, validate_rule};
#[allow(unused_imports)]
pub use matchers::{matcher_matches, path_within_folder, specificity};
#[allow(unused_imports)]
pub use model::{
    BashMode, ChainEntry, ChainStatus, FieldName, PathField, PermissionMatcher,
    PermissionPolicySnapshot, PermissionRule, PermissionSource, PolicyDecision, PolicyDisposition,
    PolicyValidationError, ToolInvocation,
};

#[cfg(test)]
mod evaluate_test;
