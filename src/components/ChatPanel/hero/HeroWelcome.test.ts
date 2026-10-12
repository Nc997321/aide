// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

// WorkspacePicker 是既有组件（自有测试覆盖），这里 mock 成按钮桩，聚焦 HeroWelcome 主控。
vi.mock("../../../ui/WorkspacePicker.vue", () => ({
  default: {
    name: "WorkspacePicker",
    props: { path: String },
    emits: ["select"],
    template: `<button data-test="ws-picker" @click="$emit('select', { path: 'C:/demo' })">{{ path || '未选择' }}</button>`,
  },
}));

// 「接着上次」的取数走日常归属 + 会话列表；mock 边界指 SDK 包内模块（不是 @/ 壳）。
const { listSessions } = vi.hoisted(() => ({ listSessions: vi.fn() }));
vi.mock("@aide/sdk/api", () => ({ api: { listSessionsForWorkspace: listSessions } }));
vi.mock("@aide/sdk/utils/dailyWorkspace", () => ({
  ensureDailyWorkspace: async () => true,
  dailyWorkspaceBind: () => ({ wsKey: "daily", wsPath: "/daily" }),
}));

import HeroWelcome from "./HeroWelcome.vue";
import { flushPromises } from "@vue/test-utils";

/** 固定系统时间：2026-09-01（周二）14:30 → 下午好。 */
const AFTERNOON = new Date(2026, 8, 1, 14, 30, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AFTERNOON);
  // seed 固定为 0 → 文案池第一条
  vi.spyOn(Math, "random").mockReturnValue(0);
  listSessions.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HeroWelcome 渲染", () => {
  it("渲染时间问候 + 日期 + 轮换文案（工程 / seed=0 取池首）", () => {
    const wrapper = mount(HeroWelcome, {
      props: { mode: "project", workspacePath: "", modelName: "" },
    });
    const text = wrapper.text();
    expect(text).toContain("下午好。");
    expect(text).toContain("9月1日 · 星期二");
    expect(text).toContain("14:30");
    expect(text).toContain("今天想从哪块代码开始？");
    expect(text).toContain("发个目标、贴段报错，或直接指个文件——我先读代码再动手。");
  });

  it("modelName 缺省显示「默认模型」，传入则显示模型名", async () => {
    const wrapper = mount(HeroWelcome, {
      props: { mode: "project", workspacePath: "", modelName: "" },
    });
    expect(wrapper.text()).toContain("默认模型");

    await wrapper.setProps({ modelName: "Claude Opus" });
    expect(wrapper.text()).toContain("Claude Opus");
  });

  it("workspacePath 透传给 WorkspacePicker", () => {
    const wrapper = mount(HeroWelcome, {
      props: { mode: "project", workspacePath: "C:/demo", modelName: "" },
    });
    expect(wrapper.get('[data-test="ws-picker"]').text()).toContain("C:/demo");
  });

  it("WorkspacePicker 的 select 上抛为 select-workspace", async () => {
    const wrapper = mount(HeroWelcome, {
      props: { mode: "project", workspacePath: "", modelName: "" },
    });
    await wrapper.get('[data-test="ws-picker"]').trigger("click");
    expect(wrapper.emitted("select-workspace")?.[0]?.[0]).toEqual({ path: "C:/demo" });
  });
});

