// headless 验收脚本共享库（清单 §7-4 沉淀的 smoke-headless-* 家族公共层）。
// 上层只有工具函数，无业务判断；两个验收脚本（host / gateway）共享：
//   进程编排（spawnRuntime / 优雅关停观测） · 协议客户端（invokeOnce / sseOpen / rawSubscribe）
//   观测（claude.exe PID 快照、RSS、mock MCP 命中记录、日志哨兵扫描） · 台账（check/report）
// 约定：全部只连 127.0.0.1 随机/固定端口；凭据面一律假哨兵，真 key 不进本家族。
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEAD_BASE_URL = "http://127.0.0.1:9";

/** 死端点 env（send.env 下发）：端点不可达但 CLI 可完成本地握手。 */
export function deadEndpointEnv(apiKeySentinel: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: DEAD_BASE_URL, ANTHROPIC_API_KEY: apiKeySentinel };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 pred 给出真值；超时抛错（验收脚本宁可显式失败也不静默半跑）。 */
export async function waitFor<T>(
  what: string,
  pred: () => T | undefined | null | false,
  timeoutMs = 30_000,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor(${what}) timed out after ${timeoutMs}ms`);
    await sleep(everyMs);
  }
}

// ---- 结果台账 ----

interface CheckRow { name: string; ok: boolean; note: string }
const ledger: CheckRow[] = [];

export function check(name: string, ok: boolean, note = ""): void {
  ledger.push({ name, ok, note });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${note ? ` — ${note}` : ""}`);
}

/** 台账收尾：打印汇总、复位 exitCode 供脚本决定去留。返回失败数。 */
export function report(): number {
  const bad = ledger.filter((r) => !r.ok);
  console.log(`\n[ledger] ${ledger.length - bad.length}/${ledger.length} passed`);
  for (const r of bad) console.log(`[ledger] FAILED: ${r.name} ${r.note}`);
  return bad.length;
}

// ---- 宿主进程编排 ----

export interface RuntimeHandle {
  child: ChildProcess;
  port: number;
  /** runtime 全部 stdout+stderr 行（C8 哨兵扫描与协议观测共用）。 */
  logs: string[];
  exit: Promise<{ code: number | null; signal: string | null }>;
}

/** 起 headless 宿主（跑 dist 产物），等 headless-listening 行。 */
export async function spawnRuntime(o: {
  port: number;
  token?: string;
  configDir?: string;
  extraEnv?: Record<string, string>;
}): Promise<RuntimeHandle> {
  const child = spawn(process.execPath, ["dist/runtime.js", "headless"], {
    env: {
      ...process.env,
      AIDE_HEADLESS_PORT: String(o.port),
      ...(o.token ? { AIDE_HEADLESS_TOKEN: o.token } : {}),
      ...(o.configDir ? { CLAUDE_CONFIG_DIR: o.configDir } : {}),
      ...(o.extraEnv ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const sink = (prefix: string) => (d: Buffer) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (line.trim()) logs.push(line);
      if (process.env.SMOKE_VERBOSE) process.stdout.write(`[${prefix}] ${line}\n`);
    }
  };
  child.stdout.on("data", sink("runtime"));
  child.stderr.on("data", sink("runtime:err"));
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(
    "headless-listening",
    () => logs.some((l) => l.includes("headless-listening")),
    20_000,
  );
  return { child, port: o.port, logs, exit };
}

// ---- 协议客户端 ----

export async function invokeOnce(
  port: number,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* 400 等非 JSON 回包如实保留 text */ }
  return { status: res.status, json, text };
}

/** 超大 body 专用：服务端先回 400 再因未读完请求 RST 连接，fetch 会把它当网络错误。
 *  用裸 http.request 抓首响应状态码（首响应胜出，之后的 socket 错误忽略）。 */
export function invokeRawStatus(port: number, raw: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      {
        host: "127.0.0.1", port, path: "/invoke", method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      },
      (res) => { if (!settled) { settled = true; resolve(res.statusCode ?? 0); } res.resume(); },
    );
    req.setTimeout(15_000, () => { if (!settled) { settled = true; req.destroy(); reject(new Error("invokeRawStatus timeout")); } });
    req.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    req.end(raw);
  });
}

export interface SseStream {
  /** 已收 data 帧（hello / {sessionId,event} 原样解析）。 */
  frames: Array<Record<string, unknown>>;
  /** `: ping` 注释行计数（A12）。 */
  comments: number;
  closed: boolean;
  closeReason: "done" | "error" | null;
  error: string;
  cancel(): void;
}

