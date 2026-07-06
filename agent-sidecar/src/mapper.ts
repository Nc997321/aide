import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { ChatEvent, ImageAttachment, RateLimitWindow, TurnUsage } from "./types.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";

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
 * 子代理内部消息（`parent_tool_use_id` 非空）：转发文本/thinking 的逐字增量（对齐
 * 主线程 stream_event 的粒度），以及工具调用摘要——三者按到达顺序穿插，前端据此
 * 拼出"子代理具体在做什么"的完整时间线（v2，取代 v1 的"只报工具调用摘要"）。
 *
 * 明确不支持嵌套子代理（子代理内部再调用 Task/Agent 工具）：那种情况会落进下面的
 * `toolUses` 分支，当成一次普通工具调用报出去（`toolName: "Agent"`），不递归展开
 * 其内部活动——这个场景现在用不到，按 YAGNI 不做。
 *
 * 顺带在第一条可采信的 assistant 消息上把 `message.model` 带一次，让前端知道这个
 * 子代理具体跑在哪个模型上（`claimModelReport` 保证只报一次）。
 */
function emitSubagentProgress(msg: any, emit: (e: ChatEvent) => void, subagents: SubagentTracker) {
  const parentId = msg.parent_tool_use_id as string;
  if (!subagents.isActive(parentId)) return; // 防御性：理论上不会出现不认识的 id

  // 逐字流式：子代理内部的 text_delta / thinking_delta 增量。
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev?.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        emit({ type: "subagent_text_delta", id: parentId, delta: ev.delta.text });
      } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        emit({ type: "subagent_thinking_delta", id: parentId, delta: ev.delta.thinking });
      }
    }
    return;
  }

  if (msg.type !== "assistant" || !msg.message?.content) return;
  const toolUses = (msg.message.content as any[]).filter((b) => b.type === "tool_use");
  if (toolUses.length === 0) return; // 纯文本/thinking：已经在 stream_event 阶段逐字发过，这里跳过避免重复渲染
  const model =
    isAdoptableAssistantModel(msg) && subagents.claimModelReport(parentId)
      ? (msg.message.model as string)
      : undefined;
  toolUses.forEach((block, i) => {
    emit({
      type: "subagent_progress",
      id: parentId,
      toolName: block.name,
      input: block.input,
      ...(i === 0 && model ? { model } : {}),
    });
  });
}

export function mapSdkMessage(
  msg: any,
  emit: (e: ChatEvent) => void,
  tasks: TaskTracker,
  subagents: SubagentTracker,
  tools: ToolLifecycleTracker,
) {
  if (msg.parent_tool_use_id) {
    emitSubagentProgress(msg, emit, subagents);
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

  // 真流式：query 开了 includePartialMessages，文本以 stream_event 的
  // text_delta 逐字到达；thinking_delta 等其他增量类型不进对话流。
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      emit({ type: "text_delta", delta: ev.delta.text });
    }
    return;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        // 文本已经在 stream_event 阶段逐字发过了（includePartialMessages 由
        // index.ts 无条件开启），整块再发一遍会导致前端重复渲染——只跳过。
        continue;
      } else if (block.type === "tool_use") {
        // 插队安全边界判断的账本：不管是普通工具、Task/Agent 子代理还是内置
        // Task* 工具，从主线程视角都是"一步指令，结果没回来之前不能打断"。
        tools.onToolUse(block.id);
        if (SubagentTracker.isSubagentTool(block.name)) {
          const { agentName, description } = subagents.handleToolUse(block.id, block.input);
          emit({ type: "subagent_start", id: block.id, agentName, description });
        } else if (TaskTracker.isTaskTool(block.name)) {
          if (tasks.handleToolUse(block.id, block.name, block.input)) {
            emit({ type: "tasks_update", tasks: tasks.snapshot() });
          }
        } else {
          emit({ type: "tool_use_start", id: block.id, name: block.name, input: block.input });
        }
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
    const entries = modelUsage ? Object.values(modelUsage) : [];
    let usage: TurnUsage | null = null;
    if (entries.length > 0) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
      for (const m of entries) {
        usage.inputTokens += m.inputTokens ?? 0;
        usage.outputTokens += m.outputTokens ?? 0;
        usage.cacheReadInputTokens += m.cacheReadInputTokens ?? 0;
        usage.cacheCreationInputTokens += m.cacheCreationInputTokens ?? 0;
        usage.costUsd += m.costUSD ?? 0;
      }
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
