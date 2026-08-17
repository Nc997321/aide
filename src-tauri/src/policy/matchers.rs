//! Matcher evaluation: specificity, Bash command scanning, path containment
//! with symlink resolution, and field equality. Provider-agnostic — no Claude
//! SDK types, no tool dispatch. Pure functions except `path_within_folder`,
//! which consults the filesystem only to resolve symlinks for safety.

use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

use crate::settings::PermissionEffect;

use super::model::{BashMode, FieldName, PathField, PermissionMatcher};

/// Fixed specificity table (plan §Canonical Contracts):
/// tool=0; bash all=1; bash contains=2; bash prefix=3; path all=1; path
/// folder=3; field equals=3. Specificity never depends on string length.
pub fn specificity(matcher: &PermissionMatcher) -> u32 {
    match matcher {
        PermissionMatcher::Tool => 0,
        PermissionMatcher::Bash { mode, .. } => match mode {
            BashMode::All => 1,
            BashMode::Contains => 2,
            BashMode::Prefix => 3,
        },
        PermissionMatcher::Path { folder, .. } => {
            if folder.is_some() {
                3
            } else {
                1
            }
        }
        PermissionMatcher::Field { .. } => 3,
    }
}

/// Does `matcher` accept this invocation? Called only after the tool name has
/// already been matched against `rule.tool`, so `Tool` matchers accept
/// unconditionally. `effect` is threaded in so the Bash prefix-allow shell gate
/// can be applied conservatively (ask/deny inspect raw text).
pub fn matcher_matches(
    matcher: &PermissionMatcher,
    input: &Map<String, Value>,
    cwd: Option<&str>,
    effect: PermissionEffect,
) -> bool {
    match matcher {
        PermissionMatcher::Tool => true,
        PermissionMatcher::Bash { mode, value } => {
            let command = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            bash_matches(*mode, value.as_deref().unwrap_or(""), command, effect)
        }
        PermissionMatcher::Path { field, folder } => {
            let field_key = path_field_key(*field);
            let target = match input.get(field_key).and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return false,
            };
            match folder.as_deref() {
                // "all paths" — matches any invocation that supplies the field.
                None => true,
                Some(folder) => path_within_folder(target, folder, cwd),
            }
        }
        PermissionMatcher::Field { field, equals } => {
            let field_key = field_name_key(*field);
            input.get(field_key).and_then(|v| v.as_str()) == Some(equals.as_str())
        }
    }
}

fn path_field_key(field: PathField) -> &'static str {
    match field {
        PathField::FilePath => "file_path",
        PathField::Path => "path",
        PathField::NotebookPath => "notebook_path",
    }
}

fn field_name_key(field: FieldName) -> &'static str {
    match field {
        FieldName::Url => "url",
        FieldName::Query => "query",
        FieldName::Command => "command",
    }
}

fn bash_matches(mode: BashMode, value: &str, command: &str, effect: PermissionEffect) -> bool {
    match mode {
        // "all commands" matches any Bash invocation, including chained ones —
        // the user explicitly allowed every command, so chaining is in scope.
        BashMode::All => true,
        BashMode::Prefix => {
            // Conservative gate: an `allow` prefix must not widen across
            // unquoted shell control tokens (`;`, `|`, `&`, `<`, `>`, newline,
            // backtick, `$(`). ask/deny may inspect the raw text. Chained
            // commands reach this matcher one segment at a time via
            // `split_bash_segments` in `evaluate` — this gate is the backstop
            // for everything that analysis could not verify.
            if effect == PermissionEffect::Allow && has_unquoted_shell_control(command) {
                return false;
            }
            command_starts_with_boundary(command, value)
        }
        // `contains` is never `allow` (validated upstream); for ask/deny a
        // substring match on the raw command is intentional.
        BashMode::Contains => !value.is_empty() && command.contains(value),
    }
}

