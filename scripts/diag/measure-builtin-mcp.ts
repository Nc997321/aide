// 量 Aide 内建 MCP server（docs/knowledge/browser）的 tools/list 载荷体积
// ——即这些工具定义进入 system prompt 的固定 token 成本。
// 用法：cd agent-sidecar && npx tsx ../scripts/diag/measure-builtin-mcp.ts
// 纯只读：只构造定义，不发起任何查询。
//
// 基线（2026-09-23，换成真 JSON Schema 量尺后重量的第一版；当天收官后重量过一次）：
//   aide-browser 9 个工具 payload ≈3524 tok + instructions ≈1804 tok = ≈5328 tok；
//   内建四 server 合计 ≈9824 tok。
//   browser_network desc+schema 1077c≈299 tok、browser_console 1063c≈295 tok，合计 ≈594 tok
//   （预算红线 600，未超——余量只剩 6，动这两条 description 前先重新量）。
//   ⚠️ 收官前那一版量到的是 payload ≈3459 / ≈5263 / ≈9759：差的 ≈65 tok 全来自同一批的
//   **描述措辞**改动（`browser_read` 的 Raw text 一句、`include_hidden` 与截图 `text` 的说明），
//   不是代码落进来的成本——**改描述就要重量**，别拿旧数对账。
// ⚠️ 更早的数字是用旧 `schemaChars()` 量的（schema 那一半低估约 1.5×），**不许与新数字并列比较**。
import { buildBrowserTools } from "../../agent-sidecar/src/extensions/browserTools.js";
import { buildKnowledgeTools } from "../../agent-sidecar/src/extensions/knowledgeTools.js";
import { buildDocxTools } from "../../agent-sidecar/src/extensions/docxTools.js";
import { buildPdfTools } from "../../agent-sidecar/src/extensions/pdfTools.js";
import { DOCS_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/docsMcp.js";
import { KNOWLEDGE_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/knowledgeMcp.js";
import { BROWSER_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/browserMcp.js";
import { createRequire } from "node:module";

// zod 是 **agent-sidecar 的依赖**，本脚本住在仓库根、根 node_modules 里没有 zod：裸 `import
// { z } from "zod"` 在这里是 ERR_MODULE_NOT_FOUND（实测）。锚在 agent-sidecar 的 package.json
// 上解析，与上面那几行 `../../agent-sidecar/src/…` 同一口径——这个脚本量的是 sidecar 的工具，
// 依赖也从 sidecar 取。
const { z } = createRequire(new URL("../../agent-sidecar/package.json", import.meta.url))("zod");

const noop = () => {};
const env = process.env;
const cwd = process.cwd();

const groups: { label: string; instructions: string; tools: any[] }[] = [
  {
    label: "aide-docs",
    instructions: DOCS_INSTRUCTIONS,
    tools: [...buildDocxTools(cwd), ...buildPdfTools(cwd)],
  },
  { label: "aide-knowledge", instructions: KNOWLEDGE_INSTRUCTIONS, tools: buildKnowledgeTools(env, cwd) },
  { label: "aide-browser", instructions: BROWSER_INSTRUCTIONS, tools: buildBrowserTools(env, noop) },
];

/**
 * 工具在 wire 上的形态 = {name, description, inputSchema(JSON Schema)}（SDK 发出去的就是这个）。
 *
 * ⚠️ 上一版把 zod raw shape 数成「字段名 + 字段描述（每个字段 +12 字）」并注释"schema 实为小头"
 * ——**实测低估 1.55×**：raw shape 里每个字段的 describe / optional / enum / 类型字面量都会进
 * JSON Schema，还带一个 `$schema` 头。量预算的尺偏小，等于此后每个人都拿偏小的数做决策
 * （`browser_network` / `browser_console` 的 600 token 红线就是这么量出来的），所以换成真 schema。
 */
function schemaChars(t: any): number {
  const raw = t?.inputSchema;
  if (!raw || typeof raw !== "object") return 0;
  try {
    return JSON.stringify(z.toJSONSchema(z.object(raw))).length;
  } catch {
    // 非 zod raw shape（理论上不该有）——退化成字段名 + 描述长度，并让数字明显偏小
    return Object.entries(raw as Record<string, any>).reduce(
      (n, [k, v]) => n + k.length + (typeof (v as any)?.description === "string" ? (v as any).description.length : 0),
      0,
    );
  }
}

/** 粗略 token 估算：CJK ~1.5 字/tok，其余 ~3.6 字/tok（比固定 4 字/tok 靠谱，
 *  内建工具的描述有大量中文段落，固定比值会明显低估）。 */
function estTokens(s: string): number {
  const cjk = (s.match(/[㐀-鿿　-〿＀-￯]/g) ?? []).length;
  return Math.round(cjk / 1.5 + (s.length - cjk) / 3.6);
}

let grand = 0;
for (const g of groups) {
  const rows = g.tools
    .map((t) => ({
      name: t?.name ?? "<anon>",
      desc: typeof t?.description === "string" ? t.description.length : 0,
      schema: schemaChars(t),
    }))
    .sort((a, b) => b.desc + b.schema - (a.desc + a.schema));
  const toolChars = rows.reduce((s, r) => s + r.desc + r.schema, 0);
  grand += estTokens(g.instructions) + estTokens("x".repeat(toolChars));
  console.log(
    `\n[${g.label}] tools=${rows.length}  toolPayload=${toolChars}c  instructions=${g.instructions.length}c  ≈${estTokens(g.instructions)} + ≈${estTokens("x".repeat(toolChars))} tok`,
  );
  for (const r of rows) {
    console.log(`    desc=${String(r.desc).padStart(5)} schema≈${String(r.schema).padStart(4)}  ${r.name}`);
  }
}
console.log(`\n=== 内建四 server 合计 ≈ ${grand} tok ===`);

