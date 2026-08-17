// Matcher evaluation: specificity, Bash command scanning, path containment
// with symlink resolution, and field equality. Provider-agnostic — no Claude
// SDK types, no tool dispatch. Pure functions except pathWithinFolder,
// which consults the filesystem only to resolve symlinks for safety.

import * as path from "node:path";
import * as fs from "node:fs/promises";

import type { PermissionMatcher } from "./types.js";

// ---------------------------------------------------------------------------
// Specificity (fixed, never string-length-based)
// ---------------------------------------------------------------------------

/** Fixed specificity table (plan Canonical Contracts):
 * tool=0; bash all=1; bash contains=2; bash prefix=3; path all=1; path
 * folder=3; field equals=3. Specificity never depends on string length. */
export function specificity(matcher: PermissionMatcher): number {
  switch (matcher.kind) {
    case "tool":
      return 0;
    case "bash":
      switch (matcher.mode) {
        case "all":
          return 1;
        case "contains":
          return 2;
        case "prefix":
          return 3;
      }
      break;
    case "path":
      return matcher.folder !== undefined ? 3 : 1;
    case "field":
      return 3;
  }
}

// ---------------------------------------------------------------------------
// Bash shell-control scanner
// ---------------------------------------------------------------------------

/** True if `command` contains an unquoted shell control token that could
 * widen a prefix allow into a second command. Tracks single/double quote
 * state and backslash escapes (outside single quotes, `\` escapes the next
 * char). Inside single quotes everything is literal. */
export function hasUnquotedShellControl(command: string): boolean {
  const chars = command.split("");
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\" && !inSingle) {
      // Backslash escape (outside single quotes). In double quotes
      // backslash only escapes a few chars, but for control-token
      // detection skipping the next char is safe either way.
      i += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (
        c === ";" || c === "|" || c === "&" || c === "<" || c === ">" ||
        c === "\n" || c === "`"
      ) {
        return true;
      }
      if (c === "$" && i + 1 < chars.length && chars[i + 1] === "(") {
        return true;
      }
    }
    i += 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bash prefix boundary check
// ---------------------------------------------------------------------------

/** Prefix match with a command boundary: `value` must match the start of
 * `command` and be followed by whitespace, a shell separator, or end-of-string.
 * `"pnpm test"` matches `"pnpm test --runInBand"` but not `"pnpm testx"`. */
export function commandStartsWithBoundary(command: string, value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const trimmed = command.trimStart();
  if (!trimmed.startsWith(value)) {
    return false;
  }
  const rest = trimmed.slice(value.length);
  if (rest.length === 0) {
    return true;
  }
  const next = rest[0];
  return (
    next === " " || next === "\t" ||
    next === ";" || next === "|" || next === "&" ||
    next === "<" || next === ">" || next === "\n"
  );
}

// ---------------------------------------------------------------------------
// Bash chained-command segmentation
// ---------------------------------------------------------------------------

/** Split a chained command (`a | b`, `a && b`, `a; b`, `a & b`, newlines) into
 * independently verifiable segments, or `null` when the command is NOT safely
 * verifiable as a whole:
 *  - unquoted backtick / `$(` command substitution (nested commands unseen),
 *  - a file redirect (`> out`, `< in`, heredoc, process substitution) — writes
 *    must never inherit per-segment allows,
 *  - an empty interior segment (`cmd | | grep`), unbalanced quotes.
 *
 * Harmless redirect OPERATORS are stripped in place before a segment is
 * returned: fd duplication (`2>&1`, `>&2`, `2>&-`) and discards to /dev/null
 * (`2>/dev/null`, `>&/dev/null`, `&>/dev/null`). The IO_NUMBER fd stays in the
 * segment — `cmd 2>&1` yields `cmd 2`, NOT `cmd` — so a literal rule `cmd 2`
 * (a remembered or hand-written prefix ending in that very `2`) still matches
 * the redirect variant; the `2` is indistinguishable from an argument at rule
 * level, and keeping it in the segment is what makes remembered rules hit.
 * A single trailing separator (`cmd &&`, `cmd;`) is tolerated — it launches no
 * extra command.
 *
 * Security argument: each returned segment is a standalone simple command
 * judged by the ordinary prefix-boundary matcher, so the chained execution set
 * is a subset of what the rules already authorize standalone — no widening.
 * Rust mirror: src-tauri/src/policy/matchers.rs `split_bash_segments`. */
