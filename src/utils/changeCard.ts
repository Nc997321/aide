import { api } from "../api";
import type { DiffPair } from "../types";

/**
 * 对话内「变更卡」的数据层：把 Edit / Write / NotebookEdit 三种变更类工具的
 * input 统一解析成 DiffViewer 能直接吃的 DiffPair（片段级 diff：旧片段 vs 新片段，
 * 不是全文件），外加头行统计（+N/-N）和「打开 ↗」定位锚点。
 * 解析失败一律返回 null，调用方静默回退到普通结果文本展示。
 *
 * （本模块取代旧 editDiff.ts：红/绿 <pre> 渲染已换成 DiffViewer 组件，
 *  只保留输入解析，不再维护第二套 diff 视图。）
 */

export interface ChangeInfo {
  filePath: string;
  pair: DiffPair;
  /** 头行统计（按行计） */
  addCount: number;
  delCount: number;
  /** 打开定位锚点：新内容全文，取其中第一个非空行去现文件里搜行号 */
  anchor: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

/** 校验 Edit 工具的 input 形状；字段缺失或类型不对时返回 null，让调用方静默回退。 */
export function parseEditInput(input: unknown): EditToolInput | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (
    typeof obj.file_path !== "string" ||
    typeof obj.old_string !== "string" ||
    typeof obj.new_string !== "string"
  ) {
    return null;
  }
  return { file_path: obj.file_path, old_string: obj.old_string, new_string: obj.new_string };
}

interface WriteToolInput {
  file_path: string;
  content: string;
}

function parseWriteInput(input: unknown): WriteToolInput | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.file_path !== "string" || typeof obj.content !== "string") return null;
  return { file_path: obj.file_path, content: obj.content };
}

interface NotebookEditToolInput {
  notebook_path: string;
  old_source: string;
  new_source: string;
}

/** NotebookEdit 的 old_source 在 insert 模式下可缺省，按空串处理（等价纯新增）。 */
function parseNotebookEditInput(input: unknown): NotebookEditToolInput | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.notebook_path !== "string" || typeof obj.new_source !== "string") return null;
  if (obj.old_source !== undefined && typeof obj.old_source !== "string") return null;
  return {
    notebook_path: obj.notebook_path,
    old_source: (obj.old_source as string | undefined) ?? "",
    new_source: obj.new_source,
  };
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function makePair(oldText: string, newText: string, status: DiffPair["status"]): DiffPair {
  return {
    oldText,
    newText,
    oldLabel: status === "added" ? "（空）" : "修改前",
    newLabel: status === "added" ? "新文件" : "修改后",
    status,
    isBinary: false,
    eolOnly: false,
    tooBig: false,
  };
}

/** 三种变更类工具 → 统一 ChangeInfo；不支持的形状返回 null。 */
export function buildChangeInfo(name: string, input: unknown): ChangeInfo | null {
  if (name === "Edit") {
    const e = parseEditInput(input);
    if (!e) return null;
    return {
      filePath: e.file_path,
      pair: makePair(e.old_string, e.new_string, "modified"),
      addCount: lineCount(e.new_string),
      delCount: lineCount(e.old_string),
      anchor: e.new_string,
    };
  }
  if (name === "Write") {
    const w = parseWriteInput(input);
    if (!w) return null;
    return {
      filePath: w.file_path,
      pair: makePair("", w.content, "added"),
      addCount: lineCount(w.content),
      delCount: 0,
      anchor: w.content,
    };
  }
  if (name === "NotebookEdit") {
    const n = parseNotebookEditInput(input);
    if (!n) return null;
    return {
      filePath: n.notebook_path,
      pair: makePair(n.old_source, n.new_source, "modified"),
      addCount: lineCount(n.new_source),
      delCount: lineCount(n.old_source),
      anchor: n.new_source,
    };
  }
  return null;
}

/**
 * 「打开 ↗」定位：读当前文件，找 anchor 第一个非空行所在的 1-based 行号。
 * 文件读不到 / 锚点已被后续改动冲掉 → undefined（调用方退化为只打开不定位）。
 */
export async function locateAnchorLine(
  path: string,
  anchor: string,
): Promise<number | undefined> {
  const first = anchor
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return undefined;

  let text: string;
  try {
    text = await api.readFileContent(path);
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  // 先整行精确匹配（trim 后），再退化为子串包含（锚点行可能被后续编辑加了前缀/后缀）
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === first) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(first)) return i + 1;
  }
  return undefined;
}

/**
 * 变更卡行号偏移用：算 Edit/NotebookEdit 片段在当前文件中的 1-based 起始行号，
 * 供 DiffViewer 的 lineNumbers({ firstLineNumber }) 显示真实行号。
 *
 * 搜的是 **new_string**（不是 old_string）：Edit 把 old_string 替换成 new_string，
 * 执行后文件里是 new_string、old_string 已不在——搜 old 必失败。new_string 与
 * old_string 同位置替换，起始行相同，故 new_string 起始行 = 真实改动起始行。
 * 与「打开↗」的 locateAnchorLine 同源（它也搜 new_string）。
 * - Write / 纯插入（newText 空 / status=added）：返回 undefined → 行号从 1（新文件语义）。
 * - new_string 被后续改动覆盖 / 读失败：返回 undefined → 退化从 1（不假装准）。
 *
 * readFileContent 不归一化 \r\n（decode_text_bytes 仅解码字节，见 filesystem.rs:243），
 * 故这里统一 \r\n → \n 再匹配——行数不变，行号仍准确。
 */
export async function locateEditStartLine(
  path: string,
  newText: string,
  status: DiffPair["status"],
): Promise<number | undefined> {
  if (status === "added" || !newText) return undefined;
  try {
    const raw = await api.readFileContent(path);
    const text = raw.replace(/\r\n/g, "\n");
    const needle = newText.replace(/\r\n/g, "\n");
    const idx = text.indexOf(needle);
    if (idx === -1) return undefined;
    let line = 1;
    for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  } catch {
    // 读失败退化从 1：变更卡是历史记录，行号偏移降级不应阻塞 UI（语义见 JSDoc）
    return undefined;
  }
}
