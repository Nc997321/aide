import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useLspStatus } from "./useLspStatus";

const invoke = vi.mocked((await import("@tauri-apps/api/core")).invoke);

describe("useLspStatus", () => {
  beforeEach(() => invoke.mockReset());

  it("probes languages and maps ensure outcome to status", async () => {
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const lang = (args as { lang?: string } | undefined)?.lang;
      if (cmd === "lsp_detect_languages") return ["rust", "java"];
      if (cmd === "lsp_ensure_server") {
        return lang === "rust"
          ? { ok: true }
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

  it("re-probes on workspace change and clears stale langs", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["rust"];
      return { ok: true };
    });
    const root = ref("/ws-a");
    const enabled = ref(true);
    const { langs } = useLspStatus(() => root.value, enabled);
    await vi.waitFor(() => expect(langs.value).toEqual([{ lang: "rust", status: "ok" }]));
    invoke.mockClear();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "lsp_detect_languages") return ["java"];
      return { ok: true };
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

  // 注：ensure 挂起 → withTimeout(8s) → failed 的超时路径不做单测——挂起 invoke
  // 在 vitest 4 下触发 teardown 超时（环境限制）；catch 路径已由
  // "marks failed when ensure throws" 覆盖，withTimeout 本身是薄封装。
});