export function splitBashSegments(command: string): string[] | null {
  const chars = [...command];
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  // Interior separators require a non-empty segment; the trailing segment is
  // handled after the loop (a dangling final separator launches nothing).
  const finalizeInterior = (): boolean => {
    const seg = current.trim();
    current = "";
    if (seg.length === 0) return false;
    segments.push(seg);
    return true;
  };

  /** Read a redirect target word (no quotes/expansions — unverifiable then). */
  const readRedirectTarget = (): string | null => {
    while (chars[i] === " " || chars[i] === "\t") i++;
    if (i >= chars.length) return null;
    if (chars[i] === "'" || chars[i] === '"') return null;
    let t = "";
    while (i < chars.length && !/[ \t;|&<>\n`$"'\\]/.test(chars[i])) {
      t += chars[i];
      i++;
    }
    return t.length > 0 ? t : null;
  };

  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\" && !inSingle) {
      if (i + 1 < chars.length) {
        current += c + chars[i + 1];
        i += 2;
      } else {
        current += c;
        i += 1;
      }
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
      i++;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      current += c;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      current += c;
      i++;
      continue;
    }

    // Unquoted from here on.
    if (c === "$" && chars[i + 1] === "(") return null;
    if (c === "`") return null;
    if (c === ";" || c === "\n") {
      if (!finalizeInterior()) return null;
      i++;
      continue;
    }
    if (c === "|") {
      i++;
      if (chars[i] === "|") i++; // `||` is one separator
      if (!finalizeInterior()) return null;
      continue;
    }
    if (c === "&") {
      const next = chars[i + 1];
      if (next === "&") {
        i += 2;
        if (!finalizeInterior()) return null;
        continue;
      }
      if (next === ">") {
        // `&>file` / `&>>file` redirect both streams — only /dev/null is harmless.
        i += 2;
        if (chars[i] === ">") i++;
        const target = readRedirectTarget();
        if (target !== "/dev/null") return null;
        continue;
      }
      // Single `&` = background separator.
      i++;
      if (!finalizeInterior()) return null;
      continue;
    }
    if (c === ">" || c === "<") {
      const op = c;
      i++;
      if (op === ">" && chars[i] === ">") {
        i++; // `>>`
      } else if (op === "<" && chars[i] === "<") {
        return null; // heredoc / herestring
      }
      if (chars[i] === "&") {
        // fd duplication `[n]>&[m]` / `[n]>&-` — no filesystem effect.
        // A non-numeric target (`>&file`) redirects BOTH streams to a file.
        i++;
        const t = readRedirectTarget();
        if (t === null || !/^(\d+|-)$/.test(t)) return null;
        continue;
      }
      const target = readRedirectTarget();
      if (op === ">" && target === "/dev/null") continue; // harmless discard
      return null; // any real file redirect is unverifiable
    }
    current += c;
    i++;
  }
  if (inSingle || inDouble) return null;
  const last = current.trim();
  if (last.length > 0) segments.push(last);
  return segments.length > 0 ? segments : null;
}

// ---------------------------------------------------------------------------
// Bash matcher
// ---------------------------------------------------------------------------

function bashMatches(
  mode: "all" | "prefix" | "contains",
  value: string,
  command: string,
  effect: "allow" | "ask" | "deny",
): boolean {
  switch (mode) {
    // "all commands" matches any Bash invocation, including chained ones —
    // the user explicitly allowed every command, so chaining is in scope.
    case "all":
      return true;
    case "prefix": {
      // Conservative gate: an `allow` prefix must not widen across
      // unquoted shell control tokens (`;`, `|`, `&`, `<`, `>`, newline,
      // backtick, `$(`). ask/deny may inspect the raw text. Chained
      // commands reach this matcher one segment at a time via
      // `splitBashSegments` in evaluatePolicy — this gate is the backstop
      // for everything that analysis could not verify.
      if (effect === "allow" && hasUnquotedShellControl(command)) {
        return false;
      }
      return commandStartsWithBoundary(command, value);
    }
    // `contains` is never `allow` (validated upstream); for ask/deny a
    // substring match on the raw command is intentional.
    case "contains":
      return value.length > 0 && command.includes(value);
  }
}

// ---------------------------------------------------------------------------
// Path containment with symlink safety
// ---------------------------------------------------------------------------

/** Lexically resolve `.` and `..` components without touching the filesystem.
 * `..` only pops a Normal component, never the root dir, so it clamps at the
 * root (matching Rust std::fs::canonicalize semantics). */
export function lexicalNormalize(p: string): string {
  const parts = p.split(/[/\\]+/);
  const result: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") {
      continue;
    }
    if (part === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else {
        result.push("..");
      }
    } else {
      result.push(part);
    }
  }
  if (result.length === 0) {
    return ".";
  }
  // Preserve leading separator for absolute paths
  if (p.startsWith("/")) {
    return "/" + result.join("/");
  }
  // Windows drive-letter prefix
  if (/^[a-zA-Z]:[/\\]/.test(p)) {
    return result[0] + "/" + result.slice(1).join("/");
  }
  return result.join("/");
}

