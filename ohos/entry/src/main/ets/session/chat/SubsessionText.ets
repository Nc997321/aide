/**
 * 子会话消息的文本还原（历史回看用）。
 *
 * 过筛自 packages/aide-sdk/src/utils/subsessionText.ts。`display` 不落盘，重开历史时
 * 只剩发给模型的 prompt 文本——它由 Host 按固定格式拼出（aide-core `subsession.rs` 的
 * task_prompt / followup_prompt / reports_prompt），这里是它们的逆运算，把文本拆回
 * 回报卡片 / 「来自父会话」指令卡片，与实时路径（user_message 的 display 块）同形。
 *
 * ⚠️ 改 Rust 那三段格式时这里与桌面 subsessionText.ts 一起改。
 * 认不出 → 返回 null，调用方按普通文本渲染（整条消息不消失）。
 */
import { uuid } from './ChatWire';
import { SubsessionReportBlock, SubsessionInstructionBlock } from './ChatBlocks';

const REPORT_HEAD: string = '[子会话回报]';
/** agent 派的「[来自父会话「X」派发的…]」与用户手动派的「[用户从父会话「X」派发的…]」 */
const TASK_HEAD: RegExp = /^\[(来自|用户从)父会话「([^」]*)」派发的子会话任务\]\n/;
const FOLLOWUP_HEAD: RegExp = /^\[来自父会话「([^」]*)」的追加指令[^\]]*\]\n/;
const SECTION_HEAD: RegExp = /^### 子会话「([^」]*)」（id ([^）]+)）· (已完成|出错|被打断) · (.+)$/;
const TRUNCATED_LINE: RegExp = /^（回报过长已截断，完整内容在子会话「[^」]*」里）$/;
const EMPTY_BODY: string = '（这一轮没有文字回复）';

function statusOf(label: string): string {
  if (label === '已完成') {
    return 'done';
  }
  if (label === '出错') {
    return 'error';
  }
  return label === '被打断' ? 'interrupted' : 'done';
}

function originOf(label: string): string {
  if (label === '执行派发的任务') {
    return 'task';
  }
  if (label === '执行用户手动派发的任务') {
    return 'user_task';
  }
  if (label === '回应你的追加指令') {
    return 'parent';
  }
  return 'user'; // 「由用户在子会话里触发」及认不出的标签都归这一类（同桌面缺省）
}

/** 收尾一段回报：去尾部空行、摘截断标记、空回复还原为空串。 */
function finishReport(cur: SubsessionReportBlock, body: string[], out: SubsessionReportBlock[]): void {
  while (body.length > 0 && body[body.length - 1].trim() === '') {
    body.pop();
  }
  if (body.length > 0 && TRUNCATED_LINE.test(body[body.length - 1])) {
    body.pop();
    cur.truncated = true;
  }
  const joined: string = body.join('\n');
  cur.text = joined === EMPTY_BODY ? '' : joined;
  out.push(cur);
}

/** 回报 prompt → 回报块（可能多段）；不是回报 → null。 */
export function parseReportPrompt(text: string): SubsessionReportBlock[] | null {
  if (!text.startsWith(REPORT_HEAD)) {
    return null;
  }
  const out: SubsessionReportBlock[] = [];
  const lines: string[] = text.split('\n');
  let cur: SubsessionReportBlock | null = null;
  let body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line: string = lines[i];
    const m: RegExpExecArray | null = SECTION_HEAD.exec(line);
    if (m !== null) {
      if (cur !== null) {
        finishReport(cur, body, out);
      }
      cur = new SubsessionReportBlock(uuid(), m[2], m[1], statusOf(m[3]), originOf(m[4]), '', false);
      body = [];
      continue;
    }
    if (cur !== null) {
      body.push(line);
    }
  }
  if (cur !== null) {
    finishReport(cur, body, out);
  }
  return out.length > 0 ? out : null;
}

/** 父会话派来的任务 / 追加指令 prompt → 指令块；不是指令 → null。 */
export function parseInstructionPrompt(text: string): SubsessionInstructionBlock | null {
  const task: RegExpExecArray | null = TASK_HEAD.exec(text);
  if (task !== null) {
    const sep: number = text.indexOf('\n---\n');
    const body: string = sep >= 0 ? text.substring(sep + 5) : text;
    const by: string = task[1] === '用户从' ? 'user' : 'agent';
    return new SubsessionInstructionBlock(uuid(), '', task[2], body, 'task', by);
  }
  const follow: RegExpExecArray | null = FOLLOWUP_HEAD.exec(text);
  if (follow !== null) {
    return new SubsessionInstructionBlock(uuid(), '', follow[1], text.substring(follow[0].length), 'followup', 'agent');
  }
  return null;
}
