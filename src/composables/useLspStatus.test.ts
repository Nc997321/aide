import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { effectScope, nextTick, ref, type EffectScope, type Ref } from "vue";
import { flushPromises } from "@vue/test-utils";

// 捕获 listen 注册的 handler，供测试手动触发就绪/死亡事件（vi.hoisted 保证提升到 mock 之前）
const handlers = vi.hoisted(() => ({
  ready: null as ((ev: { payload: { workspaceRoot: string; lang: string } }) => void) | null,
  dead: null as (() => void) | null,
}));
const board = vi.hoisted(() => ({ cb: null as ((ev: { payload: unknown }) => void) | null }));
const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn(),
}));
vi.mock("@aide/sdk/api", () => ({
  api: {
    lspDetectLanguages: async (workspaceRoot: string) => mocks.invoke("lsp_detect_languages", { workspaceRoot }),
    lspEnsureServer: async (workspaceRoot: string, lang: string) => mocks.invoke("lsp_ensure_server", { workspaceRoot, lang }),
    lspStatus: async (workspaceRoot: string) => mocks.invoke("lsp_status", { workspaceRoot }),
  },
}));
vi.mock("@aide/sdk", async () => ({
  api: (await import("@aide/sdk/api")).api,
  listen: mocks.listen,
  permissionsApi: {},
  openExternal: vi.fn(),
}));

import { useLspStatus } from "./useLspStatus";

