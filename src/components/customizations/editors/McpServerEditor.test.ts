// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi } from "vitest";
import McpServerEditor from "./McpServerEditor.vue";

vi.mock("../../../api/customization", () => ({
  testMcpConnection: vi.fn().mockResolvedValue({ status: "ok", tools: ["a", "b"], duration_ms: 10 }),
}));

const item: any = {
  id: "x",
  name: "playwright",
  type: "mcp_server",
  enabled: true,
  path: "",
  source: "user",
  metadata: { command: "npx", args: ["-y", "srv"], env: {} },
};

describe("McpServerEditor", () => {
  it("stdio 渲染 command/args/env", () => {
    const w = mount(McpServerEditor, { props: { item } });
    expect(w.text()).toContain("command");
    expect(w.text()).toContain("args");
    expect(w.text()).toContain("env");
    const commandInput = w
      .findAll("input")
      .find((i) => (i.element as HTMLInputElement).value === "npx");
    expect(commandInput).toBeTruthy();
  });

  it("切到 sse 隐藏 command，显示 url", async () => {
    const w = mount(McpServerEditor, { props: { item } });
    const sseBtn = w.findAll("button").find((b) => b.text() === "sse")!;
    await sseBtn.trigger("click");
    expect(w.text()).toContain("url");
    expect(w.text()).not.toContain("command");
  });

  it("测试连接点亮绿灯 + 工具数", async () => {
    const w = mount(McpServerEditor, { props: { item } });
    await w.find("button.test-conn").trigger("click");
    await flushPromises();
    expect(w.find(".dot-ok").exists()).toBe(true);
    expect(w.text()).toContain("2 工具");
  });

  it("内置来源只读（无保存/测试按钮）", () => {
    const w = mount(McpServerEditor, { props: { item: { ...item, source: "builtin" } } });
    expect(w.find("button.test-conn").exists()).toBe(false);
    expect(w.find("button.save-btn").exists()).toBe(false);
  });
});