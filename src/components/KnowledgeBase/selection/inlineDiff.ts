/**
 * 原文 ↔ 新文的行内对照：去掉共同前缀与后缀，只把中间不同的一截标成「删 / 增」。
 * 卡片里 AI 要改圈选的那一段时，用户要看清「具体动了哪几个字」，而不是对着两整段自己找不同。
 */
export interface InlineDiff {
  same1: string;
  del: string;
  ins: string;
  same2: string;
}

export function inlineDiff(before: string, after: string): InlineDiff {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return {
    same1: before.slice(0, p),
    del: before.slice(p, before.length - s),
    ins: after.slice(p, after.length - s),
    same2: before.slice(before.length - s),
  };
}
