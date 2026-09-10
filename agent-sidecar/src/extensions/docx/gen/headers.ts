// IR 页眉页脚 → docx 库 Header/Footer 节点。
// 页眉页脚 children 不接受 TableOfContents（文档级块），需过滤；
// type 槽位（default/first/even）由门面按对象键组装。

import { Footer, Header } from "docx";
import type { HeaderFooter as IRHeaderFooter } from "../model.js";
import { blocksToDocx, withoutToc, type GenCtx } from "./body.js";

/** IR 页眉 → docx Header */
export function headerToDocx(hf: IRHeaderFooter, ctx: GenCtx): Header {
  return new Header({ children: withoutToc(blocksToDocx(hf.blocks, ctx)) });
}

/** IR 页脚 → docx Footer */
export function footerToDocx(hf: IRHeaderFooter, ctx: GenCtx): Footer {
  return new Footer({ children: withoutToc(blocksToDocx(hf.blocks, ctx)) });
}
