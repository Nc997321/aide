//! Policy evaluation tests. The shared JSON fixture is compiled in via
//! `include_str!` so Rust and the TypeScript sidecar (Task 6) run the exact
//! same precedence/safety cases. Path containment and symlink-escape cases
//! live here (not in the portable fixture) because they need real filesystem
//! state.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::settings::{PermissionEffect, SettingsScope};

use super::evaluate::evaluate;
use super::model::{
    BashMode, FieldName, PathField, PermissionMatcher, PermissionPolicySnapshot, PermissionRule,
    PermissionSource, PolicyDisposition, ToolInvocation,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    name: String,
    rules: Vec<PermissionRule>,
    invocation: ToolInvocation,
    expected_disposition: String,
    expected_winner: Option<String>,
}

fn load_fixture_cases() -> Vec<FixtureCase> {
    let text = include_str!("fixtures/permission-policy.json");
    serde_json::from_str(text).expect("fixture must parse")
}

#[test]
fn shared_fixture_has_identical_policy_results() {
    for case in load_fixture_cases() {
        let snapshot = PermissionPolicySnapshot {
            revision: 1,
            rules: case.rules,
        };
        let result = evaluate(&snapshot, &case.invocation);
        assert_eq!(
            result.disposition.as_str(),
            case.expected_disposition,
            "disposition mismatch for case: {}",
            case.name
        );
        assert_eq!(
            result
                .winner
                .as_ref()
                .map(|r| r.id.as_str())
                .map(str::to_owned),
            case.expected_winner,
            "winner mismatch for case: {}",
            case.name
        );
    }
}

#[test]
fn explanation_shows_managed_deny_and_shadowed_local_allow() {
    // Mirrors fixture case 1 but asserts the chain shape directly.
    let rules = vec![
        PermissionRule {
            id: "m".into(),
            scope: SettingsScope::Managed,
            order: 0,
            effect: PermissionEffect::Deny,
            tool: "Bash".into(),
            matcher: PermissionMatcher::Bash {
                mode: BashMode::Prefix,
                value: Some("rm".into()),
            },
            source: PermissionSource::default(),
        },
        PermissionRule {
            id: "l".into(),
            scope: SettingsScope::Local,
            order: 0,
            effect: PermissionEffect::Allow,
            tool: "Bash".into(),
            matcher: PermissionMatcher::Bash {
                mode: BashMode::Prefix,
                value: Some("rm -rf build".into()),
            },
            source: PermissionSource::default(),
        },
    ];
    let snapshot = PermissionPolicySnapshot { revision: 1, rules };
    let invocation = invocation_bash("rm -rf build");
    let decision = evaluate(&snapshot, &invocation);
    assert_eq!(decision.disposition, PolicyDisposition::Deny);
    assert_eq!(decision.winner.as_ref().map(|r| r.id.as_str()), Some("m"));
    let local_entry = decision
        .chain
        .iter()
        .find(|e| e.rule_id == "l")
        .expect("local allow must appear in chain");
    assert_eq!(local_entry.status, super::model::ChainStatus::OverriddenByDeny);
    let managed_entry = decision
        .chain
        .iter()
        .find(|e| e.rule_id == "m")
        .expect("managed deny must appear in chain");
    assert_eq!(managed_entry.status, super::model::ChainStatus::Selected);
}

#[test]
fn same_scope_loser_is_shadowed_by_specificity() {
    let rules = vec![
        PermissionRule {
            id: "a".into(),
            scope: SettingsScope::Project,
            order: 0,
            effect: PermissionEffect::Ask,
            tool: "Bash".into(),
            matcher: PermissionMatcher::Bash { mode: BashMode::All, value: None },
            source: PermissionSource::default(),
        },
        PermissionRule {
            id: "b".into(),
            scope: SettingsScope::Project,
            order: 1,
            effect: PermissionEffect::Allow,
            tool: "Bash".into(),
            matcher: PermissionMatcher::Bash {
                mode: BashMode::Prefix,
                value: Some("pnpm test".into()),
            },
            source: PermissionSource::default(),
        },
    ];
    let snapshot = PermissionPolicySnapshot { revision: 1, rules };
    let decision = evaluate(&snapshot, &invocation_bash("pnpm test --runInBand"));
    assert_eq!(decision.disposition, PolicyDisposition::Allow);
    assert_eq!(decision.winner.as_ref().map(|r| r.id.as_str()), Some("b"));
    let a_entry = decision.chain.iter().find(|e| e.rule_id == "a").unwrap();
    assert_eq!(a_entry.status, super::model::ChainStatus::ShadowedBySpecificity);
}

// --- Path containment (cross-platform, no symlinks) --- //

