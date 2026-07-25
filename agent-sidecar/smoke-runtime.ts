// 冒烟：直接驱动打包后的 sidecar（dist/runtime.js），复刻 Rust 的 send 路径，
// 验证会话能否起来 + mcp__aide-codegraph__* 是否被模型调用。
// 用法（agent-sidecar 目录）：npx tsx smoke-runtime.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDEcar_ENTRY = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/dist/runtime.js";
const CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";

const child = spawn("node", [SIDEcar_ENTRY], {
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
    AIDE_CLAUDE_EXE: CLAUDE_EXE,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (d) => console.error("[stderr]", String(d).slice(0, 500)));

const rl = createInterface({ input: child.stdout });
const toolCounts = new Map<string, number>();
let sawInit = false;
rl.on("line", (line) => {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    console.log("[non-json]", line.slice(0, 200));
    return;
  }
  if (e.type === "heartbeat") return;
  if (e.type === "session_init") {
    sawInit = true;
    console.log("=== SESSION_INIT ===", e.session_id);
    return;
  }
  if (e.type === "tool_use_start") {
    toolCounts.set(e.name, (toolCounts.get(e.name) ?? 0) + 1);
    console.log("TOOL_USE:", e.name, JSON.stringify(e.input).slice(0, 120));
    return;
  }
  if (e.type === "message_stop") {
    console.log("=== MESSAGE_STOP ===", e.stop_reason, "cost:", e.total_cost_usd);
    console.log("=== TOOL HISTOGRAM ===", Object.fromEntries(toolCounts));
    child.kill();
    process.exit(sawInit ? 0 : 2);
  }
  if (e.type === "session_dead" || e.type === "error") {
    console.log("!!!", e.type, JSON.stringify(e).slice(0, 400));
    child.kill();
    process.exit(3);
  }
  // codegraph_query 事件是工具被调用的直接证据
  if (e.type === "codegraph_query") {
    console.log("*** CODEGRAPH_QUERY:", e.tool, JSON.stringify(e.args));
    return;
  }
});

// 与 Rust 同形状：prompt 直接点名用工具，降低模型自由度
const cmd = {
  cmd: "send",
  session_id: "smoke-runtime-2",
  // 与用户 A/B 臂 A 逐字相同的自然语言 prompt
  prompt: "理清 aide 权限弹窗从 canUseTool 到用户点击的完整链路",
  cwd: "C:/Users/<user>/IdeaProjects/aide",
  env: {},
};
child.stdin.write(JSON.stringify(cmd) + "\n");

setTimeout(() => {
  console.log("TIMEOUT 600s — no message_stop; sawInit =", sawInit);
  console.log("=== TOOL HISTOGRAM ===", Object.fromEntries(toolCounts));
  child.kill();
  process.exit(4);
}, 600_000);
