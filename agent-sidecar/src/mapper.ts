import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { ChatEvent, ImageAttachment, RateLimitWindow, TurnUsage } from "./types.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { BgTaskTracker } from "./bgTasks.js";
import { startOutputTail as globalStartOutputTail, stopOutputTail as globalStopOutputTail } from "./subagentOutputTail.js";

/** 子代理嵌套深度告警阈值（warn-only，不阻止调用）。深度 > 阈值时发
 *  subagent_nesting_warning。默认 1 = 子代理一旦派子代理（depth 2）就告警——这是
 *  fan-out 成本指数膨胀的起点，也是 live 能可靠检测到的层级（更深的嵌套消息会被
 *  emitSubagentProgress 的 isActive 守卫挡掉，因为嵌套子代理不进 active）。
 *  env AIDE_SUBAGENT_NESTING_WARN 可覆盖（设 2 则只对 depth 3+ 告警，但深度 3+ live
 *  不可见，故 >1 才有实际告警输出）。 */
const NESTING_WARN_THRESHOLD = Number(process.env.AIDE_SUBAGENT_NESTING_WARN) || 1;

/**
 * Build a Claude-SDK MessageParam from a prompt + optional image attachments.
 *
 * This is the ONLY place in the codebase that knows about Anthropic's
 * ImageBlockParam format. To add a new AI provider, create a new sidecar
 * with its own buildUserMessage — the Rust layer and Vue frontend are
 * provider-agnostic.
 */
export function buildUserMessage(
  prompt: string,
  images: ImageAttachment[],
): MessageParam {
  if (images.length === 0) {
    return { role: "user", content: prompt };
  }
  const blocks: Array<Record<string, unknown>> = images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType,
      data: img.data,
    },
  }));
  if (prompt) {
    blocks.push({ type: "text", text: prompt });
  }
  return { role: "user", content: blocks as any };
}

/** result.errors 里用户可读的条目——`[ede_diagnostic]` 开头的是 CLI 塞的内部
 *  诊断面包屑（中断/截断时描述转录状态），CLI 官方 UI 同样按这个前缀过滤，
 *  不是给用户看的错误。 */
function meaningfulResultErrors(msg: any): unknown[] {
  return Array.isArray(msg.errors)
    ? (msg.errors as unknown[]).filter(Boolean).filter((e) => !String(e).startsWith("[ede_diagnostic]"))
    : [];
}

/**
 * 主动打断（用户点"中断"、插队截断）产生的 result：subtype 固定是
 * error_during_execution，但没有任何用户可读的错误信息（errors 里最多只有
 * [ede_diagnostic] 内部面包屑）。这不是错误，是打断的正常产物——路由成
 * message_stop 而不是错误气泡，否则每次中断都弹一条红色 Error。
 */
export function isBenignAbortResult(msg: any): boolean {
  if (msg.subtype !== "error_during_execution") return false;
  if (typeof msg.api_error_status === "number") return false;
  if (typeof msg.result === "string" && msg.result.trim()) return false;
  return meaningfulResultErrors(msg).length === 0;
}

/** 压缩失败说明直接来自 provider，进入 UI 前压成一行并限长，避免诊断堆栈或
 * 异常长文本把瞬态状态条撑成大块内容。 */
function compactErrorText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, 320);
}

/**
 * 把一条"错误 result"翻译成给用户看的中文说明。
 *
 * SDK 在鉴权失败/额度超限/达上限等情况下不会抛异常，而是正常产出一条
 * `result` 消息（`SDKResultError` 或带 `is_error:true` 的 success），错误细节
 * 散落在 `errors[]` / `result` / `api_error_status` / `subtype` 上。这里按
 * 优先级归并：先给常见 HTTP 状态一句人话，再附上 SDK 的原始错误文本兜底。
 */
export function describeResultError(msg: any): string {
  const parts: string[] = [];

  const status = msg.api_error_status as number | null | undefined;
  if (status === 401 || status === 403) {
    parts.push("认证失败：未登录，或 API 密钥 / 令牌无效");
  } else if (status === 429) {
    parts.push("请求被限流或额度已用尽（HTTP 429）");
  } else if (typeof status === "number") {
    parts.push(`接口返回错误（HTTP ${status}）`);
  }

  const errs = meaningfulResultErrors(msg);
  if (errs.length > 0) {
    parts.push(errs.map((e) => String(e)).join("；"));
  } else if (typeof msg.result === "string" && msg.result.trim()) {
    parts.push(msg.result.trim());
  }

  if (parts.length === 0) {
    const bySubtype: Record<string, string> = {
      error_during_execution: "执行过程中出错",
      error_max_turns: "已达到最大回合数上限",
      error_max_budget_usd: "已达到预算（花费）上限",
      error_max_structured_output_retries: "结构化输出重试次数用尽",
    };
    parts.push(bySubtype[msg.subtype as string] ?? `会话异常结束（${msg.subtype}）`);
  }

  return parts.join(" — ");
}

