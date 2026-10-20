// 回合消息分派（session-worker.ts 拆分批 3 迁出，纯移动）：startLoop 的
// for-await 里每条 SDK 消息的顺序处理。原循环体的 `continue` 用返回值
// "continue" 表达（调用方 `if (handleQueryMessage(...) === "continue") continue;`）。
// 状态读写全部经 TurnContext 闭包注入——本模块无状态、可直测。
import type { Query, SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../types.js";
import { detectImageUnsupported } from "../imageRollback.js";
import { isErrorResult, mapSdkMessage, type MapperDeps } from "../mapper.js";

export interface TurnContext {
  /** 图片 400 检测命中：置 rollbackPending + abort 当前 query（回滚在 catch 里执行）。 */
  markImageRollback: () => void;
  /** 自动化一次性会话：400 后进程自毁，没有"下一轮重放干净历史"，故不回滚。 */
  isAutomation: () => boolean;
  setTurnActive: (v: boolean) => void;
  applyPlanMode: () => void;
  emit: (e: ChatEvent) => void;
  /** worker 每轮迭代构建一次（partialMode 捕获当轮支线状态）。 */
  mapperDeps: MapperDeps;
  /** CLI 回显了一条主线程用户消息（`--replay-user-messages`）= 它被模型接入的那一刻。 */
  onUserReplay: (id: string) => void;
  /** CLI 命令生命周期帧（queued / started / completed / cancelled，按消息 uuid）。 */
  onCommandLifecycle: (id: string, state: string) => void;
  /** system/init：供应商切换 fork 通知 + resumeSource 过户 + 模型名册采纳。
   *  newSid 可空语义与原实现一致（undefined 时保留旧 resumeSource）。 */
  onSessionInit: (newSid: string | undefined, q: Query) => void;
  /** 主线程 assistant 消息：模型坐实落账（adoptable 判定在 worker 方法内）。 */
  onMainThreadAssistant: (msg: SDKAssistantMessage) => void;
  /** result：工具生命周期收尾 + 遥测 + btw/automation 自毁调度。 */
  onResult: (q: Query) => void;
}

export function handleQueryMessage(
  msg: SDKMessage,
  q: Query,
  turn: TurnContext,
): "continue" | "terminate" | undefined {
  // 图片 400 回滚：模型不支持图片时，历史里带图消息重放必 400（会话报废）。
  // 检测到即 abort 杀 CLI（停一切写入），catch 里执行回滚（去图重写历史），
  // 下一轮 query 重放干净历史。automation 是一次性会话（400 后自毁），无需回滚。
  if (!turn.isAutomation() && detectImageUnsupported(msg)) {
    turn.markImageRollback();
  }
  // 用户消息回显：不是模型产出，不进 mapper（content 是用户原文，字符串分支会拿它当
  // task-notification 解析）。只用来认出排队消息被接入的时机。
  if (msg.type === "user" && (msg as { isReplay?: boolean }).isReplay) {
    const id = (msg as { uuid?: string }).uuid;
    if (!msg.parent_tool_use_id && id) turn.onUserReplay(id);
    return "continue";
  }
  if ((msg as { type: string }).type === "command_lifecycle") {
    const m = msg as unknown as { command_uuid?: string; state?: string };
    if (m.command_uuid && m.state) turn.onCommandLifecycle(m.command_uuid, m.state);
    return "continue";
  }
  if (msg.type === "result") {
    turn.setTurnActive(false);
  }

  // 检测模型主动进入计划模式（auto 等模式下 SDK 可能不经 canUseTool
  // 自动批准 EnterPlanMode）：主线程 assistant 消息里出现 EnterPlanMode
  // 工具调用时，对齐本地账本并广播。子代理内部不计（不污染主线程模式）。
  if (
    msg.type === "assistant" &&
    !msg.parent_tool_use_id
  ) {
    // assistant content 可能是字符串（罕见），Array.isArray 防御后再扫块
    const blocks = msg.message?.content;
    if (
      Array.isArray(blocks) &&
      blocks.some((b) => b.type === "tool_use" && b.name === "EnterPlanMode")
    ) {
      turn.applyPlanMode();
    }
  }

  mapSdkMessage(msg, turn.emit, turn.mapperDeps);

  if (msg.type === "system" && msg.subtype === "init") {
    turn.onSessionInit(msg.session_id, q);
  } else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
    // 原 else-if 链的第二分支带 adoptable/model 去重条件——判定移进 worker 的
    // onMainThreadAssistant（assistant 消息永远落不进 result 分支，链路等价）。
    turn.onMainThreadAssistant(msg);
  } else if (msg.type === "result") {
    turn.onResult(q);
    // 错误终态（鉴权/额度/上限/执行错误，良性打断豁免——interrupt 后会话必须
    // 原 query 可用，B5 契约）：存活 query 的 env/注入头随 spawn 固化，续发只会
    // 喂僵尸 CLI（F3：死端点 error 后同 worker 续发永不重连 MCP）。终止循环让
    // 下一条 send 走 !currentQuery 分支以 resume 重启，新配置随新 spawn 定装。
    if (isErrorResult(msg)) return "terminate";
  }
  return undefined;
}
