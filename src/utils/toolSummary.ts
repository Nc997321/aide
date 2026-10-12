/**
 * 把一次工具调用提炼成对话流里那一行的文案：头行摘要（调用了什么）与结果预览
 * （得到了什么）。`ToolCallBlock.vue` 是唯一消费者（顶层工具行与子代理时间线
 * 的工具步都经它渲染），规则集中在这里，避免改一处漏一处。
 */

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 头行摘要：把 input 写成人读的一句，而不是原始 JSON。 */
export function summarizeToolInput(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash") return String(record.command ?? "");
  if (["Read", "Write", "Edit"].includes(name)) return String(record.file_path ?? "");
  if (name === "Grep" && str(record.pattern)) {
    const scope = str(record.path) || str(record.glob) || (str(record.type) && `*.${str(record.type)}`);
    return scope ? `"${str(record.pattern)}" in ${scope}` : `"${str(record.pattern)}"`;
  }
  if (name === "Glob" && str(record.pattern)) {
    return str(record.path) ? `${str(record.pattern)} in ${str(record.path)}` : str(record.pattern);
  }
  return JSON.stringify(record).slice(0, 80);
}

/** 工具行的结果预览：拐角下的几行正文。不配状态文字（"运行中" / "无匹配" / 行数
 *  摘要）——状态由圆点表达，结果由正文自己说话。 */
export interface ToolResultPreview {
  /** 预览行（1 ~ PREVIEW_LINES 行） */
  lines: string[];
  /** 预览之外还剩多少行 */
  rest: number;
}

export const PREVIEW_LINES = 3;

/** 单行预览的字符上限：一行压缩过的 JSON / minified 输出可能上 MB，预览只要开头。 */
const PREVIEW_LINE_CHARS = 240;

// CSI 序列（颜色/光标）。预览是纯文本节点，不剥掉会露出 "[32m" 这类残骸；
// 展开后的 Bash 全文走 xterm，由它自己解释。
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const clean = (line: string): string =>
  line.replace(ANSI_RE, "").replace(/\r/g, "").slice(0, PREVIEW_LINE_CHARS);

/** 不给正文预览的工具：Read 的结果就是文件内容，贴前三行是噪音。 */
const NO_PREVIEW: ReadonlySet<string> = new Set(["Read"]);

/**
 * 结果预览。只扫描不整段 split——流式 stdout 每来一段增量就会重算一次，
 * 大输出（构建/安装日志）整段切行是 O(累计)。
 *
 * tail = 取末尾几行（还在跑的命令：最新输出在尾部）；否则取开头几行。
 * 没有可预览的正文（还没结果 / 空输出 / 无匹配 / Read）→ null。
 */
export function previewToolResult(
  name: string,
  result: string | undefined,
  opts: { tail?: boolean } = {},
): ToolResultPreview | null {
  if (result === undefined || NO_PREVIEW.has(name)) return null;
  // 尾部空白不算行：命令输出几乎都以换行结尾
  let end = result.length;
  while (end > 0 && /\s/.test(result[end - 1])) end--;
  if (end === 0) return null;

  let total = 1;
  for (let i = result.indexOf("\n"); i !== -1 && i < end; i = result.indexOf("\n", i + 1)) total++;

  const head = result.slice(0, Math.min(end, 80));
  if (/^No (files|matches) found/.test(head)) return null;

  const take = Math.min(PREVIEW_LINES, total);
  const lines: string[] = [];
  if (opts.tail) {
    let hi = end;
    for (let n = 0; n < take; n++) {
      const lo = result.lastIndexOf("\n", hi - 1);
      lines.unshift(clean(result.slice(lo + 1, hi)));
      hi = lo;
    }
  } else {
    let lo = 0;
    for (let n = 0; n < take; n++) {
      const nl = result.indexOf("\n", lo);
      const hi = nl === -1 || nl > end ? end : nl;
      lines.push(clean(result.slice(lo, hi)));
      lo = hi + 1;
    }
  }
  return { lines, rest: total - take };
}