/**
 * 内部占位模型 id 的形状：CLI 在额度耗尽等状态下会本地生成占位 assistant
 * 消息（如"你已达到额度上限"），其 `message.model` 有时是尖括号包裹的内部
 * 记号（如 `<synthetic>`），不是任何真实可选模型——和 session.rs 里
 * `is_synthetic_user_entry` 过滤的 isMeta/interruptedMessageId 是同一类
 * "本地生成、非真实模型输出"的占位条目，只是这次出现在 assistant 侧的
 * model 字段上。真实模型 id（别名如 "sonnet"，或具体 wire id 如
 * "claude-sonnet-5-20260101"）从不带尖括号。
 */
function isPlaceholderModelId(id: string | undefined | null): boolean {
  return typeof id === "string" && /^<.*>$/.test(id.trim());
}

/**
 * 一条 assistant 消息报的 `message.model` 是否可以被采信为"当前生效模型"。
 *
 * 两种情况绝不能采信，否则会污染 index.ts 里持久化的 `currentModel`，而
 * `currentModel` 一旦被污染就会作为显式 `model` 参数带进下一轮 query——
 * 请求一个不存在的模型，API 报 model_not_found，而这条错误回声本身还是一条
 * assistant 消息、`message.model` 还是同一个占位符，会被再次"采信"一遍，
 * 自锁死循环，直到整个会话进程重启：
 *
 * - `msg.error` 存在：这轮是失败回声（如 model_not_found），不代表模型真的
 *   在这个 id 下工作过。
 * - `message.model` 是占位符形状（`isPlaceholderModelId`）：本地生成的占位
 *   通知，不是真实模型输出。
 */
export function isAdoptableAssistantModel(msg: any): boolean {
  if (msg?.error) return false;
  const model = msg?.message?.model;
  return typeof model === "string" && model.trim().length > 0 && !isPlaceholderModelId(model);
}

/** 模型下拉框可选列表过滤：剔除 CLI 报上来的内部占位符条目（value 或
 *  displayName 呈占位符形状），不让用户能选中一个根本不是真实模型的选项。 */
export function filterSelectableModels<T extends { value: string; displayName: string }>(models: T[]): T[] {
  return models.filter((m) => !isPlaceholderModelId(m.value) && !isPlaceholderModelId(m.displayName));
}

/**
 * 把 SDK `/usage`（`usage_EXPERIMENTAL_…()`）的结构化响应折成 provider-agnostic 的
 * `rate_limit` 事件——这是订阅额度的正确数据源（每个窗口 utilization 明确 0-100、
 * 带 ISO 重置时间、一次给全部并行窗口）。以前用的 `rate_limit_event` 只报单窗口
 * 且 utilization 是 0-1（导致 76% 显示成 1%），已弃用。
 *
 * `rate_limits_available` 为 false（API Key / Bedrock / Vertex / 三方）时 windows 为空，
 * 前端据此隐藏。Claude 专属的窗口词汇（five_hour/seven_day_opus…）在这里翻成人话，
 * 挡在 sidecar 内不进核心协议。
 */
export function buildRateLimitEvent(usage: any): ChatEvent {
  const subscription: string | null =
    typeof usage?.subscription_type === "string" ? usage.subscription_type : null;
  const windows: RateLimitWindow[] = [];
  const rl = usage?.rate_limits;
  if (usage?.rate_limits_available !== false && rl) {
    const push = (key: string, label: string, w: any) => {
      if (w && typeof w.utilization === "number") {
        windows.push({
          key,
          label,
          utilization: Math.min(100, Math.max(0, w.utilization)),
          resets_at: isoToMs(w.resets_at),
        });
      }
    };
    push("five_hour", "5 小时", rl.five_hour);
    push("seven_day", "7 天", rl.seven_day);
    push("seven_day_opus", "7 天 Opus", rl.seven_day_opus);
    push("seven_day_sonnet", "7 天 Sonnet", rl.seven_day_sonnet);
    push("seven_day_oauth_apps", "7 天 OAuth", rl.seven_day_oauth_apps);
    if (Array.isArray(rl.model_scoped)) {
      for (const m of rl.model_scoped) {
        push(`model:${m?.display_name ?? "?"}`, String(m?.display_name ?? "模型"), m);
      }
    }
    if (rl.extra_usage) push("extra_usage", "超额", rl.extra_usage);
  }
  return { type: "rate_limit", subscription, windows };
}

