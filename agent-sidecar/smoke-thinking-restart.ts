// 冒烟（台账）：思考值漂移 → 原地重启，端到端走**真 CLI + 真 SessionManager**，
// 只把 Anthropic 端点换成本地 mock（零成本抓线上请求体）。
//
// 验的是「快速 ⇒ 关思考」的下半段：SDK 没有运行时 thinking setter，只能在下一条
// send 时重建 query 用 spawn 期参数兑现。本脚本钉死四件事：
//   A1 首轮请求体 thinking = adaptive（对照基线）
//   A2 漂移后的请求体 thinking = disabled（**真关掉了**，不是展示层假装）
//   A3 漂移后的请求带回了完整历史（消息数增长）＝ resume 而非全新会话
//   A4 事件流里 session_id 始终同一个（原地；fork 换 id 会让三端 re-key）
//   A5 全程恰好两条 message_stop（两轮真实收尾）——重启自己不许伪造终态
// 用法（agent-sidecar 目录）：npx tsx smoke-thinking-restart.ts
import http from "node:http";
import { existsSync } from "node:fs";
import { SessionManager } from "./src/engine/session-manager.js";
import { check, report } from "./smoke-ledger.js";

const DEFAULT_CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
if (!process.env.AIDE_CLAUDE_EXE && existsSync(DEFAULT_CLAUDE_EXE)) {
  process.env.AIDE_CLAUDE_EXE = DEFAULT_CLAUDE_EXE;
}

const PORT = 18796;

// ---- 本地 mock Anthropic 端点：逐请求记 thinking 字段 + 消息数，SSE 回纯文本 ----
type Wire = { n: number; thinking: string; msgs: number; tools: number };
const wire: Wire[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!req.url?.includes("/v1/messages")) { res.writeHead(200).end("{}"); return; }
    let j: Record<string, any> = {};
    try { j = JSON.parse(raw) as Record<string, any>; } catch { /* 非 JSON */ }
    const info: Wire = {
      n: wire.length + 1,
      thinking: j.thinking ? JSON.stringify(j.thinking) : "(字段缺席)",
      msgs: (j.messages ?? []).length,
      tools: (j.tools ?? []).length,
    };
    wire.push(info);
    // 只打真正的回合请求：旁路小查询是「1 条消息 + 带工具」，回合请求带历史（≥2 条）
    if (info.tools > 0 && info.msgs >= 2) console.log(`[wire] 请求#${info.n} thinking=${info.thinking} 消息数=${info.msgs}`);

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: `m${info.n}`, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
});
server.listen(PORT, "127.0.0.1");

// ---- 驱动真 SessionManager ----
const events: any[] = [];
const stops: string[] = [];
let realSid = ""; // session_init 确立的真实会话 id——re-key 后这才是路由键
const initialSid = "smoke-think-restart";
const mgr = new SessionManager({
  emit: (_sid: string, e: any) => {
    events.push(e);
    if (e.type === "session_init" && e.session_id) realSid = String(e.session_id);
    if (e.type === "message_stop") stops.push(String(e.session_id ?? ""));
  },
});

const env = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  ANTHROPIC_API_KEY: "smoke-dummy-key",
  ANTHROPIC_MODEL: "claude-sonnet-5",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 回合请求 = 带工具且带历史（旁路小查询只有 1 条消息）。 */
const turnRequests = () => wire.filter((w) => w.tools > 0 && w.msgs >= 2);
async function waitFor(label: string, cond: () => boolean, ms = 90_000): Promise<boolean> {
  for (let i = 0; i < ms / 100; i++) { if (cond()) return true; await sleep(100); }
  console.log(`[timeout] ${label}`);
  return false;
}

console.log("=== 思考值漂移 → 原地重启（真 CLI + mock 端点）===");
console.log(">>> 轮1：thinking_enabled=true（对照）");
mgr.handleCommand({ cmd: "send", session_id: initialSid, prompt: "只回复：甲", cwd: process.cwd(), env, thinking_enabled: true } as any);
await waitFor("轮1请求", () => turnRequests().length >= 1);
await waitFor("轮1收尾", () => stops.length >= 1);
await waitFor("真实会话 id", () => !!realSid);
console.log(`    真实会话 id = ${realSid}`);

console.log(">>> 轮2：thinking_enabled=false（模拟用户在空闲时切到「快速」）");
mgr.handleCommand({ cmd: "send", session_id: realSid, prompt: "只回复：乙", cwd: process.cwd(), env, thinking_enabled: false } as any);
await waitFor("轮2请求", () => turnRequests().length >= 2);
await waitFor("轮2收尾", () => stops.length >= 2);
await sleep(1_000); // 让可能的额外帧落定，A5 才有意义

if (stops.length < 2) {
  console.log("[debug] 事件序列:", events.map((e) => e.type).join(","));
  console.log("[debug] error 帧:", JSON.stringify(events.filter((e) => e.type === "error")));
  console.log("[debug] 全部落到的请求:", JSON.stringify(wire.map((w) => ({ n: w.n, t: w.thinking, m: w.msgs }))));
}

const r1 = turnRequests()[0];
const r2 = turnRequests()[1];
const ids = [...new Set(events.map((e) => String(e.session_id ?? "")).filter(Boolean))];

check("A1 首轮请求体 thinking=adaptive", r1?.thinking.includes("adaptive") === true, `实际 ${r1?.thinking}`);
check("A2 漂移后请求体 thinking=disabled（真关掉）", r2?.thinking === '{"type":"disabled"}', `实际 ${r2?.thinking}`);
check("A3 漂移后带全历史（resume 而非全新会话）", (r2?.msgs ?? 0) > (r1?.msgs ?? 0), `轮1=${r1?.msgs} 轮2=${r2?.msgs} 条消息`);
check("A4 事件流 session_id 始终同一个（原地、不 fork）", ids.length === 1, `出现过的 id=${JSON.stringify(ids)}`);
check("A5 恰好两条 message_stop（重启不伪造终态）", stops.length === 2, `实际 ${stops.length} 条`);

mgr.handleCommand({ cmd: "session_stop", session_id: realSid || initialSid } as any);
server.close();
await sleep(500);
process.exit(report() === 0 ? 0 : 1);