const invoke = mocks.invoke;
const scopes: EffectScope[] = [];
function createStatus(root: () => string, enabled: Ref<boolean>) {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => useLspStatus(root, enabled))!;
}
beforeEach(() => {
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (event: string, cb: (ev: unknown) => void) => {
    if (event === "lsp-server-ready") handlers.ready = cb as typeof handlers.ready;
    if (event === "lsp-server-dead") handlers.dead = cb as () => void;
    return () => {};
  });
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

describe("useLspStatus", () => {
  beforeEach(() => {
    invoke.mockReset();
    handlers.ready = null;
    handlers.dead = null;
  });

  it("probes languages and maps ensure outcome to status", async () => {
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const lang = (args as { lang?: string } | undefined)?.lang;
      if (cmd === "lsp_detect_languages") return ["rust", "java"];
      if (cmd === "lsp_ensure_server") {
        return lang === "rust"
          ? { ok: true, ready: true }
          : { ok: false, kind: "server_not_found" };
      }
      return undefined;
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([
        { lang: "rust", status: "ok" },
        { lang: "java", status: "missing" },
      ]);
    });
  });

  it("does not probe when LSP disabled", async () => {
    const enabled = ref(false);
    createStatus(() => "/ws", enabled);
    await new Promise((r) => setTimeout(r, 30));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks failed when ensure throws", async () => {
    // vitest 4 官方推荐 mockRejectedValue（mockImplementation 内 throw 的
    // rejection 可能逃出测试作用域被 vitest 记为 unhandled，见 vitest#1649）。
    invoke.mockResolvedValueOnce(["go"]);
    invoke.mockRejectedValueOnce(new Error("boom"));
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{ lang: "go", status: "failed" }]);
    });
  });

  it("marks handshake_failed as failed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["python"];
      return { ok: false, kind: "handshake_failed" };
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{ lang: "python", status: "failed" }]);
    });
  });

  it("captures error detail from handshake_failed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["rust"];
      return { ok: false, kind: "handshake_failed", error: "channel closed; stderr:\nUnknown binary 'rust-analyzer.exe'" };
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{
        lang: "rust",
        status: "failed",
        error: "channel closed; stderr:\nUnknown binary 'rust-analyzer.exe'",
      }]);
    });
  });

  it("captures error detail from spawn_failed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["go"];
      return { ok: false, kind: "spawn_failed", error: "\"C:/x/gopls.exe\": 系统找不到指定的文件" };
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{
        lang: "go",
        status: "failed",
        error: "\"C:/x/gopls.exe\": 系统找不到指定的文件",
      }]);
    });
  });

  it("re-probes on workspace change and clears stale langs", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["rust"];
      return { ok: true, ready: true };
    });
    const root = ref("/ws-a");
    const enabled = ref(true);
    const { langs } = createStatus(() => root.value, enabled);
    await vi.waitFor(() => expect(langs.value).toEqual([{ lang: "rust", status: "ok" }]));
    invoke.mockClear();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      return { ok: true, ready: true };
    });
    root.value = "/ws-b";
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{ lang: "java", status: "ok" }]);
    });
  });

  it("resets probing when disabled", async () => {
    // 回归：probe 在 disabled/无工作区时必须把 probing 复位（防旧挂起残留卡死
    // 面板「永远探测中」）。注：挂起 invoke 的完整场景在 vitest 4 下会触发
    // teardown 超时（环境限制），这里直测 return 分支的复位语义。
    invoke.mockResolvedValue(["rust"]);
    const enabled = ref(false);
    const { probing, probe } = createStatus(() => "/ws", enabled);
    probing.value = true; // 模拟上一次 probe 挂起残留
    await probe(); // disabled → return 分支复位
    expect(probing.value).toBe(false);
  });

  it("java indexing until ready event flips to ok", async () => {
    // jdtls 握手成功但 ready=false（索引中）→ indexing；收到 lsp-server-ready → ok
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      return { ok: true, ready: false };
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{ lang: "java", status: "indexing" }]);
    });
    // ensureListening 异步注册 ready handler；等它就位再触发
    await vi.waitFor(() => expect(handlers.ready).not.toBeNull());
    handlers.ready!({ payload: { workspaceRoot: "/ws", lang: "java" } });
    await vi.waitFor(() => {
      expect(langs.value).toEqual([{ lang: "java", status: "ok" }]);
    });
  });

  it("ready event for wrong workspace is ignored", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      return { ok: true, ready: false };
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => expect(langs.value).toEqual([{ lang: "java", status: "indexing" }]));
    await vi.waitFor(() => expect(handlers.ready).not.toBeNull());
    handlers.ready!({ payload: { workspaceRoot: "/other", lang: "java" } });
    // 仍 indexing（旧工作区事件忽略，防切工作区后旧 server 的就绪信号误染新工作区）
    await new Promise((r) => setTimeout(r, 30));
    expect(langs.value).toEqual([{ lang: "java", status: "indexing" }]);
  });

  // 注：ensure 挂起 → withTimeout(8s) → failed 的超时路径不做单测——挂起 invoke
  // 在 vitest 4 下触发 teardown 超时（环境限制）；catch 路径已由
  // "marks failed when ensure throws" 覆盖，withTimeout 本身是薄封装。
  //
  // 注：90s 慢索引兜底（indexing 超 INDEXING_SLOW_MS 加 note）+ ready 事件清计时器、
  // lsp-server-dead 重 probe 三条路径不做单测——fake timers 与 async/await + withTimeout
  // 在 vitest 4 下交互脆弱（vi.waitFor 在 fake timers 下需手动推进，易挂）；逻辑轻量
  // 且 ready 事件切态已覆盖核心，手测覆盖：开 Java 工作区观察「索引中…」→「就绪 ✓」、
  // 关 LSP/杀 server 验证不卡「索引中」。
});
describe("useLspStatus：Host 状态板为准", () => {
  beforeEach(() => {
    invoke.mockReset();
    board.cb = null;
    mocks.listen.mockImplementation(async (event: string, cb: (ev: { payload: unknown }) => void) => {
      if (event === "lsp-status") board.cb = cb;
      return () => {};
    });
  });

  it("握手成功不等于就绪：状态板没实测通过前显示索引中，并带进度与阶段", async () => {
    const since = Date.now() - 12_000;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      if (cmd === "lsp_ensure_server") return { ok: true, ready: true };
      if (cmd === "lsp_status")
        return [{ workspaceRoot: "/ws", lang: "java", phase: "loading", nav: false, symbols: "unknown", progress: 50, message: "Starting Java Language Server", since }];
      return undefined;
    });
    const { langs } = createStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(langs.value[0]?.status).toBe("indexing"));
    expect(langs.value[0].note).toMatch(/^加载工程 · 50% Starting Java Language Server · 已 1\d 秒$/);
  });

  it("lsp-status 推进到 ready 才显示就绪；跳转可用、按名未好时如实说", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      if (cmd === "lsp_ensure_server") return { ok: true, ready: false };
      if (cmd === "lsp_status") return [];
      return undefined;
    });
    const { langs } = createStatus(() => "C:\\ws", ref(true));
    await vi.waitFor(() => expect(board.cb).not.toBeNull());
    const base = { workspaceRoot: "c:/ws", lang: "java", since: Date.now(), symbols: "unknown" };
    board.cb!({ payload: { ...base, phase: "indexing", nav: true } });
    await vi.waitFor(() => expect(langs.value[0].note).toMatch(/^跳转可用，按名查询索引中/));
    board.cb!({ payload: { ...base, phase: "ready", nav: true, symbols: "ready" } });
    await vi.waitFor(() => expect(langs.value[0]).toEqual({ lang: "java", status: "ok" }));
  });

  it("别的工作区的状态不串进来", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      if (cmd === "lsp_ensure_server") return { ok: true, ready: false };
      return [];
    });
    const { langs } = createStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(board.cb).not.toBeNull());
    board.cb!({ payload: { workspaceRoot: "/other", lang: "java", phase: "ready", nav: true, symbols: "ready", since: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(langs.value[0].status).toBe("indexing");
  });

  it("项目列表不包含辅助语言，旧失败快照不会重新加回 Python", async () => {
    const base = { workspaceRoot: "/ws", nav: false, symbols: "unknown", since: Date.now() };
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages") return ["rust"];
      if (cmd === "lsp_ensure_server") return { ok: true, ready: true };
      if (cmd === "lsp_status") return [
        { ...base, lang: "python", phase: "missing" },
        { ...base, lang: "ruby", phase: "failed", error: "old failure" },
        { ...base, lang: "go", phase: "off" },
        { ...base, lang: "java", phase: "disabled" },
      ];
    });
    const { langs, probing } = createStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(probing.value).toBe(false));
    expect(langs.value).toEqual([{ lang: "rust", status: "ok" }]);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "lsp_ensure_server")).toEqual([
      ["lsp_ensure_server", { workspaceRoot: "/ws", lang: "rust" }],
    ]);
  });

  it.each(["starting", "loading", "indexing", "ready", "sleeping"])("按需服务 %s 事件补入非项目语言，停用后移除", async (phase) => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages" || cmd === "lsp_status") return [];
    });
    const { langs, probing } = createStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(probing.value).toBe(false));
    expect(langs.value).toEqual([]);
    const base = { workspaceRoot: "/ws", lang: "python", nav: true, symbols: "ready", since: Date.now() };
    board.cb!({ payload: { ...base, phase } });
    expect(langs.value.map((l) => l.lang)).toEqual(["python"]);
    board.cb!({ payload: { ...base, phase: "sleeping" } });
    expect(langs.value[0].status).toBe("sleeping");
    board.cb!({ payload: { ...base, phase: "failed", error: "server exited" } });
    expect(langs.value).toEqual([{ lang: "python", status: "failed", error: "server exited" }]);
    board.cb!({ payload: { ...base, phase: "off" } });
    expect(langs.value).toEqual([]);
    board.cb!({ payload: { ...base, phase: "missing" } });
    expect(langs.value).toEqual([]);
    board.cb!({ payload: { ...base, phase: "ready" } });
    expect(langs.value.map((l) => l.lang)).toEqual(["python"]);
    board.cb!({ payload: { ...base, phase: "disabled" } });
    expect(langs.value).toEqual([]);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "lsp_ensure_server")).toBe(false);
  });

  it("快照中的实际活动服务补入列表且项目行不重复", async () => {
    const base = { workspaceRoot: "/ws", nav: true, symbols: "ready", since: Date.now() };
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages") return ["rust"];
      if (cmd === "lsp_ensure_server") return { ok: true, ready: true };
      if (cmd === "lsp_status") return [
        { ...base, lang: "rust", phase: "ready" },
        { ...base, lang: "python", phase: "ready" },
      ];
    });
    const { langs, probing } = createStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(probing.value).toBe(false));
    expect(langs.value).toEqual([{ lang: "rust", status: "ok" }, { lang: "python", status: "ok" }]);
  });

  it("探测尚未返回时也接收按文件启动的状态事件", async () => {
    let resolve!: (value: string[]) => void;
    const pending = new Promise<string[]>((done) => { resolve = done; });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages") return pending;
      if (cmd === "lsp_status") return [];
    });
    const { langs, probing } = createStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("lsp_detect_languages", { workspaceRoot: "/ws" }));
    board.cb!({ payload: { workspaceRoot: "/ws", lang: "python", phase: "ready", nav: true, symbols: "ready", since: 0 } });
    expect(langs.value).toEqual([{ lang: "python", status: "ok" }]);
    resolve([]);
    await vi.waitFor(() => expect(probing.value).toBe(false));
    expect(langs.value).toEqual([{ lang: "python", status: "ok" }]);
  });

  it("切工作区或禁用时清除活动语言并拒绝旧事件", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages" || cmd === "lsp_status") return [];
    });
    const root = ref("/ws-a");
    const enabled = ref(true);
    const { langs, probing } = createStatus(() => root.value, enabled);
    await vi.waitFor(() => expect(probing.value).toBe(false));
    const base = { lang: "python", phase: "ready", nav: true, symbols: "ready", since: 0 };
    board.cb!({ payload: { ...base, workspaceRoot: "/ws-a" } });
    expect(langs.value.map((l) => l.lang)).toEqual(["python"]);
    root.value = "/ws-b";
    await nextTick();
    await vi.waitFor(() => expect(probing.value).toBe(false));
    board.cb!({ payload: { ...base, workspaceRoot: "/ws-a" } });
    expect(langs.value).toEqual([]);
    board.cb!({ payload: { ...base, workspaceRoot: "/ws-b" } });
    expect(langs.value.map((l) => l.lang)).toEqual(["python"]);
    enabled.value = false;
    await nextTick();
    board.cb!({ payload: { ...base, workspaceRoot: "/ws-b" } });
    expect(langs.value).toEqual([]);
  });

  it("切工作区后不接纳旧探测结果或自动启动旧语言", async () => {
    let resolve!: (value: string[]) => void;
    const pending = new Promise<string[]>((done) => { resolve = done; });
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "lsp_detect_languages") return (args as { workspaceRoot: string }).workspaceRoot === "/ws-a" ? pending : ["rust"];
      if (cmd === "lsp_ensure_server") return { ok: true, ready: true };
      if (cmd === "lsp_status") return [];
    });
    const root = ref("/ws-a");
    const { langs, probing } = createStatus(() => root.value, ref(true));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("lsp_detect_languages", { workspaceRoot: "/ws-a" }));
    root.value = "/ws-b";
    await vi.waitFor(() => expect(langs.value).toEqual([{ lang: "rust", status: "ok" }]));
    resolve(["python"]);
    await flushPromises();
    await vi.waitFor(() => expect(probing.value).toBe(false));
    expect(langs.value).toEqual([{ lang: "rust", status: "ok" }]);
    expect(invoke).not.toHaveBeenCalledWith("lsp_ensure_server", { workspaceRoot: "/ws-a", lang: "python" });
  });

  it("禁用后到达的 ensure 结果不重建面板", async () => {
    let resolve!: (value: { ok: boolean; ready: boolean }) => void;
    const pending = new Promise<{ ok: boolean; ready: boolean }>((done) => { resolve = done; });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages") return ["python"];
      if (cmd === "lsp_ensure_server") return pending;
      if (cmd === "lsp_status") return [];
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("lsp_ensure_server", { workspaceRoot: "/ws", lang: "python" }));
    enabled.value = false;
    await nextTick();
    resolve({ ok: true, ready: true });
    await flushPromises();
    expect(langs.value).toEqual([]);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "lsp_status")).toBe(false);
  });

  it("禁用后到达的活动快照不会重新添加 Python", async () => {
    let resolve!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((done) => { resolve = done; });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "lsp_detect_languages") return [];
      if (cmd === "lsp_status") return pending;
    });
    const enabled = ref(true);
    const { langs } = createStatus(() => "/ws", enabled);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("lsp_status", { workspaceRoot: "/ws" }));
    enabled.value = false;
    await nextTick();
    resolve([{ workspaceRoot: "/ws", lang: "python", phase: "ready", nav: true, symbols: "ready", since: 0 }]);
    await flushPromises();
    expect(langs.value).toEqual([]);
  });
});