/// True if `command` contains an unquoted shell control token that could
/// widen a prefix allow into a second command. Tracks single/double quote
/// state and backslash escapes (outside single quotes, `\` escapes the next
/// char). Inside single quotes everything is literal.
pub fn has_unquoted_shell_control(command: &str) -> bool {
    let chars: Vec<char> = command.chars().collect();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && !in_single {
            // Backslash escape (outside single quotes). In double quotes
            // backslash only escapes a few chars, but for control-token
            // detection skipping the next char is safe either way.
            i += 2;
            continue;
        }
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            _ if in_single || in_double => {}
            ';' | '|' | '&' | '<' | '>' | '\n' | '`' => return true,
            '$' if i + 1 < chars.len() && chars[i + 1] == '(' => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

/// Split a chained command (`a | b`, `a && b`, `a; b`, `a & b`, newlines) into
/// independently verifiable segments, or `None` when the command is NOT safely
/// verifiable as a whole:
///  - unquoted backtick / `$(` command substitution (nested commands unseen),
///  - a file redirect (`> out`, `< in`, heredoc, process substitution) — writes
///    must never inherit per-segment allows,
///  - an empty interior segment (`cmd | | grep`), unbalanced quotes.
///
/// Harmless redirect OPERATORS are stripped in place before a segment is
/// returned: fd duplication (`2>&1`, `>&2`, `2>&-`) and discards to /dev/null
/// (`2>/dev/null`, `>&/dev/null`, `&>/dev/null`). The IO_NUMBER fd stays in
/// the segment — `cmd 2>&1` yields `cmd 2`, NOT `cmd` — so a literal rule
/// `cmd 2` (a remembered or hand-written prefix ending in that very `2`) still
/// matches the redirect variant; the `2` is indistinguishable from an argument
/// at rule level, and keeping it in the segment is what makes remembered rules
/// hit. A single trailing separator (`cmd &&`, `cmd;`) is tolerated — it
/// launches no extra command.
///
/// Security argument: each returned segment is a standalone simple command
/// judged by the ordinary prefix-boundary matcher, so the chained execution set
/// is a subset of what the rules already authorize standalone — no widening.
/// TypeScript mirror: agent-sidecar/src/policy/matchers.ts `splitBashSegments`.
pub fn split_bash_segments(command: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && !in_single {
            if i + 1 < chars.len() {
                current.push(c);
                current.push(chars[i + 1]);
                i += 2;
            } else {
                current.push(c);
                i += 1;
            }
            continue;
        }
        if c == '\'' && !in_double {
            in_single = !in_single;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '"' && !in_single {
            in_double = !in_double;
            current.push(c);
            i += 1;
            continue;
        }
        if in_single || in_double {
            current.push(c);
            i += 1;
            continue;
        }

        // Unquoted from here on.
        if c == '$' && chars.get(i + 1) == Some(&'(') {
            return None;
        }
        if c == '`' {
            return None;
        }
        if c == ';' || c == '\n' {
            if !finalize_interior_segment(&mut current, &mut segments) {
                return None;
            }
            i += 1;
            continue;
        }
        if c == '|' {
            i += 1;
            if chars.get(i) == Some(&'|') {
                i += 1; // `||` is one separator
            }
            if !finalize_interior_segment(&mut current, &mut segments) {
                return None;
            }
            continue;
        }
        if c == '&' {
            match chars.get(i + 1) {
                Some('&') => {
                    i += 2;
                    if !finalize_interior_segment(&mut current, &mut segments) {
                        return None;
                    }
                }
                Some('>') => {
                    // `&>file` / `&>>file` redirect both streams — only
                    // /dev/null is harmless.
                    i += 2;
                    if chars.get(i) == Some(&'>') {
                        i += 1;
                    }
                    match read_redirect_target(&chars, &mut i) {
                        Some(t) if t == "/dev/null" => {}
                        _ => return None,
                    }
                }
                // Single `&` = background separator.
                _ => {
                    i += 1;
                    if !finalize_interior_segment(&mut current, &mut segments) {
                        return None;
                    }
                }
            }
            continue;
        }
        if c == '>' || c == '<' {
            let op = c;
            i += 1;
            if op == '>' && chars.get(i) == Some(&'>') {
                i += 1; // `>>`
            } else if op == '<' && chars.get(i) == Some(&'<') {
                return None; // heredoc / herestring
            }
            if chars.get(i) == Some(&'&') {
                // fd duplication `[n]>&[m]` / `[n]>&-` — no filesystem effect.
                // A non-numeric target (`>&file`) redirects BOTH streams to a file.
                i += 1;
                match read_redirect_target(&chars, &mut i) {
                    Some(t) if t == "-" || t.chars().all(|ch| ch.is_ascii_digit()) => {}
                    _ => return None,
                }
                continue;
            }
            match read_redirect_target(&chars, &mut i) {
                Some(t) if op == '>' && t == "/dev/null" => {} // harmless discard
                _ => return None, // any real file redirect is unverifiable
            }
            continue;
        }
        current.push(c);
        i += 1;
    }
    if in_single || in_double {
        return None;
    }
    // The trailing segment is handled here: a dangling final separator
    // (`cmd &&`) launches nothing, so an empty tail is tolerated.
    let last = current.trim();
    if !last.is_empty() {
        segments.push(last.to_string());
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments)
}

/// Interior separators require a non-empty segment (`cmd | | grep` is
/// unverifiable). Clears `current` either way.
fn finalize_interior_segment(current: &mut String, segments: &mut Vec<String>) -> bool {
    let seg = current.trim().to_string();
    current.clear();
    if seg.is_empty() {
        return false;
    }
    segments.push(seg);
    true
}

/// Read a redirect target word (no quotes/expansions — unverifiable then).
/// Stops at whitespace, shell control, or any char that could hide expansion.
fn read_redirect_target(chars: &[char], i: &mut usize) -> Option<String> {
    while *i < chars.len() && (chars[*i] == ' ' || chars[*i] == '\t') {
        *i += 1;
    }
    if *i >= chars.len() {
        return None;
    }
    if chars[*i] == '\'' || chars[*i] == '"' {
        return None;
    }
    let mut t = String::new();
    while *i < chars.len() {
        let c = chars[*i];
        if matches!(
            c,
            ' ' | '\t' | ';' | '|' | '&' | '<' | '>' | '\n' | '`' | '$' | '"' | '\'' | '\\'
        ) {
            break;
        }
        t.push(c);
        *i += 1;
    }
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Prefix match with a command boundary: `value` must match the start of
/// `command` and be followed by whitespace, a shell separator, or end-of-string.
/// `"pnpm test"` matches `"pnpm test --runInBand"` but not `"pnpm testx"`.
fn command_starts_with_boundary(command: &str, value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let trimmed = command.trim_start();
    if !trimmed.starts_with(value) {
        return false;
    }
    let rest = &trimmed[value.len()..];
    match rest.chars().next() {
        None => true,
        Some(c) => c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | '\n'),
    }
}

/// Path containment with symlink safety. The target and folder are resolved
/// against `cwd`, lexically normalized for `.`/`..`, then the deepest existing
/// ancestor is canonicalized (resolving symlinks) with the non-existent tail
/// appended — so a rule covering `allowed/` does not match
/// `allowed/link/outside.txt` when `link` points outside `allowed/`. Any
/// filesystem/permission error returns `false` (no-match), never `true`.
pub fn path_within_folder(target: &str, folder: &str, cwd: Option<&str>) -> bool {
    let cwd_path = cwd.map(PathBuf::from);
    let target_abs = make_absolute(Path::new(target), cwd_path.as_deref());
    let folder_abs = make_absolute(Path::new(folder), cwd_path.as_deref());
    let target_norm = lexical_normalize(&target_abs);
    let folder_norm = lexical_normalize(&folder_abs);
    let target_canon = match canonicalize_with_tail(&target_norm) {
        Some(p) => p,
        None => return false,
    };
    let folder_canon = match canonicalize_with_tail(&folder_norm) {
        Some(p) => p,
        None => return false,
    };
    is_within(&target_canon, &folder_canon)
}

fn make_absolute(path: &Path, cwd: Option<&Path>) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        match cwd {
            Some(base) => base.join(path),
            None => path.to_path_buf(),
        }
    }
}

