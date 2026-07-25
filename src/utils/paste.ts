import type { ClipboardEntry } from "../composables/useFileClipboard";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".tiff"]);

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot !== -1 && IMAGE_EXTENSIONS.has(lower.slice(dot));
}

export interface PasteResolution {
  text: string;        // @file references or plain text to insert in textarea
  imagePaths: string[]; // paths of image files to convert to attachments
}

/**
 * Resolve clipboard paste into text payload (@path refs / plain text)
 * and image paths (to be base64-encoded and sent as image attachments).
 *
 * Priority: OS files > clipboard image > in-app file-tree copy > plain text.
 * Image files from OS clipboard go to imagePaths, not @path text.
 */
export function resolvePastePayload(
  files: string[],
  img: string | null,
  entry: ClipboardEntry | null,
  text: string,
): PasteResolution {
  if (files.length > 0) {
    const textFiles = files.filter((f) => !isImagePath(f));
    const imageFiles = files.filter(isImagePath);
    return {
      text: textFiles.length > 0 ? textFiles.map((p) => `@${p}`).join(" ") + " " : "",
      imagePaths: imageFiles,
    };
  }
  if (img) {
    return { text: "", imagePaths: [img] };
  }
  // Plain text from the system clipboard always takes priority over the in-app
  // file-tree clipboard. Otherwise a stale "copy" entry (set by Ctrl+C in the
  // file tree) would shadow every subsequent Ctrl+V, making it
  // impossible to paste anything else until the entry is cleared.
  if (text) {
    return { text, imagePaths: [] };
  }
  if (entry && entry.op === "copy") {
    return { text: `@${entry.path} `, imagePaths: [] };
  }
  return { text, imagePaths: [] };
}
