import * as readline from "readline";
import { SessionManager } from "./session-manager.js";

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