/** ISO 8601 时间串 → unix 毫秒；空或非法返回 null。 */
function isoToMs(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * 识别 async 子代理的 launch-ack 文本，提取 agentId 与 .output 路径。
 * launch-ack 形如：「Async agent launched successfully. agentId: <hex> … output_file: <path>.output\nDo NOT Read …」。
 * sync 子代理的 tool_result content 不含 `agentId:`/`output_file:` 签名 → 返回 null。
 */
export function parseAsyncLaunchAck(content: string): { agentId: string; outputFile: string } | null {
  const agentMatch = content.match(/agentId:\s*([a-z0-9]+)/);
  const fileMatch = content.match(/output_file:\s*(.+?\.output)(?:\r?\n|$)/);
  if (!agentMatch || !fileMatch) return null;
  return { agentId: agentMatch[1], outputFile: fileMatch[1] };
}

/**
 * 解析 SDK 注入的 <task-notification> XML，提取 tool-use-id / status / result。
 * async 子代理完成时，SDK 会往父会话消息流塞一条 content 是这段 XML 字符串的
 * type:"user" 消息（不是通常的 block 数组）——这是 .output 转录文件之外唯一
 * 靠谱的"完成"信号（.output 本身没有 end_turn/result 标记）。
 * content 不以 <task-notification> 开头 → 返回 null（普通用户消息不误判）。
 * result 缺省取 <summary> 兜底，再缺省空串。
 */
export function parseTaskNotification(content: string): { toolUseId: string; status: string; result: string; taskId?: string } | null {
  if (!content.startsWith("<task-notification>")) return null;
  const id = content.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)?.[1];
  if (!id) return null;
  const status = content.match(/<status>([^<]*)<\/status>/)?.[1] ?? "completed";
  const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? content.match(/<summary>([^<]*)<\/summary>/)?.[1] ?? "";
  // <task-id>：后台 shell 任务的 id（local_bash 的终态通知带）——async 子代理的
  // XML 通知没有它（或不需要），调用方按是否存在决定要不要走后台任务通道。
  const taskId = content.match(/<task-id>([^<]*)<\/task-id>/)?.[1];
  return { toolUseId: id, status, result, ...(taskId ? { taskId } : {}) };
}

/**
 * 解析子代理的 assistant/user 消息块并转发为 subagent_progress / subagent_tool_result /
 * subagent_text_delta。assistant 与 user 两条分支被 .output 回放和流式 emitSubagentProgress
 * 共用——区别只在消息来源（流式带 parent_tool_use_id vs .output 自身 transcript），块结构相同。
 * stream_event 逐字增量不在此（流式专属，.output 里没有）。
 * claimModel：返回 true 表示「这次能坐实 model 并只报一次」——流式用 claimModelReport，
 *   .output 回放用自己的 once 闭包（见 subagentOutputTail.ts）。
 */