fn temp_dir_for(name: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir()
        .join(format!("aide-policy-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn folder_rule(folder: &str, effect: PermissionEffect) -> PermissionRule {
    PermissionRule {
        id: "f".into(),
        scope: SettingsScope::User,
        order: 0,
        effect,
        tool: "Write".into(),
        matcher: PermissionMatcher::Path {
            field: PathField::FilePath,
            folder: Some(folder.to_string()),
        },
        source: PermissionSource::default(),
    }
}

fn invocation_write(target: &str, cwd: Option<&str>) -> ToolInvocation {
    let mut input = Map::new();
    input.insert("file_path".into(), Value::String(target.to_string()));
    ToolInvocation {
        tool: "Write".into(),
        input,
        cwd: cwd.map(str::to_string),
    }
}

#[test]
fn folder_rule_matches_file_inside_folder() {
    let root = temp_dir_for("inside");
    let allowed = root.join("allowed");
    std::fs::create_dir_all(allowed.join("sub")).unwrap();
    let target = allowed.join("sub").join("file.txt");
    std::fs::write(&target, "x").unwrap();

    let snapshot = PermissionPolicySnapshot {
        revision: 1,
        rules: vec![folder_rule(&allowed.to_string_lossy(), PermissionEffect::Allow)],
    };
    let decision = evaluate(
        &snapshot,
        &invocation_write(&target.to_string_lossy(), Some(&root.to_string_lossy())),
    );
    assert_eq!(decision.disposition, PolicyDisposition::Allow);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn folder_rule_rejects_file_outside_folder() {
    let root = temp_dir_for("outside");
    let allowed = root.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    let outside = root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let target = outside.join("file.txt");
    std::fs::write(&target, "x").unwrap();

    let snapshot = PermissionPolicySnapshot {
        revision: 1,
        rules: vec![folder_rule(&allowed.to_string_lossy(), PermissionEffect::Allow)],
    };
    let decision = evaluate(
        &snapshot,
        &invocation_write(&target.to_string_lossy(), Some(&root.to_string_lossy())),
    );
    assert_eq!(
        decision.disposition,
        PolicyDisposition::Defer,
        "file outside the allowed folder must not match"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn folder_rule_rejects_dotdot_traversal() {
    let root = temp_dir_for("dotdot");
    let allowed = root.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    let outside = root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("file.txt"), "x").unwrap();

    // allowed/../outside/file.txt must lexically normalize to outside/file.txt
    // and therefore fail the containment check.
    let target = allowed.join("..").join("outside").join("file.txt");
    let snapshot = PermissionPolicySnapshot {
        revision: 1,
        rules: vec![folder_rule(&allowed.to_string_lossy(), PermissionEffect::Allow)],
    };
    let decision = evaluate(
        &snapshot,
        &invocation_write(&target.to_string_lossy(), Some(&root.to_string_lossy())),
    );
    assert_eq!(decision.disposition, PolicyDisposition::Defer);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn folder_rule_resolves_relative_target_against_cwd() {
    let root = temp_dir_for("relative");
    let allowed = root.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    let target = allowed.join("file.txt");
    std::fs::write(&target, "x").unwrap();

    // Relative target "allowed/file.txt" resolved against cwd=root.
    let snapshot = PermissionPolicySnapshot {
        revision: 1,
        rules: vec![folder_rule(&allowed.to_string_lossy(), PermissionEffect::Allow)],
    };
    let decision = evaluate(
        &snapshot,
        &invocation_write("allowed/file.txt", Some(&root.to_string_lossy())),
    );
    assert_eq!(decision.disposition, PolicyDisposition::Allow);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn folder_rule_matches_nonexistent_file_via_ancestor_tail() {
    // A file about to be created must still be judged by its resolved parent
    // directory + remaining tail — the rule must not silently fail.
    let root = temp_dir_for("nonexistent");
    let allowed = root.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    let target = allowed.join("new.txt"); // does not exist

    let snapshot = PermissionPolicySnapshot {
        revision: 1,
        rules: vec![folder_rule(&allowed.to_string_lossy(), PermissionEffect::Allow)],
    };
    let decision = evaluate(
        &snapshot,
        &invocation_write(&target.to_string_lossy(), Some(&root.to_string_lossy())),
    );
    assert_eq!(
        decision.disposition,
        PolicyDisposition::Allow,
        "non-existent file inside allowed folder must still match"
    );
    let _ = std::fs::remove_dir_all(&root);
}

// --- Symlink escape (unix-only; Windows symlink creation needs privileges) --- //

#[cfg(unix)]
#[test]
fn folder_rule_does_not_match_symlink_escape() {
    use std::os::unix::fs::symlink;

    let root = temp_dir_for("symlink-escape");
    let allowed = root.join("allowed");
    let outside = root.join("outside");
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("file.txt"), "x").unwrap();
    symlink(&outside, allowed.join("link")).unwrap();

    let target = allowed.join("link").join("file.txt");
    let snapshot = PermissionPolicySnapshot {
        revision: 1,
        rules: vec![folder_rule(&allowed.to_string_lossy(), PermissionEffect::Allow)],
    };
    let decision = evaluate(
        &snapshot,
        &invocation_write(&target.to_string_lossy(), Some(&root.to_string_lossy())),
    );
    assert_eq!(
        decision.disposition,
        PolicyDisposition::Defer,
        "symlink escape must not be treated as a folder allow"
    );
    let _ = std::fs::remove_dir_all(&root);
}

// --- validate_rule --- //

fn rule(id: &str, effect: PermissionEffect, tool: &str, matcher: PermissionMatcher) -> PermissionRule {
    PermissionRule {
        id: id.into(),
        scope: SettingsScope::User,
        order: 0,
        effect,
        tool: tool.into(),
        matcher,
        source: PermissionSource::default(),
    }
}

#[test]
fn validate_rejects_bash_contains_allow() {
    let r = rule(
        "r",
        PermissionEffect::Allow,
        "Bash",
        PermissionMatcher::Bash {
            mode: BashMode::Contains,
            value: Some("rm".into()),
        },
    );
    assert_eq!(
        super::evaluate::validate_rule(&r).unwrap_err(),
        super::model::PolicyValidationError::BashContainsAllow
    );
}

#[test]
fn validate_allows_bash_contains_deny() {
    let r = rule(
        "r",
        PermissionEffect::Deny,
        "Bash",
        PermissionMatcher::Bash {
            mode: BashMode::Contains,
            value: Some("rm".into()),
        },
    );
    assert!(super::evaluate::validate_rule(&r).is_ok());
}

#[test]
fn validate_rejects_empty_prefix_and_contains() {
    let empty_prefix = rule(
        "r",
        PermissionEffect::Allow,
        "Bash",
        PermissionMatcher::Bash {
            mode: BashMode::Prefix,
            value: Some("  ".into()),
        },
    );
    assert_eq!(
        super::evaluate::validate_rule(&empty_prefix).unwrap_err(),
        super::model::PolicyValidationError::EmptyPrefix
    );

    let empty_contains = rule(
        "r",
        PermissionEffect::Deny,
        "Bash",
        PermissionMatcher::Bash {
            mode: BashMode::Contains,
            value: None,
        },
    );
    assert_eq!(
        super::evaluate::validate_rule(&empty_contains).unwrap_err(),
        super::model::PolicyValidationError::EmptyContains
    );
}

#[test]
fn validate_rejects_empty_id_tool_folder_equals() {
    let empty_id = rule(
        " ",
        PermissionEffect::Allow,
        "Bash",
        PermissionMatcher::Bash {
            mode: BashMode::Prefix,
            value: Some("pnpm test".into()),
        },
    );
    assert_eq!(
        super::evaluate::validate_rule(&empty_id).unwrap_err(),
        super::model::PolicyValidationError::EmptyId
    );

    let empty_tool = rule(
        "r",
        PermissionEffect::Allow,
        "  ",
        PermissionMatcher::Tool,
    );
    assert_eq!(
        super::evaluate::validate_rule(&empty_tool).unwrap_err(),
        super::model::PolicyValidationError::EmptyTool
    );

    let empty_folder = rule(
        "r",
        PermissionEffect::Allow,
        "Write",
        PermissionMatcher::Path {
            field: PathField::FilePath,
            folder: Some("  ".into()),
        },
    );
    assert_eq!(
        super::evaluate::validate_rule(&empty_folder).unwrap_err(),
        super::model::PolicyValidationError::EmptyFolder
    );

    let empty_equals = rule(
        "r",
        PermissionEffect::Allow,
        "WebFetch",
        PermissionMatcher::Field {
            field: FieldName::Url,
            equals: "".into(),
        },
    );
    assert_eq!(
        super::evaluate::validate_rule(&empty_equals).unwrap_err(),
        super::model::PolicyValidationError::EmptyEquals
    );
}

#[test]
fn parse_stored_rule_rejects_malformed_matcher() {
    use crate::settings::{PermissionEffect, StoredPermissionRule};
    let stored = StoredPermissionRule {
        id: "x".into(),
        effect: PermissionEffect::Allow,
        tool: "Bash".into(),
        matcher: json!({ "kind": "bash", "mode": "definitely-not-a-mode" }),
        order: 0,
    };
    let result = super::evaluate::parse_stored_rule(
        &stored,
        SettingsScope::User,
        PermissionSource::default(),
    );
    assert!(matches!(
        result,
        Err(super::model::PolicyValidationError::InvalidMatcher(_))
    ));
}

fn invocation_bash(command: &str) -> ToolInvocation {
    let mut input = Map::new();
    input.insert("command".into(), Value::String(command.to_string()));
    ToolInvocation {
        tool: "Bash".into(),
        input,
        cwd: None,
    }
}