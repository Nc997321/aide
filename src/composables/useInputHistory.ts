/**
 * 输入框发送历史（终端式 ↑/↓ 回溯）。
 *
 * 条目只住内存、整个窗口共用一份（跟终端一样不分会话）；只记正文文本，
 * 引用芯片 / 图片不在其中。游标每个输入框各持一份。
 */
const MAX_ENTRIES = 100;
const entries: string[] = [];

/** 记一条已发出的内容；空白与紧邻重复不记。 */
export function pushInputHistory(text: string): void {
  const t = text.trim();
  if (!t || entries[entries.length - 1] === t) return;
  entries.push(t);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** 仅测试用：清空历史。 */
export function resetInputHistory(): void {
  entries.length = 0;
}

export function useInputHistory() {
  /** 正在看第几条；null = 没在回溯。 */
  let index: number | null = null;
  /** 开始回溯那一刻输入框里的内容，↓ 翻过最新一条时还回去。 */
  let stash = "";

  /** 上一条；没有更早的了返回 null（调用方不拦按键）。 */
  function prev(current: string): string | null {
    if (index === null) {
      if (!entries.length) return null;
      stash = current;
      index = entries.length - 1;
    } else if (index > 0) {
      index--;
    } else {
      return null;
    }
    return entries[index] ?? null;
  }

  /** 下一条；翻过最新一条 = 回到回溯前的内容。没在回溯返回 null。 */
  function next(): string | null {
    if (index === null) return null;
    if (index < entries.length - 1) {
      index++;
      return entries[index] ?? null;
    }
    index = null;
    return stash;
  }

  /** 用户动手改了内容 / 发出去了：结束回溯。 */
  function reset(): void {
    index = null;
  }

  return { prev, next, reset, browsing: () => index !== null };
}
