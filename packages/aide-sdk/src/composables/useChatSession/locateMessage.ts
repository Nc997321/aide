import type { Row } from "./recycle";

/**
 * 轮次 → 聊天区用户气泡的定位（纯函数，无 Vue / 无 DOM / 无 Tauri）。
 *
 * 为什么单独成模块：轮次标题（`ChangeRound.prompt`）与用户气泡文本**同源**——
 * 两者都取发送时的 `item.prompt`（原文，@引用未展开；展开后的内容另走
 * `mentions.sendText`，见 ChatInputBox 的发送段注释）。所以按文本相等即可对上号。
 * 这段映射是变更面板「定位」功能唯一的判据，纯逻辑放这里才能脱离宿主单测。
 *
 * **为什么文本是主判据、序号只做消歧**——两个候选键都不可靠，但不可靠的方式不同：
 *   - 序号（第 N 轮 = 第 N 次派发）本是最强的键，但它**会被静默打断**：落盘失败
 *     时轮次会丢（useConversationChanges 的 save 有「rounds will be lost」告警），
 *     丢一轮后面所有序号整体前移。远程端（手机/PWA）发的消息不经过本地
 *     prepareSend，`lastDispatchedPrompt` 没值 → 那轮 prompt 为空但序号照占。
 *   - 文本**会被写错**：排队的多条消息在 prepareSend 里互相覆盖
 *     `lastDispatchedPrompt`，轮到较早那条时取到的可能是后一条的文本。
 *
 * 取舍：**文本命中是唯一能把「用户点的那个标题」和「屏上那个气泡」直接连起来的
 * 证据**，所以它是主判据；序号只在同文本重复提问（连发两次"继续"）时用来挑第几条，
 * 且只有行模型覆盖会话起点（`fromStart`）时才可信。两者都对不上 → 返回 null，
 * 由调用方如实报「找不到」，**绝不用错位的序号去猜**（跳错轮次比跳不过去更糟：
 * 用户看不出跳错了）。
 */

/** 用户消息在行模型里的落点：所在行 id + 该行内的消息下标。 */
export interface UserMessageHit {
  rowId: string;
  messageIndex: number;
}

export interface LocateQuery {
  /** 轮次标题文本（= `ChangeRound.prompt`）。空串 = 无可依据（远程发送的轮次）→ 不定位。 */
  prompt: string;
  /** 轮次序号（1-based，会话全局）。仅用于同文本重复提问的消歧。 */
  roundIndex: number;
  /** 行模型是否覆盖会话起点（无更早页未加载）。false 时序号必偏移，不可用于消歧。 */
  fromStart: boolean;
}

/** 视觉序遍历所有用户消息的落点（占位行没有消息，跳过）。 */
function collectUserMessages(rows: readonly Row[]): UserMessageHit[] {
  const out: UserMessageHit[] = [];
  for (const row of rows) {
    if (row.kind === "page") {
      row.messages.forEach((m, i) => {
        if (m.role === "user") out.push({ rowId: row.id, messageIndex: i });
      });
    } else if (row.kind === "live") {
      if (row.message.role === "user") out.push({ rowId: row.id, messageIndex: 0 });
    }
  }
  return out;
}

/** 取某条用户消息的文本块内容（非文本块——如动作胶囊——返回空串）。 */
function textOfRow(rows: readonly Row[], hit: UserMessageHit): string {
  const row = rows.find((r) => r.id === hit.rowId);
  if (!row) return "";
  const message =
    row.kind === "page" ? row.messages[hit.messageIndex] : row.kind === "live" ? row.message : undefined;
  const block = message?.blocks[0];
  return block?.type === "text" ? block.text : "";
}

/**
 * 定位轮次对应的用户气泡。返回 null = 本窗口内找不到（调用方决定取回更早页后重试，
 * 或如实报「找不到」）。
 *
 * 判据见文件头：文本为主、序号仅消歧。
 */
export function locateUserMessage(rows: readonly Row[], query: LocateQuery): UserMessageHit | null {
  if (!query.prompt) return null;

  const users = collectUserMessages(rows);
  const matches = users.filter((hit) => textOfRow(rows, hit) === query.prompt);
  if (matches.length === 0) return null; // 无文本证据：不靠序号猜（见文件头）
  if (matches.length === 1) return matches[0]; // 唯一命中：序号无关

  // 同文本重复提问：序号可信时按序号挑（第 N 轮 = 第 N 条用户消息）。
  // 序号越界 = 与命中集对不上（轮次丢失/消息被截断）→ 不采用，走下面的保守回落。
  if (query.fromStart && query.roundIndex >= 1) {
    const byOrdinal = users[query.roundIndex - 1];
    if (byOrdinal && matches.includes(byOrdinal)) return byOrdinal;
  }
  // 序号不可信/不落在命中集里 → 取最近一次相同提问（保守：不按错位序号乱跳）
  return matches[matches.length - 1];
}
