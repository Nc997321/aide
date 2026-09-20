import { describe, expect, it } from "vitest";
import { chimeForDate, pickHeroCopy, type HeroCopy, type Period } from "./heroCopy";
import type { ChatMode } from "../modes";

/** 构造本地时区指定时刻（月份 0 起，与 Date 构造器一致）。 */
function at(h: number, m: number, day = 1, month = 8, year = 2026): Date {
  return new Date(year, month - 1, day, h, m, 0, 0);
}

describe("chimeForDate 时段分段（本地时区）", () => {
  // 每个时段：边界左右各一例（含跨段接缝 4:59/5:00、12:59/13:00、17:59/18:00、22:59/23:00）
  const cases: Array<[number, number, Period, string]> = [
    [0, 0, "late", "夜深了"],
    [4, 59, "late", "夜深了"],
    [5, 0, "morning", "早上好"],
    [10, 59, "morning", "早上好"],
    [11, 0, "noon", "中午好"],
    [12, 59, "noon", "中午好"],
    [13, 0, "afternoon", "下午好"],
    [17, 59, "afternoon", "下午好"],
    [18, 0, "evening", "晚上好"],
    [22, 59, "evening", "晚上好"],
    [23, 0, "late", "夜深了"],
    [23, 59, "late", "夜深了"],
  ];

  it.each(cases)("%02d:%02d → %s（%s）", (h, m, period, greeting) => {
    const chime = chimeForDate(at(h, m));
    expect(chime.period).toBe(period);
    expect(chime.greeting).toBe(greeting);
  });
});

describe("chimeForDate 日期标签", () => {
  it("2026-09-01（星期二）→ 9月1日 · 星期二", () => {
    expect(chimeForDate(at(14, 30, 1, 9)).dateLabel).toBe("9月1日 · 星期二");
  });

  it("12月31日不越月进位", () => {
    const chime = chimeForDate(new Date(2026, 11, 31, 8, 0));
    expect(chime.dateLabel).toMatch(/^12月31日 · /);
    expect(chime.greeting).toBe("早上好");
  });

  it("dateLabel 包含星期且与 getDay 一致", () => {
    const d = new Date(2026, 2, 15);
    const label = chimeForDate(d).dateLabel;
    expect(label).toBe("3月15日 · " + ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()]);
  });
});

describe("chimeForDate 时钟标签", () => {
  it("两位补零格式 08:05 / 14:30 / 00:00", () => {
    expect(chimeForDate(at(8, 5)).clockLabel).toBe("08:05");
    expect(chimeForDate(at(14, 30)).clockLabel).toBe("14:30");
    expect(chimeForDate(at(0, 0)).clockLabel).toBe("00:00");
  });
});

describe("pickHeroCopy seed 轮换（两个池子同一套取模规则）", () => {
  const MODES: ChatMode[] = ["daily", "project"];
  const poolOf = (mode: ChatMode): readonly HeroCopy[] =>
    [0, 1, 2, 3, 4].map((seed) => pickHeroCopy(mode, seed));

  it.each(MODES)("%s：0..4 池内 5 条互相不同（真实轮换），且 headline/body 都非空", (mode) => {
    const all = poolOf(mode);
    expect(new Set(all.map((c) => c.headline)).size).toBe(5);
    for (const c of all) {
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });

  it.each(MODES)("%s：seed=5 回到池首（取模）", (mode) => {
    expect(pickHeroCopy(mode, 5)).toEqual(poolOf(mode)[0]);
  });

  it.each(MODES)("%s：seed=-1 落到池尾（数学模，非 JS 负余）", (mode) => {
    expect(pickHeroCopy(mode, -1)).toEqual(poolOf(mode)[4]);
  });

  it.each(MODES)("%s：seed 越界与大整数稳定收敛", (mode) => {
    const seed = 123_456_789;
    expect(pickHeroCopy(mode, seed)).toEqual(poolOf(mode)[((seed % 5) + 5) % 5]);
    expect(pickHeroCopy(mode, seed)).toEqual(pickHeroCopy(mode, seed));
  });
});
