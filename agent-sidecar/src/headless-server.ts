// headless 宿主入口：把 SessionManager 的 stdin/stdout 协议搬到 HTTP/SSE 上，
// 供业务前端（如农业平台聊天组件）直连。桌面入口（index.ts 的 readline 分支）零改动。
//
// 分层：
//   核心（纯逻辑，无 IO）：命令白名单、invoke 校验、事件投递判定 —— 可 vitest 直测
//   适配（HTTP/SSE 边界）：body 校验收窄 → SidecarCommand；ChatEvent → SSE 帧
//   宿主（IO 编排）：startHeadlessServer 组装 http server + SessionManager + 路由
//
// 安全基线（骨架）：默认只监听 127.0.0.1；设 AIDE_HEADLESS_TOKEN 后强制 Bearer 校验；
// 不鉴权又要求对外监听 = 启动即拒绝（安全基线不靠自觉，见 M6）。
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { ChatEvent, SidecarCommand } from "./engine/types.js";
import { parseInvokeBody } from "./headless-schema.js";

// ---- 命令白名单 = headless-schema.ts 的 invokeBodySchema 判别联合（唯一真相，
//      正式版 10 命令 = 骨架 7 + 桌面扩展通道按需收编 3；codegraph_result 永关
//      ——headless 无 Rust 回包方，理由见 schema union 注释）。骨架期这里的
//      INVOKABLE_COMMANDS 清单已删——两份白名单必然漂移，一致性用例在测试侧钉住。

/** headless 协议版本：/invoke 请求-响应形状、SSE 帧形状、命令面发生不兼容变化
 *  时递增。三处暴露：headless-listening 行（index.ts）、/invoke 成功响应、
 *  SSE 订阅首帧 hello——客户端连上即知版本，不匹配可拒连。 */
export const PROTOCOL_VERSION = 1;

/**
 * 校验 invoke body → SidecarCommand。委托 headless-schema.ts 的 parseInvokeBody：
 * zod 判别联合逐命令收窄重建（M3），loose 面保留未知字段（前向兼容不静默丢），
 * 错误消息只含 path+code 不回显值（N5）。session_id 在 headless 形态恒必填
 * ——客户端生成并用它订阅事件流，没有它订阅表无从建。
 */
export function validateInvokeBody(
  body: unknown,
): { ok: true; command: SidecarCommand } | { ok: false; error: string } {
  return parseInvokeBody(body);
}

// ---- 事件路由：按会话隔离（headless 的机制②，多客户端互不见对方的会话事件） ----

/** 订阅表：sessionId → 该会话的 SSE 连接集合。dispatch 只投匹配订阅者。 */
export class SessionEventRouter {
  /** 正表：会话键 → 订阅集合。 */
  private bySession = new Map<string, Set<ServerResponse>>();
  /** 反表：响应 → 订阅键（连接断开时 O(1) 摘除，不遍历所有会话）。 */
  private byRes = new Map<ServerResponse, string>();

  subscribe(sessionId: string, res: ServerResponse): void {
    // 同一连接重复订阅（含跨会话）先摘旧：byRes 只记一个键，不摘会让旧会话
    // 侧残留一条永远摘不掉的死引用，且事件投给已改订阅他会的连接（跨会话泄漏）。
    if (this.byRes.has(res)) {
      this.unsubscribe(res);
    }
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(res);
    this.byRes.set(res, sessionId);
  }

