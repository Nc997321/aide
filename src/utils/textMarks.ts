/**
 * 把「行内变更段」插进已高亮的行 HTML。
 *
 * 为什么不直接按字符下标插 `<span>`：高亮后的行里夹着 `<span class="hljs-*">`，
 * 纯文本下标与 HTML 下标不是一回事；而变更段的边界又常常落在 token 中间或跨过
 * 边界（改一个词，词的左右是别的 token）。所以先解析成「文本 + 类名栈」的 run，
 * 再按变更段的边界切开重拼——拼出来的嵌套永远合法，token 颜色在里、变更段底色
 * 在外，各归各层。
 *
 * 输入必须是**已转义的高亮产物**（`highlightLines` 的输出：hljs 转义过文本，
 * 类名由 hljs 自己产出）——本函数只搬位置、不引入新的未转义文本，所以拼出来的
 * 仍是安全的 HTML。函数不碰 `v-html` 之外的任何东西，消毒仍由上游负责。
 */

interface TextRun {
  text: string;
  /** 外层 → 内层的类名（与标签嵌套同序） */
  classes: string[];
}

/** HTML 实体 → 字符。**必须先把下标空间还原成纯文本**：`&lt;` 在渲染后是一个字符，
 *  而变更段的下标是按纯文本算的——不还原就会整体错位（实体的长度差越攒越大）。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // 必须最后：先还原它会把 "&amp;lt;" 变成 "<"
}

/** 纯文本 → HTML（与 hljs 的转义口径一致，回拼时不再引入裸标记）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** 高亮 HTML → run 列表：文本连同它所处的类名栈。相邻同类名栈的文本合并成一段，
 *  少产出几个 span。 */
function parseRuns(html: string): TextRun[] {
  const runs: TextRun[] = [];
  const stack: string[] = [];

  const push = (raw: string) => {
    const text = decodeEntities(raw);
    if (!text) return;
    const last = runs[runs.length - 1];
    const sameStack =
      last !== undefined &&
      last.classes.length === stack.length &&
      last.classes.every((c, i) => c === stack[i]);
    if (sameStack) last.text += text;
    else runs.push({ text, classes: [...stack] });
  };

  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        push(html.slice(i)); // 残缺标签：当文本收下，绝不吞内容
        break;
      }
      const tag = html.slice(i, end + 1);
      const cls = /^<span\b[^>]*\bclass="([^"]*)"/.exec(tag);
      if (cls) stack.push(cls[1]);
      else if (tag.startsWith("</")) stack.pop();
      i = end + 1;
      continue;
    }
    const next = html.indexOf("<", i);
    const stop = next === -1 ? html.length : next;
    push(html.slice(i, stop));
    i = stop;
  }
  return runs;
}

/** 按类名栈包回嵌套 span（外 → 内）。 */
function wrap(classes: readonly string[], inner: string): string {
  return classes.reduceRight((acc, cls) => `<span class="${cls}">${acc}</span>`, inner);
}

/**
 * `marks` 是相对该行纯文本的 `[start, end)`（升序、不重叠）。
 * 无 marks 时原样返回输入字符串（省一次解析+重拼）。
 */
export function applyTextMarks(
  html: string,
  marks: ReadonlyArray<readonly [number, number]>,
  markClass: string,
): string {
  if (marks.length === 0) return html;

  const runs = parseRuns(html);
  let out = "";
  let offset = 0;

  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;

    // 切点 = run 两端 + 与 marks 的交界；切开后每段要么整段在某个变更段里，要么整段不在
    const cuts = new Set<number>([runStart, runEnd]);
    for (const [start, end] of marks) {
      if (end <= runStart || start >= runEnd) continue;
      cuts.add(Math.max(start, runStart));
      cuts.add(Math.min(end, runEnd));
    }
    const points = [...cuts].sort((a, b) => a - b);

    for (let k = 0; k < points.length - 1; k++) {
      const start = points[k];
      const end = points[k + 1];
      if (end <= start) continue;
      const text = escapeHtml(run.text.slice(start - runStart, end - runStart));
      const marked = marks.some(([ms, me]) => ms <= start && me >= end);
      out += wrap(run.classes, marked ? `<span class="${markClass}">${text}</span>` : text);
    }
  }
  return out;
}