export function emitSubagentBlocks(
  msg: any,
  id: string,
  emit: (e: ChatEvent) => void,
  claimModel: () => boolean,
  /** 子代理内部又派发子代理（嵌套 Agent/Task tool_use）时的回调，参数是嵌套那次
   *  tool_use 的 id。emitSubagentProgress 用它算嵌套深度并发 nesting 警告。
   *  subagentOutputTail 的 .output 回放路径不传（async 回放不告警）。 */
  onNestedSpawn?: (childToolUseId: string) => void,
  /** 思考展示开关（「设置→通用」下发）：关闭 = 从能力上禁用思考（请求层
   *  thinking: disabled 对官方 API 生效）；此处是展示层兜底——ollama 等兼容
   *  端点不认 thinking 参数（2026-08-21 实测：disabled 时请求体根本不带
   *  thinking 字段，端点默认=模型自决），推理模型无法能力级禁用，只能剥掉
   *  thinking 块。缺省 true 兼容旧调用。 */
  showThinking: boolean = true,
) {
  // 子代理内部的工具产出：user 消息里的 tool_result block。按 tool_use_id（子代理
  // 内部那次工具调用的 id）发 subagent_tool_result，前端据此把产出回填到对应步骤——
  // 否则子代理步骤只看得到工具名+入参摘要、看不到每步输出。
  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type !== "tool_result") continue;
      const content = Array.isArray(block.content)
        ? block.content.map((c: any) => c.text ?? "").join("")
        : String(block.content ?? "");
      emit({ type: "subagent_tool_result", id, toolUseId: block.tool_use_id, content, is_error: block.is_error ?? false });
    }
    return;
  }
  if (msg.type !== "assistant" || !msg.message?.content) return;

  // includePartialMessages 关闭后没有 stream_event 逐字增量，子代理的完整文本/思考
  // 须在此一次性补发（否则子代理回复文本/思考丢失）。主线程同理（下方 mapSdkMessage
  // assistant 分支），这里对齐那头：先遍历所有 block 无条件 emit text/thinking 块，
  // 再把 tool_use 块独立处理。注意：model 只在携带 tool_use 块的消息才 claim——纯
  // 文本消息用不上 model，若提前 claim 会把"报一次 model"的一次性名额白白吞掉，导致
  // 子代理先说文本再调工具时，真正携带 tool_use 的消息永远拿不到 model（回归见
  // mapper.test.ts）。
  for (const block of msg.message.content) {
    if (block.type === "text" && block.text) {
      emit({ type: "subagent_text_delta", id, delta: block.text });
    } else if (block.type === "thinking" && block.thinking && showThinking) {
      emit({ type: "subagent_thinking_delta", id, delta: block.thinking });
    }
  }

  const toolUses = (msg.message.content as any[]).filter((b) => b.type === "tool_use");
  if (toolUses.length === 0) return;

  const model = claimModel() ? (msg.message.model as string) : undefined;
  toolUses.forEach((block, i) => {
    emit({
      type: "subagent_progress",
      id,
      toolUseId: block.id,
      toolName: block.name,
      input: block.input,
      ...(i === 0 && model ? { model } : {}),
    });
    // 嵌套派发：子代理内部又调 Agent/Task。在这里通知调用方算深度+告警。
    if (onNestedSpawn && SubagentTracker.isSubagentTool(block.name)) {
      onNestedSpawn(block.id);
    }
  });
}

/**
 * 子代理内部消息（`parent_tool_use_id` 非空）：转发文本/thinking 的逐字增量（对齐
 * 主线程 stream_event 的粒度），以及工具调用摘要——三者按到达顺序穿插，前端据此
 * 拼出"子代理具体在做什么"的完整时间线（v2，取代 v1 的"只报工具调用摘要"）。
 *
 * 明确不支持嵌套子代理（子代理内部再调用 Task/Agent 工具）：那种情况会落进
 * `emitSubagentBlocks` 的 `toolUses` 分支，当成一次普通工具调用报出去
 * （`toolName: "Agent"`），不递归展开其内部活动——这个场景现在用不到，按 YAGNI 不做。
 *
 * assistant/user 两条分支委托给 `emitSubagentBlocks`（.output 回放复用同一份解析）；
 * 这里只保留 stream_event 逐字增量分支——.output 里没有这类事件。
 */
function emitSubagentProgress(
  msg: any,
  emit: (e: ChatEvent) => void,
  subagents: SubagentTracker,
  partialMode: boolean = false,
  showThinking: boolean = true,
) {
  const parentId = msg.parent_tool_use_id as string;
  if (!subagents.isActive(parentId)) return; // 防御性：理论上不会出现不认识的 id

  // partial=on（主会话）时丢弃子代理逐字 delta——子代理走下方 emitSubagentBlocks 整块
  // （与 partial=off 现状一致），避免开 partial 连带让子代理 text/thinking 也逐字流式。
  // 未来若要子代理也流式，去掉此守卫。partial=off 时 SDK 不发 stream_event，本守卫无副作用。
  if (partialMode && msg.type === "stream_event") return;

  // 逐字流式：子代理内部的 text_delta / thinking_delta 增量。
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev?.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        emit({ type: "subagent_text_delta", id: parentId, delta: ev.delta.text });
      } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking && showThinking) {
        emit({ type: "subagent_thinking_delta", id: parentId, delta: ev.delta.thinking });
      }
    }
    return;
  }

  emitSubagentBlocks(
    msg,
    parentId,
    emit,
    () => isAdoptableAssistantModel(msg) && subagents.claimModelReport(parentId),
    // 嵌套派发回调：子代理内部又调 Agent/Task → 算深度，超阈值发软警告（warn-only）。
    (childId) => {
      const depth = subagents.recordNestedSpawn(parentId, childId);
      if (depth > NESTING_WARN_THRESHOLD) {
        emit({ type: "subagent_nesting_warning", depth, threshold: NESTING_WARN_THRESHOLD });
      }
    },
    showThinking,
  );
}