/// Lexically resolve `.` and `..` components without touching the filesystem.
/// `..` only pops a `Normal` component, never the Windows prefix or root dir,
/// so it clamps at the root (matching `std::fs::canonicalize` semantics for the
/// existing prefix). This is a lexical pass only — symlinks are resolved later
/// by `canonicalize_with_tail`.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Canonicalize the deepest existing ancestor and append the non-existent tail.
/// Returns `None` only if `canonicalize` fails on the existing ancestor with a
/// real I/O / permission error (not "does not exist" — that just means walk
/// further up). A non-existent target is judged against its resolved parent +
/// remaining tail, so a rule never silently fails for a file about to be
/// created.
fn canonicalize_with_tail(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::metadata(&existing) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(name) = existing.file_name() {
                    tail.push(name.to_owned());
                }
                if !existing.pop() {
                    // Reached the prefix/root without finding anything existing.
                    // Return the lexically-normalized path as-is (no symlinks
                    // to resolve above a non-existent root).
                    let mut result = existing;
                    for name in tail.into_iter().rev() {
                        result.push(name);
                    }
                    return Some(result);
                }
            }
            Err(_) => return None, // permission / I/O error → no-match
        }
    }
    let canon = std::fs::canonicalize(&existing).ok()?;
    let mut result = canon;
    for name in tail.into_iter().rev() {
        result.push(name);
    }
    Some(result)
}

