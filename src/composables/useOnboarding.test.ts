import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted 保证 mockUpdate/mockSettings 在 vi.mock 工厂里可用，且每次 useSettings()
// 返回同一个 update 实例——否则 complete() 调的 update 和测试断言的 update 是两个不同 vi.fn。
const { mockUpdate, mockSettings } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockSettings: { onboarded: false } as { onboarded: boolean },
}));

vi.mock("./useSettings", () => ({
  useSettings: () => ({ settings: mockSettings, update: mockUpdate }),
}));

import { useOnboarding } from "./useOnboarding";

describe("useOnboarding", () => {
  beforeEach(() => {
    const ob = useOnboarding();
    ob.visible.value = false;
    ob.step.value = "welcome";
    mockUpdate.mockClear();
    mockSettings.onboarded = false;
  });

  it("open() 在未 onboarded 时显示向导、停在 welcome", () => {
    const ob = useOnboarding();
    ob.open();
    expect(ob.visible.value).toBe(true);
    expect(ob.step.value).toBe("welcome");
  });

  it("open() 在已 onboarded 时不显示（老用户不弹）", () => {
    mockSettings.onboarded = true;
    const ob = useOnboarding();
    ob.open();
    expect(ob.visible.value).toBe(false);
  });

  it("advance 顺序推进 welcome→workspace→login→model→done，done 触发 complete", () => {
    const ob = useOnboarding();
    ob.open();
    ob.advance(); expect(ob.step.value).toBe("workspace");
    ob.advance(); expect(ob.step.value).toBe("login");
    ob.advance(); expect(ob.step.value).toBe("model");
    ob.advance(); // → done → complete()
    expect(ob.step.value).toBe("done");
    expect(ob.visible.value).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith({ onboarded: true });
  });

  it("complete() 调 update({onboarded:true}) 并隐藏", async () => {
    const ob = useOnboarding();
    ob.open();
    await ob.complete();
    expect(mockUpdate).toHaveBeenCalledWith({ onboarded: true });
    expect(ob.visible.value).toBe(false);
  });

  it("skipAll() 直接 complete（跳过整个引导）", async () => {
    const ob = useOnboarding();
    ob.open();
    ob.skipAll();
    await Promise.resolve();
    expect(mockUpdate).toHaveBeenCalledWith({ onboarded: true });
    expect(ob.visible.value).toBe(false);
  });

  it("openAt('login') 直达指定步（上下文兜底用）", () => {
    const ob = useOnboarding();
    ob.openAt("login");
    expect(ob.visible.value).toBe(true);
    expect(ob.step.value).toBe("login");
  });

  it("back() 回退一步（welcome 不再退）", () => {
    const ob = useOnboarding();
    ob.open();           // welcome
    ob.advance();        // workspace
    ob.back();
    expect(ob.step.value).toBe("welcome");
    ob.back();           // welcome 不再退
    expect(ob.step.value).toBe("welcome");
  });
});