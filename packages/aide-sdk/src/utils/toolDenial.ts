// 工具拒绝态识别：从 tool_result 正文反解出「这次调用是被拒绝的，不是失败」。
//
// 为什么是反解而不是协议加字段：
// 拒绝与工具报错在协议里共用 tool_result（content + is_error），区别只在 content
// 的外框。外框是 aide 按 CLI 官方模板写进去的（`userDenyMessage` /
// `policyDenyMessage`），也就是说 content **已经**是「是否拒绝 + 拒绝理由」的
// 完整载体。再在事件/历史结构里加一个 `denied` 或 `denialReason` 字段，就是同一
// 真相的第二份——两处会漂移，是影子参数。所以这里只做纯函数派生，协议零新增。
//
// 副产品：实时路径（sidecar 事件 → ToolCallBlock.result）与历史路径（Rust 解析
// jsonl → HistoryBlock::ToolCall.result）拿到的是同一个字段的同一份全文，派生
// 逻辑只有这一处，两条路径不可能出现「刚发生的能识别、回看识别不了」的分裂。

/** 人工拒绝（用户在权限弹窗点了拒绝）——CLI 官方模板 nhe/YFe 的首句，
 *  逐字取自 claude.exe @279529599。写入方 agent-sidecar/src/permissions.ts
 *  `DENY_BASE`，改任一侧都要同步另一侧。 */
export const DENY_USER_PREFIX = "The user doesn't want to proceed with this tool use.";

/** 策略/规则拒绝（非人工）——官方模板 hRe 的首句。写入方 `DENY_POLICY_BASE`。 */
export const DENY_POLICY_PREFIX = "Permission for this tool use was denied.";

/** 附言分隔符：官方 YFe 模板把用户原话接在这句话后面。 */
const USER_FEEDBACK_MARK = "To tell you how to proceed, the user said:\n";

/** 策略理由分隔符：`policyDenyMessage` 用空行把理由接在模板之后。 */
const POLICY_REASON_SEP = "\n\n";

export interface ToolDenial {
  /** `user` = 人在弹窗点了拒绝；`policy` = 命中权限规则被拒（没人参与）。 */
  kind: "user" | "policy";
  /** 用户附言 / 策略理由。有附言才有值——没有就不该在 UI 上编一个。 */
  reason?: string;
}

/**
 * 识别 tool_result 正文里的拒绝外框。不是拒绝（普通输出、真报错、旧会话里
 * 没有外框的历史记录）一律返回 null——调用方据此退回常规错误态，不猜。
 *
 * `truncated` 的块正文已被替换成占位摘要，反解不出东西，调用方应先判掉。
 */
export function parseToolDenial(content?: string | null): ToolDenial | null {
  if (!content) return null;
  const text = content.trimStart();

  if (text.startsWith(DENY_USER_PREFIX)) {
    const at = text.indexOf(USER_FEEDBACK_MARK);
    if (at < 0) return { kind: "user" };
    const reason = text.slice(at + USER_FEEDBACK_MARK.length).trim();
    return reason ? { kind: "user", reason } : { kind: "user" };
  }

  if (text.startsWith(DENY_POLICY_PREFIX)) {
    const rest = text.slice(DENY_POLICY_PREFIX.length);
    const at = rest.indexOf(POLICY_REASON_SEP);
    if (at < 0) return { kind: "policy" };
    // 模板本体是单行，第一个空行之后必然是追加的理由
    const reason = rest.slice(at + POLICY_REASON_SEP.length).trim();
    return reason ? { kind: "policy", reason } : { kind: "policy" };
  }

  return null;
}
