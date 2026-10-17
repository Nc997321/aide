// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { TaskItem } from "@/types/chat";
import TaskListPanel from "./TaskListPanel.vue";

const task = (id: string, status: TaskItem["status"], subject = `任务 ${id}`): TaskItem =>
  ({ id, subject, status }) as TaskItem;

const mountPanel = (tasks: TaskItem[]) =>
  mount(TaskListPanel, { props: { tasks }, global: { directives: { tooltip: {} } }, attachTo: document.body });

describe("TaskListPanel — 单行头条", () => {
  it("头条一行：进度、计数与当前步骤；清单默认不展开", () => {
    const w = mountPanel([task("1", "completed"), task("2", "in_progress", "跑测试"), task("3", "pending")]);
    expect(w.find(".task-summary-count").text()).toBe("1/3");
    expect(w.find(".task-summary-current").text()).toBe("跑测试");
    expect(w.find(".task-summary-bar i").attributes("style")).toContain("33%");
    expect(w.find(".task-pop").exists()).toBe(false);
    w.unmount();
  });

  it("新任务到来不自动展开（浮层不许自己盖住正在流式的正文）", async () => {
    const w = mountPanel([task("1", "pending")]);
    await w.setProps({ tasks: [task("1", "pending"), task("2", "pending")] });
    expect(w.find(".task-pop").exists()).toBe(false);
    w.unmount();
  });

  it("点头条开浮层；点外部 / Esc 收起", async () => {
    const w = mountPanel([task("1", "pending"), task("2", "pending")]);
    await w.find(".task-summary").trigger("click");
    expect(w.findAll(".task-pop .task-item")).toHaveLength(2);

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.find(".task-pop").exists()).toBe(false);

    await w.find(".task-summary").trigger("click");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await w.vm.$nextTick();
    expect(w.find(".task-pop").exists()).toBe(false);
    w.unmount();
  });

  it("全部完成", () => {
    const w = mountPanel([task("1", "completed"), task("2", "completed")]);
    expect(w.find(".task-summary-current").text()).toBe("全部完成");
    w.unmount();
  });
});