/** fetch 版 SSE 订阅：读循环收帧，cancel 走 AbortController（D4 断开模拟）。 */
export function sseOpen(port: number, sessionId: string, token?: string): SseStream {
  const ac = new AbortController();
  const stream: SseStream = {
    frames: [], comments: 0, closed: false, closeReason: null, error: "",
    cancel: () => ac.abort(),
  };
  (async () => {
    let buf = "";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        stream.closed = true;
        stream.closeReason = "error";
        stream.error = `http ${res.status}`;
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              try { stream.frames.push(JSON.parse(line.slice(6))); } catch { /* 非 JSON data 帧保留在 logs 侧 */ }
            } else if (line.startsWith(":")) {
              stream.comments += 1;
            }
          }
        }
      }
      stream.closed = true;
      stream.closeReason = "done";
    } catch (e) {
      stream.closed = true;
      stream.closeReason = "error";
      stream.error = String((e as Error)?.message ?? e);
    }
  })();
  return stream;
}

/** 业务事件帧（排除 hello）：脚本里高频使用的取子器。 */
export function eventsOf(s: SseStream): Array<Record<string, unknown>> {
  return s.frames.filter((f) => f.type !== "hello").map((f) => f.event as Record<string, unknown>);
}

/** 原始 socket 订阅：A11 断线（destroy）与 A20 背压（pause 不读）需要连接级控制。 */
export function rawSubscribe(
  port: number,
  path: string,
  opts?: { token?: string; pauseImmediately?: boolean },
): { socket: Socket; data: string; pause(): void; resume(): void; close(): void } {
  const socket = netConnect({ host: "127.0.0.1", port });
  const holder = { data: "" };
  socket.on("data", (d: Buffer) => { holder.data += d.toString("utf8"); });
  const req = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n`
    + (opts?.token ? `Authorization: Bearer ${opts.token}\r\n` : "")
    + "\r\n";
  socket.once("connect", () => {
    socket.write(req);
    if (opts?.pauseImmediately) socket.pause();
  });
  return {
    socket,
    get data() { return holder.data; },
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    close: () => socket.destroy(),
  };
}

// ---- 观测：进程面 ----

/** claude.exe PID 快照（tasklist CSV 一次全量，不逐进程 spawn）。 */
export function claudePids(): Set<number> {
  const out = execSync("tasklist /FO CSV /NH /FI \"IMAGENAME eq claude.exe\"", { encoding: "utf8" });
  const set = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"claude\.exe","(\d+)"/i);
    if (m) set.add(Number(m[1]));
  }
  return set;
}

export function diffPids(before: Set<number>, after: Set<number>): number[] {
  return [...after].filter((p) => !before.has(p));
}

/** 指定 PID 的 RSS（KB），进程已消失返回 undefined。tasklist 列格式如 "12,345 K"。 */
export function rssKBOf(pid: number): number | undefined {
  const out = execSync(`tasklist /FO CSV /NH /FI "PID eq ${pid}"`, { encoding: "utf8" });
  const m = out.match(/"([0-9][0-9.,]*)\s*K"/);
  return m ? Number(m[1].replace(/[.,]/g, "")) : undefined;
}

export function killPid(pid: number): void {
  try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch { /* 已退出即达成 */ }
}

// ---- mock MCP server（机制①验收靶子） ----

export interface MockMcp {
  port: number;
  /** 每条到达请求：注入头值 + 对端源端口（会话隔离按连接分组用）。 */
  hits: Array<{ value: string; remotePort: number; t: number }>;
  close(): Promise<void>;
}

/** 任何请求都记头值（握手成败无关），固定 404 回包——smoke-mcp-headers 同法。 */
export async function makeMockMcp(headerName: string): Promise<MockMcp> {
  const hits: MockMcp["hits"] = [];
  const server = createServer((req, res) => {
    const v = req.headers[headerName.toLowerCase()];
    if (typeof v === "string") hits.push({ value: v, remotePort: req.socket.remotePort ?? 0, t: Date.now() });
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ---- 临时配置根 ----

export interface SmokeConfigRoot { dir: string; cleanup(): void }

/** 写 settings.json（mcpServers 表 + 可选扩展键如 hooks）进临时配置根；cwd 也用它。 */
export function makeConfigRoot(mcpServers: Record<string, unknown>, extra: Record<string, unknown> = {}): SmokeConfigRoot {
  const dir = mkdtempSync(join(tmpdir(), "aide-headless-accept-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...extra, mcpServers }));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (e) {
        console.log(`[note] 临时目录清理未完成（不影响判定）: ${dir} — ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
    },
  };
}

/** 日志哨兵扫描（C8/N5）：任一凭据值出现在 runtime 日志 = 泄漏。 */
export function scanLeaks(logs: string[], sentinels: string[]): string[] {
  const joined = logs.join("\n");
  return sentinels.filter((s) => s.length > 0 && joined.includes(s));
}
