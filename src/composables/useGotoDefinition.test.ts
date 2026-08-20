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

import { useGotoDefinition, __resetGotoForTest } from "./useGotoDefinition";
import * as resolver from "./definitionResolver";
import { api } from "../api";
import { useLsp } from "./useLsp";

describe("useGotoDefinition.search provider chain", () => {
  beforeEach(() => {
    useLsp().__resetForTest();
    __resetGotoForTest();
    vi.clearAllMocks();
  });

  it("lsp_first_then_codegraph_then_grep", async () => {
    (api.lspDefinition as any).mockResolvedValue({
      status: "ok",
      results: [
        { symbol: { name: "foo", file: "p/b.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
      ],
    });
    // 开 LSP（直接置 enabled，绕过 enableLsp 的 tauri invoke）
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
    expect(results.value[0].source).toBe("lsp");
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
    expect(results.value[0].source).toBe("ast");
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
    (api.lspDefinition as any).mockResolvedValue({
      status: "ok",
      results: [
        { symbol: { name: "foo", file: "/p/main.rs", line: 1, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
        { symbol: { name: "foo", file: "/p/other.rs", line: 5, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
      ],
    });
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(results.value.length).toBe(1);
    expect(results.value[0].symbol.file).toBe("/p/other.rs");
  });

  // ── 新增：status 分流 / retry / seq cancel ──

  it("timeout_single_no_retry", async () => {
    // 删 retry：单次 timeout → 降级提示，不 auto-fallback（无第二次 LSP 调用）
    (api.lspDefinition as any).mockResolvedValue({ status: "timeout", results: [] });
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results, searching, degraded } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3, sourceWordColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
    expect(api.codegraphGotoDefinition).not.toHaveBeenCalled();
    expect(degraded.value).toBe("timeout");
    expect(results.value.length).toBe(0);
    expect(searching.value).toBe(false);
  });

  it("not_ready_falls_to_codegraph_with_degraded", async () => {
    (api.lspDefinition as any).mockResolvedValue({ status: "not_ready", results: [] });
    (api.codegraphGotoDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results, degraded } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalledTimes(1); // not_ready 不重试
    expect(api.codegraphGotoDefinition).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
    expect(results.value[0].source).toBe("ast");
    expect(degraded.value).toBe("not_ready");
  });

  it("gone_falls_to_codegraph_no_degraded", async () => {
    (api.lspDefinition as any).mockResolvedValue({ status: "gone", results: [] });
    (api.codegraphGotoDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results, degraded } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
    expect(api.codegraphGotoDefinition).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
    expect(degraded.value).toBe(null);
  });

  it("stale_request_cancelled_newer_wins", async () => {
    // 首调 LSP deferred（pending），次调 LSP 立即 ok → 次调结果胜；首调后 resolve 应被 seq guard 弃。
    let resolveFirst: (v: any) => void = () => {};
    (api.lspDefinition as any)
      .mockImplementationOnce(() => new Promise<any>(r => { resolveFirst = r; }))
      .mockResolvedValueOnce({
        status: "ok",
        results: [
          { symbol: { name: "foo", file: "/p/second.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
        ],
      });
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, results } = useGotoDefinition();
    const first = search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    const second = search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 5, sourceExt: "rs", sourceColumn: 3 });
    await second; // 次调完成 → results = second.rs
    expect(results.value.length).toBe(1);
    expect(results.value[0].symbol.file).toBe("/p/second.rs");
    resolveFirst({
      status: "ok",
      results: [
        { symbol: { name: "foo", file: "/p/first.rs", line: 1, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
      ],
    });
    await first; // 首调 await 结束，seq guard 让它不覆盖
    expect(results.value[0].symbol.file).toBe("/p/second.rs");
  });

  it("searching_true_while_lsp_pending", async () => {
    let resolveLsp: (v: any) => void = () => {};
    (api.lspDefinition as any).mockImplementationOnce(() => new Promise<any>(r => { resolveLsp = r; }));
    (api.codegraphGotoDefinition as any).mockResolvedValue([]);
    (api.grepSymbol as any).mockResolvedValue([]);
    useLsp().lspEnabledWorkspaces.value.add("/p");
    const { search, searching } = useGotoDefinition();
    const p = search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    // LSP pending 期间 searching 应为 true（浮层显示「跳转中…」而非「未找到定义」）
    expect(searching.value).toBe(true);
    resolveLsp({ status: "ok", results: [] }); // ok 空 → 落本地索引（也 mock 空）
    await p;
    expect(searching.value).toBe(false);
  });

  // ── 缓存 + 预取（definitionResolver 层）──

  it("cache_hit_instant_no_api_no_loading", async () => {
    // 预取先用与 click 相同的词首列暖缓存，click 命中 → 不调 api、无「跳转中…」
    (api.lspDefinition as any).mockResolvedValue({
      status: "ok",
      results: [{ symbol: { name: "foo", file: "/p/def.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null }],
    });
    useLsp().lspEnabledWorkspaces.value.add("/p");
    resolver.prefetch("/p", "/p/main.rs", 1, 3, "foo"); // 词首列 3
    await new Promise<void>(r => setTimeout(r, 0)); // 等 settle
    vi.clearAllMocks();
    const { search, results, searching } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 5, sourceWordColumn: 3 });
    expect(api.lspDefinition).not.toHaveBeenCalled(); // 命中缓存
    expect(results.value.length).toBe(1);
    expect(results.value[0].source).toBe("lsp");
    expect(searching.value).toBe(false);
  });

  it("prefetch_warms_cache_single_api", async () => {
    (api.lspDefinition as any).mockResolvedValue({
      status: "ok",
      results: [{ symbol: { name: "foo", file: "/p/def.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null }],
    });
    useLsp().lspEnabledWorkspaces.value.add("/p");
    resolver.prefetch("/p", "/p/main.rs", 1, 3, "foo");
    await new Promise<void>(r => setTimeout(r, 0));
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 5, sourceWordColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalledTimes(1); // 仅预取那一次；click 命中缓存
    expect(results.value.length).toBe(1);
    expect(results.value[0].source).toBe("lsp");
  });

  it("edit_invalidates_then_refetches", async () => {
    (api.lspDefinition as any).mockResolvedValue({
      status: "ok",
      results: [{ symbol: { name: "foo", file: "/p/def.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null }],
    });
    useLsp().lspEnabledWorkspaces.value.add("/p");
    resolver.prefetch("/p", "/p/main.rs", 1, 3, "foo");
    await new Promise<void>(r => setTimeout(r, 0));
    resolver.invalidateFile("/p/main.rs"); // 编辑失效
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceFileAbs: "/p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 5, sourceWordColumn: 3 });
    expect(api.lspDefinition).toHaveBeenCalledTimes(2); // 预取 + 失效后重取
    expect(results.value.length).toBe(1);
  });
});