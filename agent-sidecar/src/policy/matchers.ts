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
      // backtick, `$(`). ask/deny may inspect the raw text.
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
