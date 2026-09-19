// 一次性探针：`CLAUDE_CODE_EXTRA_BODY` 能不能把 `thinking` 塞进 CLI 真正发出去的请求体？
//
// 动机：CLI 对**它不认识的模型名**整个丢掉 `thinking` 字段（见 discussions/2026-09-19 的 F2），
// 而「把 ANTHROPIC_MODEL 换成 Claude 名」（方案 A）会锁死选型、还需供应商配合。若 EXTRA_BODY 能
// 直接改写 body，则方案 B（本地透传代理）整个不需要——它就只是 cliEnv.ts 里的一行 env。
//
// 零上游成本：只在本机捕获请求体，**从不转发给真端点**。返回 canned SSE 让 CLI 自己收尾。
//
// 用法（agent-sidecar 目录）：npx tsx probe-extra-body.ts
// 注意：在 Claude Code 会话里跑必须清继承 env（下面的 scrub 已覆盖，shell 层再 env -u 一层更稳）。
import http from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

export {};

const DEFAULT_CLAUDE_EXE =
  process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);
/** 独立的配置目录：别把探针会话写进用户真实的 ~/.aide/claude。 */
const PROBE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "aide-probe-extra-body-"));

type ThinkMode = "disabled" | "adaptive";
interface Arm {
  id: string;
  model: string;
  thinkMode: ThinkMode;
  /** 原样写进 CLAUDE_CODE_EXTRA_BODY；不给就不设该 env。 */
  extraBody?: string;
  note: string;
}

const ARMS: Arm[] = [
  { id: "A", model: "claude-sonnet-5", thinkMode: "disabled", note: "正对照：harness 能否看见 thinking" },
  { id: "B", model: "deepseek-flash", thinkMode: "disabled", note: "复现 F2：陌生名字丢字段" },
  { id: "C", model: "deepseek-flash", thinkMode: "disabled", extraBody: '{"top_k":42}', note: "对照：EXTRA_BODY 到底摊不摊进 body" },
  { id: "D", model: "deepseek-flash", thinkMode: "disabled", extraBody: '{"thinking":{"type":"disabled"}}', note: "★ 本命问题" },
  { id: "E", model: "deepseek-flash", thinkMode: "adaptive", extraBody: '{"thinking":{"type":"disabled"}}', note: "合并次序：SDK 要 adaptive 时谁盖谁" },
];

const captures: string[] = [];

/** 起本地捕获端点，返回真实端口。带 tools 的才算回合请求（旁路小查询不算）。 */
function startCaptureServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url?.includes("/v1/messages")) {
        try {
          const j = JSON.parse(raw) as { tools?: unknown[] };
          if ((j.tools ?? []).length > 0) captures.push(raw);
        } catch {
          /* 非 JSON，忽略 */
        }
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (t: string, d: unknown) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
      const model = "probe-model";
      ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
      ev("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** 清掉继承的 Claude/Anthropic env，只留探针自己指定的那几个。 */
function buildArmEnv(port: number, arm: Arm): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC|CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT|CLAUDE_AGENT_SDK|CLAUDE_PID)/.test(k)) delete env[k];
  }
  env.CLAUDE_CONFIG_DIR = PROBE_CONFIG_DIR;
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_API_KEY = "probe-dummy";
  if (arm.extraBody) env.CLAUDE_CODE_EXTRA_BODY = arm.extraBody;
  return env;
}

async function runArm(port: number, arm: Arm): Promise<string | null> {
  const before = captures.length;
  const thinking = arm.thinkMode === "adaptive" ? { type: "adaptive", display: "summarized" } : { type: "disabled" };
  const q = query({
    prompt: "估算 127*349 的精确值，先心算验证两遍，再只输出最终数字。",
    options: {
      model: arm.model,
      settingSources: [],
      allowedTools: [],
      thinking: thinking as never,
      env: buildArmEnv(port, arm),
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    },
  });
  for await (const m of q as AsyncIterable<{ type: string }>) {
    if (m.type === "result") break;
  }
  return captures.slice(before).at(-1) ?? null;
}

function report(arm: Arm, raw: string | null): void {
  const head = `[${arm.id}] model=${arm.model} sdk_thinking=${arm.thinkMode} extra=${arm.extraBody ?? "-"}`;
  if (!raw) {
    console.log(`${head}\n     ✗ 没捕获到回合请求（CLI 没走到 /v1/messages）`);
    return;
  }
  const j = JSON.parse(raw) as { model?: unknown; thinking?: unknown; top_k?: unknown };
  console.log(`${head}\n     body: model=${JSON.stringify(j.model)} thinking=${JSON.stringify(j.thinking ?? null)} top_k=${JSON.stringify(j.top_k ?? null)}`);
}

const port = await startCaptureServer();
console.log(`本地捕获端点 127.0.0.1:${port}（不转发上游）；CLAUDE_CONFIG_DIR=${PROBE_CONFIG_DIR}\n`);
for (const arm of ARMS) {
  console.log(`--- ${arm.id}: ${arm.note}`);
  report(arm, await runArm(port, arm));
}
console.log("\n=== 判读 ===\nA 有 thinking / B 无 ⇒ harness 与 F2 都对；C 有 top_k ⇒ 摊进 body 成立；\nD 有 thinking ⇒ EXTRA_BODY 就是方案 B 的免代理替代；E 决定 env 泄漏时会不会吃掉 adaptive。");
process.exit(0);
