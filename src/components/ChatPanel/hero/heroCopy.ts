/**
 * hero 欢迎页的文案核心：时间问候 + 轮换文案，纯函数、无 IO/时钟/随机，
 * 同输入必同输出。UI 组件负责喂时间与 seed，这里只回答「现在该说什么」。
 */
import type { HeroMode } from "./modes";

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

/** 工程池：全部是「下一步做什么」的行动邀请，body 说明怎么开始。 */
const PROJECT_COPY_POOL: readonly HeroCopy[] = [
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
 * 日常池：不假设手上有什么，邀请「说点什么」而不是「推进什么」。
 * 与工程池的 headline 刻意不重叠——模式切换要让用户**看得见**。
 */
const DAILY_COPY_POOL: readonly HeroCopy[] = [
  {
    headline: "今天想聊点什么？",
    body: "随便问，不用先想清楚要干什么。",
  },
  {
    headline: "有什么想弄明白的？",
    body: "概念、原理、一段看不懂的文字，贴过来就行。",
  },
  {
    headline: "要写点什么吗？",
    body: "措辞、总结、翻译、换个口气 —— 说个大概，我来起草。",
  },
  {
    headline: "在琢磨什么事？",
    body: "先把想法倒出来，我帮你理一理。",
  },
  {
    headline: "有什么要查的？",
    body: "问一句就行，我整理好再给你。",
  },
];

/** 模式 → 文案池。新增模式时必须在这里给它一个池子（类型系统会强制）。 */
export function heroCopyPool(mode: HeroMode): readonly HeroCopy[] {
  return mode === "daily" ? DAILY_COPY_POOL : PROJECT_COPY_POOL;
}

/**
 * seed 取模轮换：负数与越界 seed 都落到合法槽（数学模），同 seed 同模式必同文案。
 * idx 经数学模恒 ∈ [0, n)，池为 readonly 非空数组——索引必命中，无兜底臂。
 */
export function pickHeroCopy(mode: HeroMode, seed: number): HeroCopy {
  const pool = heroCopyPool(mode);
  const n = pool.length;
  return pool[((seed % n) + n) % n];
}
