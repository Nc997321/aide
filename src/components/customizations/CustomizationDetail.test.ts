// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, it, expect } from "vitest";
import CustomizationDetail from "./CustomizationDetail.vue";
import type { CustomizationItem } from "../../types/customization";

const mkItem = (type: CustomizationItem["type"]): CustomizationItem => ({
  id: "x",
  name: "x",
  type,
  enabled: true,
  path: "",
  source: "user",
});

describe("CustomizationDetail 门面", () => {
  it("type=mcp_server 渲染 McpServerEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "mcp_server", item: mkItem("mcp_server") } });
    expect(w.findComponent({ name: "McpServerEditor" }).exists()).toBe(true);
  });
  it("type=hook 渲染 HookEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "hook", item: mkItem("hook") } });
    expect(w.findComponent({ name: "HookEditor" }).exists()).toBe(true);
  });
  it("type=skill 渲染 SkillEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "skill", item: mkItem("skill") } });
    expect(w.findComponent({ name: "SkillEditor" }).exists()).toBe(true);
  });
  it("type=agent 渲染 AgentEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "agent", item: mkItem("agent") } });
    expect(w.findComponent({ name: "AgentEditor" }).exists()).toBe(true);
  });
  it("type=instruction 渲染 InstructionEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "instruction", item: mkItem("instruction") } });
    expect(w.findComponent({ name: "InstructionEditor" }).exists()).toBe(true);
  });
  it("透传 item 给子 editor", () => {
    const item = mkItem("mcp_server");
    const w = mount(CustomizationDetail, { props: { type: "mcp_server", item } });
    expect(w.findComponent({ name: "McpServerEditor" }).props("item")).toEqual(item);
  });
});