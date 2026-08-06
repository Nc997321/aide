import { describe, it, expect, vi, beforeEach } from "vitest";

// mock api: lspDefinition / codegraphGotoDefinition / grepSymbol
vi.mock("../api", () => ({
  api: {
    lspDefinition: vi.fn(),
    codegraphGotoDefinition: vi.fn(),
    grepSymbol: vi.fn(),
    workspaceSetLspEnabled: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useGotoDefinition } from "./useGotoDefinition";
import { api } from "../api";
import { useLsp } from "./useLsp";

describe("useGotoDefinition.search provider chain", () => {
  beforeEach(() => {
    useLsp().__resetForTest();
    vi.clearAllMocks();
  });

  it("lsp_first_then_codegraph_then_grep", async () => {
    (api.lspDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/b.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    // 开 LSP（直接置 enabled，绕过 enableLsp 的 tauri invoke）
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
    expect(api.codegraphGotoDefinition).not.toHaveBeenCalled();
  });

  it("lsp_error_falls_through_to_codegraph", async () => {
    (api.lspDefinition as any).mockRejectedValue(new Error("server dead"));
    (api.codegraphGotoDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    // 开 LSP（直接置 enabled）
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(api.codegraphGotoDefinition).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
  });

  it("lsp_off_skips_lsp_goes_codegraph", async () => {
    (api.codegraphGotoDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    // LSP 未开
    const { search } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs" });
    expect(api.lspDefinition).not.toHaveBeenCalled();
    expect(api.codegraphGotoDefinition).toHaveBeenCalled();
  });

  it("lsp_self_ref_filtered_when_absolute_path", async () => {
    // LSP 返回绝对路径（uri_to_path 出来），source.sourceFile 是相对路径；
    // 归一后自引用（同文件同行）应被滤掉，只留真正的另一处定义。
    (api.lspDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "/p/main.rs", line: 1, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
      { symbol: { name: "foo", file: "/p/other.rs", line: 5, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(results.value.length).toBe(1);
    expect(results.value[0].symbol.file).toBe("/p/other.rs");
  });
});
