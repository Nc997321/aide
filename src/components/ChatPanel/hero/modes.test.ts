import { describe, it, expect } from "vitest";
import { DEFAULT_HERO_MODE, HERO_MODES } from "./modes";
import { heroCopyPool, pickHeroCopy } from "./heroCopy";

describe("hero 模式表", () => {
  it("默认是日常", () => {
    expect(DEFAULT_HERO_MODE).toBe("daily");
  });

  it("两个模式各有名字，顺序是 日常 → 工程", () => {
    expect(HERO_MODES.map((m) => m.id)).toEqual(["daily", "project"]);
    expect(HERO_MODES.map((m) => m.label)).toEqual(["日常", "工程"]);
  });
});

describe("pickHeroCopy 分模式", () => {
  it("两个池子的 headline 不重叠（模式切换必须是看得见的）", () => {
    const daily = new Set(heroCopyPool("daily").map((c) => c.headline));
    const project = new Set(heroCopyPool("project").map((c) => c.headline));
    expect(daily.size).toBeGreaterThan(0);
    for (const h of daily) expect(project.has(h)).toBe(false);
  });

  it("每个模式只从自己的池子里取；负数与越界 seed 都落在池内", () => {
    for (const mode of ["daily", "project"] as const) {
      const pool = heroCopyPool(mode);
      for (const seed of [-7, -1, 0, 3, 9999]) {
        expect(pool).toContain(pickHeroCopy(mode, seed));
      }
    }
  });

  it("同 seed 同模式必同文案（纯函数，重渲染不抖动）", () => {
    expect(pickHeroCopy("daily", 42)).toEqual(pickHeroCopy("daily", 42));
    expect(pickHeroCopy("project", 42)).toEqual(pickHeroCopy("project", 42));
  });

  it("两个池子都满足「headline 是邀请、body 说怎么开始」的最小约束", () => {
    for (const mode of ["daily", "project"] as const) {
      for (const c of heroCopyPool(mode)) {
        expect(c.headline.length).toBeGreaterThan(0);
        expect(c.body.length).toBeGreaterThan(0);
      }
    }
  });
});
