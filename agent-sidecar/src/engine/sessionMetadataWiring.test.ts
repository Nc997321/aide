// 会话元数据 / MCP 头注入的 worker 级接线测试（headless 机制①）。
// 纯函数逻辑在 sessionMetadata.test.ts；这里验证 SessionWorker 的三个契约：
//   1. send.mcp_headers → query() options.mcpServers 的 http 条目收到注入头（stdio 不动）
//   2. metadata → HookBuildContext.session.metadata() 可读，且是活值（send 刷新可见）
//   3. 每条 send 刷新：第二条 send 的新头在新 query 生效；非法形状 fail-closed + 日志不带值（N5）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionWorker } from "./session-worker.js";

// 包装 buildBuiltinHooks 捕获 ctx（委托原实现，行为不变）——断言 metadata 读取口。
// 工厂体内不读 lastHookCtx（只在包装函数调用时读），无 TDZ 风险。
let lastHookCtx: { session: { metadata(): Record<string, unknown> } } | null = null;
vi.mock("../extensions/builtinHooks/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../extensions/builtinHooks/index.js")>();
  return {
    ...orig,
    buildBuiltinHooks: (ctx: Parameters<typeof orig.buildBuiltinHooks>[0]) => {
      lastHookCtx = ctx as typeof lastHookCtx;
      return orig.buildBuiltinHooks(ctx);
    },
  };
});

// ---- 确定性 user MCP 配置（loadUserMcpServers 读 CLAUDE_CONFIG_DIR/settings.json） ----

let configDir = "";
let savedConfigDir: string | undefined;

beforeEach(() => {
  lastHookCtx = null;
  configDir = mkdtempSync(join(tmpdir(), "aide-meta-wiring-"));
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      mcpServers: {
        biz: { type: "http", url: "http://127.0.0.1:9/mcp" },
        legacy: { type: "stdio", command: "npx", args: ["legacy-mcp"] },
      },
    }),
  );
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 测试缝：queryFn 捕获每轮 query 的 options；空 generator 让本轮立即结束
 *  （for-await 正常结束 → break → currentQuery=null，下一条 send 重新 startLoop）。 */
function makeWorker(captured: { opts: any[] }): SessionWorker {
  return new SessionWorker("sid-meta", () => {}, {
    cwd: "/tmp",
    queryFn: ((args: any) => {
      captured.opts.push(args.options);
      return (async function* () {})() as any;
    }) as any,
  });
}

function sendCmd(extra: Record<string, unknown> = {}) {
  return {
    cmd: "send",
    session_id: "sid-meta",
    prompt: "hi",
    cwd: "/tmp",
    env: {},
    ...extra,
  } as any;
}

describe("SessionWorker — MCP 头注入接线", () => {
  it("send.mcp_headers：http server 收到注入头，stdio 条目不动", async () => {
    const captured = { opts: [] as any[] };
    const worker = makeWorker(captured);
    worker.handleCommand(sendCmd({ mcp_headers: { biz: { Authorization: "Bearer t1" } } }));
    await vi.waitFor(() => expect(captured.opts).toHaveLength(1));
    const mcp = captured.opts[0].mcpServers;
    expect(mcp.biz.headers).toEqual({ Authorization: "Bearer t1" });
    expect(mcp.legacy.headers).toBeUndefined();
    worker.stop();
  });

  it("不带 mcp_headers：http server 无 headers（桌面路径零注入）", async () => {
    const captured = { opts: [] as any[] };
    const worker = makeWorker(captured);
    worker.handleCommand(sendCmd());
    await vi.waitFor(() => expect(captured.opts).toHaveLength(1));
    expect(captured.opts[0].mcpServers.biz.headers).toBeUndefined();
    worker.stop();
  });

  it("每条 send 刷新：第二条 send 的新头在新 query 生效（token 轮换）", async () => {
    const captured = { opts: [] as any[] };
    const worker = makeWorker(captured);
    worker.handleCommand(sendCmd({ mcp_headers: { biz: { Authorization: "Bearer old" } } }));
    await vi.waitFor(() => expect(captured.opts).toHaveLength(1));
    // 等第一轮 for-await 结束（break → currentQuery=null），第二条 send 才会重新 startLoop
    await new Promise((r) => setTimeout(r, 50));
    worker.handleCommand(sendCmd({ mcp_headers: { biz: { Authorization: "Bearer new" } } }));
    await vi.waitFor(() => expect(captured.opts).toHaveLength(2));
    expect(captured.opts[1].mcpServers.biz.headers).toEqual({ Authorization: "Bearer new" });
    worker.stop();
  });

  it("非法 mcp_headers：fail-closed 整体忽略 + console.error 不回显表内凭据（N5）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const captured = { opts: [] as any[] };
    const worker = makeWorker(captured);
    // 表内一个值非法（42 非 string）→ 整表拒绝；同表的合法凭据串不得进日志
    worker.handleCommand(
      sendCmd({ mcp_headers: { biz: { Authorization: "Bearer s3cret", Bad: 42 } } }),
    );
    await vi.waitFor(() => expect(captured.opts).toHaveLength(1));
    expect(captured.opts[0].mcpServers.biz.headers).toBeUndefined(); // 未注入
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("s3cret");
    worker.stop();
  });
});

describe("SessionWorker — metadata hooks 读取口", () => {
  it("metadata 经 HookBuildContext.session.metadata() 可读；send 刷新后旧 ctx 也见活值", async () => {
    const captured = { opts: [] as any[] };
    const worker = makeWorker(captured);
    worker.handleCommand(sendCmd({ metadata: { tenant: "acme" } }));
    await vi.waitFor(() => expect(captured.opts).toHaveLength(1));
    expect(lastHookCtx).not.toBeNull();
    const firstCtx = lastHookCtx!;
    expect(firstCtx.session.metadata()).toEqual({ tenant: "acme" });

    // 第二条 send 刷新 metadata：旧 ctx 的闭包读到新值（函数形式读活值）
    worker.handleCommand(sendCmd({ metadata: { tenant: "beta" } }));
    await vi.waitFor(() => expect(firstCtx.session.metadata()).toEqual({ tenant: "beta" }));
    worker.stop();
  });

  it("send 缺席 metadata → 清空（{}），hook 读到空对象不是陈旧值", async () => {
    const captured = { opts: [] as any[] };
    const worker = makeWorker(captured);
    worker.handleCommand(sendCmd({ metadata: { tenant: "acme" } }));
    await vi.waitFor(() => expect(captured.opts).toHaveLength(1));
    const firstCtx = lastHookCtx!;
    worker.handleCommand(sendCmd()); // 不带 metadata
    await vi.waitFor(() => expect(firstCtx.session.metadata()).toEqual({}));
    worker.stop();
  });
});
