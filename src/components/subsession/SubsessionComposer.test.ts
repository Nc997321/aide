// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const spawnMock = vi.fn();
vi.mock("@aide/sdk/api", () => ({ api: { spawnSubsession: (a: unknown) => spawnMock(a) } }));
const openBeside = vi.fn();
vi.mock("@/composables/usePaneLayout", () => ({ usePaneLayout: () => ({ openSubsession: openBeside }) }));

import SubsessionComposer from "./SubsessionComposer.vue";

function mountIt(props: Record<string, unknown> = {}) {
  return mount(SubsessionComposer, {
    props: {
      parentId: "p1",
      running: 1,
      defaults: () => ({ model: "opus", effort: "high", permissionMode: "auto" }),
      ...props,
    },
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  openBeside.mockReset();
});

describe("SubsessionComposer", () => {
  it("回车派出：任务 = 话 + 原文引用，带上父会话输入框的模型 / 档位 / 权限", async () => {
    spawnMock.mockResolvedValue({ child_id: "c1", title: "按这个实现" });
    const w = mountIt({ quote: "登录失败没有限流。" });
    await w.find("textarea").setValue("按这个实现");
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(spawnMock).toHaveBeenCalledWith({
      parentId: "p1",
      task: "按这个实现\n\n> 登录失败没有限流。",
      model: "opus",
      effort: "high",
      permissionMode: "auto",
    });
    expect(w.text()).toContain("已派出「按这个实现」");
    await w.find(".ssc-link").trigger("click");
    expect(openBeside).toHaveBeenCalledWith("c1");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("Shift+回车不派；没写也没原文时派出按钮不可点", async () => {
    const w = mountIt();
    await w.find("textarea").trigger("keydown", { key: "Enter", shiftKey: true });
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(w.find(".ssc-btn--primary").attributes("disabled")).toBeDefined();
  });

  it("只有原文：留空也能派", async () => {
    spawnMock.mockResolvedValue({ child_id: "c1", title: "t" });
    const w = mountIt({ quote: "原文" });
    await w.find(".ssc-btn--primary").trigger("click");
    await flushPromises();
    expect(spawnMock.mock.calls[0][0].task).toBe("原文");
  });

  it("失败：浮窗不关、写的留着、按钮变重试", async () => {
    spawnMock.mockRejectedValue("子会话没起来：会话进程已退出");
    const w = mountIt();
    await w.find("textarea").setValue("做件事");
    await w.find(".ssc-btn--primary").trigger("click");
    await flushPromises();
    expect(w.find(".ssc-error").text()).toContain("会话进程已退出");
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("做件事");
    expect(w.find(".ssc-btn--primary").text()).toContain("重试");
    expect(w.emitted("close")).toBeFalsy();
  });

  it("满额：提示原因，不让派", async () => {
    const w = mountIt({ running: 4 });
    await w.find("textarea").setValue("做件事");
    expect(w.find(".ssc-meta").text()).toContain("已有 4 个子会话在跑");
    expect(w.find(".ssc-btn--primary").attributes("disabled")).toBeDefined();
  });

  it("写了东西就报 dirty（外层据此不让点外部关掉）", async () => {
    const w = mountIt();
    await w.find("textarea").setValue("x");
    expect(w.emitted("dirty")?.at(-1)).toEqual([true]);
  });
});
