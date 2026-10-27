import { marked } from "marked";
import { resolveFileLinkPath } from "./fileLink";

/** v1 展示协议：assistant 正文中顶层、完整的 aide-document JSON 围栏。
 * 直接随 text 事件广播和 transcript 落盘；不另造本地状态或文件写入事件。
 * 未识别的客户端仍能读到 JSON 中的文件信息。未知/非法内容保留为普通正文。
 */
export interface DocumentArtifact {
  version: 1;
  path: string;
  title: string;
  summary?: string;
}

export function parseDocumentArtifact(json: string): DocumentArtifact | null {
  try {
    const v = JSON.parse(json);
    if (!v || v.version !== 1 || typeof v.path !== "string" || typeof v.title !== "string") return null;
    const path = v.path.trim();
    const title = v.title.trim();
    // 只支持已有文本弹窗的文档格式；拒绝 URL、行号、控制字符与非文件目标。
    if (!title || title.length > 200 || !path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return null;
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
    if (!/\.(md|markdown|txt)$/i.test(path) || /[?#]/.test(path)) return null;
    if (v.summary !== undefined && (typeof v.summary !== "string" || v.summary.length > 500)) return null;
    return { version: 1, path, title, ...(v.summary?.trim() ? { summary: v.summary.trim() } : {}) };
  } catch {
    return null;
  }
}

/** 规范化身份仅用于当前消息内去重；Host 隔离由消息所属窗口保证。
 * POSIX 区分大小写，显式 Windows 路径不区分；相对路径不猜目标 Host 的平台。
 */
function identity(path: string, workspacePath?: string): string {
  const resolved = resolveFileLinkPath(path, workspacePath).replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of resolved.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== ".." && parts[parts.length - 1] !== "" && !/:$/.test(parts[parts.length - 1])) parts.pop();
    else parts.push(part);
  }
  const key = parts.join("/");
  return /^[a-z]:\//i.test(key) || key.startsWith("//") ? key.toLowerCase() : key;
}

/** 仅在消息定稿后调用，避免流式增量全量解析，也不在 JSON 尚未闭合时亮出卡片。 */
export function collectDocumentArtifacts(
  blocks: readonly { type: string; text?: string }[],
  workspacePath?: string,
): { texts: Map<number, string>; documents: DocumentArtifact[] } {
  const texts = new Map<number, string>();
  const documents = new Map<string, DocumentArtifact>();
  blocks.forEach((block, index) => {
    if (block.type !== "text" || !block.text?.includes("aide-document")) return;
    let changed = false;
    const text = marked.lexer(block.text).map((token) => {
      // 只看顶层 code token，引用/列表/外层示例围栏中的协议示例不会变成卡片。
      if (token.type !== "code" || token.lang !== "aide-document") return token.raw;
      const lines = token.raw.trimEnd().split("\n");
      const fence = /^ {0,3}(`{3,}|~{3,})aide-document\s*$/.exec(lines[0]);
      if (!fence || lines.length < 3 || !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[lines.length - 1])) return token.raw;
      const artifact = parseDocumentArtifact(token.text);
      if (!artifact) return token.raw;
      documents.set(identity(artifact.path, workspacePath), artifact);
      changed = true;
      return "";
    }).join("");
    if (changed) texts.set(index, text);
  });
  return { texts, documents: [...documents.values()] };
}
