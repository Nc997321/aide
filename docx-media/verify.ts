import { readFileSync, writeFileSync } from "node:fs";
import { parseDocx } from "C:/document/owner/cypress-agent/agent-sidecar/src/docx/parse/index.js";
import { modelToMarkdown } from "C:/document/owner/cypress-agent/agent-sidecar/src/docx/md/toMarkdown.js";

const buf = readFileSync("C:\document\工作\docs\项目\蒲城石坡镇\等保\身份鉴别整改材料（修订版）-优化版.docx");
const res = parseDocx(buf, { images: "placeholder" });
if (!res.ok) { console.error(res.detail); process.exit(1); }
const md = modelToMarkdown(res.doc, { images: "placeholder" });
writeFileSync("docx-media/verify.md", md, "utf-8");
console.log("written", md.length);