  /** 连接断开时摘除；返回 true 表示该连接确实在订阅表中（防重复/未注册断开）。 */
  unsubscribe(res: ServerResponse): boolean {
    const sessionId = this.byRes.get(res);
    if (sessionId === undefined) {
      return false;
    }
    this.byRes.delete(res);
    const set = this.bySession.get(sessionId);
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        this.bySession.delete(sessionId);
      }
    }
    return true;
  }

  /** SessionManager.emit 的回调形状：把事件投给订阅了该会话的所有连接。 */
  dispatch(sessionId: string, event: ChatEvent): void {
    const set = this.bySession.get(sessionId);
    if (!set) {
      return; // 无订阅者：不投不告（订阅制语义，非泄漏路径）
    }
    const frame = sseFrame({ sessionId, event });
    for (const res of set) {
      try {
        if (!res.writableEnded) {
          res.write(frame);
        }
      } catch (e) {
        // 写失败 = 连接已死；摘除避免每次 dispatch 都撞同一个死连接。
        console.error("[headless] sse write failed, dropping connection:", String(e));
        this.unsubscribe(res);
      }
    }
  }

  /** SSE 注释行心跳：防中间层静默断链（30s 一次，由宿主挂定时器）。 */
  heartbeat(): void {
    for (const set of this.bySession.values()) {
      for (const res of set) {
        try {
          res.write(": ping\n\n");
        } catch {
          // 心跳写失败 = 连接半死，等 res 的 close 事件摘除即可，不在热路径重抛
        }
      }
    }
  }

  /** 宿主关闭时主动断开所有订阅连接（res.end 让客户端 reader 收到 done，
   *  否则 httpServer.close 会等这些长连接，宿主 close 挂死）。 */
  closeAll(): void {
    for (const set of this.bySession.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          // 已死连接不必强断，等 close 事件清理
        }
      }
    }
    this.bySession.clear();
    this.byRes.clear();
  }
}

// ---- 适配：HTTP/SSE 边界 ----

const MAX_INVOKE_BODY_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 30_000;

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  // 不可达（防御性幂等）：handleInvoke 的每条路径在 respondJson 前都 return，
  // 同一 res 二次响应只在并发竞态窗口出现——保留早退是为竞态兜底，不是死代码。
  if (res.writableEnded) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** HTTP 边界鉴权：Bearer token 匹配与否。凭据永不写日志（N5）。 */
function isAuthorized(headers: IncomingHttpHeaders, token: string | undefined): boolean {
  if (token === undefined) {
    return true; // 回环模式，无鉴权
  }
  const auth = headers.authorization;
  return typeof auth === "string" && auth === `Bearer ${token}`;
}

/** 读请求体：上限内拼字节流；大小约束在边界完成（N1）。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_INVOKE_BODY_BYTES) {
      throw new Error(`invoke body exceeds ${MAX_INVOKE_BODY_BYTES} bytes`);
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** 安全基线：不鉴权时禁止监听非回环地址——暴露面必须与鉴权同时存在。 */
function assertLoopbackUnlessAuthenticated(host: string, token: string | undefined): void {
  if (token === undefined && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `headless without a token may only listen on a loopback address (got host="${host}"); set AIDE_HEADLESS_TOKEN to expose beyond localhost`,
    );
  }
}

/** POST /invoke：鉴权 → 校验 → manager.handleCommand；结果走事件流（sidecar 语义）。 */
function handleInvoke(manager: HeadlessManager, body: unknown, res: ServerResponse): void {
  const verdict = validateInvokeBody(body);
  if (!verdict.ok) {
    respondJson(res, 400, { ok: false, error: verdict.error });
    return;
  }
  try {
    manager.handleCommand(verdict.command);
  } catch (e) {
    // 命令路由的同步异常：带上下文回给调用方（N1——失败要让对端看见）
    respondJson(res, 500, { ok: false, error: `command dispatch failed: ${String(e)}` });
    return;
  }
  // 已入队；真实结果经 GET /events 推送。protocol 随响应暴露（版本化三处之一）。
  respondJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION });
}

/** GET /events：SSE 流，按订阅键只收该会话的事件；断开自动摘除。 */
function handleEvents(url: URL, router: SessionEventRouter, res: ServerResponse): void {
  const sessionId = url.searchParams.get("sessionId");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    respondJson(res, 400, { ok: false, error: "sessionId query param is required" });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders(); // 立即发出响应头：SSE 无首帧前客户端的 response 事件不会触发
  // 协议版本握手首帧（版本化三处之一）：客户端连上即知版本，不匹配可主动断开。
  res.write(sseFrame({ type: "hello", protocol: PROTOCOL_VERSION, sessionId }));
  router.subscribe(sessionId, res);
  res.on("close", () => {
    router.unsubscribe(res);
  });
}

