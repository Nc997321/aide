import type { SubsessionInstruction, SubsessionReport } from "../types/chat";

/**
 * 子会话消息的文本还原（历史回看用）。`display` 不落盘，重开历史时只有发给模型的 prompt 文本——
 * 它由 Host 按固定格式拼出（aide-core `subsession.rs` 的 `task_prompt` / `followup_prompt` /
 * `reports_prompt`），这里是它们的逆运算，把文本拆回回报卡片 / 「来自父会话」气泡，
 * 与实时路径（user_message 的 display 块）同形。
 *
 * ⚠️ 改 Rust 那三段格式时这里一起改（subsessionText.test.ts 钉着样本）。
 * 认不出 → 返回 null，调用方按普通文本渲染（整条消息不消失）。
 */

const REPORT_HEAD = "[子会话回报]";
/** agent 派的「[来自父会话「X」派发的…]」与用户手动派的「[用户从父会话「X」派发的…]」 */
const TASK_HEAD = /^\[(来自|用户从)父会话「([^」]*)」派发的子会话任务\]\n/;
const FOLLOWUP_HEAD = /^\[来自父会话「([^」]*)」的追加指令[^\]]*\]\n/;
const SECTION_HEAD = /^### 子会话「([^」]*)」（id ([^）]+)）· (已完成|出错|被打断) · (.+)$/;
const TRUNCATED_LINE = /^（回报过长已截断，完整内容在子会话「[^」]*」里）$/;
const EMPTY_BODY = "（这一轮没有文字回复）";

const STATUS: Record<string, string> = { 已完成: "done", 出错: "error", 被打断: "interrupted" };
const ORIGIN: Record<string, string> = {
  执行派发的任务: "task",
  执行用户手动派发的任务: "user_task",
  回应你的追加指令: "parent",
  由用户在子会话里触发: "user",
};

export function parseReportPrompt(text: string): SubsessionReport[] | null {
  if (!text.startsWith(REPORT_HEAD)) return null;
  const out: SubsessionReport[] = [];
  let cur: (SubsessionReport & { lines: string[] }) | null = null;
  const flush = () => {
    if (!cur) return;
    const { lines, ...r } = cur;
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length && TRUNCATED_LINE.test(lines[lines.length - 1])) {
      lines.pop();
      r.truncated = true;
    }
    const body = lines.join("\n");
    out.push({ ...r, text: body === EMPTY_BODY ? "" : body });
  };
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(SECTION_HEAD);
    if (m) {
      flush();
      cur = {
        title: m[1],
        childId: m[2],
        status: STATUS[m[3]] ?? "done",
        origin: ORIGIN[m[4]] ?? "user",
        text: "",
        lines: [],
      };
      continue;
    }
    cur?.lines.push(line);
  }
  flush();
  return out.length ? out : null;
}

export function parseInstructionPrompt(text: string): SubsessionInstruction | null {
  const task = text.match(TASK_HEAD);
  if (task) {
    const sep = text.indexOf("\n---\n");
    return {
      parentId: "",
      parentTitle: task[2],
      text: sep >= 0 ? text.slice(sep + 5) : text,
      kind: "task",
      by: task[1] === "用户从" ? "user" : "agent",
    };
  }
  const follow = text.match(FOLLOWUP_HEAD);
  if (follow) return { parentId: "", parentTitle: follow[1], text: text.slice(follow[0].length), kind: "followup" };
  return null;
}
