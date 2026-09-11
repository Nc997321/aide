// 端到端验收：headless 宿主 + 会话级 MCP 头注入（机制①第 3/4 步）。
// 链路：POST /invoke send(mcp_headers) → SessionWorker.startLoop → applyMcpHeaders
//       → SDK query() mcpServers → mock MCP http server 收到注入头。
// 手动运行：npx tsx smoke-headless-mcp-headers.ts
// 前提：npm run build（跑的是 dist/runtime.js 真实产物）；本机 claude.exe 可解析。
// LLM 端点故意不通（ANTHROPIC_BASE_URL=127.0.0.1:9）——MCP 连接发生在会话启动
// 阶段，不依赖 LLM 可达（同 probe-sdk-mcp-headers.ts 的验证方式）。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TENANT_VALUE = "smoke-acme-42";
const headlessPort = 18099;

// ---- mock MCP http server：记录到达的注入头（任何请求都记，握手成败无关） ----
const hits: string[] = [];
const mcpHttp = createServer((req, res) => {
  const v = req.headers["x-tenant-token"];
  if (typeof v === "string") hits.push(v);
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
const mcpPort = await new Promise<number>((resolve) => {
  mcpHttp.listen(0, "127.0.0.1", () => resolve((mcpHttp.address() as { port: number }).port));
});

// ---- 临时配置根：settings.json 提供 http 型 user MCP server ----
const configDir = mkdtempSync(join(tmpdir(), "aide-headless-smoke-"));
writeFileSync(
  join(configDir, "settings.json"),
  JSON.stringify({
    mcpServers: { bizsmoke: { type: "http", url: `http://127.0.0.1:${mcpPort}/mcp` } },
  }),
);

// ---- 拉起 headless 宿主，等 listening 行 ----
const runtime = spawn(process.execPath, ["dist/runtime.js", "headless"], {
  env: {
    ...process.env,
    AIDE_HEADLESS_PORT: String(headlessPort),
    CLAUDE_CONFIG_DIR: configDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
runtime.stdout.on("data", (d: Buffer) => process.stdout.write(`[runtime] ${d}`));
runtime.stderr.on("data", (d: Buffer) => process.stderr.write(`[runtime:err] ${d}`));

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("headless-listening timeout")), 15_000);
  runtime.stdout.on("data", (d: Buffer) => {
    if (d.toString().includes("headless-listening")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

// ---- 发送带 mcp_headers 的 send ----
const base = `http://127.0.0.1:${headlessPort}`;
const res = await fetch(`${base}/invoke`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    cmd: "send",
    session_id: "smoke-1",
    prompt: "hi",
    cwd: configDir,
    env: { ANTHROPIC_API_KEY: "smoke-not-real", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
    mcp_headers: { bizsmoke: { "X-Tenant-Token": TENANT_VALUE } },
  }),
});
console.log("[smoke] invoke status:", res.status, JSON.stringify(await res.json()));

// ---- 轮询 mock server 命中（CLI spawn + MCP 连接需要几秒） ----
const deadline = Date.now() + 45_000;
while (Date.now() < deadline && hits.length === 0) {
  await new Promise((r) => setTimeout(r, 500));
}

const pass = hits.includes(TENANT_VALUE);
console.log(`[smoke] VERDICT: ${pass ? "PASS — 注入头到达 MCP server" : `FAIL — hits=${JSON.stringify(hits)}`}`);

// ---- 清理：先等 runtime 退出（其子进程 claude CLI 的 cwd 在 configDir 里，
//      不退干净就删会 EPERM），再删临时目录（带重试兜底 Windows 文件锁） ----
runtime.kill("SIGTERM");
await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 5_000); // 等不到 exit 也继续清理
  runtime.once("exit", () => { clearTimeout(timer); resolve(); });
});
mcpHttp.close();
try {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (e) {
  // claude CLI 孙进程可能仍持转录句柄（CLAUDE_CONFIG_DIR 下）——best-effort，
  // 残留不翻转验收判定，如实报路径由 OS 临时目录策略兜底。
  console.log(`[smoke] 临时目录清理未完成（不影响判定）: ${configDir} — ${String((e as Error)?.message ?? e).slice(0, 80)}`);
}
process.exit(pass ? 0 : 1);