/// Component-wise containment: `target` is within `folder` iff `folder` is a
/// proper prefix of `target`'s component sequence. String-prefix matching is
/// explicitly avoided (`/a/evil` is not within `/a/b`).
fn is_within(target: &Path, folder: &Path) -> bool {
    let target_components: Vec<_> = target.components().collect();
    let folder_components: Vec<_> = folder.components().collect();
    if target_components.len() < folder_components.len() {
        return false;
    }
    folder_components
        .iter()
        .zip(target_components.iter())
        .all(|(f, t)| f == t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_control_detected_unquoted() {
        assert!(has_unquoted_shell_control("pnpm test && rm -rf /"));
        assert!(has_unquoted_shell_control("echo a; rm b"));
        assert!(has_unquoted_shell_control("echo a | grep b"));
        assert!(has_unquoted_shell_control("echo a > out"));
        assert!(has_unquoted_shell_control("echo $(whoami)"));
        assert!(has_unquoted_shell_control("echo `whoami`"));
        assert!(has_unquoted_shell_control("echo a\nrm b"));
    }

    #[test]
    fn shell_control_ignored_when_quoted_or_escaped() {
        assert!(!has_unquoted_shell_control("echo \"a;b\""));
        assert!(!has_unquoted_shell_control("echo 'a;b'"));
        assert!(!has_unquoted_shell_control("echo a\\;b"));
        assert!(!has_unquoted_shell_control("pnpm test --runInBand"));
        assert!(!has_unquoted_shell_control("rm -rf build"));
    }

    #[test]
    fn prefix_boundary_rejects_partial_words() {
        assert!(command_starts_with_boundary("pnpm test --runInBand", "pnpm test"));
        assert!(command_starts_with_boundary("pnpm test", "pnpm test"));
        assert!(command_starts_with_boundary("rm -rf build", "rm"));
        assert!(!command_starts_with_boundary("pnpm testx", "pnpm test"));
        assert!(!command_starts_with_boundary("rmdir", "rm"));
        assert!(!command_starts_with_boundary("pnpm test", ""));
    }

    #[test]
    fn segments_split_on_unquoted_separators() {
        assert_eq!(
            split_bash_segments("cargo test | tail -20"),
            Some(vec!["cargo test".to_string(), "tail -20".to_string()])
        );
        assert_eq!(
            split_bash_segments("a && b || c; d\ne"),
            Some(vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "d".to_string(),
                "e".to_string()
            ])
        );
        assert_eq!(
            split_bash_segments("sleep 1 & echo done"),
            Some(vec!["sleep 1".to_string(), "echo done".to_string()])
        );
    }

    #[test]
    fn segments_strip_harmless_redirects() {
        // The redirect OPERATOR vanishes, but the IO_NUMBER fd stays in the
        // segment — a literal rule `cmd 2` must still match `cmd 2>&1`.
        assert_eq!(
            split_bash_segments("cargo test --lib 2>&1"),
            Some(vec!["cargo test --lib 2".to_string()])
        );
        assert_eq!(
            split_bash_segments("ls /tmp 2>/dev/null"),
            Some(vec!["ls /tmp 2".to_string()])
        );
        // No leading IO_NUMBER — nothing to keep.
        assert_eq!(
            split_bash_segments("cmd >&2"),
            Some(vec!["cmd".to_string()])
        );
        assert_eq!(
            split_bash_segments("cmd &>/dev/null"),
            Some(vec!["cmd".to_string()])
        );
        assert_eq!(
            split_bash_segments("cmd 2>&1 | tail -1"),
            Some(vec!["cmd 2".to_string(), "tail -1".to_string()])
        );
        // digits glued to a word are an argument, not an fd
        assert_eq!(
            split_bash_segments("echo foo2>&1"),
            Some(vec!["echo foo2".to_string()])
        );
    }

    #[test]
    fn segments_reject_unverifiable_constructs() {
        // file redirects — writes must never inherit per-segment allows
        assert_eq!(split_bash_segments("cargo test > out.txt"), None);
        assert_eq!(split_bash_segments("sort < in.txt"), None);
        assert_eq!(split_bash_segments("cmd >> log.txt"), None);
        assert_eq!(split_bash_segments("cmd &> both.txt"), None);
        assert_eq!(split_bash_segments("cat <<EOF"), None);
        // command substitution hides nested commands
        assert_eq!(split_bash_segments("echo $(whoami) | cat"), None);
        assert_eq!(split_bash_segments("echo `whoami`"), None);
        // empty interior segments / unbalanced quotes
        assert_eq!(split_bash_segments("echo hi | | cat"), None);
        assert_eq!(split_bash_segments("| cat"), None);
        assert_eq!(split_bash_segments("echo \"unterminated | x"), None);
        // redirect target with expansion/quote is unverifiable
        assert_eq!(split_bash_segments("cmd 2> $LOG"), None);
    }

    #[test]
    fn segments_tolerate_trailing_separator_and_quoting() {
        assert_eq!(
            split_bash_segments("pnpm test;"),
            Some(vec!["pnpm test".to_string()])
        );
        // quoted separators stay inside the segment
        assert_eq!(
            split_bash_segments("echo \"a|b\""),
            Some(vec!["echo \"a|b\"".to_string()])
        );
        assert_eq!(
            split_bash_segments("git commit -m 'fix: a; b'"),
            Some(vec!["git commit -m 'fix: a; b'".to_string()])
        );
    }

    #[test]
    fn specificity_table_is_fixed() {        assert_eq!(specificity(&PermissionMatcher::Tool), 0);
        assert_eq!(
            specificity(&PermissionMatcher::Bash {
                mode: BashMode::All,
                value: None,
            }),
            1
        );
        assert_eq!(
            specificity(&PermissionMatcher::Bash {
                mode: BashMode::Contains,
                value: Some("x".into()),
            }),
            2
        );
        assert_eq!(
            specificity(&PermissionMatcher::Bash {
                mode: BashMode::Prefix,
                value: Some("x".into()),
            }),
            3
        );
        assert_eq!(
            specificity(&PermissionMatcher::Path {
                field: PathField::FilePath,
                folder: None,
            }),
            1
        );
        assert_eq!(
            specificity(&PermissionMatcher::Path {
                field: PathField::FilePath,
                folder: Some("/a".into()),
            }),
            3
        );
        assert_eq!(
            specificity(&PermissionMatcher::Field {
                field: FieldName::Url,
                equals: "x".into(),
            }),
            3
        );
    }
}