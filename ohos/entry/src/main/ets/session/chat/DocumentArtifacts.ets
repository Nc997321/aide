/** document-artifacts.md v1 的 ArkTS 消费端。纯函数，不读取文件、不改变消息。
 * 与 SDK 的解析结果由 src/utils/ohosDocumentArtifacts.test.ts 对账。
 * ArkTS 无 marked，扫描顶层完整围栏；列表/引用/代码示例不提升为成果。
 */
export class DocumentArtifact {
  version: number = 1;
  path: string = '';
  title: string = '';
  summary: string = '';
}

export interface ArtifactTextSource {
  type: string;
  text: string;
}

export class DocumentPresentation {
  texts: Map<number, string> = new Map<number, string>();
  documents: DocumentArtifact[] = [];
}

export function parseDocumentArtifact(json: string): DocumentArtifact | null {
  try {
    const value: Object | null = JSON.parse(json) as Object | null;
    if (value === null || typeof value !== 'object') return null;
    const v: Record<string, Object> = value as Record<string, Object>;
    if (v['version'] !== 1 || typeof v['path'] !== 'string' || typeof v['title'] !== 'string') return null;
    const path: string = (v['path'] as string).trim();
    const title: string = (v['title'] as string).trim();
    if (title === '' || title.length > 200 || path === '' || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return null;
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
    if (!/\.(md|markdown|txt)$/i.test(path) || /[?#]/.test(path)) return null;
    const summary: Object | undefined = v['summary'];
    if (summary !== undefined && (typeof summary !== 'string' || (summary as string).length > 500)) return null;
    const result: DocumentArtifact = new DocumentArtifact();
    result.path = path;
    result.title = title;
    result.summary = typeof summary === 'string' ? (summary as string).trim() : '';
    return result;
  } catch {
    return null;
  }
}

function identity(path: string, workspacePath: string): string {
  const absolute: boolean = /^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\');
  const resolved: string = (absolute || workspacePath === '' ? path : `${workspacePath}/${path}`).replace(/\\/g, '/');
  const parts: string[] = [];
  const segments: string[] = resolved.split('/');
  for (let i: number = 0; i < segments.length; i++) {
    const part: string = segments[i];
    if (part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '' && !/:$/.test(parts[parts.length - 1])) parts.pop();
    else parts.push(part);
  }
  const key: string = parts.join('/');
  return /^[a-z]:\//i.test(key) || key.startsWith('//') ? key.toLowerCase() : key;
}

/** 调用方只在 assistant 消息收尾后解析，避免流式逐字全量扫描。 */
export function collectDocumentArtifacts(blocks: ArtifactTextSource[], workspacePath: string = ''): DocumentPresentation {
  const result: DocumentPresentation = new DocumentPresentation();
  const documents: Map<string, DocumentArtifact> = new Map<string, DocumentArtifact>();
  for (let blockIndex: number = 0; blockIndex < blocks.length; blockIndex++) {
    const block: ArtifactTextSource = blocks[blockIndex];
    if (block.type !== 'text' || !block.text.includes('aide-document')) continue;
    const lines: string[] = block.text.split('\n');
    const kept: string[] = [];
    let changed: boolean = false;
    let listIndent: number = 0;
    let i: number = 0;
    while (i < lines.length) {
      const line: string = lines[i];
      const list: RegExpMatchArray | null = line.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/);
      if (list !== null) listIndent = list[0].length;
      const indent: number = line.length - line.trimStart().length;
      if (line.trim() !== '' && list === null && indent < listIndent) listIndent = 0;
      const opener: RegExpMatchArray | null = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/);
      if (opener === null) {
        kept.push(line);
        i++;
        continue;
      }
      const marker: string = opener[1];
      const close: RegExp = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
      let end: number = i + 1;
      while (end < lines.length && !close.test(lines[end])) end++;
      const body: string = lines.slice(i + 1, end).join('\n');
      const artifact: DocumentArtifact | null = end < lines.length && listIndent === 0 && opener[2].trim() === 'aide-document'
        ? parseDocumentArtifact(body) : null;
      if (artifact !== null) {
        documents.set(identity(artifact.path, workspacePath), artifact);
        changed = true;
      } else {
        for (let j: number = i; j <= Math.min(end, lines.length - 1); j++) kept.push(lines[j]);
      }
      i = end + 1;
    }
    if (changed) result.texts.set(blockIndex, kept.join('\n'));
  }
  documents.forEach((document: DocumentArtifact): void => { result.documents.push(document); });
  return result;
}
