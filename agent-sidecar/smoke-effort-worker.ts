// 活体验证：SessionManager 全链路 effort 切换（真 CLI，不走 mock）。
// 步骤：send(env 带 CLAUDE_CODE_EFFORT_LEVEL=low) → 等 message_stop 盖 effort=low 戳
//   → set_effort max → 等 effort_changed → 再 send → message_stop 应盖 effort=max。
// 同时验证 cliEnv 已剔除 CLAUDE_CODE_EFFORT_LEVEL（否则 max 会被 env 压住，第二轮仍是 low）。
// 用法（agent-sidecar 目录）：npx tsx smoke-effort-worker.ts
import { SessionManager } from "./src/session-manager.js";
import { existsSync } from "node:fs";

const DEFAULT_CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
if (!process.env.AIDE_CLAUDE_EXE && existsSync(DEFAULT_CLAUDE_EXE)) {
  process.env.AIDE_CLAUDE_EXE = DEFAULT_CLAUDE_EXE;
}

const SID = "smoke-effort-live";
let step = 0;
let realSid = SID; // session_init 后 worker re-key 成 SDK 真 ID，后续事件都带它

const mgr = new SessionManager({
  emit: (sid, e) => {
    if (e.type === "session_init") { realSid = (e as any).session_id; console.log("[event] session_init", realSid); return; }
    if (sid !== realSid) return;
    console.log(`[event] ${e.type}`, e.type === "text_delta" ? "" : JSON.stringify(e).slice(0, 200));
    if (e.type === "message_stop") {
      const u = (e as any).usage;
      console.log(`message_stop: effort=${JSON.stringify((e as any).effort)} in=${u?.inputTokens} cacheRead=${u?.cacheReadInputTokens} out=${u?.outputTokens}`);
      if (step === 0) {
        step = 1;
        console.log(">>> set_effort max");
        mgr.handleCommand({ cmd: "set_effort", session_id: realSid, effort: "max" });
      } else if (step === 2) {
        step = 3;
        console.log(">>> send #3（不切档位，验证缓存复暖）");
        mgr.handleCommand({ cmd: "send", session_id: realSid, prompt: "Reply with exactly: ok" });
      } else if (step === 3) {
        step = 4;
      }
    } else if (e.type === "effort_changed") {
      console.log("effort_changed:", JSON.stringify(e));
      if (step === 1 && !(e as any).error) {
        step = 2;
        console.log(">>> send #2");
        mgr.handleCommand({ cmd: "send", session_id: realSid, prompt: "Reply with exactly: ok" });
      }
    } else if (e.type === "error") {
      console.log("ERROR:", JSON.stringify(e));
    }
  },
});

console.log(">>> send #1 (env CLAUDE_CODE_EFFORT_LEVEL=low)");
mgr.handleCommand({
  cmd: "send",
  session_id: SID,
  prompt: "Reply with exactly: ok",
  env: {
    CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
    CLAUDE_CODE_EFFORT_LEVEL: "low",
  },
});

// 轮询等终态，避免挂死
const deadline = Date.now() + 240_000;
while (step < 4 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}
console.log(step === 4 ? "DONE" : `TIMEOUT at step ${step}`);
process.exit(step === 4 ? 0 : 1);
