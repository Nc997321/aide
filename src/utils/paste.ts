import type { ClipboardEntry } from "../composables/useFileClipboard";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".tiff"]);

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot !== -1 && IMAGE_EXTENSIONS.has(lower.slice(dot));
}

export interface PasteResolution {
  text: string;         // plain text to insert in textarea
  /** 非图片文件的确切路径：调用方直接建芯片（pathTypes 校验后 addMention），
   *  不绕道 `@path ` 文本——文本词法以空白为界，文件名带空格会被截断、静默丢失。
   *  校验不存在的路径由调用方回退成 `@path ` 文本插入。 */
  mentionPaths: string[];
  imagePaths: string[]; // paths of image files to convert to attachments
}

/**
 * Resolve clipboard paste into text payload (plain text),
 * mention paths (→ chips) and image paths (→ base64 attachments).
 *
 * Priority: OS files > clipboard image > in-app file-tree copy > plain text.
 * Image files from OS clipboard go to imagePaths, not mentions.
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
      text: "",
      mentionPaths: textFiles,
      imagePaths: imageFiles,
    };
  }
  if (img) {
    return { text: "", mentionPaths: [], imagePaths: [img] };
  }
  // Plain text from the system clipboard always takes priority over the in-app
  // file-tree clipboard. Otherwise a stale "copy" entry (set by Ctrl+C in the
  // file tree) would shadow every subsequent Ctrl+V, making it
  // impossible to paste anything else until the entry is cleared.
  if (text) {
    return { text, mentionPaths: [], imagePaths: [] };
  }
  if (entry && entry.op === "copy" && entry.paths.length > 0) {
    // 多条来源（OS 多选复制）逐条成芯片
    return { text: "", mentionPaths: entry.paths, imagePaths: [] };
  }
  return { text, mentionPaths: [], imagePaths: [] };
}
