import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRightPanel, rightPanelWidthSource, LAYOUT_ANIM_MS, __resetRightPanelForTest } from "./useRightPanel";

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

describe("ensureBrowserShown：幂等展开（agent 的 focus 请求走它）", () => {
  it("用户正看着浏览器时不会把面板收起来", () => {
    const p = useRightPanel();
    p.select("browser"); // 展开
    expect(p.collapsed.value).toBe(false);

    p.ensureBrowserShown();
    p.ensureBrowserShown(); // 幂等：调几次都一样

    expect(p.collapsed.value).toBe(false);
    expect(p.tab.value).toBe("browser");
  });

  it("从别的 tab 切回浏览器，并保证面板是展开的", () => {
    const p = useRightPanel();
    p.select("files");
    p.ensureBrowserShown();
    expect(p.tab.value).toBe("browser");
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

describe("宽度档位", () => {
  it("浏览器停靠态用宽档；最大化 / 其它 tab 用窄档", () => {
    const p = useRightPanel();
    expect(p.widthProfile.value).toBe("narrow");
    p.select("browser");
    expect(p.widthProfile.value).toBe("browser");
    p.setMaximized(true);
    expect(p.widthProfile.value).toBe("narrow"); // 最大化吃满，宽度不再参与布局
  });

  it("值存在 store 里（切档往返不丢）", () => {
    const p = useRightPanel();
    p.setWidth("browser", 720);
    expect(p.widths.value.browser).toBe(720);
  });
});

describe("rightPanelWidthSource", () => {
  const measure = () => ({ appW: 1600, leftW: 280 });

  it("active 跟随 store 的档位", () => {
    const p = useRightPanel();
    const src = rightPanelWidthSource(measure);
    expect(src.active()).toBe("narrow");
    p.select("browser");
    expect(src.active()).toBe("browser");
  });

  it("宽档：初值 = 窗口一半，上限给聊天留 400px", () => {
    const src = rightPanelWidthSource(measure);
    const limits = src.limits("browser");
    expect((limits.initial as () => number)()).toBe(800);
    expect(limits.min).toBe(420);
    expect((limits.max as () => number)()).toBe(1600 - 280 - 400 - 2); // 918
  });

  it("窄档与旧行为一致（340 / 300..540）", () => {
    const src = rightPanelWidthSource(measure);
    const limits = src.limits("narrow");
    expect(limits.initial).toBe(340);
    expect(limits.min).toBe(300);
    expect(limits.max).toBe(540);
  });

  it("窗口过窄 → max < min（由 useResizable 按 min 收）", () => {
    const src = rightPanelWidthSource(() => ({ appW: 900, leftW: 280 }));
    const limits = src.limits("browser");
    expect((limits.max as () => number)()).toBeLessThan(limits.min);
  });

  it("读到的已记宽度能写回（store 是唯一主人）", () => {
    const p = useRightPanel();
    const src = rightPanelWidthSource(measure);
    src.set("browser", 700);
    expect(src.get("browser")).toBe(700);
    expect(p.widths.value.browser).toBe(700);
  });
});

// 「切进日常就收起右栏」用的裁决（spec 2026-09-20）。幂等、不动"上次看的是哪一栏"。
describe("collapse", () => {
  it("从展开态收起", () => {
    const p = useRightPanel();
    p.select("git");
    expect(p.collapsed.value).toBe(false);

    p.collapse();
    expect(p.collapsed.value).toBe(true);
  });

  it("幂等：已经收起再调不报错", () => {
    const p = useRightPanel();
    p.collapse();
    p.collapse();
    expect(p.collapsed.value).toBe(true);
  });

  it("不切走 tab —— 收起只关面板，\"上次看的是哪一栏\"留着", () => {
    const p = useRightPanel();
    p.select("git");
    p.collapse();
    expect(p.tab.value).toBe("git");
  });

  it("收起的浏览器 tab 不再算 active（视图可见性总闸跟着关）", () => {
    const p = useRightPanel();
    p.select("browser");
    expect(p.browserActive.value).toBe(true);

    p.collapse();
    expect(p.browserActive.value).toBe(false);
  });
});

describe("ensureTabShown：幂等展开任意 tab（结算卡的「变更面板 ↗」走它）", () => {
  it("已在该 tab 且面板展开时再点 → 不收起（select 是 toggle，不能用）", () => {
    const p = useRightPanel();
    p.select("changes"); // 展开
    expect(p.collapsed.value).toBe(false);

    p.ensureTabShown("changes");
    p.ensureTabShown("changes"); // 幂等：调几次都一样

    expect(p.tab.value).toBe("changes");
    expect(p.collapsed.value).toBe(false);
  });

  it("从别的 tab 切过去，并保证面板是展开的", () => {
    const p = useRightPanel();
    p.select("files");
    p.ensureTabShown("changes");
    expect(p.tab.value).toBe("changes");
    expect(p.collapsed.value).toBe(false);
  });

  it("收起态调它 → 展开（不切走别的 tab 的语义）", () => {
    const p = useRightPanel();
    p.collapse();
    p.ensureTabShown("changes");
    expect(p.collapsed.value).toBe(false);
    expect(p.tab.value).toBe("changes");
  });

  it("browser 走同一条路径：懒挂载标记照旧置位", () => {
    const p = useRightPanel();
    p.ensureTabShown("browser");
    expect(p.browserEverActive.value).toBe(true);
    p.ensureTabShown("browser"); // 幂等
    expect(p.collapsed.value).toBe(false);
  });

  it("非 browser 的 tab 不动 browserEverActive（懒挂载只认浏览器）", () => {
    const p = useRightPanel();
    p.ensureTabShown("changes");
    expect(p.browserEverActive.value).toBe(false);
  });
});

// 别的模块请求「在右栏打开一个地址」（资料库的网页产物预览走它，spec 2026-09-30 §4.6）。
// 右栏只记待办 + 展开；消费是 BrowserPanel 自己的事（它的内部状态不对外暴露）。
describe("openInBrowser：待打开地址的待办与消费", () => {
  it("展开右栏并记住要打开的地址", () => {
    const p = useRightPanel();
    p.collapse(); // 前置：右栏是收起的
    p.openInBrowser("http://127.0.0.1:8788/p/abc");

    expect(p.tab.value).toBe("browser");
    expect(p.collapsed.value).toBe(false);
    expect(p.pendingBrowserUrl.value).toBe("http://127.0.0.1:8788/p/abc");
  });

  it("消费之后待办清空，不会被第二个面板重复打开", () => {
    const p = useRightPanel();
    p.openInBrowser("http://127.0.0.1:8788/p/abc");

    expect(p.consumePendingBrowserUrl()).toBe("http://127.0.0.1:8788/p/abc");
    expect(p.consumePendingBrowserUrl()).toBeNull();
    expect(p.pendingBrowserUrl.value).toBeNull();
  });

  it("连开两个地址时后者覆盖前者（排队没有语义）", () => {
    const p = useRightPanel();
    p.openInBrowser("http://127.0.0.1:8788/p/one");
    p.openInBrowser("http://127.0.0.1:8788/p/two");

    expect(p.pendingBrowserUrl.value).toBe("http://127.0.0.1:8788/p/two");
  });

  it("已经在浏览器 tab 时不会把面板收起来（幂等展开，不是 toggle）", () => {
    const p = useRightPanel();
    p.ensureBrowserShown();
    p.openInBrowser("http://127.0.0.1:8788/p/abc");

    expect(p.collapsed.value).toBe(false);
    expect(p.tab.value).toBe("browser");
  });

  it("懒挂载标记照旧置位（浏览器组件要被挂起来才有人消费待办）", () => {
    const p = useRightPanel();
    expect(p.browserEverActive.value).toBe(false);
    p.openInBrowser("http://127.0.0.1:8788/p/abc");
    expect(p.browserEverActive.value).toBe(true);
  });
});

describe("开合动画状态（原生浏览器视图据此推迟露头）", () => {
  it("展开 / 收起 / 换档都置 layoutAnimating，落定后清除并放行等待者", async () => {
    vi.useFakeTimers();
    try {
      const p = useRightPanel();
      expect(p.layoutAnimating.value).toBe(false);

      p.select("git"); // 展开
      expect(p.layoutAnimating.value).toBe(true);
      let settled = false;
      void p.whenLayoutSettled().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(LAYOUT_ANIM_MS + 50);
      expect(p.layoutAnimating.value).toBe(false);
      expect(settled).toBe(true);

      p.select("browser"); // 窄档 → 宽档
      expect(p.layoutAnimating.value).toBe(true);
      await vi.advanceTimersByTimeAsync(LAYOUT_ANIM_MS + 50);

      p.select("browser"); // 收起
      expect(p.layoutAnimating.value).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("窄档内部切 tab 不触发（轨道没变）；没在动时 whenLayoutSettled 立即 resolve", async () => {
    vi.useFakeTimers();
    try {
      const p = useRightPanel();
      p.select("git");
      await vi.advanceTimersByTimeAsync(LAYOUT_ANIM_MS + 50);
      p.select("search");
      expect(p.layoutAnimating.value).toBe(false);
      await expect(p.whenLayoutSettled()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
