// 值守：两次读取之间的变化（纯函数）。
//
// 按行比对、当作多重集合：新读取里多出来的行 = 新出现的内容（聊天里的新消息、终端里的新输出），
// 旧读取里少掉的行只计数。与位置无关——窗口滚动、终端可见区上移都不会把旧内容误报成新内容。

/** 窗口读取的文字 → 用于比对的行：去掉每次都会变的抬头（obs 编号）、元素编号与缩进。 */
export function windowLines(rendered: string): string[] {
  return rendered
    .split("\n")
    .filter((l) => !l.startsWith("Window ") && !l.startsWith("NOTE:") && !l.startsWith("Screenshot"))
    .map((l) =>
      l
        .trim()
        .replace(/^\[e\d+\]\s*/, "")
        .replace(/^\|\s?/, ""),
    )
    .filter((l) => l.length > 0);
}

/** 命令输出 → 行。 */
export function commandLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

export interface LineDelta {
  added: string[];
  removed: number;
}

export function lineDelta(before: string[], after: string[]): LineDelta {
  const pool = new Map<string, number>();
  for (const l of before) pool.set(l, (pool.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else added.push(l);
  }
  let removed = 0;
  for (const n of pool.values()) removed += n;
  return { added, removed };
}
