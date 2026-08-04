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
});