/** Canonicalize the deepest existing ancestor and append the non-existent tail.
 * Returns `null` only if `realpath` fails on the existing ancestor with a
 * real I/O / permission error (not "does not exist" — that just means walk
 * further up). A non-existent target is judged against its resolved parent +
 * remaining tail, so a rule never silently fails for a file about to be
 * created. */
async function canonicalizeWithTail(p: string): Promise<string | null> {
  let existing = p;
  const tail: string[] = [];

  // Walk up until we find an existing component
  while (true) {
    try {
      await fs.access(existing);
      break;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        const name = path.basename(existing);
        tail.push(name);
        const parent = path.dirname(existing);
        if (parent === existing) {
          // Reached the root without finding anything existing.
          // Return the lexically-normalized path as-is (no symlinks
          // to resolve above a non-existent root).
          let result = existing;
          for (const n of tail.reverse()) {
            result = path.join(result, n);
          }
          return result;
        }
        existing = parent;
      } else {
        return null; // permission / I/O error → no-match
      }
    }
  }

  // Canonicalize the existing ancestor (resolves symlinks)
  let canon: string;
  try {
    canon = await fs.realpath(existing);
  } catch {
    return null;
  }

  // Append the non-existent tail
  let result = canon;
  for (const n of tail.reverse()) {
    result = path.join(result, n);
  }
  return result;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Component-wise containment: `target` is within `folder` iff `folder` is a
 * proper prefix of `target`'s component sequence. String-prefix matching is
 * explicitly avoided (`/a/evil` is not within `/a/b`). */
function isWithin(target: string, folder: string): boolean {
  const tParts = target.split(/[/\\]+/).filter((p) => p.length > 0);
  const fParts = folder.split(/[/\\]+/).filter((p) => p.length > 0);
  if (tParts.length < fParts.length) {
    return false;
  }
  for (let i = 0; i < fParts.length; i++) {
    if (tParts[i] !== fParts[i]) {
      return false;
    }
  }
  return true;
}

/** Path containment with symlink safety. The target and folder are resolved
 * against `cwd`, lexically normalized for `.`/`..`, then the deepest existing
 * ancestor is canonicalized (resolving symlinks) with the non-existent tail
 * appended — so a rule covering `allowed/` does not match
 * `allowed/link/outside.txt` when `link` points outside `allowed/`. Any
 * filesystem/permission error returns `false` (no-match), never `true`. */
export async function pathWithinFolder(
  target: string,
  folder: string,
  cwd?: string,
): Promise<boolean> {
  const targetAbs = makeAbsolute(target, cwd);
  const folderAbs = makeAbsolute(folder, cwd);
  const targetNorm = lexicalNormalize(targetAbs);
  const folderNorm = lexicalNormalize(folderAbs);
  const targetCanon = await canonicalizeWithTail(targetNorm);
  if (targetCanon === null) {
    return false;
  }
  const folderCanon = await canonicalizeWithTail(folderNorm);
  if (folderCanon === null) {
    return false;
  }
  return isWithin(targetCanon, folderCanon);
}

function makeAbsolute(p: string, cwd?: string): string {
  if (path.isAbsolute(p)) {
    return p;
  }
  if (cwd !== undefined) {
    return path.resolve(cwd, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Top-level matcher dispatch (async)
// ---------------------------------------------------------------------------

/** Does `matcher` accept this invocation? Called only after the tool name has
 * already been matched against `rule.tool`, so `Tool` matchers accept
 * unconditionally. `effect` is threaded in so the Bash prefix-allow shell gate
 * can be applied conservatively (ask/deny inspect raw text). */
export async function matcherMatches(
  matcher: PermissionMatcher,
  input: Record<string, unknown>,
  cwd: string | undefined,
  effect: "allow" | "ask" | "deny",
): Promise<boolean> {
  switch (matcher.kind) {
    case "tool":
      return true;
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      return bashMatches(matcher.mode, matcher.value ?? "", command, effect);
    }
    case "path": {
      const fieldKey = matcher.field;
      const target = input[fieldKey];
      if (typeof target !== "string") {
        return false;
      }
      if (matcher.folder === undefined) {
        // "all paths" — matches any invocation that supplies the field.
        return true;
      }
      return pathWithinFolder(target, matcher.folder, cwd);
    }
    case "field": {
      const val = input[matcher.field];
      return typeof val === "string" && val === matcher.equals;
    }
  }
}
