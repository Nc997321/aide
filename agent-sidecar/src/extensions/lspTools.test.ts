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

const EXPECTED_TOOLS = ["lsp_symbols", "lsp_references", "lsp_definition", "lsp_implementations"];

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

  it("env AIDE_LSP_TOOLS=off → 不挂载（逃生舱，同 codegraph/docx 惯例）", () => {
    expect(
      lspMcpRegistration({ ...OK, env: { AIDE_LSP_TOOLS: "off" } as NodeJS.ProcessEnv })
    ).toBeNull();
  });

  it("放行前缀是 server 级（与 codegraph 同款）", () => {
    expect(LSP_ALLOW_RULE).toBe("mcp__aide-lsp");
  });

  /// 工具名冻结：与 Rust 侧 `tool` 字段的映射是 `lsp_X` → `X`，名字漂移会让
  /// 事件里带出主进程不认识的 tool，静默落到 unknown 分支。
  it("工具名清单冻结（lsp_X → Rust 侧 X）", () => {
    expect([...LSP_TOOL_NAMES]).toEqual(EXPECTED_TOOLS);
    for (const t of LSP_TOOL_NAMES) expect(t.startsWith("lsp_")).toBe(true);
  });

  /// instructions 是 server 级的引导（codegraph 的实证：光注册工具模型会无视，
  /// instructions 才翻转行为）。它必须同时讲清「用在语义问题」与「何时退回 Grep」，
  /// 以及**状态语义**——非 ready 的空结果不代表没有，这是红线在 server 级的那一半。
  ///
  /// 注：每个工具的 description 也是引导手段，但 SDK 的活对象无法内省到
  /// tools 数组深处（`Object.values` 够不着），单测射程到此为止；
  /// 「工具真的出现在模型工具列表里」由端到端验收（计划的 Task 6）负责。
  it("instructions 讲清用途、边界与状态语义", () => {
    expect(LSP_INSTRUCTIONS).toMatch(/grep/i); // 边界：纯文本仍归 Grep
    expect(LSP_INSTRUCTIONS).toMatch(/compiler-precise|real reference/i); // 用途：语义精确
    expect(LSP_INSTRUCTIONS).toMatch(/status/i); // 状态语义
    expect(LSP_INSTRUCTIONS).toMatch(/indexing|index/i); // 冷启动
    expect(LSP_INSTRUCTIONS).toMatch(/never report "no references"/i); // 红线
  });
});
