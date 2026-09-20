import { presentableDiff, type Change } from "@codemirror/merge";

/**
 * 片段 diff 的行模型：给定一对文本，产出「逐行」的渲染数据——静态 diff 视图
 * （变更卡）靠它画行号、增删行底色与行内变更段，**不建任何编辑器**。
 *
 * 为什么复用 @codemirror/merge 的 `presentableDiff`：它是 MergeView 内部同一套
 * 差异化算法（字符级、按词边界对齐、丢掉短的未变区间）。自己另写一份 LCS 会与
 * 「在文件查看器里看到的 diff」出现两套结果——同一处改动换个地方看就换了样子。
 * `diff()` 是纯计算，不碰 DOM，也不要求有编辑器。
 *
 * 三个约定（与 StaticDiff.vue、highlightLines 同一套，改动要一起改）：
 * - 行号是**片段内 1 起**；真实文件行号由调用方加 `firstLineNumber - 1` 偏移；
 * - 行切分用 `split("\n")`——末尾换行会多出一个空行；
 * - `marks` 是行内变更段，**整行都被改动时不给**（只留行底色）。
 */

export interface DiffRow {
  kind: "ctx" | "del" | "add";
  /** 片段内 1 起行号；ctx 两侧都有，del 只有 a、add 只有 b */
  aLine?: number;
  bLine?: number;
  /** 该行纯文本（不含换行符） */
  text: string;
  /** 行内变更段：相对 `text` 的 [start, end)，升序不重叠 */
  marks: Array<[number, number]>;
}

/** 一侧文本的行视图：行文本 + 每行首字符偏移。 */
interface Side {
  lines: string[];
  starts: number[];
  /** 字符偏移 → 行下标（0 起）。 */
  lineAt(offset: number): number;
}

function makeSide(text: string): Side {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1; // +1 = 换行符
  }
  return {
    lines,
    starts,
    lineAt(offset: number): number {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

/** 一个变更块在两侧的行区间（含端）；空区间用 `to < from` 表示。 */
interface Hunk {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
  /** 该块内的字符级变更（用于算行内变更段） */
  changes: readonly Change[];
}

/** 字符区间 → 该侧占用的行区间。
 *  空区间（纯插入/纯删除）要看落点：**落在行首** = 整行插入/删除，本侧不占行；
 *  **落在行中** = 这一行也变了，本侧照占——unified diff 里「改一行中的一个词」
 *  呈现为 `-整行 / +整行`，只把变的那几个字加行内变更段，而不是凭空多出一行。 */
function spanLines(side: Side, from: number, to: number): { from: number; to: number } {
  const start = side.lineAt(from);
  if (to > from) return { from: start, to: side.lineAt(to - 1) };
  return { from: start, to: side.starts[start] === from ? start - 1 : start };
}

/** 字符级变更 → 行级块：同一行内（两段之间不含换行）的变更合成一块，
 *  否则同一处改动会被拆成好几行 del/add，读起来像多次改动。 */
function toHunks(changes: readonly Change[], a: Side, b: Side, oldText: string, newText: string): Hunk[] {
  const hunks: Hunk[] = [];
  /** 累积中的块：只记字符区间，行区间等闭合时一次算出。 */
  let cur: { fromA: number; toA: number; fromB: number; toB: number; changes: Change[] } | null = null;

  const close = () => {
    if (!cur) return;
    const spanA = spanLines(a, cur.fromA, cur.toA);
    const spanB = spanLines(b, cur.fromB, cur.toB);
    hunks.push({ aFrom: spanA.from, aTo: spanA.to, bFrom: spanB.from, bTo: spanB.to, changes: cur.changes });
    cur = null;
  };

  for (const ch of changes) {
    if (cur) {
      const gapA = oldText.slice(cur.toA, ch.fromA);
      const gapB = newText.slice(cur.toB, ch.fromB);
      if (!gapA.includes("\n") && !gapB.includes("\n")) {
        cur.toA = ch.toA;
        cur.toB = ch.toB;
        cur.changes.push(ch);
        continue;
      }
      close();
    }
    cur = { fromA: ch.fromA, toA: ch.toA, fromB: ch.fromB, toB: ch.toB, changes: [ch] };
  }
  close();
  return hunks;
}

/** 某行的行内变更段：变更与该行文本的交集；**整行都被改动时返回空**
 *  （行底色已经表达了「这行变了」，再叠一层没有信息量）。 */
function marksOfLine(hunk: Hunk, side: Side, lineIndex: number, which: "a" | "b"): Array<[number, number]> {
  const lineStart = side.starts[lineIndex];
  const lineEnd = lineStart + side.lines[lineIndex].length;
  const marks: Array<[number, number]> = [];
  for (const ch of hunk.changes) {
    const from = which === "a" ? ch.fromA : ch.fromB;
    const to = which === "a" ? ch.toA : ch.toB;
    const start = Math.max(from, lineStart);
    const end = Math.min(to, lineEnd);
    if (end <= start) continue;
    if (start === lineStart && end === lineEnd) return []; // 整行变更
    marks.push([start - lineStart, end - lineStart]);
  }
  return marks;
}

/** 片段 diff → 行模型。空 old（新增文件片段）自然退化成整段 add。 */
export function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const a = makeSide(oldText);
  const b = makeSide(newText);
  const hunks = toHunks(presentableDiff(oldText, newText), a, b, oldText, newText);

  const rows: DiffRow[] = [];
  let ai = 0;
  let bi = 0;
  let ao = 0;
  let bo = 0;

  /** 两侧都停在行首且该行文本相同时，成对出 ctx 行。 */
  const pushCtx = (limitA: number) => {
    while (
      ai < a.lines.length &&
      bi < b.lines.length &&
      ao === a.starts[ai] &&
      bo === b.starts[bi] &&
      ao < limitA &&
      a.lines[ai] === b.lines[bi]
    ) {
      rows.push({ kind: "ctx", aLine: ai + 1, bLine: bi + 1, text: a.lines[ai], marks: [] });
      ao += a.lines[ai].length + 1;
      bo += b.lines[bi].length + 1;
      ai += 1;
      bi += 1;
    }
  };

  for (const hunk of hunks) {
    pushCtx(a.starts[hunk.aFrom]);
    for (let i = Math.max(hunk.aFrom, ai); i <= hunk.aTo; i++) {
      rows.push({ kind: "del", aLine: i + 1, text: a.lines[i], marks: marksOfLine(hunk, a, i, "a") });
    }
    for (let i = Math.max(hunk.bFrom, bi); i <= hunk.bTo; i++) {
      rows.push({ kind: "add", bLine: i + 1, text: b.lines[i], marks: marksOfLine(hunk, b, i, "b") });
    }
    if (hunk.aTo >= ai) {
      ai = hunk.aTo + 1;
      ao = ai < a.lines.length ? a.starts[ai] : oldText.length + 1;
    }
    if (hunk.bTo >= bi) {
      bi = hunk.bTo + 1;
      bo = bi < b.lines.length ? b.starts[bi] : newText.length + 1;
    }
  }
  const END = Number.MAX_SAFE_INTEGER;
  pushCtx(END);

  return rows;
}
