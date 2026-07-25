import * as readline from "readline";
import { SessionManager } from "./session-manager.js";
import { ensureWindowsBashEnv } from "./winBashEnv.js";

// Windows：给 Bash 工具的非交互 bash 注入 BASH_ENV（chcp 65001），
// 让 Windows 原生 CLI 输出 UTF-8，防 GBK 乱码。内建于 runtime，免用户配置。
ensureWindowsBashEnv(process.env);

// 过滤 SDK 的 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 警告。
// 该警告是 SDK 提醒 canUseTool 不会对 allowedTools 里的裸名（"Agent","Task"）
// 生效——但裸名自动批准正是我们想要的：模型每次派子代理都不该弹权限框（permMgr
// 的 canUseTool 对每个工具都发 permission_request 让用户确认，Agent/Task 走它
// 就会逐个子代理打断）。这是预期行为，压掉这条噪声即可，其余警告照常透出。
const __origEmitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: unknown, options: unknown) => {
  const code = typeof options === "object" && options !== null
    ? (options as { code?: string }).code
    : typeof options === "string" ? options : undefined;
  if (code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") return;
  __origEmitWarning(warning as string, options as any);
};

// ================================================================
// Agent Runtime 入口 — 单进程、多会话（SessionWorker）
//
// 每个会话的 SDK query() 循环封装在 SessionWorker 实例中；
// SessionManager 负责按 session_id 路由 stdin 命令并统一 stdout 输出。
// 本身不再持有任何 SDK / 权限 / 子代理状态。
// ================================================================

const manager = new SessionManager();
manager.startHealthTimer();

// ---- 存活心跳（Runtime 级别，每 5s） ----
// Rust 看门狗读到任意 stdout 行即证明进程存活并重置计时；连续 15s 无行 → 判死。
setInterval(() => {
  process.stdout.write(JSON.stringify({ type: "heartbeat" }) + "\n");
}, 5_000).unref();

// ---- 代理设置（进程级） ----
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

// ---- stdin 命令路由器 ----
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let cmd: any;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  try {
    manager.handleCommand(cmd);
  } catch (e: any) {
    // 单条命令处理失败不崩整个 Runtime：写一条 error 事件带 session_id 继续
    const sid = cmd?.session_id ?? "unknown";
    manager.emitToStdout(sid, {
      type: "error",
      message: `Runtime: ${e?.message ?? e}`,
      fatal: false,
    });
  }
});

rl.on("close", () => {
  manager.shutdown();
  process.exit(0);
});
