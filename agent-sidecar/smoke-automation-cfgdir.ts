// 验证 CLAUDE_CONFIG_DIR 隔离：automation 的 send 带 env.CLAUDE_CONFIG_DIR 后，
// 转录应落到任务自己的目录（<task_dir>/claude/projects/），而**不进**
// ~/.aide/claude/projects/ —— 后者被 list_workspaces() 全量扫描当工作区显示，
// automation 的转录目录混进去就是侧栏污染（2026-09-07 bug）。
//
// 同时验证副作用：改了 CLAUDE_CONFIG_DIR 后子进程是否还能正常用工具
// （Read 读得到文件 = 基本能力没退化）。
//
// 用法（agent-sidecar 目录）：npx tsx smoke-automation-cfgdir.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = process.env.USERPROFILE!;
const SIDECAR_ENTRY = path.join(HOME, "IdeaProjects/aide/agent-sidecar/dist/runtime.js");
const CLAUDE_EXE = path.join(
  HOME,
  "IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
);

// 模拟任务目录结构：~/.aide/automations/<task-id>/claude → 这里用临时目录代替，
// 避免污染真实任务区；机制与结构完全一致。
const TASK_DIR = path.join(os.tmpdir(), "aide-cfgdir-smoke", "aut_cfgtest");
const CFG_DIR = path.join(TASK_DIR, "claude");
const GLOBAL_PROJECTS = path.join(HOME, ".aide/claude/projects");

fs.rmSync(TASK_DIR, { recursive: true, force: true });
fs.mkdirSync(CFG_DIR, { recursive: true });

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
function countJsonl(p: string): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) n++;
    }
  };
  if (fs.existsSync(p)) walk(p);
  return n;
}

const beforeGlobal = new Set(listDirs(GLOBAL_PROJECTS));

const child = spawn("node", [SIDECAR_ENTRY], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(HOME, ".aide/claude"), AIDE_CLAUDE_EXE: CLAUDE_EXE },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => console.error("[stderr]", String(d).slice(0, 300)));

const SESSION = "smoke-cfgdir-1";
let sawInit = false;
let readOk = false;
let cost: number | null = null;

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
    sawInit = true;
    console.log("=== session_init ===", e.session_id ?? "");
    return;
  }
  if (e.type === "tool_result" && !e.is_error) {
    readOk = true;
    console.log("=== tool_result 成功（工具能力正常）===", String(e.content).slice(0, 80));
    return;
  }
  if (e.type === "message_stop") {
    cost = e.total_cost_usd;
    console.log("=== MESSAGE_STOP ===", e.stop_reason, "cost:", cost);
    finish(0);
    return;
  }
  if (e.type === "error" || e.type === "session_dead") {
    console.log("!!! " + e.type, JSON.stringify(e).slice(0, 300));
    finish(3);
  }
});

function finish(code: number) {
  setTimeout(() => {
    const cfgProjects = path.join(CFG_DIR, "projects");
    const inTask = countJsonl(cfgProjects);
    const afterGlobal = listDirs(GLOBAL_PROJECTS);
    const added = afterGlobal.filter((d) => !beforeGlobal.has(d));

    console.log("\n========== 判定 ==========");
    console.log(`init=${sawInit}  工具可用=${readOk}  cost=${cost}`);
    console.log(`任务目录转录 jsonl 数（<task_dir>/claude/projects）：${inTask}`);
    console.log(`全局 projects 新增目录：${added.length ? added.join(", ") : "（无）"}`);
    console.log(
      `\n结论：CLAUDE_CONFIG_DIR ${inTask > 0 ? "生效 ✅ 转录已隔离到任务目录" : "未生效 ❌ 转录没落进来"}` +
        `；全局目录 ${added.length === 0 ? "未被污染 ✅" : "被写入 ❌"}`,
    );
    child.kill();
    process.exit(inTask > 0 && added.length === 0 ? 0 : 2);
  }, 800);
}

// 关键：env 带 CLAUDE_CONFIG_DIR —— Rust 侧 build_send_command 已按此下发
const cmd = {
  cmd: "send",
  session_id: SESSION,
  prompt:
    "用 Read 工具读取 agent-sidecar/package.json，只回复其中 name 字段的值，不要任何解释。",
  cwd: "C:/Users/<user>/IdeaProjects/aide",
  env: { CLAUDE_CONFIG_DIR: CFG_DIR },
  permission_mode: "default",
  auto_title: false,
  trusted: true,
  automation: {
    task_id: "aut_cfgtest",
    run_id: "run_cfgtest1",
    preset: "auto",
    tools: ["Read", "Glob", "Grep"],
    mcp_allowlist: [],
    task_dir: TASK_DIR,
    max_turns: 4,
  },
};
child.stdin.write(JSON.stringify(cmd) + "\n");

setTimeout(() => {
  console.log("TIMEOUT 180s");
  finish(4);
}, 180_000);
