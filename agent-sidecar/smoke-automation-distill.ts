// 蒸馏冒烟（M4）：验证「运行 → resume 蒸馏 → playbook.md 落盘」全链路。
// 关键点：蒸馏轮 resume 的是一个 worker 已自毁的会话（resume 语义由 SDK 保证），
// 且蒸馏要写任务目录（cwd 之外）——auto 模式下靠 hook 的任务目录写例外放行。
// 用法（agent-sidecar 目录，先构建 dist）：npx tsx smoke-automation-distill.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SIDECAR_ENTRY = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/dist/runtime.js";
const CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";

const TASK_DIR = join(tmpdir(), "aide-automation-distill-smoke");
rmSync(TASK_DIR, { recursive: true, force: true });
mkdirSync(join(TASK_DIR, "scripts"), { recursive: true });
const PLAYBOOK = join(TASK_DIR, "playbook.md");

const child = spawn("node", [SIDECAR_ENTRY], {
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
    AIDE_CLAUDE_EXE: CLAUDE_EXE,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => console.error("[stderr]", String(d).slice(0, 300)));

const RUN_SID = "smoke-distill-run";
const DISTILL_SID = RUN_SID + "-d";
let phase: "run" | "distill" = "run";
let runCost: number | null = null;
let distillCost: number | null = null;
// SDK 真实会话 id（session_init 时坐实）——resume 的目标是它，不是我们的路由键
let sdkSessionId: string | null = null;
// 蒸馏轮 fork 断言结果（session_init 时判定）
let distillForkOk: boolean | null = null;

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
    console.log(`INIT [${phase}]`, e.session_id);
    if (phase === "run") sdkSessionId = e.session_id;
    if (phase === "distill") {
      // fork 语义断言：蒸馏必须是全新会话 id——同 id 意味着还在共享运行会话，
      // 发往运行会话的命令（关 tab 的 session_stop 等）会误杀蒸馏（2026-08-23 实锤）
      distillForkOk = e.session_id !== sdkSessionId;
      console.log(distillForkOk ? "FORK OK（蒸馏=新会话 id）" : "!!! FORK 失效：蒸馏与运行同会话 id");
    }
    return;
  }
  if (e.type === "tool_use_start") {
    console.log(`TOOL [${phase}]:`, e.name, JSON.stringify(e.input).slice(0, 110));
    return;
  }
  if (e.type === "message_stop") {
    if (phase === "run") {
      runCost = e.total_cost_usd;
      console.log("=== RUN STOP ===", e.stop_reason, "cost:", runCost);
      // 运行终态（worker 自毁）后发起蒸馏：resume 运行会话（SDK 真实 id），写任务目录
      phase = "distill";
      setTimeout(() => {
        console.log("--- 发起蒸馏轮（resume", sdkSessionId, "）…");
        child.stdin.write(JSON.stringify(distillCmd()) + "\n");
      }, 1500);
    } else {
      distillCost = e.total_cost_usd;
      console.log("=== DISTILL STOP ===", e.stop_reason, "cost:", distillCost);
      finish();
    }
    return;
  }
  if (e.type === "session_dead" || e.type === "error") {
    console.log("!!!", e.type, JSON.stringify(e).slice(0, 400));
    finish(3);
  }
});

function automation(runId: string) {
  return {
    task_id: "aut_smoke",
    run_id: runId,
    preset: "auto",
    tools: ["*"],
    mcp_allowlist: [],
    task_dir: TASK_DIR,
    max_turns: phase === "distill" ? 15 : 8,
    max_budget_usd: 0.3,
    // 蒸馏轮 fork 成新 SDK 会话（隔离运行会话 id，防误杀）
    ...(phase === "distill" ? { fork: true } : {}),
  };
}

function distillCmd() {
  return {
    cmd: "send",
    session_id: DISTILL_SID,
    resume_session_id: sdkSessionId,
    cwd: "C:/Users/<user>/IdeaProjects/aide",
    trusted: true,
    permission_mode: "auto",
    auto_title: false,
    automation: automation(DISTILL_SID),
    prompt:
      `[自动化系统] 你刚才完成了一次自动化任务运行。现在不要继续执行任务本身，而是做「执行手册蒸馏」。\n\n` +
      `回顾你刚才完成这个任务的过程，把可复用的执行步骤提炼出来：\n` +
      `1. 用 Write 把手册写到 ${PLAYBOOK}——面向一个完全没有本次记忆的会话写：步骤化（先做什么、再做什么、产出什么格式）\n` +
      `2. 手册控制在 200 行以内\n\n完成后回复一句话说明写了哪些文件。`,
  };
}

function finish(code = 0) {
  const produced = existsSync(PLAYBOOK) && statSync(PLAYBOOK).size > 0;
  console.log(`\n=== 判定: runCost=${runCost} distillCost=${distillCost} fork=${distillForkOk ? "OK" : "失效/未到蒸馏"} playbook=${produced ? `已生成（${statSync(PLAYBOOK).size}B）` : "未生成"}`);
  if (produced) console.log("路径:", PLAYBOOK);
  child.kill();
  const failed = code !== 0 || !produced || distillForkOk !== true;
  process.exit(failed ? (code || 2) : 0);
}

child.stdin.write(
  JSON.stringify({
    cmd: "send",
    session_id: RUN_SID,
    cwd: "C:/Users/<user>/IdeaProjects/aide",
    trusted: true,
    permission_mode: "auto",
    auto_title: false,
    automation: automation(RUN_SID),
    prompt:
      "用 Read 读 agent-sidecar/package.json，然后用 Glob 列出 agent-sidecar/src 下的 .ts 文件数量，最后报告：包名、版本、src 下 ts 文件数。",
  }) + "\n",
);

setTimeout(() => {
  console.log("TIMEOUT 420s");
  finish(4);
}, 420_000);
