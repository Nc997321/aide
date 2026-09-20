// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SidebarDailySection from "./SidebarDailySection.vue";
import type { Session } from "../types";

const s = (id: string, name: string, timestamp = Date.now()): Session => ({ id, name, timestamp });

const mountSection = (props: {
  sessions?: Session[];
  activeSessionId?: string;
  collapsed?: boolean;
}) =>
  mount(SidebarDailySection, {
    props: {
      sessions: props.sessions ?? [],
      activeSessionId: props.activeSessionId ?? "",
      collapsed: props.collapsed ?? false,
    },
  });

describe("SidebarDailySection（侧栏「日常」根分区）", () => {
  it("栏头写「日常」，计数等于会话数", () => {
    const w = mountSection({ sessions: [s("a", "甲"), s("b", "乙")] });
    expect(w.text()).toContain("日常");
    expect(w.text()).toContain("2");
  });

  it("零会话：显示空态，不显示计数", () => {
    const w = mountSection({ sessions: [] });
    expect(w.text()).toContain("还没有日常对话");
    expect(w.find(".sec-count").exists()).toBe(false);
  });

  it("会话行直接挂分区下（**没有工作区行那一层**）", () => {
    const w = mountSection({ sessions: [s("a", "甲")] });
    expect(w.find(".workspace-item").exists()).toBe(false);
    expect(w.findAll(".subtree > .session-row").length).toBe(0); // 行在 .session-anim-group 里
    expect(w.findAll(".sec-subtree .session-row")).toHaveLength(1);
  });

  it("点会话行 emit select（带 sid）", async () => {
    const w = mountSection({ sessions: [s("a", "甲")] });
    await w.find(".session-row").trigger("click");
    expect(w.emitted("select")?.[0]).toEqual(["a"]);
  });

  it("右键会话行 emit contextmenu（具名载荷，event 与 sid 不错位）", async () => {
    const w = mountSection({ sessions: [s("a", "甲")] });
    await w.find(".session-row").trigger("contextmenu");
    const payload = w.emitted("contextmenu")?.[0]?.[0] as { event: MouseEvent; sid: string };
    expect(payload.sid).toBe("a");
    expect(payload.event).toBeInstanceOf(Event);
  });

  it("当前会话高亮 on", () => {
    const w = mountSection({ sessions: [s("a", "甲"), s("b", "乙")], activeSessionId: "b" });
    const rows = w.findAll(".session-row");
    expect(rows[0].classes()).not.toContain("on");
    expect(rows[1].classes()).toContain("on");
  });

  it("折叠时不渲染会话行（子级整段收起）", () => {
    const w = mountSection({ sessions: [s("a", "甲")], collapsed: true });
    expect(w.find(".session-row").exists()).toBe(false);
    expect(w.find(".sec-head").exists()).toBe(true);
  });

  it("点分区头 emit toggle", async () => {
    const w = mountSection({ sessions: [s("a", "甲")] });
    await w.find(".sec-head").trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
  });
});
