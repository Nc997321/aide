/** 用户主动提供的文档作为输入解析；不向模型注册任何文件工具。 */
import { open } from "node:fs/promises";
import { extname } from "node:path";
import type { SidecarCommand } from "../engine/types.js";
import { parseDocx, DOCX_MAX_BYTES } from "./docx/parse.js";
import { parsePdf, PDF_MAX_BYTES } from "./pdf/parse.js";
type Send = Extract<SidecarCommand, { cmd: "send" }>;
export async function prepareInputDocuments(cmd: Send): Promise<Send> {
  if (!cmd.input_documents?.length) return cmd;
  const sections: string[] = [];
  const display = cmd.display?.map(block => ({ ...block }));
  const paths = [...new Set(cmd.input_documents)];
  if (paths.length > 8) throw new Error("每条消息最多添加 8 份 PDF / DOCX 文档");
  let total = 0;
  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    if (ext !== ".pdf" && ext !== ".docx") throw new Error("附件解析仅支持 PDF / DOCX");
    const file = await open(path, "r");
    let buffer: Buffer;
    try {
      const stat = await file.stat();
      const limit = ext === ".pdf" ? PDF_MAX_BYTES : DOCX_MAX_BYTES;
      if (!stat.isFile() || stat.size > limit) throw new Error(`附件过大或不是文件：${path}`);
      buffer = await file.readFile();
    } finally { await file.close(); }
    const result = ext === ".pdf" ? await parsePdf(buffer, { pageLimit: 100 }) : await parseDocx(buffer);
    if (!result.ok) throw new Error(`附件解析失败：${path}（${result.reason}: ${result.detail}）`);
    if (result.mode !== "markdown") throw new Error("附件解析未返回正文");
    let content = result.markdown;
    if (ext === ".pdf" && "pages" in result.meta) {
      const meta = result.meta;
      if (meta.readPages < meta.pages) content += `\n[仅解析了 ${meta.readPages}/${meta.pages} 页，其余页未提供]`;
      if (meta.scannedPages) content += `\n[${meta.scannedPages} 页没有文字层，需要 OCR；当前未提取这些页面的文字]`;
    }
    if (result.truncated) content += "\n[文档内容已达到解析长度上限，后续内容未提供]";
    total += content.length;
    if (total > 120_000) throw new Error("文档总内容过长，请减少附件或拆分后发送");
    sections.push(`--- 用户提供的文档：${path} ---\n${content}\n--- 文档结束 ---`);
    for (const block of display ?? []) {
      if (block.type === "mention" && block.path === path) block.content = content;
    }
  }
  return { ...cmd, prompt: [cmd.prompt, ...sections].join("\n\n"), display, input_documents: undefined };
}
