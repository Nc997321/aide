/**
 * 消息流末尾那行（ThinkingLine）与活动带的状态词：每轮随机一个动词，这一轮内不变。
 *
 * 那一行表示「这一轮还在跑」（含跑工具、等子会话、输出正文），不是「模型在思考」——
 * 模型的思考由消息里的「正在思考…」表示（思考块流式中）。所以这里刻意不用「思考 / 想 / 考」
 * 一类字眼，免得两行并排都说在思考。一轮内不换：同一行右边已有使用提示在轮播，再轮一个会吵。
 */
export const WORKING_VERBS: readonly string[] = [
  "琢磨中",
  "推敲中",
  "酝酿中",
  "捣鼓中",
  "盘算中",
  "斟酌中",
  "梳理中",
  "施工中",
  "张罗中",
  "掂量中",
  "合计中",
  "折腾中",
  "拾掇中",
  "摸索中",
  "筹划中",
  "打磨中",
  "钻研中",
  "端详中",
];

/** 随机抽一个，和上一轮的不重复。rand 可注入（测试用）。 */
export function pickWorkingVerb(prev: string | null, rand: () => number = Math.random): string {
  const pool = prev ? WORKING_VERBS.filter((v) => v !== prev) : WORKING_VERBS;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}
