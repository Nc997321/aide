// 自动化「预授权连接器」候选：内置 MCP（取前端镜像，不另写死）+ 用户配置的。
//
// 2026-10-10 修：此前编辑器写死 ["aide-docs"]，知识库 / 记忆 / 浏览器在自动化里勾不到。
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { builtinMcpServers } from "@aide/sdk/composables/useCustomizations";
import { automationConnectorOptions } from "./connectorOptions";

const names = (user: string[] = []) => automationConnectorOptions(user).map((c) => c.name);

describe("自动化连接器候选", () => {
  it("内置 MCP 全部可选——除了自动化里挂不上的 aide-lsp / aide-sessions", () => {
    const builtin = builtinMcpServers.value.map((s) => s.id);
    expect(builtin).toEqual(expect.arrayContaining(["aide-lsp", "aide-sessions"])); // 镜像里有，这里刻意不列
    expect(names()).toEqual(builtin.filter((id) => id !== "aide-lsp" && id !== "aide-sessions"));
    expect(names()).toEqual(expect.arrayContaining(["aide-docs", "aide-knowledge", "aide-memory", "aide-browser"]));
  });

  it("用户配置的 MCP server 追加在后，与内置重名不重复", () => {
    expect(names(["github", "aide-docs"]).slice(-1)).toEqual(["github"]);
    expect(names(["github", "aide-docs"]).filter((n) => n === "aide-docs")).toHaveLength(1);
  });

  it("免确认就能做不可逆 / 等同本人身份操作的连接器带 caution", () => {
    const caution = automationConnectorOptions(["github"]).filter((c) => c.caution).map((c) => c.name);
    expect(caution).toEqual(["aide-knowledge", "aide-browser", "aide-computer"]);
  });

  it("每个内置连接器都有一句说明（新增内置 MCP 忘了写说明会在这里挂）", () => {
    for (const c of automationConnectorOptions([])) expect(c.note, c.name).not.toBe("");
  });
});
