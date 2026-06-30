import type { ClipboardEntry } from "../composables/useFileClipboard";

/**
 * Decide what to write to the PTY on Ctrl+V / Cmd+V, given the four clipboard
 * sources in priority order: OS files > OS image > in-app file-tree copy >
 * plain text. Returns "" to mean "write nothing".
 *
 * Pure / side-effect-free so it can be unit-tested independently of Tauri and
 * the clipboard.
 */
export function resolvePastePayload(
  files: string[],
  img: string | null,
  entry: ClipboardEntry | null,
  text: string,
): string {
  if (files.length > 0) {
    return files.map((p) => `@${p}`).join(" ") + " ";
  }
  if (img) {
    return `@${img} `;
  }
  if (entry && entry.op === "copy") {
    return `@${entry.path} `;
  }
  return text;
}