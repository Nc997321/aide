// 冒烟（台账）：btw 侧问看到的对话快照有多新。真 CLI + 真 SessionManager + mock 端点。
//
// 假设：CLI 的 side_question 优先用「上一次主线程回合收尾时」存下的 cacheSafeParams
// 快照（sF()），回合进行中不刷新——主 agent 正在干活时问 btw，看不到本轮的用户消息
// 和工具结果。
//   S1 回合进行中问：侧问请求体是否含本轮用户消息（假设成立 → 不含）
//   S2 回合结束后问：侧问请求体含本轮用户消息（对照）
//   S3 回合结束后问：快照已刷新，不再拼补遗（不重复）
// 修复（btwTurnLedger 补遗）后 S1 通过；去掉补遗 S1 必挂。
// 用法（agent-sidecar 目录）：AIDE_CLAUDE_EXE=<claude 可执行> npx tsx smoke-btw-staleness.ts
import http from "node:http";
import { SessionManager } from "./src/engine/session-manager.js";
import { check, report } from "./smoke-ledger.js";

const PORT = 18798;
type Wire = { n: number; text: string; msgs: number; side: boolean; last: string };
const wire: Wire[] = [];
const flatten = (v: any): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map(flatten).join("\n") : v && typeof v === "object" ? Object.values(v).map(flatten).join("\n") : "";

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    if (!req.url?.includes("/v1/messages")) { res.writeHead(200).end("{}"); return; }
    let j: any = {};
    try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
    const msgs = j.messages ?? [];
    const lastText = flatten(msgs.at(-1));
    const info: Wire = { n: wire.length + 1, text: flatten(msgs), msgs: msgs.length, side: /BTWQ\d/.test(lastText), last: lastText };
    wire.push(info);
    // 主线程第二轮（最后一条用户消息带 BANANA）：拖 15s 再回——模拟 agent 正在长时间干活
    const slow = !info.side && (j.tools ?? []).length > 0 && lastText.includes("BANANA_NOW");
    console.log(`[wire] #${info.n} side=${info.side} msgs=${info.msgs}${slow ? " (慢回合)" : ""}`);
    if (slow) await new Promise((r) => setTimeout(r, 15_000));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: `m${info.n}`, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: info.side ? "BTW_ANSWER" : `REPLY_${info.n}` } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
});
server.listen(PORT, "127.0.0.1");

const events: any[] = [];
let realSid = "";
const mgr = new SessionManager({
  emit: (_sid: string, e: any) => {
    events.push(e);
    if (e.type === "session_init" && e.session_id) realSid = String(e.session_id);
  },
});
const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`, ANTHROPIC_API_KEY: "smoke-dummy-key", ANTHROPIC_MODEL: "claude-sonnet-5" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, cond: () => boolean, ms = 90_000) {
  for (let i = 0; i < ms / 100; i++) { if (cond()) return true; await sleep(100); }
  console.log(`[timeout] ${label}`); return false;
}
const count = (t: string) => events.filter((e) => e.type === t).length;
const send = (prompt: string) => mgr.handleCommand({ cmd: "send", session_id: realSid || "smoke-btw-stale", prompt, cwd: process.cwd(), env } as any);
const ask = (q: string) => mgr.handleCommand({ cmd: "btw_ask", session_id: realSid, question: q, history: [] } as any);
const sides = () => wire.filter((w) => w.side);

console.log(">>> 轮1：APPLE_OLD");
send("记住 APPLE_OLD，只回复 ok");
await waitFor("轮1收尾", () => count("message_stop") >= 1);
await waitFor("真实 id", () => !!realSid);
await sleep(1000);

console.log(">>> 轮2：BANANA_NOW（mock 拖 15s，模拟 agent 正在干活）");
send("现在的任务是 BANANA_NOW");
await waitFor("轮2请求已到 mock", () => wire.some((w) => !w.side && w.text.includes("BANANA_NOW")));
await sleep(2000);
console.log(">>> btw Q1（轮2 进行中）");
ask("BTWQ1 我现在让你做什么");
await waitFor("Q1 侧问请求", () => sides().length >= 1, 20_000);

await waitFor("轮2收尾", () => count("message_stop") >= 2, 60_000);
await sleep(1000);
console.log(">>> btw Q2（轮2 结束后）");
ask("BTWQ2 我现在让你做什么");
await waitFor("Q2 侧问请求", () => sides().length >= 2, 20_000);
await sleep(500);

const [q1, q2] = sides();
console.log(`\n[Q1 回合中] msgs=${q1?.msgs} 含 APPLE_OLD=${q1?.text.includes("APPLE_OLD")} 含 BANANA_NOW=${q1?.text.includes("BANANA_NOW")}`);
console.log(`[Q2 回合后] msgs=${q2?.msgs} 含 APPLE_OLD=${q2?.text.includes("APPLE_OLD")} 含 BANANA_NOW=${q2?.text.includes("BANANA_NOW")}`);
check("S1 回合进行中问：侧问看得到本轮用户消息", !!q1?.text.includes("BANANA_NOW"), `msgs=${q1?.msgs}`);
check("S2 回合结束后问：侧问看得到本轮用户消息（对照）", !!q2?.text.includes("BANANA_NOW"), `msgs=${q2?.msgs}`);
check("S3 回合结束后问：不再拼补遗（快照已刷新）", !!q2 && !q2.last.includes("[Background"), "");

mgr.handleCommand({ cmd: "session_stop", session_id: realSid } as any);
server.close();
await sleep(500);
process.exit(report() === 0 ? 0 : 1);
