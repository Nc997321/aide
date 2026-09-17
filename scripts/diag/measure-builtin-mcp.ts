// 量 Aide 内建 MCP server（codegraph/docs/knowledge/browser）的 tools/list 载荷体积
// ——即这些工具定义进入 system prompt 的固定 token 成本。
// 用法：cd agent-sidecar && npx tsx ../scripts/diag/measure-builtin-mcp.ts
// 纯只读：只构造定义，不发起任何查询。
import { buildBrowserTools } from "../../agent-sidecar/src/extensions/browserTools.js";
import { buildKnowledgeTools } from "../../agent-sidecar/src/extensions/knowledgeTools.js";
import { buildDocxTools } from "../../agent-sidecar/src/extensions/docxTools.js";
import { buildPdfTools } from "../../agent-sidecar/src/extensions/pdfTools.js";
import { codegraphMcpRegistration } from "../../agent-sidecar/src/extensions/codegraphTools.js";
import { CODEGRAPH_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/codegraphTools.js";
import { DOCS_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/docsMcp.js";
import { KNOWLEDGE_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/knowledgeMcp.js";
import { BROWSER_INSTRUCTIONS } from "../../agent-sidecar/src/extensions/browserMcp.js";

const noop = () => {};
const env = process.env;
const cwd = process.cwd();

/** codegraph 的三个工具只能从 registration 里拿（内部 createSdkMcpServer）。 */
function codegraphTools(): any[] {
  const reg = codegraphMcpRegistration(cwd, noop, env, true, true) as any;
  const inst = reg?.["aide-codegraph"]?.instance;
  const table = inst?._registeredTools ?? {};
  return Object.entries(table).map(([name, def]: [string, any]) => ({
    name,
    description: def?.description ?? "",
    inputSchema: def?.inputSchema,
  }));
}

const groups: { label: string; instructions: string; tools: any[] }[] = [
  { label: "aide-codegraph", instructions: CODEGRAPH_INSTRUCTIONS, tools: codegraphTools() },
  {
    label: "aide-docs",
    instructions: DOCS_INSTRUCTIONS,
    tools: [...buildDocxTools(cwd), ...buildPdfTools(cwd)],
  },
  { label: "aide-knowledge", instructions: KNOWLEDGE_INSTRUCTIONS, tools: buildKnowledgeTools(env, cwd) },
  { label: "aide-browser", instructions: BROWSER_INSTRUCTIONS, tools: buildBrowserTools(env, noop) },
];

/** 工具在 wire 上的形态 = {name, description, inputSchema(JSON Schema)}；
 *  zod raw shape 无法直接 JSON 化，取其字段名 + 字段描述做近似（schema 实为小头）。 */
function schemaChars(t: any): number {
  const raw = t?.inputSchema;
  if (!raw || typeof raw !== "object") return 0;
  if (typeof raw.toJSON === "function") return JSON.stringify(raw.toJSON()).length;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    n += k.length + (typeof (v as any)?.description === "string" ? (v as any).description.length : 0);
    // zod 内部 _def.typeName / 字段数：粗算 type 关键字开销
    n += 12;
  }
  return n;
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

