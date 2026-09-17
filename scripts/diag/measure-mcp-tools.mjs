// 量一个 stdio MCP server 的 tools/list 载荷体积（工具定义进入 prompt 的固定成本）。
// 用法：node scripts/diag/measure-mcp-tools.mjs <server 入口 js 的绝对路径>
// 只做 initialize + tools/list，不调用任何工具（纯只读探针）。
import { spawn } from "node:child_process";

const entry = process.argv[2];
if (!entry) {
  console.error("用法: node measure-mcp-tools.mjs <server.js>");
  process.exit(2);
}

const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", () => {}); // 吞掉 server 日志，别污染输出

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});

let id = 0;
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000);
  });
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const res = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "aide-measure", version: "0" },
});
notify("notifications/initialized", {});

const list = await send("tools/list", {});
const tools = list.result?.tools ?? [];

// 每条工具：name + description + inputSchema 全序列化 = 真正进 prompt 的字节数
const rows = tools
  .map((t) => ({
    name: t.name,
    descChars: (t.description ?? "").length,
    schemaChars: JSON.stringify(t.inputSchema ?? {}).length,
  }))
  .map((r) => ({ ...r, total: r.descChars + r.schemaChars }))
  .sort((a, b) => b.total - a.total);

const totalChars = rows.reduce((s, r) => s + r.total, 0);
console.log(`server: ${res.result?.serverInfo?.name ?? "?"} v${res.result?.serverInfo?.version ?? "?"}`);
console.log(`tools: ${tools.length}`);
console.log(`instructions: ${(res.result?.instructions ?? "").length} chars`);
console.log(`TOTAL payload: ${totalChars} chars  (~${Math.round(totalChars / 4)} tok @4ch/tok, ~${Math.round(totalChars / 3)} tok @3ch/tok)`);
console.log("--- top 15 ---");
for (const r of rows.slice(0, 15)) {
  console.log(`${String(r.total).padStart(7)}  desc=${String(r.descChars).padStart(6)} schema=${String(r.schemaChars).padStart(6)}  ${r.name}`);
}

child.kill();
process.exit(0);
