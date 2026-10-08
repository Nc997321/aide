import { describe, it, expect } from "vitest";
import { lspMcpRegistration, LSP_ALLOW_RULE, LSP_INSTRUCTIONS, LSP_TOOL_NAMES } from "./lspTools.js";
import type { LspToolsDeps } from "./lspTools.js";

const OK: LspToolsDeps = {
  cwd: "/proj",
  emit: () => {},
  env: {} as NodeJS.ProcessEnv,
  trusted: true,
  lspLanguages: ["rust"],
};

const EXPECTED_TOOLS = ["lsp_symbols", "lsp_references", "lsp_definition", "lsp_implementations", "lsp_outline"];

describe("lspMcpRegistration 的四档挂载闸门", () => {
  it("全满足 → 挂载 aide-lsp server", () => {
    const spec = lspMcpRegistration(OK);
    expect(spec).not.toBeNull();
    expect(spec!["aide-lsp"]).toBeDefined();
  });

  it("未信任 → 不挂载", () => {
    expect(lspMcpRegistration({ ...OK, trusted: false })).toBeNull();
  });

  /// 没有配得上 LSP 的语言就别挂：工具 schema 每轮重发，白付 token，
  /// 还会诱导模型去调一个注定返回 no_server 的工具。
  it("该工作区没有配得上 LSP 的语言 → 不挂载", () => {
    expect(lspMcpRegistration({ ...OK, lspLanguages: [] })).toBeNull();
  });

  it("env AIDE_LSP_TOOLS=off → 不挂载（逃生舱，同 docx 惯例）", () => {
    expect(
      lspMcpRegistration({ ...OK, env: { AIDE_LSP_TOOLS: "off" } as NodeJS.ProcessEnv })
    ).toBeNull();
  });

  it("放行前缀是 server 级（与 docs 同款）", () => {
    expect(LSP_ALLOW_RULE).toBe("mcp__aide-lsp");
  });

  /// 工具名冻结：与 Rust 侧 `tool` 字段的映射是 `lsp_X` → `X`，名字漂移会让
  /// 事件里带出主进程不认识的 tool，静默落到 unknown 分支。
  it("工具名清单冻结（lsp_X → Rust 侧 X）", () => {
    expect([...LSP_TOOL_NAMES]).toEqual(EXPECTED_TOOLS);
    for (const t of LSP_TOOL_NAMES) expect(t.startsWith("lsp_")).toBe(true);
  });

  /// instructions 是 server 级的引导（实证：光注册工具模型会无视，
  /// instructions 才翻转行为）。2026-09-29 起它按**模型真实的 grep 形状**写：每种 grep
  /// 换成哪个调用。它还必须讲清三件事：纯文本仍归 Grep、调用不会空等（文本兜底）、
  /// 只有「confirmed negative」才证明没有（红线在 server 级的那一半）。
  it("instructions：grep 形状 → 调用映射，边界与红线都在", () => {
    for (const t of EXPECTED_TOOLS) expect(LSP_INSTRUCTIONS).toContain(t);
    expect(LSP_INSTRUCTIONS).toMatch(/grep -n "fn foo" -A 30/); // 定义 + 函数体的那种 grep
    expect(LSP_INSTRUCTIONS).toMatch(/Grep stays right for non-code text/); // 边界
    expect(LSP_INSTRUCTIONS).toMatch(/never hang/i); // 不空等
    expect(LSP_INSTRUCTIONS).toMatch(/confirmed negative/); // 红线
    expect(LSP_INSTRUCTIONS).toMatch(/annotated/); // grep 顺带作答
  });
});
