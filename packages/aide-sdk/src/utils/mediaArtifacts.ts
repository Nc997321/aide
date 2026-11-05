import { marked } from "marked";
import { resolveFileLinkPath } from "./fileLink";

export interface MediaArtifact { path: string; title: string }

const MEDIA_EXT = /\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|flac|aac|mpg|mpeg)$/i;
const MEDIA_MENTION = /\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|flac|aac|mpg|mpeg)\b/i;

export function isMediaFilePath(path: string): boolean {
  return MEDIA_EXT.test(path) || MEDIA_EXT.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function resolveMediaLink(raw: string, workspacePath?: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
  if (raw.startsWith("//")) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* 带字面百分号的文件名保留原样。 */ }
  if (!isMediaFilePath(decoded)) return null;
  const path = MEDIA_EXT.test(decoded) ? decoded : decoded.split(/[?#]/, 1)[0] ?? "";
  const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(path);
  if (!absolute && !workspacePath) return null;
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return null;
  return normalizedPath(absolute ? path : resolveFileLinkPath(path, workspacePath));
}

function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "" && !/:$/.test(parts[parts.length - 1] ?? "")) parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function identity(path: string): string {
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

/** 只解析正文里的实际 Markdown 链接；不读取磁盘，不把围栏示例或远程网页当成本地交付。 */
export function collectMediaArtifacts(blocks: readonly { type: string; text?: string }[], workspacePath?: string): MediaArtifact[] {
  const files = new Map<string, MediaArtifact>();
  for (const block of blocks) {
    if (block.type !== "text" || !block.text || !MEDIA_MENTION.test(block.text)) continue;
    marked.walkTokens(marked.lexer(block.text), (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const path = resolveMediaLink(token.href, workspacePath);
      if (!path) return;
      const key = identity(path);
      if (!files.has(key)) files.set(key, { path, title: token.text || path.split("/").pop() || path });
    });
  }
  return [...files.values()];
}
