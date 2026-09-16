import * as readline from "readline";
import { SessionManager } from "./engine/session-manager.js";
import { ensureWindowsBashEnv } from "./engine/winBashEnv.js";
import { ensureCodegraphSkill } from "./extensions/codegraphSkill.js";
import { ensureBrowserSkill } from "./extensions/browserSkill.js";
import { setStdoutBackpressureNotifier, writeStdoutFrame } from "./engine/stdoutFrames.js";

// test-mcp 子命令：探活 MCP server。被 Rust test_mcp_connection spawn 调用
// （agent-runtime test-mcp <config-json>）。最早分支，跳过会话初始化，输出 JSON 退出。
if (process.argv[2] === "test-mcp") {
  const { runTestMcp } = await import("./extensions/testMcp.js");
  await runTestMcp(process.argv[3] ?? "{}");
  process.exit(0);
}

// Windows：给 Bash 工具的非交互 bash 注入 BASH_ENV（chcp 65001），让 Windows
// 原生 CLI 输出 UTF-8，防 GBK 乱码。引擎级平台行为——桌面与 headless 两宿主
// 共享（headless 会话同样跑 Bash 工具；2026-09-11 验收发现 headless 分支漏挂）。
// test-mcp 探活分支在上面已退出，不需要。
ensureWindowsBashEnv(process.env);

// headless 子命令：HTTP/SSE 宿主。业务前端直连（不走桌面 Rust 宿主），事件按会话
// 订阅。配置走 env：AIDE_HEADLESS_PORT（默认 18090）、AIDE_HEADLESS_TOKEN（鉴权，
// 省略则只允许回环监听）。桌面路径零改动，本分支不触碰任何 stdio 初始化。
if (process.argv[2] === "headless") {
  // 宿主标记：内嵌浏览器工具据此在**发起前**短路成引导文本。没有它，桥的对面（桌面 Rust）
  // 不存在，调用只会白等 15s 超时，而超时文案会把「本环境没这个能力」伪装成「浏览器卡了」。
  // 工具本身**照挂不摘**——理由见 browserMcp.ts（工具列表跨宿主稳定，模型要拿到明确信号）。
  process.env.AIDE_HEADLESS = "1";
  const { startHeadlessServer, PROTOCOL_VERSION } = await import("./headless-server.js");
  const port = Number(process.env.AIDE_HEADLESS_PORT ?? "18090");
  const token = process.env.AIDE_HEADLESS_TOKEN || undefined;
  const handle = await startHeadlessServer({
    port,
    token,
    createManager: (dispatch) => {
      const manager = new SessionManager({ emit: dispatch });
      manager.startHealthTimer();
      return manager;
    },
  });
  // 监听地址是宿主内部的安全基线（不鉴权禁对外），这里只报端口。
  // protocol 随 listening 行暴露（版本化三处之一，另两处见 headless-server.ts）。
  console.log(JSON.stringify({ type: "headless-listening", port: handle.port, protocol: PROTOCOL_VERSION }));
  const shutdownHeadless = (): void => {
    // fire-and-forget 的收尾：close 失败要落日志可见，且信号驱动的退出必须真退出
    // （worker 的 SDK 连接是持久句柄，不 exit 进程会滞留——N4）。
    handle
      .close()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error("[headless] shutdown failed:", String(e));
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdownHeadless);
  process.on("SIGINT", shutdownHeadless);
  process.on("uncaughtException", (e) => {
    // 长驻宿主兜底（N4）：单点异常不静默死，报错后按失败退出让宿主重启
    console.error("[headless] uncaughtException:", e);
    process.exit(1);
  });
} else {
  await mainDesktop();
}

// ---- 桌面宿主（stdin/stdout 协议，由 Rust 拉起）：原顶层初始化原样收进本函数，
//      执行顺序不变；headless 分支不再走这里。 ----
async function mainDesktop(): Promise<void> {
  // （ensureWindowsBashEnv 已上移到 host 分支前的共同路径——headless 共享）

  // codegraph-explore skill 落地：任务级触发「探索代码先用索引工具」，
  // 与 MCP instructions 互补。内建于 runtime，免用户配置。
  ensureCodegraphSkill(process.env);

  // browser-inspect skill 落地：任务级触发「用户丢原型/规格页链接 → 读页面骨架 → 逐页抽规格」，
  // 并约定站点适配住 references/（数据），不进代码。与 codegraphSkill 同款内建落地。
  ensureBrowserSkill(process.env);

  // 过滤 SDK 的 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 警告。
  // 该警告是 SDK 提醒 canUseTool 不会对 allowedTools 里的裸名（"Agent","Task"）
  // 生效——但裸名自动批准正是我们想要的：模型每次派子代理都不该弹权限框（permMgr
  // 的 canUseTool 对每个工具都发 permission_request 让用户确认，Agent/Task 走它
  // 就会逐个子代理打断）。这是预期行为，压掉这条噪声即可，其余警告照常透出。
  const __origEmitWarning = process.emitWarning.bind(process);
  // Node 的 emitWarning 签名是 overloads 集合，这里用窄签名覆盖（参数取 unknown 是
  // 超集逆变，赋值兼容）；透传时按最宽 overload 还原成 string | Error。
  (process as { emitWarning: (warning: unknown, options: unknown) => void }).emitWarning = (warning: unknown, options: unknown) => {
    const code = typeof options === "object" && options !== null
      ? (options as { code?: string }).code
      : typeof options === "string" ? options : undefined;
    if (code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") return;
    __origEmitWarning(warning as string | Error, options as Parameters<typeof __origEmitWarning>[1]);
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

  // 背压降级/熔断的通知：走 emitToStdout 组装带会话上下文（无会话时落 _runtime）的
  // error 帧。该帧自身是"非增量"，背压期间照常进 Node 缓冲，对端恢复读取后能收到。
  // 见 stdoutFrames.ts —— 这是 OOM 前最后的可见信号，Rust 侧也可据此给前端报错。
  setStdoutBackpressureNotifier((message, sessionId) => {
    manager.emitToStdout(sessionId ?? "_runtime", { type: "error", message, fatal: false });
  });

  // ---- 存活心跳（Runtime 级别，每 5s） ----
  // Rust 看门狗读到任意 stdout 行即证明进程存活并重置计时；连续 15s 无行 → 判死。
  // 心跳是"可丢弃"帧：背压期间跳过（对端真挂时，看门狗判死重启正是预期恢复路径）。
  setInterval(() => {
    writeStdoutFrame(JSON.stringify({ type: "heartbeat" }) + "\n", true);
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
    } catch (e: unknown) {
      // 单条命令处理失败不崩整个 Runtime：写一条 error 事件带 session_id 继续
      const sid = cmd?.session_id ?? "unknown";
      manager.emitToStdout(sid, {
        type: "error",
        message: `Runtime: ${(e as Error)?.message ?? String(e)}`,
        fatal: false,
      });
    }
  });

  rl.on("close", () => {
    manager.shutdown();
    process.exit(0);
  });
}
