// 一次性生成脚本：用修复后的 src 代码生成优化版 docx（绕过运行中的旧 MCP 工具）
import { readFileSync, writeFileSync } from "node:fs";
import { markdownToModel } from "../agent-sidecar/src/docx/md/toModel.js";
import { modelToDocxBuffer } from "../agent-sidecar/src/docx/gen/index.js";

const md = readFileSync(new URL("./doc.md", import.meta.url), "utf-8");
const parsed = markdownToModel(md, { cwd: "C:\\document\\owner\\cypress-agent" });
if (!parsed.ok) {
  console.error("markdownToModel failed:", parsed.detail);
  process.exit(1);
}
const buffer = await modelToDocxBuffer(parsed.doc);
const out = "C:\\document\\工作\\docs\\项目\\蒲城石坡镇\\等保\\身份鉴别整改材料（修订版）-优化版.docx";
writeFileSync(out, buffer);
console.log(
  `Wrote ${parsed.paragraphs} paragraphs, ${parsed.images} images, ${parsed.skippedImages} skipped. Bytes: ${buffer.length}`,
);