// ---- 宿主：依赖注入 + 组装 ----

export interface HeadlessManager {
  handleCommand(cmd: SidecarCommand): void;
  shutdown(): void;
}

export interface HeadlessServerOptions {
  /** 监听端口（0 = 随机）。 */
  port: number;
  /** 依赖注入（测试缝）：dispatch 是 SessionEventRouter.dispatch，manager 构造时接上。 */
  createManager: (dispatch: (sessionId: string, event: ChatEvent) => void) => HeadlessManager;
  /** Bearer token；省略 = 不鉴权（此时只允许监听回环地址）。 */
  token?: string;
  /** 监听地址，默认 127.0.0.1。 */
  host?: string;
}

export interface HeadlessServerHandle {
  port: number;
  close(): Promise<void>;
}

/** 组装 HTTP server：路由分派 + 鉴权 + 错误监听（不崩进程，N4）。 */
function buildHttpServer(
  manager: HeadlessManager,
  router: SessionEventRouter,
  token: string | undefined,
): import("node:http").Server {
  return createServer((req, res) => {
    // base 用固定常量：host 可能是 "::1"（IPv6 裸地址不能直接进 URL，需方括号），
    // 而这里只需要 pathname/searchParams，与监听地址无关。
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isAuthorized(req.headers, token)) {
      respondJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/invoke") {
      readBody(req)
        .then((raw) => JSON.parse(raw.toString("utf8") || "{}"))
        .then((body) => handleInvoke(manager, body, res))
        .catch((e) => respondJson(res, 400, { ok: false, error: String((e as Error)?.message ?? e) }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      handleEvents(url, router, res);
      return;
    }
    respondJson(res, 404, { ok: false, error: `no route: ${req.method} ${url.pathname}` });
  }).on("error", (e) => {
    // 监听期错误（端口占用等）不崩进程——headless 宿主可被上层重试（N4）
    console.error("[headless] server error:", e);
  });
}

function startHeartbeat(router: SessionEventRouter): NodeJS.Timeout {
  const timer = setInterval(() => router.heartbeat(), SSE_HEARTBEAT_MS);
  timer.unref();
  return timer;
}

async function listenHttp(server: import("node:http").Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : port);
    });
  });
}

/** 关闭编排：幂等 + 清定时器 + 主动断订阅连接 + manager 收尾（顺序承重墙，勿插入 await）。 */
function buildClose(
  heartbeatTimer: NodeJS.Timeout,
  router: SessionEventRouter,
  manager: HeadlessManager,
  httpServer: import("node:http").Server,
): () => Promise<void> {
  let closed = false;
  return async (): Promise<void> => {
    if (closed) {
      return; // 幂等：宿主可被上层与信号处理器重复调用
    }
    closed = true;
    clearInterval(heartbeatTimer);
    router.closeAll();
    manager.shutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((e) => (e && (e as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(e) : resolve()));
    });
  };
}

/** 主函数：只编排——校验基线、建路由、建 manager、起 HTTP、心跳、监听、收尾。 */
export async function startHeadlessServer(opts: HeadlessServerOptions): Promise<HeadlessServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  assertLoopbackUnlessAuthenticated(host, opts.token);

  const router = new SessionEventRouter();
  const manager = opts.createManager((sessionId, event) => router.dispatch(sessionId, event));
  const httpServer = buildHttpServer(manager, router, opts.token);
  const heartbeatTimer = startHeartbeat(router);
  const port = await listenHttp(httpServer, opts.port, host);
  return { port, close: buildClose(heartbeatTimer, router, manager, httpServer) };
}