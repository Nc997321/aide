// 值守回报的文字形态 → 卡片数据。
//
// 实时路径靠 display 的 watch_report 块；但 display 不落盘，重开历史时只有发给模型的那段文字，
// 这里按 sidecar 固定的格式（agent-sidecar/src/extensions/watch/manager.ts 的 watchReportPrompt）拆回来。
// 两边格式的对账测试在 agent-sidecar/src/extensions/watch/manager.test.ts。
import type { WatchReport } from "../types/chat";

const HEAD = "[值守回报] ";
const SECTION = /^新出现的内容（(\d+) 行(，只保留最后一部分)?；另有 (\d+) 行消失）：$/;

export function parseWatchPrompt(text: string): WatchReport | null {
  if (!text.startsWith(HEAD)) return null;
  const lines = text.split("\n");
  const head = lines[0].slice(HEAD.length);
  const sep = head.lastIndexOf(" · ");
  const report: WatchReport = {
    watchId: "",
    title: sep >= 0 ? head.slice(0, sep) : head,
    at: sep >= 0 ? head.slice(sep + 3) : "",
    focus: "",
    source: "",
    kind: "change",
    added: [],
    removed: 0,
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("关注：")) report.focus = line.slice(3);
    else if (line.startsWith("来源：")) report.source = line.slice(3);
    else if (line.startsWith("+ ")) report.added.push(line.slice(2));
    else if (line.startsWith("值守已结束：")) {
      report.kind = "ended";
      report.reason = line.slice(6);
    } else {
      const m = line.match(SECTION);
      if (m) {
        report.removed = Number(m[3]);
        if (m[2]) report.truncated = true;
      }
    }
  }
  return report;
}