describe("HeroWelcome 模式分叉（日常 / 工程）", () => {
  const props = { workspacePath: "", modelName: "" } as const;

  it("日常：文案取自日常池，且**没有归属选择器**（没有工作区这个概念）", () => {
    const wrapper = mount(HeroWelcome, { props: { ...props, mode: "daily" } });
    const text = wrapper.text();
    expect(text).toContain("今天想聊点什么？");
    expect(text).toContain("随便问，不用先想清楚要干什么。");
    expect(text).not.toContain("新会话位于");
    expect(wrapper.find('[data-test="ws-picker"]').exists()).toBe(false);
  });

  it("工程：有归属行，文案不取自日常池", () => {
    const wrapper = mount(HeroWelcome, { props: { ...props, mode: "project" } });
    expect(wrapper.text()).toContain("新会话位于");
    expect(wrapper.find('[data-test="ws-picker"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("今天想聊点什么？");
  });

  it("分段控件标出当前模式（aria-selected + is-active）", () => {
    const daily = mount(HeroWelcome, { props: { ...props, mode: "daily" } });
    const btns = daily.findAll(".va-mode-btn");
    expect(btns.map((b) => b.text())).toEqual(["日常", "工程"]);
    expect(btns[0].classes()).toContain("is-active");
    expect(btns[1].classes()).not.toContain("is-active");
  });

  it("点另一个模式上抛 select-mode", async () => {
    const wrapper = mount(HeroWelcome, { props: { ...props, mode: "daily" } });
    await wrapper.findAll(".va-mode-btn")[1].trigger("click");
    expect(wrapper.emitted("select-mode")?.[0]).toEqual(["project"]);
  });

  it("切模式重掷文案：日常 → 工程后文案换成工程池那条（seed 固定 0 = 池首）", async () => {
    const wrapper = mount(HeroWelcome, { props: { ...props, mode: "daily" } });
    expect(wrapper.text()).toContain("今天想聊点什么？");

    await wrapper.setProps({ mode: "project" });
    expect(wrapper.text()).toContain("今天想从哪块代码开始？");
    expect(wrapper.text()).not.toContain("今天想聊点什么？");
  });
});

describe("HeroWelcome 日常模式的环境脚注", () => {
  it("日常不渲染模型脚注（模型名就在输入盒的下拉里，不重复）", () => {
    const wrapper = mount(HeroWelcome, {
      props: { mode: "daily", workspacePath: "", modelName: "Opus 5.5" },
    });
    expect(wrapper.text()).not.toContain("Opus 5.5");
    expect(wrapper.find(".va-rule").exists()).toBe(false);
  });

  it("有日常对话时给「接着上次」：取时间最新的一场，点一下上抛 open-session", async () => {
    const hour = 3_600_000;
    listSessions.mockResolvedValue([
      { id: "old", name: "旧的那场", timestamp: AFTERNOON.getTime() - 30 * hour },
      { id: "new", name: "合同要点整理", timestamp: AFTERNOON.getTime() - 3 * hour },
    ]);
    const wrapper = mount(HeroWelcome, {
      props: { mode: "daily", workspacePath: "", modelName: "" },
      global: { directives: { tooltip: {} } },
    });
    await flushPromises();
    const row = wrapper.get(".va-resume");
    expect(row.text()).toContain("合同要点整理");
    expect(row.text()).toContain("3小时前");
    expect(row.text()).not.toContain("旧的那场");
    await row.trigger("click");
    expect(wrapper.emitted("open-session")).toEqual([["new"]]);
  });

  it("工程模式不取、不显示「接着上次」", async () => {
    listSessions.mockResolvedValue([{ id: "a", name: "某场", timestamp: AFTERNOON.getTime() }]);
    const wrapper = mount(HeroWelcome, {
      props: { mode: "project", workspacePath: "", modelName: "" },
    });
    await flushPromises();
    expect(wrapper.find(".va-resume").exists()).toBe(false);
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe("HeroWelcome 跨时段翻新", () => {
  const base = { mode: "daily", workspacePath: "", modelName: "" } as const;

  it("60s 后时钟走到 14:31（时钟不冻结）", async () => {
    const wrapper = mount(HeroWelcome, { props: base });
    expect(wrapper.text()).toContain("14:30");

    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.text()).toContain("14:31");
  });

  it("60s 后时段未变则问候不变", async () => {
    const wrapper = mount(HeroWelcome, { props: base });
    expect(wrapper.text()).toContain("下午好。");

    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.text()).toContain("下午好。");
  });

  it("跨过 18:00 边界后问候翻成「晚上好」", async () => {
    const wrapper = mount(HeroWelcome, { props: base });
    expect(wrapper.text()).toContain("下午好。");

    vi.setSystemTime(new Date(2026, 8, 1, 18, 0, 0, 0));
    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.text()).toContain("晚上好。");
  });

  it("卸载后定时器清理（F2）", () => {
    const wrapper = mount(HeroWelcome, { props: base });
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