describe("boardNote：休眠与倒计时", () => {
  const base = { workspaceRoot: "/ws", lang: "java", nav: true, symbols: "ready" as const, since: 0 };
  it("就绪：剩余分钟向上取整；不足一分钟说即将休眠", async () => {
    const { boardNote } = await import("./useLspStatus");
    expect(boardNote({ ...base, phase: "ready", sleepAt: 32 * 60_000 - 1 }, 0)).toBe("32 分钟后休眠");
    expect(boardNote({ ...base, phase: "ready", sleepAt: 30_000 }, 0)).toBe("即将休眠");
  });
  it("编辑器开着文件：不休眠；已休眠：用到时自动唤醒", async () => {
    const { boardNote } = await import("./useLspStatus");
    expect(boardNote({ ...base, phase: "ready", keptBy: "editor" }, 0)).toBe("编辑器开着该语言的文件 · 不休眠");
    expect(boardNote({ ...base, phase: "sleeping" }, 0)).toBe("空闲休眠中，用到时自动唤醒");
  });
});

describe("内存读数", () => {
  it("formatMemory：GB 一位小数、MB 取整", async () => {
    const { formatMemory } = await import("./useLspStatus");
    expect(formatMemory(1.34 * 1024 ** 3)).toBe("1.3 GB");
    expect(formatMemory(512 * 1024 ** 2)).toBe("512 MB");
  });
});
