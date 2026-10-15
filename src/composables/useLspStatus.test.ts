import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";

// 捕获 listen 注册的 handler，供测试手动触发就绪/死亡事件（vi.hoisted 保证提升到 mock 之前）
const handlers = vi.hoisted(() => ({
  ready: null as ((ev: { payload: { workspaceRoot: string; lang: string } }) => void) | null,
  dead: null as (() => void) | null,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (ev: unknown) => void) => {
    if (event === "lsp-server-ready") handlers.ready = cb as typeof handlers.ready;
    if (event === "lsp-server-dead") handlers.dead = cb as () => void;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useLspStatus } from "./useLspStatus";

const invoke = vi.mocked((await import("@tauri-apps/api/core")).invoke);

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
    const { langs } = useLspStatus(() => "/ws", enabled);
    await vi.waitFor(() => {
      expect(langs.value).toEqual([
        { lang: "rust", status: "ok" },
        { lang: "java", status: "missing" },
      ]);
    });
  });

  it("does not probe when LSP disabled", async () => {
    const enabled = ref(false);
    useLspStatus(() => "/ws", enabled);
    await new Promise((r) => setTimeout(r, 30));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks failed when ensure throws", async () => {
    // vitest 4 官方推荐 mockRejectedValue（mockImplementation 内 throw 的
    // rejection 可能逃出测试作用域被 vitest 记为 unhandled，见 vitest#1649）。
    invoke.mockResolvedValueOnce(["go"]);
    invoke.mockRejectedValueOnce(new Error("boom"));
    const enabled = ref(true);
    const { langs } = useLspStatus(() => "/ws", enabled);
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
    const { langs } = useLspStatus(() => "/ws", enabled);
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
    const { langs } = useLspStatus(() => "/ws", enabled);
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
    const { langs } = useLspStatus(() => "/ws", enabled);
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
    const { langs } = useLspStatus(() => root.value, enabled);
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
    const { probing, probe } = useLspStatus(() => "/ws", enabled);
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
    const { langs } = useLspStatus(() => "/ws", enabled);
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
    const { langs } = useLspStatus(() => "/ws", enabled);
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
  const board = vi.hoisted(() => ({ cb: null as ((ev: { payload: unknown }) => void) | null }));
  beforeEach(async () => {
    invoke.mockReset();
    board.cb = null;
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockImplementation(async (event: string, cb: (ev: { payload: unknown }) => void) => {
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
    const { langs } = useLspStatus(() => "/ws", ref(true));
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
    const { langs } = useLspStatus(() => "C:\\ws", ref(true));
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
    const { langs } = useLspStatus(() => "/ws", ref(true));
    await vi.waitFor(() => expect(board.cb).not.toBeNull());
    board.cb!({ payload: { workspaceRoot: "/other", lang: "java", phase: "ready", nav: true, symbols: "ready", since: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(langs.value[0].status).toBe("indexing");
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
