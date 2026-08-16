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