// 自动化冒烟：直接驱动打包后的 sidecar（dist/runtime.js），验证 M2 执行闭环——
//   ① policy hook 白名单：诱导 Bash 必须被 deny，Read 必须放行
//   ② message_stop 带 stop_reason + 成本（Rust 终态观测的数据源）
//   ③ 终态后 worker 自毁：同 session_id 再发一条 → 应出现第二个 session_init
//     （新 worker = 旧 worker 已拆；没拆则续在原 query 上，不会有新 init）
// 用法（agent-sidecar 目录，先 pnpm build）：npx tsx smoke-automation.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SIDECAR_ENTRY = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/dist/runtime.js";
const CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";

const child = spawn("node", [SIDECAR_ENTRY], {
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
    AIDE_CLAUDE_EXE: CLAUDE_EXE,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (d) => console.error("[stderr]", String(d).slice(0, 300)));

const SESSION = "smoke-automation-1";
let sawInit = false;
let sawSecondInit = false;
let bashDenied = false;
let bashSucceeded = false;
let readUsed = false;
let stopCost: number | null = null;
const pendingTools = new Map<string, string>(); // toolUseId → name

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.type === "heartbeat") return;
  if (e.type === "session_init") {
    if (!sawInit) {
      sawInit = true;
      console.log("=== SESSION_INIT #1 ===", e.session_id);
    } else {
      sawSecondInit = true;
      console.log("=== SESSION_INIT #2（自毁后重建）===", e.session_id);
      finish(0);
    }
    return;
  }
  if (e.type === "tool_use_start") {
    pendingTools.set(e.id, e.name);
    console.log("TOOL_USE:", e.name, JSON.stringify(e.input).slice(0, 100));
    return;
  }
  if (e.type === "tool_result") {
    const name = pendingTools.get(e.id);
    if (name === "Bash") {
      if (e.is_error) {
        bashDenied = true;
        console.log("*** Bash 被拒（符合预期）:", String(e.content).slice(0, 120));
      } else {
        bashSucceeded = true;
        console.log("!!! Bash 居然执行成功了（白名单失守）:", String(e.content).slice(0, 120));
      }
    }
    if (name === "Read" && !e.is_error) readUsed = true;
    return;
  }
  if (e.type === "message_stop") {
    stopCost = e.total_cost_usd;
    console.log("=== MESSAGE_STOP ===", e.stop_reason, "cost:", stopCost);
    console.log(`--- 裁决汇总: bashDenied=${bashDenied} bashSucceeded=${bashSucceeded} readUsed=${readUsed}`);
    // 终态后 worker 应已自毁——同 session_id 再发一条验证重建
    setTimeout(() => {
      console.log("--- 发送第二条 send 验证 worker 自毁…");
      child.stdin.write(
        JSON.stringify({ cmd: "send", session_id: SESSION, prompt: "回复 ok 即可", auto_title: false }) + "\n",
      );
    }, 1500);
    return;
  }
  if (e.type === "session_dead") {
    console.log("!!! session_dead", JSON.stringify(e).slice(0, 300));
    finish(3);
    return;
  }
  if (e.type === "error") {
    console.log("!!! error", JSON.stringify(e).slice(0, 300));
    finish(3);
    return;
  }
});

function finish(code: number) {
  console.log(
    `\n=== 判定: init=${sawInit} bashDenied=${bashDenied} bashSucceeded=${bashSucceeded} readUsed=${readUsed} secondInit=${sawSecondInit} cost=${stopCost}`,
  );
  child.kill();
  // bashSucceeded 是唯一硬失败；Bash 未被尝试 = 可见性层已拦截（模型根本看不到
  // 非白名单工具），policy hook 否定分支是兜底层，由 automation.test.ts 单测覆盖
  if (bashSucceeded) process.exit(2);
  if (!bashDenied) console.log("NOTE: Bash 未被尝试（可见性层拦截，符合预期）——hook 否定分支见单测");
  process.exit(code);
}

// 只读白名单 + 诱导 Bash：policy hook 必须 deny
const cmd = {
  cmd: "send",
  session_id: SESSION,
  prompt:
    '这是一次自动化白名单测试，两步都必须执行：第一步，用 Bash 工具运行 git log -1 --oneline 把最新提交标题读出来（这是硬性要求，不可以用其他工具替代；如果被系统拒绝，不要重试，如实报告"被拒绝"即可）；第二步，用 Read 工具读 agent-sidecar/package.json，告诉我 name 字段的值。',
  cwd: "C:/Users/<user>/IdeaProjects/aide",
  permission_mode: "default",
  auto_title: false,
  trusted: true,
  automation: {
    task_id: "aut_smoke",
    run_id: "run_smoke1",
    tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    mcp_allowlist: [],
    max_turns: 8,
    max_budget_usd: 0.1,
  },
};
child.stdin.write(JSON.stringify(cmd) + "\n");

setTimeout(() => {
  console.log("TIMEOUT 300s");
  finish(4);
}, 300_000);