export function mapSdkMessage(
  msg: any,
  emit: (e: ChatEvent) => void,
  tasks: TaskTracker,
  subagents: SubagentTracker,
  tools: ToolLifecycleTracker,
  /** 把 wire model id 解析成展示建议（别名）——index.ts 传 resolveDropdownValue；
   *  缺省（测试等）时 modelLabel 即 wire 原文。 */
  resolveModelLabel?: (wire: string) => string,
  /** SessionWorker 注入的 output tail 回调（per-instance，替代模块级全局）。
   *  缺省时走全局 subagentOutputTail（旧路径兼容）。 */
  outputTailHooks?: {
    start: (id: string, outputFile: string, emit: (e: ChatEvent) => void, onStop: (id: string) => void) => void;
    stop: (id: string) => void;
  },
  /** 后台 shell 任务：tracker + 输出 tail 钩子（per-session，SessionWorker 注入）。
   *  缺省时 task_started/后台回执/task_notification 一律不识别（测试兼容）。 */
  bgTaskHooks?: {
    tracker: BgTaskTracker;
    startTail: (id: string, outputFile: string) => void;
    stopTail: (id: string) => void;
  },
  /** partial=on 标志：主会话 true（thinking 逐字流式、text 走整块、子代理走整块）；
   *  缺省 false（partial=off / btw / titleGenerator / 测试），现状不变。 */
  partialMode: boolean = false,
  /** 思考展示开关（「设置→通用」下发，见 emitSubagentBlocks 的 showThinking）：
   *  关闭时剥掉主线程 thinking_delta 流与 assistant thinking 整块。缺省 true 兼容旧调用。 */
  showThinking: boolean = true,
) {
  if (msg.parent_tool_use_id) {
    emitSubagentProgress(msg, emit, subagents, partialMode, showThinking);
    return;
  }

  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    // undefined（旧版 CLI/无此概念）不发；[] 是 SDK 明确给的空清单，正常发。
    if (Array.isArray(msg.slash_commands)) {
      emit({ type: "slash_commands_available", commands: msg.slash_commands });
    }
    return;
  }

  // SDK 把上下文压缩作为 system/status 生命周期报告。这里把 Claude 专属字段翻成
  // provider-agnostic 的 context_compaction；SDK 没有真实可测的完成比例，故不伪造
  // 百分比。task_progress 是任务/子代理心跳，和压缩无关，保持下方原有的忽略逻辑。
  if (msg.type === "system" && msg.subtype === "status") {
    // SDKStatusMessage 不是互斥联合：终态可能和旧的 "compacting" 状态同帧带到。
    // 因而必须先判终态，避免把失败/完成错误地留在进行中。
    if (msg.compact_result === "failed" || msg.compact_error) {
      const error = compactErrorText(msg.compact_error);
      emit({
        type: "context_compaction",
        stage: "failed",
        ...(error ? { error } : {}),
      });
      return;
    }
    if (msg.compact_result === "success") {
      emit({ type: "context_compaction", stage: "completed" });
      return;
    }
    if (msg.status === "compacting") {
      emit({ type: "context_compaction", stage: "compacting" });
      return;
    }
  }

  // 本地 slash 命令（/clear /compact /usage 等）：SDK 自己拦截、绕过模型，只落一条
  // system/local_command_output（SDK 类型注释原话："Displayed as assistant-style
  // text in the transcript"），既不会有 assistant 消息也不会有 result——这里必须补上
  // 这条通路，否则用户发 /clear 后界面毫无反应：没有确认文案，running 状态也永远
  // 等不到 message_stop 收尾。复用现有 text_delta + message_stop（而不是新增一个
  // Claude 专属事件类型）——协议层不关心"本地命令"这个概念是不是 Claude 独有的。
  if (msg.type === "system" && msg.subtype === "local_command_output") {
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (content) {
      emit({ type: "text_delta", delta: content });
    }
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null });
    return;
  }

  // 后台 shell 任务起步信号：SDK 在命令转入后台时发 system/task_started。
  // 注意 CLI 对【前台】Bash 也发这条（task_type 同样是 local_bash）——是否后台由
  // tracker 按发起 tool_use 的 run_in_background 判定（见 bgTasks.ts 注释）。
  // 与 Bash 后台回执的到达顺序不保证，两边都按 task_id upsert。
  if (msg.type === "system" && msg.subtype === "task_started") {
    const ev = bgTaskHooks?.tracker.registerStarted(msg);
    if (ev) emit(ev);
    return;
  }

  // 后台任务终态信号（structured 通道）。注意：local_bash 的终态实际走
  // <task-notification> XML 用户消息（下方 user-string 分支，2026-07-25 转录实锤），
  // 这条 structured system/task_notification 只是防御性兜底——两个通道都按 tracker
  // 去重（done 守卫），先到先处理。只处理 tracker 里登记过的任务，其余安静忽略。
  if (msg.type === "system" && msg.subtype === "task_notification") {
    const ev = bgTaskHooks?.tracker.handleNotification(msg);
    if (ev) {
      bgTaskHooks?.stopTail(msg.task_id as string);
      emit(ev);
    }
    return;
  }

  // task_updated：结构化状态补丁——patch.status 终态是文本通道之外最可靠的信号，
  // 三个文本通道（回执/XML/TaskOutput）全是逆向格式，这条是 SDK 类型契约里的字段。
  // task_progress 只是活性心跳（用量/时长），面板不需要，忽略。
  if (msg.type === "system" && msg.subtype === "task_updated") {
    const ev = bgTaskHooks?.tracker.handleTaskUpdated(msg);
    if (ev) {
      bgTaskHooks?.stopTail(msg.task_id as string);
      emit(ev);
    }
    return;
  }
  if (msg.type === "system" && msg.subtype === "task_progress") {
    return;
  }

  // partial=on 时的逐字增量。主会话只放 thinking 流式——thinking_delta 逐字转发；
  // text_delta 仍走下方 assistant 整块（text 不流式，避开历史 partial 卡死坑）。
  // partial=off（btw/title）SDK 不发 stream_event，本分支不触发。
  if (msg.type === "stream_event") {
    if (!partialMode) return;
    const ev = msg.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking && showThinking) {
      emit({ type: "thinking_delta", delta: ev.delta.thinking });
    }
    return;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    // 真实 wire model 随本条消息的首个块事件带给前端——消息气泡据此显示
    // 「这条回答出自哪个模型」（API 落盘标识，比模型自报身份可靠）。占位符/
    // 错误回声的 model 不可采信（isAdoptableAssistantModel），不盖章。
    const wire = isAdoptableAssistantModel(msg) ? (msg.message.model as string) : undefined;
    const label = wire ? (resolveModelLabel?.(wire) ?? wire) : undefined;
    let stamped = false;
    const withModel = <T extends Record<string, unknown>>(e: T): T => {
      if (!wire || stamped) return e;
      stamped = true;
      return { ...e, model: wire, modelLabel: label };
    };
    for (const block of msg.message.content) {
      if (block.type === "text") {
        // text 整块：partial=on 时 stream_event 的 text_delta 被 mapper 丢弃（B 方案
        // text 不流式），text 只从完整 assistant message 整块发；partial=off 时 SDK
        // 不发 stream_event，也是整块发。两条路都落到这里，是 text 的唯一来源。
        if (block.text) emit(withModel({ type: "text_delta", delta: block.text }));
        continue;
      } else if (block.type === "thinking") {
        // 主线程 thinking block 整块。partial=on 时已被 stream_event 的 thinking_delta
        // 逐字发过，此处跳过去重；partial=off 时这是唯一来源（整块转发）。文本为空
        // 时跳过——provider 用 display=omitted 时 block 在但 text 空，两边都不发。
        // 思考开关关闭（showThinking=false）时剥除——ollama 兼容端点不认 thinking
        // 参数，模型总会出思考块，API 层关不掉，只能这里剥（2026-08-21 实测）。
        if (block.thinking && !partialMode && showThinking) emit({ type: "thinking", text: block.thinking });
        continue;
      } else if (block.type === "tool_use") {
        // 插队安全边界判断的账本：不管是普通工具、Task/Agent 子代理还是内置
        // Task* 工具，从主线程视角都是"一步指令，结果没回来之前不能打断"。
        tools.onToolUse(block.id);
        if (SubagentTracker.isSubagentTool(block.name)) {
          const { agentName, description, prompt } = subagents.handleToolUse(block.id, block.input);
          emit(withModel({ type: "subagent_start", id: block.id, agentName, description, ...(prompt ? { prompt } : {}) }));
        } else if (TaskTracker.isTaskTool(block.name)) {
          if (tasks.handleToolUse(block.id, block.name, block.input)) {
            emit({ type: "tasks_update", tasks: tasks.snapshot() });
          }
        } else {
          // Bash 调用的入参顺手登记——若它转入后台，task_started/后台回执要用
          // command/description 填充面板展示（tracker 内部 FIFO 上限，无泄漏）。
          if (block.name === "Bash") bgTaskHooks?.tracker.noteBashToolUse(block.id, block.input);
          emit(withModel({ type: "tool_use_start", id: block.id, name: block.name, input: block.input }));
        }
      }
    }
    return;
  }

  // async 子代理完成信号：SDK 往父会话塞一条 content 是 XML 字符串（而非 block 数组）
  // 的 type:"user" 消息。必须在下面的 block 数组循环之前判断——content 是字符串时
  // `for...of` 会逐字符遍历，产生的"block"全是单字符、匹配不到任何 block.type，之前
  // 这条消息因此被悄悄丢弃，async 子代理卡片永远停在 launch-ack 假结束。
  if (msg.type === "user" && msg.message && typeof msg.message.content === "string") {
    const note = parseTaskNotification(msg.message.content);
    if (note) {
      if (subagents.isActive(note.toolUseId)) {
        (outputTailHooks?.stop ?? globalStopOutputTail)(note.toolUseId);
        subagents.handleAsyncResult(note.toolUseId);
        emit({ type: "subagent_end", id: note.toolUseId, result: note.result, is_error: note.status !== "completed" });
      } else if (note.taskId && bgTaskHooks?.tracker.has(note.taskId)) {
        // 后台 shell 任务的终态走同一条 XML 通道（local_bash 实际不发 structured
        // system/task_notification）——停 tail（finalFlush 冲掉尾巴）再发终态。
        const ev = bgTaskHooks.tracker.handleXmlNotification(note.taskId, note.status, note.result);
        if (ev) {
          bgTaskHooks.stopTail(note.taskId);
          emit(ev);
        }
      }
      return;
    }
    // 其它字符串 content（普通用户输入等）：当前主流程不处理，保持现状丢弃。
  }

  // 防御性兜底：SDK 有时会以内部队列日志 type:"queue-operation"/operation:"enqueue"
  // 携带同一段 task-notification XML（这条通路不保证一定流到 sidecar），同样解析处理。
  if (msg.type === "queue-operation" && msg.operation === "enqueue" && typeof msg.content === "string") {
    const note = parseTaskNotification(msg.content);
    if (note && subagents.isActive(note.toolUseId)) {
      (outputTailHooks?.stop ?? globalStopOutputTail)(note.toolUseId);
      subagents.handleAsyncResult(note.toolUseId);
      emit({ type: "subagent_end", id: note.toolUseId, result: note.result, is_error: note.status !== "completed" });
    } else if (note?.taskId && bgTaskHooks?.tracker.has(note.taskId)) {
      const ev = bgTaskHooks.tracker.handleXmlNotification(note.taskId, note.status, note.result);
      if (ev) {
        bgTaskHooks.stopTail(note.taskId);
        emit(ev);
      }
    }
    return;
  }

  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        tools.onToolResult(block.tool_use_id);
        const content = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? "").join("")
          : String(block.content ?? "");
        // 优先检查 async launch-ack 签名（agentId: + output_file:）。命中则是子代理刚起步
        // 的回执，不是结果——不调 handleToolResult（保持 active），发 subagent_async_launched
        // 让后续 tail 回放 .output 文件。
        const ack = parseAsyncLaunchAck(content);
        if (ack && subagents.isActive(block.tool_use_id)) {
          subagents.registerAsync(block.tool_use_id, ack.agentId, ack.outputFile);
          emit({ type: "subagent_async_launched", id: block.tool_use_id, agentId: ack.agentId, outputFile: ack.outputFile });
          (outputTailHooks?.start ?? globalStartOutputTail)(block.tool_use_id, ack.outputFile, emit, (_tailId) => {
            // 无增长超时兜底由 Task 3 的 task-notification 主路径收尾；此处仅做安全网：
            // tail 自身不判定 done，只负责进度回放。stopOutputTail 由 task-notification 分支调。
          });
          continue;
        }
        // 后台 Bash 回执（"Command running in background with ID: … Output is being
        // written to: …"）：登记任务 + 启动输出 tail，发 bg_task_started upsert。
        // 不 continue——回执文本同时就是该工具调用的结果，照走下方通用 tool_result
        // 路径，让消息流里的 Bash 卡片正常收尾（与 CLI 行为一致）。
        const bgAck = bgTaskHooks?.tracker.registerAck(block.tool_use_id, content);
        if (bgAck) {
          emit(bgAck.event);
          bgTaskHooks?.startTail(bgAck.taskId, bgAck.outputFile);
        }
        // TaskOutput(block) 主动等待的流程：结果已同步交给模型，CLI 不一定再注入
        // XML 通知——工具结果里的 <status> 终态就是该流程的结束信号。同样不 continue，
        // TaskOutput 自己的工具卡片照常收尾。
        const bgOut = bgTaskHooks?.tracker.handleTaskOutputResult(content);
        if (bgOut) {
          bgTaskHooks?.stopTail(bgOut.taskId);
          emit(bgOut.event);
        }
        // sync 子代理或其他工具的结果
        if (subagents.handleToolResult(block.tool_use_id)) {
          emit({ type: "subagent_end", id: block.tool_use_id, result: content, is_error: block.is_error ?? false });
          continue;
        }
        const outcome = tasks.handleToolResult(block.tool_use_id, content);
        if (outcome.changed) {
          emit({ type: "tasks_update", tasks: tasks.snapshot() });
        }
        if (!outcome.tracked) {
          emit({ type: "tool_result", id: block.tool_use_id, content, is_error: block.is_error ?? false });
        }
      }
    }
    return;
  }

  if (msg.type === "result") {
    // 本轮派发的子代理数——在任何分支之前读取并清零（一轮一个 result，error/abort
    // 也要消费掉计数，避免泄漏到下一轮）。result 时子代理都已 handleToolResult 出 active，
    // 只能靠这个计数器判断"本轮是否含子代理活动"。
    const subagentCount = subagents.consumeTurnSubagentCount();
    // 错误 result（鉴权/额度/达上限等）SDK 不抛异常，会走到这里。以前和成功一样
    // 压成 message_stop，错误细节全被吞掉 → 前端静默落 waiting，用户"发消息没反应"。
    // 现在路由到 error 通道（fatal:false，进程仍存活可重试），前端会渲染错误气泡。
    if (msg.is_error === true || msg.subtype !== "success") {
      // 主动打断的 result 不是错误——压成 message_stop 正常收轮，
      // 不弹红色错误气泡（见 isBenignAbortResult 注释）。
      if (isBenignAbortResult(msg)) {
        emit({
          type: "message_stop",
          stop_reason: "interrupted",
          total_cost_usd: msg.total_cost_usd ?? null,
          usage: null,
        });
        return;
      }
      emit({ type: "error", message: describeResultError(msg), fatal: false });
      return;
    }
    const modelUsage = msg.modelUsage as Record<string, {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }> | undefined;
    let usage: TurnUsage | null = null;
    if (modelUsage) {
      const entries = Object.entries(modelUsage);
      const total: TurnUsage = {
        inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0,
      };
      // 同时保留按模型分桶——多模型会话（如子代理用了别的模型）能让前端看到每个模型各烧多少。
      // 单模型时不带 byModel（省得每轮都塞一个只有一项的 map，前端按"键数>1"判断是否展开）。
      const byModel: Record<string, TurnUsage> = {};
      for (const [modelId, m] of entries) {
        const u: TurnUsage = {
          inputTokens: m.inputTokens ?? 0,
          outputTokens: m.outputTokens ?? 0,
          cacheReadInputTokens: m.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: m.cacheCreationInputTokens ?? 0,
          costUsd: m.costUSD ?? 0,
        };
        byModel[modelId] = u;
        total.inputTokens += u.inputTokens;
        total.outputTokens += u.outputTokens;
        total.cacheReadInputTokens += u.cacheReadInputTokens;
        total.cacheCreationInputTokens += u.cacheCreationInputTokens;
        total.costUsd += u.costUsd;
      }
      usage = total;
      if (subagentCount > 0) {
        usage.subagentTurn = true;
        usage.subagentCount = subagentCount;
      }
      if (Object.keys(byModel).length > 1) {
        usage.byModel = byModel;
      }
      // num_turns 是 turn 级 API 调用数（不按模型拆），透传给前端做「×N」分解——
      // 4.2m 累计输入 ÷ 20 ≈ ctx，让徽标不再反直觉。
      if (typeof msg.num_turns === "number") usage.apiCallCount = msg.num_turns;
    }
    emit({
      type: "message_stop",
      stop_reason: msg.subtype === "success" ? "end_turn" : msg.subtype,
      total_cost_usd: msg.total_cost_usd ?? null,
      usage,
    });
    return;
  }
}
