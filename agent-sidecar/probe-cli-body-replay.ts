// 一次性探针：**把 CLI 真正发出去的 body 原样转发给真端点**。
// 动机：直连矩阵（7 组）都说 thinking.disabled 生效；但 app 里观察到的转录仍有思考块。
// 差异只可能在"CLI 多塞了什么"。所以：① 本地端点捕获 CLI 的完整请求体 → ② 原样 POST 给
// 真 deepseek（只换 URL/鉴权，body 一字不改）→ ③ 看它还推不推理。推 = 找到复现路径，再二分。
// 用法（agent-sidecar 目录）：
//   AIDE_BASE_URL=$ANTHROPIC_BASE_URL AIDE_TOKEN=$ANTHROPIC_AUTH_TOKEN npx tsx probe-cli-body-replay.ts
import http from "node:http";
import { existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

export {};
const REAL_BASE = (process.env.AIDE_BASE_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.AIDE_TOKEN ?? "";
const MODEL = process.argv[2] ?? process.env.AIDE_MODEL ?? "deepseek-flash";
/** thinking 模式（argv[3]）：disabled | adaptive。用来对照"CLI 是丢了 disabled，还是丢了整个字段"。 */
const THINK_MODE = process.argv[3] ?? "disabled";
const CAPTURE_PORT = 18795;
const DEFAULT_CLAUDE_EXE = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

let captured: string | null = null;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!req.url?.includes("/v1/messages")) { res.writeHead(200).end("{}"); return; }
    let j: Record<string, any> = {};
    try { j = JSON.parse(raw) as Record<string, any>; } catch { /* 非 JSON */ }
    // 只认真正的回合请求（带 tools），旁路小查询不要
    if ((j.tools ?? []).length > 0 && !captured) {
      captured = raw;
      console.log(`[capture] 拿到回合请求：键=${JSON.stringify(Object.keys(j))}`);
      console.log(`[capture] **body 里的 model=${JSON.stringify(j.model)}**`);
      console.log(`[capture] thinking=${JSON.stringify(j.thinking)} output_config=${JSON.stringify(j.output_config ?? null)} tools=${(j.tools ?? []).length} system长度=${JSON.stringify(j.system ?? "").length}`);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
});
server.listen(CAPTURE_PORT, "127.0.0.1");

const env: Record<string, string | undefined> = { ...process.env };
for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT|CLAUDE_AGENT_SDK|CLAUDE_PID)/.test(k)) delete env[k];
env.CLAUDE_CONFIG_DIR = process.env.USERPROFILE + "/.aide/claude";
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CAPTURE_PORT}`;
env.ANTHROPIC_API_KEY = "probe-dummy";
// 档位槽位覆盖（对应 provider 配置的 modelMappings.defaultOpusModel 等）：
// 用来验"槽位指向哪个名字"和"请求体里的名字"谁说了算。
if (process.env.AIDE_OPUS_MODEL) env.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.AIDE_OPUS_MODEL;
if (process.env.AIDE_SONNET_MODEL) env.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.AIDE_SONNET_MODEL;

console.log(`=== ① 让 CLI 对着本地端点发一轮（model=${MODEL} thinking: ${THINK_MODE}）===`);
const thinkingOpt = THINK_MODE === "adaptive" ? { type: "adaptive", display: "summarized" } : { type: "disabled" };
const q = query({
  prompt: "估算 127*349 的精确值，先心算验证两遍，再只输出最终数字。",
  options: { model: MODEL, settingSources: [], allowedTools: [], thinking: thinkingOpt as never, env, ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}) },
});
for await (const m of q as AsyncIterable<any>) { if (m.type === "result") break; }

if (!captured) { console.log("✗ 没捕获到请求（CLI 没走到回合请求）"); process.exit(1); }
server.close();

console.log("\n=== ② 原样转发给真端点（body 一字不改，只换 URL）===");
const body = captured as string;
const r = await fetch(`${REAL_BASE}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-api-key": TOKEN, "anthropic-version": "2023-06-01" },
  body,
});
if (!r.ok) { console.log(`✗ HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
const raw = await r.text();
const types = new Set<string>();
let out: unknown = "?";
let respModel = "?";
for (const line of raw.split("\n")) {
  if (!line.startsWith("data:")) continue;
  const p = line.slice(5).trim();
  if (!p || p === "[DONE]") continue;
  let ev: Record<string, any> = {};
  try { ev = JSON.parse(p) as Record<string, any>; } catch { continue; }
  const bt = ev.content_block?.type ?? (ev.delta?.type === "thinking_delta" ? "thinking" : undefined);
  if (bt) types.add(String(bt));
  if (ev.usage?.output_tokens) out = ev.usage.output_tokens;
  // 响应自报的 model（message_start 里）
  const rm = ev.message?.model;
  if (rm) respModel = String(rm);
}
const thinks = types.has("thinking");
console.log(`   响应块 = ${JSON.stringify([...types])}  output=${out}  **响应自报 model=${respModel}**`);
console.log("\n=== 判定 ===");
console.log(thinks
  ? "  ⇒ CLI 的 body 打到真端点**仍会推理** —— 复现成功，问题在 CLI 请求体里某个我们没构造的字段（下一步二分）"
  : "  ⇒ CLI 的 body 打到真端点**不推理** —— CLI 请求体没问题，差异在 app 的 spawn 参数（下一步抓 app 的真实请求）");
process.exit(0);
