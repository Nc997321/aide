import { describe, it, expect, beforeEach } from "vitest";
import { useRightPanel, __resetRightPanelForTest } from "./useRightPanel";

// 模块级单例（与 usePaneLayout 同范式）：用例间共享状态，故每个用例前复位。
beforeEach(() => __resetRightPanelForTest());

describe("select 的三态裁决（沿用旧 onRailSelect）", () => {
  it("折叠态点任意项 → 展开并激活", () => {
    const p = useRightPanel();
    p.select("git");
    expect(p.tab.value).toBe("git");
    expect(p.collapsed.value).toBe(false);
  });

  it("点已激活项 → 折叠（不切走）", () => {
    const p = useRightPanel();
    p.select("git");
    p.select("git");
    expect(p.collapsed.value).toBe(true);
    expect(p.tab.value).toBe("git");
  });

  it("点未激活项 → 切过去，不折叠", () => {
    const p = useRightPanel();
    p.select("git");
    p.select("search");
    expect(p.tab.value).toBe("search");
    expect(p.collapsed.value).toBe(false);
  });
});

describe("browserActive / maximized 都是派生值", () => {
  it("选中浏览器且展开 → browserActive 为真", () => {
    const p = useRightPanel();
    p.select("browser");
    expect(p.browserActive.value).toBe(true);
  });

  it("折叠或切走 → browserActive 为假", () => {
    const p = useRightPanel();
    p.select("browser");
    p.select("git");
    expect(p.browserActive.value).toBe(false);
  });

  it("最大化意图在切走时不成立、切回来自动恢复（不做额外清理）", () => {
    const p = useRightPanel();
    p.select("browser");
    p.setMaximized(true);
    expect(p.maximized.value).toBe(true);

    p.select("git"); // 切走
    expect(p.maximized.value).toBe(false);
    expect(p.wantMaximized.value).toBe(true); // 意图还在

    p.select("browser"); // 切回来
    expect(p.maximized.value).toBe(true);
  });

  it("折叠浏览器 tab 时最大化立刻失效", () => {
    const p = useRightPanel();
    p.select("browser");
    p.setMaximized(true);
    p.select("browser"); // 再点一次 = 折叠
    expect(p.maximized.value).toBe(false);
  });
});

describe("懒挂载", () => {
  it("首次 select('browser') 置 browserEverActive，之后折叠仍为真", () => {
    const p = useRightPanel();
    expect(p.browserEverActive.value).toBe(false);
    p.select("browser");
    expect(p.browserEverActive.value).toBe(true);
    p.select("browser"); // 折叠
    expect(p.browserEverActive.value).toBe(true);
  });
});
