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

export interface DiffLine {
  text: string;
  cls: "aide-diff-del" | "aide-diff-add";
}

export interface EditDiffStats {
  lines: DiffLine[];
  addCount: number;
  delCount: number;
}

/**
 * 整段红/绿块 diff：old_string 逐行标红在前，new_string 逐行标绿在后。
 * 不做逐行比对（不是真正的 LCS diff），只是把两段文本按行拆开分别着色。
 */
export function buildEditDiffLines(edit: EditToolInput): EditDiffStats {
  const delTextLines = edit.old_string.split("\n");
  const addTextLines = edit.new_string.split("\n");
  const lines: DiffLine[] = [
    ...delTextLines.map((text): DiffLine => ({ text: `-${text}`, cls: "aide-diff-del" })),
    ...addTextLines.map((text): DiffLine => ({ text: `+${text}`, cls: "aide-diff-add" })),
  ];
  return { lines, addCount: addTextLines.length, delCount: delTextLines.length };
}
