/**
 * 聊天文本里「看起来是文件路径」的 inline code 判定与解析。
 *
 * 判定发生在 Markdown 渲染期（见 utils/markdown.ts 的 codespan 渲染器）：
 * 命中的 <code> 被打上 aide-file-link class，只有它们获得可点击的样式和
 * 点击行为——纯代码片段（`foo.get()`、`Vec<u8>` 等）不再被误判成文件。
 *
 * 用扩展名白名单正则而不是 fs 探测：同步、零 IPC、对不存在的路径也能给出
 * 稳定判定（点开后由 FileViewer 自己报"文件不存在"）。
 */

/** 可跳转的文件扩展名白名单——与 FileViewer 能打开的类型对齐 */
const FILE_EXTENSIONS =
  "ts|tsx|vue|rs|js|jsx|mjs|cjs|css|scss|less|html|json|jsonc|md|toml|yaml|yml|sh|ps1|py|java|kt|xml|gradle|go|c|cpp|h|hpp|rb|php|swift|cs|proto|sql|env|lock|txt|ini|cfg|conf";

/**
 * 结构：[可选盘符][目录段/]文件名.白名单扩展名[:行号]
 * - 不允许空白字符（含在字符类约束里），排除整句代码
 * - 目录段和文件名只接受路径常见字符，排除 `foo(bar).ts` 之类表达式
 */
const FILE_PATH_RE = new RegExp(
  `^((?:[A-Za-z]:[/\\\\])?(?:[\\w.@-]+[/\\\\])*[\\w.@-]+\\.(?:${FILE_EXTENSIONS}))(?::(\\d+))?$`,
);

export interface FileLink {
  path: string;
  line?: number;
}

export function isHttpUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/** 路径是否指向 HTML 文件（点击走内置浏览器）；大小写不敏感，忽略查询/片段这类 URL 尾巴。 */
export function isHtmlFilePath(path: string): boolean {
  return /\.html?$/i.test(path.split(/[?#]/, 1)[0] ?? path);
}

export function shouldOpenExternally(path: string): boolean {
  return isHttpUrl(path) || isHtmlFilePath(path);
}

/** 文本是文件路径引用则解析出 path/line，否则 null。 */
export function parseFileLink(text: string): FileLink | null {
  if (!text || text.length > 260) return null; // Windows MAX_PATH，顺带挡长代码串
  const m = text.match(FILE_PATH_RE);
  if (!m) return null;
  return { path: m[1], line: m[2] ? parseInt(m[2], 10) : undefined };
}

/** 相对路径挂到工作区根下；绝对路径（POSIX / 盘符 / URI）原样返回。 */
export function resolveFileLinkPath(path: string, workspacePath?: string): string {
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
  const isAbsolute = hasScheme || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (isAbsolute || !workspacePath) return path;
  return `${workspacePath}/${path}`.replace(/\\/g, "/");
}
