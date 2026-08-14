// header/footer 部件解析：<w:hdr> / <w:ftr> → Block[]。
// 复用 body.ts 的段落/表格解析（页眉页脚里就是普通块序列），
// 部件自身的 rels（页眉里的图片）由门面传入 ctx。

import type { Block } from "../model.js";
import { findOpenTagAny, matchBlock } from "./xml.js";
import { parseBlocks, type ImageCtx } from "./body.js";

/**
 * 解析 header/footer 部件 XML（含 xml 声明与根元素）→ 块序列。
 * 先定位根元素块（跳过 `<?xml?>` 声明），再扫描根内部——直接 indexOf(">")
 * 会命中声明结尾导致根元素被当成普通块跳过。
 */
export function parseHeaderFooter(xml: string, ctx: ImageCtx): Block[] {
  const root = findOpenTagAny(xml, 0);
  if (!root) return [];
  const rootEnd = matchBlock(xml, root.at).end;
  const innerStart = xml.indexOf(">", root.at) + 1;
  return parseBlocks(xml, innerStart, rootEnd, ctx);
}
