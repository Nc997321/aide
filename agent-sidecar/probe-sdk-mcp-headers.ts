// SDK 能力探针：验证 Claude Agent SDK query() 的 mcpServers http 配置是否把
// headers 传到 HTTP 请求（headless 会话级 token 注入的可行性验证）。
// 手动运行：npx tsx probe-sdk-mcp-headers.ts（不进测试、不改现有代码）
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";

const hits: { xProbe: string }[] = [];

// stateless MCP server：每个请求独立 transport，记录 x-probe-token 头
const mcp = new McpServer({ name: "probe-mcp", version: "0.1" });
mcp.tool("probe_tool", "probe", { x: z.string().describe("x") }, async () => ({
  content: [{ type: "text", text: "ok" }],
}));

const httpServer = createServer(async (req, res) => {
  const xProbe = req.headers["x-probe-token"] as string | undefined;
  hits.push({ xProbe: xProbe ?? "" });
  console.log(
    "[server saw]",
    JSON.stringify({
      url: req.url,
      xProbe: xProbe ?? null,
    }),
  );
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => transport.close().catch(() => {}));
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null }));
    }
  }
});

const port = await new Promise<number>((resolve) => {
  const s = httpServer.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
});

const url = `http://127.0.0.1:${port}/mcp`;
console.log("[probe] mock MCP server on", url);

// ===== 主验证：SDK query() 带 http+headers 的 mcpServers =====
// query 的迭代在 LLM 不通时不会自然结束 → 20s 后收割探针结果（MCP 连接在会话启动阶段就发生）
const q = query({
  prompt: "probe",
  options: {
    maxTurns: 1,
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "probe-not-real",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9", // LLM 端点故意不通
    },
    mcpServers: {
      probe: { type: "http", url, headers: { "X-Probe-Token": "abc123" } },
    },
  },
});
void (async () => {
  try {
    for await (const _msg of q) {
      // 消费即可，验证不依赖对话完成
    }
  } catch (e) {
    console.log("[probe] query error:", String((e as Error)?.message ?? e).slice(0, 120));
  }
})();

setTimeout(() => {
  console.log("[probe] VERDICT:", hits.length > 0 ? "SDK PASSED headers through" : "server saw nothing (SDK did not connect or did not pass headers)");
  process.exit(0);
}, 20_000);