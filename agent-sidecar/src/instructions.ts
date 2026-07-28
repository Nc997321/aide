// Aide-controlled instruction loader.
//
// Replaces the SDK's filesystem setting-source loading with an explicit read of
// exactly two CLAUDE.md files: the global one in the Aide Claude config dir and
// the project-root one. It NEVER reads .claude/settings*.json and never scans
// recursively. Each file is capped at 256 KiB; oversize or unreadable files
// yield a short diagnostics line so the query is never aborted, and a missing
// file is silently skipped.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

async function readInstructionFile(path: string): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // Missing file (ENOENT) or stat failure — silently skip. Not a diagnostic
    // case: most projects legitimately have no project-root CLAUDE.md.
    return null;
  }
  if (size > MAX_INSTRUCTION_FILE_BYTES) {
    return `（${path} 超过 256 KiB 上限，已跳过加载）`;
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    return `（${path} 读取失败，已跳过）`;
  }
}

/**
 * Load and concatenate the Aide global + project CLAUDE.md instructions.
 * Returns the joined text (non-empty chunks separated by a blank line), or an
 * empty string if neither file is present. Never throws — a bad file becomes a
 * diagnostics line so the caller's `query()` is never blocked.
 */
export async function loadAideInstructions(
  cwd: string,
  claudeConfigDir: string,
): Promise<string> {
  const files = [join(claudeConfigDir, "CLAUDE.md"), join(cwd, "CLAUDE.md")];
  const chunks = await Promise.all(files.map(readInstructionFile));
  return chunks
    .filter((t): t is string => t !== null && t.length > 0)
    .join("\n\n");
}