import { describe, it, expect, vi, beforeEach } from "vitest";
import { cmLsp } from "./cmLsp";
import { useLsp } from "../composables/useLsp";

// mock api（避免真 invoke）
vi.mock("../api", () => ({
  api: {
    lspDidOpen: vi.fn().mockResolvedValue(undefined),
    lspDidChange: vi.fn().mockResolvedValue(undefined),
    lspDidClose: vi.fn().mockResolvedValue(undefined),
    lspCompletion: vi.fn().mockResolvedValue([]),
    lspCompletionResolve: vi.fn().mockResolvedValue({ detail: null, documentation: null }),
    lspSignatureHelp: vi.fn().mockResolvedValue(null),
    lspSemanticTokens: vi.fn().mockResolvedValue([]),
    lspDidSave: vi.fn().mockResolvedValue(undefined),
    lspHover: vi.fn().mockResolvedValue({ content: null }),
    lspDefinition: vi.fn().mockResolvedValue({ status: "ok", results: [] }),
    lspShutdownWorkspace: vi.fn().mockResolvedValue(undefined),
    workspaceSetLspEnabled: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("cmLsp", () => {
  beforeEach(() => useLsp().__resetForTest());

  it("lsp_disabled_no_op_returns_empty_extension", () => {
    const ext = cmLsp({ workspaceRoot: "/p", enabled: false, lang: "rust", filePath: "/p/a.rs" });
    expect(ext).toEqual([]); // 关闭时空扩展
  });

  it("lsp_enabled_returns_nonempty_extension", () => {
    const ext = cmLsp({ workspaceRoot: "/p", enabled: true, lang: "rust", filePath: "/p/a.rs" });
    expect(Array.isArray(ext)).toBe(true);
    expect(ext).not.toEqual([]);
  });

  // didChange debounce 与 diagnostics→lint 映射需真 EditorView + 定时器推进，
  // 当前 vitest 环境为 node（非 jsdom），无法构造 EditorView。
  // 由 Task 16 手测覆盖。
});
