/**
 * hero 欢迎页的文案核心：时间问候 + 轮换文案，纯函数、无 IO/时钟/随机，
 * 同输入必同输出。UI 组件负责喂时间与 seed，这里只回答「现在该说什么」。
 */

/** 一天问候时段。跨时段页面开着不动时，由组件层定时重算（见 HeroWelcome）。 */
export type Period = "morning" | "noon" | "afternoon" | "evening" | "late";

/** 一条「此时说什么」：时段 + 问候语 + 中文日期 + 时钟。 */
export interface Chime {
  readonly period: Period;
  readonly greeting: string;
  readonly dateLabel: string;
  readonly clockLabel: string;
}

/** 一条轮换文案：headline 是行动邀请（主标题），body 是说明行。 */
export interface HeroCopy {
  readonly headline: string;
  readonly body: string;
}

const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 时段边界：5–10 早上、11–12 中午、13–17 下午、18–22 晚上、其余深夜。 */
export function chimeForDate(d: Date): Chime {
  const h = d.getHours();
  let period: Period;
  if (h >= 5 && h < 11) period = "morning";
  else if (h >= 11 && h < 13) period = "noon";
  else if (h >= 13 && h < 18) period = "afternoon";
  else if (h >= 18 && h < 23) period = "evening";
  else period = "late";
  return {
    period,
    greeting: greetingFor(period),
    dateLabel: dateLabelOf(d),
    clockLabel: clockLabelOf(d),
  };
}

function greetingFor(period: Period): string {
  switch (period) {
    case "morning":
      return "早上好";
    case "noon":
      return "中午好";
    case "afternoon":
      return "下午好";
    case "evening":
      return "晚上好";
    case "late":
      return "夜深了";
  }
}

function dateLabelOf(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${WEEKDAY_NAMES[d.getDay()]}`;
}

function clockLabelOf(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 轮换文案池：全部是「下一步做什么」的行动邀请，body 说明怎么开始。 */
const COPY_POOL: readonly HeroCopy[] = [
  {
    headline: "今天想从哪块代码开始？",
    body: "发个目标、贴段报错，或直接指个文件——我先读代码再动手。",
  },
  {
    headline: "哪个 bug 在等你？",
    body: "把现象或报错贴过来，我定位根因，再给出修复方案。",
  },
  {
    headline: "有什么想法值得做成代码？",
    body: "说个大概就行，我把它拆成一步步可落地的计划。",
  },
  {
    headline: "想推进哪一块？",
    body: "新功能、重构，或把某个角落弄干净——都行。",
  },
  {
    headline: "接下来做什么？",
    body: "一个目标、一段上下文，或一条命令——从这里开始。",
  },
];

/**
 * seed 取模轮换：负数与越界 seed 都落到合法槽（数学模），同 seed 必同文案。
 * idx 经数学模恒 ∈ [0, n)，池为 readonly 非空元组——索引必命中，无兜底臂。
 */
export function pickHeroCopy(seed: number): HeroCopy {
  const n = COPY_POOL.length;
  const idx = ((seed % n) + n) % n;
  return COPY_POOL[idx];
}
