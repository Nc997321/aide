import { api } from "../../api";
import { builtinHooks, type BuiltinHookManifest } from "../../composables/useCustomizations";
import type { ContextUsageCategory } from "../../types/chat";
import type { HealthSnapshot } from "../../composables/useDiagnosticsDashboard";
import type {
  BgTask,
  ChatMessage,
  ContentBlock,
  ContextCompactionState,
  ModelOption,
  PermissionModeOption,
  SubagentBlock,
  SubagentEntry,
  TaskItem,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  UserMessageBlock,
} from "../../types/chat";
import { useBtwSession } from "../useBtwSession";
import { judgeReadRelay, lastLspContextInMessages } from "../../utils/lspRelay";
import { useCodeGraphProgress } from "../useCodeGraphProgress";
import { useSessionNames } from "../useSessionNames";
import { sessionIdentityStore } from "../../composables/sessionIdentity";
import { useSessionState, markSessionUntracked } from "../useSessionState";
import {
  sessionState,
  stores,
  aliasMap,
  finalizedSids,
} from "./state";
import { maybeEvict } from "./evict";
import {
  BG_TASKS_CAP,
  BG_TASK_OUTPUT_CAP,
  SUBAGENT_ENTRY_CAP,
  appendSubagentTextEntry,
  clearBgDockAutoHide,
  diag,
  disposedSids,
  finalizeSession,
  finishStreaming,
  getOrCreateAssistant,
  getStore,
  isPendingSession,
  lookupSubagent,
  lookupToolCall,
  registerSubagent,
  registerToolCall,
  resetRuntimeState,
  resolveSid,
  scheduleBgDockAutoHide,
  sharedModels,
  sharedPermissionModes,
  sharedRateLimit,
  stampMessageModel,
  unregisterSubagent,
  unregisterToolCall,
} from "./state";

/** context_usage.categories 的 wire 形状守卫：name 为字符串标签、tokens 为数值，
 *  其余字段（isDeferred 等）可选——跨边界数据逐元素重建，非法元素静默剔除。 */
function isUsageCategory(v: unknown): v is ContextUsageCategory {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r["name"] === "string" && typeof r["tokens"] === "number";
}

/**
 * 流式事件总路由（拆分自原 2000+ 行宿主）：按事件类型分发到 per-sid store。
 */
/**
 * 用户消息的渲染描述 → 气泡块。
 *
 * display 缺失时（鸿蒙 v1 这类只发纯文本的客户端）降级成单个文本块——保证任何
 * 客户端发的消息在桌面上都看得见，不因协议版本差而整个消失。
 *
 * mention 复用 ToolCallBlock 的 Read 卡片渲染，与本地 @引用显示保持一致；未知形态
 * 直接跳过而不是抛错，这样 sidecar 未来新增 block 类型时老前端不会白屏。
 */
function blocksFromDisplay(
  display: UserMessageBlock[] | undefined,
  text: string,
): ContentBlock[] {
  const mapped = (display ?? [])
    .map((b): ContentBlock | null => {
      switch (b.type) {
        case "text":
          return b.text ? { type: "text", text: b.text } : null;
        case "image":
          return { type: "image", data: b.data, mediaType: b.mediaType };
        case "action":
          return {
            type: "action",
            actionId: b.actionId,
            label: b.label,
            ...(b.icon ? { icon: b.icon } : {}),
          };
        // @引用 → 合成 Read 卡（与历史回看路径 transcriptMapping 同形）。带 range
        // 时补 offset/limit，让卡片头行显示行号区间——模型并未真的调 Read，这里
        // 只是借用 Read 卡的展示形态。lspRelay 跳过用户消息，不会被误判成接力。
        case "mention":
          return {
            type: "tool_call",
            id: crypto.randomUUID(),
            name: "Read",
            input: b.range
              ? { file_path: b.path, offset: b.range.start, limit: b.range.end - b.range.start + 1 }
              : { file_path: b.path },
            result: b.content,
            isError: false,
            isPending: false,
          };
        default:
          return null;
      }
    })
    .filter((b): b is ContentBlock => b !== null);
  return mapped.length ? mapped : text ? [{ type: "text", text }] : [];
}

export function handleChatEvent(e: Record<string, unknown>): void {
  // 内置 hook 清单：sidecar 会话启动时 emit 的全局元数据（无 session_id），路由到扩展管理。
  if (e["type"] === "builtin_hooks_manifest") {
    builtinHooks.value = (e["manifest"] as BuiltinHookManifest[]) ?? [];
    return;
  }
  const raw = e["session_id"] as string | undefined;
  if (!raw) return;
  // btw 事件路由到独立 store,不进主对话 store(隔离红线)
  const btw = useBtwSession();
  if (btw.isBtwSid(raw)) {
    btw.handleBtwEvent(e);
    return;
  }
  const sid = resolveSid(raw);
  // 已收口销毁的会话：拦截一切延迟事件，防止 getStore 重建僵尸 store
  if (disposedSids.has(sid)) return;
  const store = getStore(sid);

  const identity = sessionIdentityStore;
  const { setSessionState, setSessionHealth, removeSessionState } = useSessionState();

  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid && isPendingSession(sid) && sdkSid !== sid) {
        // 临时 key 首次被 SDK 确认：finalizeSession 同步段已把 running 盖到 realId
        // 并 removeSessionState(tempId)。这里不能再 setSessionState(sid, ...)——
        // sid 是过期的 tempId，写回去会在 sessionStateMap 里留下孤儿条目，
        // 右上角"活跃会话"因此出现一个点进去空白的会话。realId 的 running 由
        // finalizeSession 负责，本分支直接结束。
        void finalizeSession(sid, sdkSid);
        break;
      }
      if (sdkSid && sdkSid !== sid) {
        // 非交互式来源（自动化运行/蒸馏轮等）：事件路由键（run_xxx）与 SDK 真实 id
        // 不一致。这类会话没有任何用户面板：若照常登记状态，sessionStateMap 会出现
        // 两个条目——路由键永远收不到终态（后续事件全带真实 id）的孤儿 running，
        // 以及无人消费的真实 id 条目（2026-08-30 实锤：自动化一次运行凭空多出两个
        // "一直存在"的会话）。处理：别名归一 + 状态不跟踪 + store 过户到真实 id。
        aliasMap.set(sid, sdkSid);
        markSessionUntracked(sdkSid);
        if (stores[sid] && !stores[sdkSid]) stores[sdkSid] = stores[sid];
        delete stores[sid];
        removeSessionState(sid);
        break;
      }
      setSessionState(sid, "running");
      // 落盘已在发送前（ChatPanel.onSendRequest 的 settleOnSend）完成，此处不再落盘。
      break;
    }
    case "text_delta": {
      const msg = getOrCreateAssistant(store);
      stampMessageModel(msg, e);
      const last = msg.blocks[msg.blocks.length - 1];
      if (last?.type === "text") {
        (last as TextBlock).text += e["delta"] as string;
      } else {
        msg.blocks.push({ type: "text", text: e["delta"] as string });
      }
      break;
    }
    case "thinking":
    case "thinking_delta": {
      // 主线程思考：partial=on 走 thinking_delta 逐字增量（delta 字段），partial=off / 历史
      // 回放走 thinking 整块（text 字段）。前端都是"追加到末尾同类型 block，否则新建"，
      // 用 text ?? delta 兼容两路。不盖 model——思考事件不带 model/modelLabel（模型徽标
      // 由同消息首个 text/tool_use 块盖）。
      const chunk = (e["text"] as string) ?? (e["delta"] as string);
      const msg = getOrCreateAssistant(store);
      const last = msg.blocks[msg.blocks.length - 1];
      if (last?.type === "thinking") {
        (last as ThinkingBlock).text += chunk;
      } else {
        msg.blocks.push({ type: "thinking", text: chunk });
      }
      break;
    }
    case "tool_use_start": {
      const msg = getOrCreateAssistant(store);
      stampMessageModel(msg, e);
      const toolId = e["id"] as string;
      const block: ToolCallBlock = {
        type: "tool_call",
        id: toolId,
        name: e["name"] as string,
        input: e["input"],
        isPending: true,
      };
      // F 方案（Read 接力显示）：Read 入场即判定是否沿用了上一个 LSP 调用的坐标，
      // 结论钉在块上随块渲染。判定核心与回看路径（transcriptMapping）共用同一实现；
      // 各以可见范围为限（见 lspRelay.ts 注释），跨页角部可能中性。
      if (block.name === "Read") {
        const relay = judgeReadRelay(block.input, lastLspContextInMessages(store.messages));
        if (relay) block.lspRelay = relay;
      }
      msg.blocks.push(block);
      registerToolCall(sid, toolId, block);
      break;
    }
    case "tool_result": {
      const toolId = e["id"] as string;
      const block = lookupToolCall(sid, toolId);
      if (block) {
        block.result = e["content"] as string;
        block.isError = e["is_error"] as boolean;
        block.isPending = false;
        unregisterToolCall(sid, toolId);
      }
      break;
    }
    case "permission_request": {
      store.pendingPermissions.push({
        id: e["id"] as string,
        name: e["name"] as string,
        input: e["input"],
        fromSubagent: e["fromSubagent"] as { id: string; agentName: string } | undefined,
      });
      setSessionState(sid, "attention");
      break;
    }
    case "permission_cancelled": {
      // 语义是「这条请求已终结」而不是「被取消」——批准/拒绝也走这里（远程客户端
      // 应答时本机没有对账动作，全靠这条事件撤弹窗）。
      const cancelledId = e["id"] as string;
      const wasQueued = store.pendingPermissions.some((p) => p.id === cancelledId);
      store.pendingPermissions = store.pendingPermissions.filter((p) => p.id !== cancelledId);
      // 队列清空 → 回到 running：只有本事件能把远程做出的决策反映到状态机上
      // （本地应答的回退在 respondPermission 里，那条路不会走到这里）。
      // 两重守卫：
      //  - wasQueued：本机应答时弹窗早已乐观出队，重放事件不该再动状态机；
      //  - attention：interrupt/stop 的 cancelAll 同样发本事件，那些场景终态是
      //    waiting/stopped，不能把已收口的会话推回 running。
      if (wasQueued && store.pendingPermissions.length === 0 && sessionState[sid] === "attention") {
        setSessionState(sid, "running"); // 放行后恢复生成（running 恒绿，无软超时）
      }
      break;
    }
    case "models_available": {
      store.models = e["models"] as ModelOption[];
      store.currentModel = e["current"] as string;
      sharedModels.value = store.models;
      // 坐实 L2 身份层：runtimeModel 供 effectiveModel 优先级，sdkModels 供系统默认下拉。
      // 进程坐实对账落盘：current 是 sidecar 坐实的下拉 value（resolveDropdownValue
      // 归一），按「盘上身份=进程现实」把它落盘（同值跳过在 commitModelFromRuntime 内）。
      // 这是「首发前选定模型」唯一能落盘的通路——该场景全程不发生 model switch、
      // 无 PostModelSwitch，settleOnSend 收窄后模型落盘无人补位（审查打回项 3）。
      identity.bindRuntime(sid, store.currentModel);
      identity.setSdkModels(sid, store.models);
      void identity.commitModelFromRuntime(sid, {
        fromModel: "",
        toModel: store.currentModel,
        requestedModel: store.currentModel,
        source: "spawn",
      });
      break;
    }
    case "model_switch_result": {
      // 模型切换终态回执（用户显式切换被受理：成功由 model_committed 驱动的
      // onCommitted 发出，失败/超时由 applyModelSwitch catch 发出）。任何终态都
      // 终结挂起的成本确认弹窗——否则超时自动 deny 后弹窗滞留，用户点「继续切换」
      // 被已清空的挂起槽静默吞掉且不走回滚（下拉卡在从未生效的模型上）。
      store.modelSwitchConfirm = null;
      store.modelSwitchResult = {
        ok: e["ok"] as boolean,
        model: e["model"] as string,
        display: (e["display"] as string) || (e["model"] as string),
        error: e["error"] as string | undefined,
        seq: (store.modelSwitchResult?.seq ?? 0) + 1,
        at: Date.now(),
      };
      // 成功回执的 model 是 sidecar 归一后的真名命名空间值（to_model 经 roster
      // 归一）——选中值坐实与落盘由它驱动。不从 model_committed.requested 取：
      // 那是 CLI 别名命名空间回显，进账面曾造成裸别名上屏 + 选中值掉出选项
      // 集合 + 别名写盘（2026-09-11 sonnet 事故）。
      if (store.modelSwitchResult.ok) {
        store.currentModel = store.modelSwitchResult.model;
        void identity.commitModelFromRuntime(sid, {
          fromModel: "",
          toModel: store.modelSwitchResult.model,
          requestedModel: store.modelSwitchResult.model,
          source: "sdk",
        });
      }
      break;
    }
    case "model_switch_confirm": {
      // 模型切换成本确认（SDK PreModelSwitch hook 挂起）：非 null 即弹确认框；
      // 决定经 api.modelSwitchConfirmDecision 回传，回传后由 UI 置 null。
      const src = e["source"];
      const ttl = e["cache_ttl"];
      store.modelSwitchConfirm = {
        confirmId: e["confirm_id"] as string,
        fromModel: e["from_model"] as string,
        toModel: e["to_model"] as string,
        source: src === "command" || src === "picker" ? src : "sdk",
        contextTokens: e["context_tokens"] as number,
        promptCacheWarm: e["prompt_cache_warm"] === true,
        estimatedCacheWriteUsd: e["estimated_cache_write_usd"] as number,
        cacheTtl: ttl === "1h" ? "1h" : "5m",
      };
      break;
    }
    case "model_committed": {
      // 进程坐实（SDK PostModelSwitch）：切换真实完成。本 case 只终结挂起的成本
      // 确认弹窗——选中值坐实与落盘已换轴到 model_switch_result(ok)（携带 sidecar
      // 归一的真名值）；requested_model 是 CLI 别名命名空间回显，纯信息字段，
      // 不进账面（2026-09-11 sonnet 事故：裸别名上屏 + 选中值掉出选项集合 + 别名写盘）。
      store.modelSwitchConfirm = null;
      break;
    }
    case "effort_changed": {
      // effort 切换坐实/回滚——成功带新值，失败（sidecar 驳回）带回滚后的旧值
      //  + error。选择器据此同步（失败时弹提示并拉回旧值）。
      store.currentEffort = e["effort"] as string;
      const err = e["error"] as string | undefined;
      if (err) {
        store.effortSwitchError = {
          message: err,
          seq: (store.effortSwitchError?.seq ?? 0) + 1,
        };
      }
      break;
    }
    case "context_usage": {
      store.contextUsage = {
        totalTokens: e["total_tokens"] as number,
        maxTokens: e["max_tokens"] as number,
        percentage: e["percentage"] as number,
        // 可选扩展字段：缺省（旧 sidecar/降级）时 undefined，环形照常工作
        rawMaxTokens:
          typeof e["raw_max_tokens"] === "number" ? e["raw_max_tokens"] : undefined,
        // wire 数据逐元素重建（M3：Array.isArray 只收窄到 any[]，元素形状必须
        // type-guard 校验，否则 name 缺失时 toLowerCase 直接炸组件）
        categories: Array.isArray(e["categories"])
          ? e["categories"].filter(isUsageCategory)
          : undefined,
      };
      break;
    }
    case "context_compaction": {
      // 压缩生命周期只属于正在运行的轮次。终态之后偶发到达的旧事件不能把
      // 状态条重新挂回一个闲置会话。
      if (!store.isBusy) break;
      const stage = e["stage"];
      if (stage === "completed") {
        // 成功后立即交还给普通思考状态；实际压缩后的窗口变化仍走 context_usage。
        if (store.contextCompaction) store.contextCompaction = null;
        break;
      }
      if (stage !== "compacting" && stage !== "failed") break;

      const detail = typeof e["detail"] === "string" ? e["detail"] : undefined;
      const error = typeof e["error"] === "string" ? e["error"] : undefined;
      const previous = store.contextCompaction;
      const startedAt =
        stage === "failed" && previous
          ? previous.startedAt
          : stage === "compacting" && previous?.stage === "compacting"
            ? previous.startedAt
            : Date.now();
      const next: ContextCompactionState = {
        stage,
        startedAt,
        ...(detail ? { detail } : {}),
        ...(error ? { error } : {}),
      };
      // Sidecar 若重复报告同一阶段，保留原对象以免无意义地触发状态条重渲染。
      if (
        previous?.stage === next.stage
        && previous.detail === next.detail
        && previous.error === next.error
      ) break;
      store.contextCompaction = next;
      break;
    }
    case "tasks_update": {
      store.tasks = e["tasks"] as TaskItem[];
      break;
    }
    case "session_title": {
      // 会话自动命名：sidecar 在 send 时同步截取首条消息生成的标题。
      //
      // 时机陷阱（2026-09-06 实锤）：这个事件早于 session_init 到达，此时会话
      // 只有临时 id、元数据尚未落盘。拿 sid（= tempId）去 auto_rename 会把标题
      // 写进 <tempId>.json，紧接着 create_session(realId, 默认名) 建真正的文件
      // ——标题变成孤儿，名字永远是「新会话 HH:MM:SS」。故未定名的会话只暂存，
      // 定名（finalizeSession）后由落盘方直接用作名字，一次写盘即最终名。
      const title = e["title"] as string;
      if (title) {
        if (finalizedSids.has(sid)) {
          // 已定名会话的迟到标题（正常路径下不会发生）：走原子改名，是否采纳由
          // Rust 判定（nameSource==manual 拒写）——返回 true 才更新名字注册表，
          // 侧栏卡片显示走注册表（SidebarLeft 模板 names[s.id] || s.name）。
          void api.autoRenameSession(sid, title).then((adopted) => {
            if (adopted) useSessionNames().setName(sid, title);
          }).catch(() => { /* 自动命名失败静默——保留默认名 */ });
          break;
        }
        // 尚未定名：sid 还是临时 id，此刻落盘会写进 <tempId>.json 成为孤儿。
        // 暂存即可——定名（finalizeSession）时随其它注册表迁到真实 id，
        // 由落盘方（各端 onSessionCreated）直接用作名字。
        // 注意这里不能用「本端是否 pending」判断：别的客户端（PWA）发起的会话，
        // 本端不是 pending 但同样只是旁观者，落盘由发起方负责——两端都暂存，
        // 最终写下的名字一致，谁后写都不出错。
        useSessionNames().setPendingTitle(sid, title);
      }
      break;
    }
    case "bg_task_started": {
      // task_started 与后台回执两路信号顺序不保证——按 id upsert 合并。
      clearBgDockAutoHide(sid); // 新任务起步：取消待执行的自动撤条
      const id = e["id"] as string;
      let task = store.bgTasks.find((t) => t.id === id);
      if (!task) {
        task = { id, status: "running", output: "", startedAt: Date.now() };
        store.bgTasks.push(task);
        // 新任务自动成为 dock 里的选中项（用户最想看的是刚起来的那个）
        store.bgDockSelectedId = id;
      }
      if (e["toolUseId"]) task.toolUseId = e["toolUseId"] as string;
      if (e["command"]) task.command = e["command"] as string;
      if (e["description"]) task.description = e["description"] as string;
      break;
    }
    case "bg_task_output": {
      const task = store.bgTasks.find((t) => t.id === (e["id"] as string));
      if (!task) break;
      task.output += e["delta"] as string;
      // 截头保尾：长跑命令的输出无界增长，超出 256KB 丢掉最旧的部分
      if (task.output.length > BG_TASK_OUTPUT_CAP) {
        task.output = task.output.slice(task.output.length - BG_TASK_OUTPUT_CAP);
      }
      break;
    }
    case "bg_task_ended": {
      const task = store.bgTasks.find((t) => t.id === (e["id"] as string));
      if (!task) break;
      task.status = e["status"] as BgTask["status"];
      if (e["summary"]) task.summary = e["summary"] as string;
      task.endedAt = Date.now();
      // 结束的任务留在列表里（用户可能正看着）——dock 关着且没有运行中任务时，
      // 短暂停留后自动撤条（scheduleBgDockAutoHide）；dock 开着则等关闭时清。
      scheduleBgDockAutoHide(sid);
      // 兜底上限：淘汰最老的已结束项，运行中的不动。
      if (store.bgTasks.length > BG_TASKS_CAP) {
        const idx = store.bgTasks.findIndex((t) => t.status !== "running");
        if (idx >= 0) store.bgTasks.splice(idx, 1);
      }
      break;
    }
    case "rate_limit": {
      // 账号级配额，跨会话共享——最新一条即当前状态；windows 空表示非订阅/不报配额。
      const rawWindows = (e["windows"] as Array<Record<string, unknown>> | undefined) ?? [];
      sharedRateLimit.value = {
        subscription: (e["subscription"] as string | null) ?? null,
        windows: rawWindows.map((w) => ({
          key: w["key"] as string,
          label: w["label"] as string,
          utilization: w["utilization"] as number,
          resetsAt: (w["resets_at"] as number | null) ?? null,
        })),
      };
      diag.handleRateLimitEvent(sharedRateLimit.value);
      break;
    }
    case "health": {
      // 边界收窄：health 事件负载即 HealthSnapshot（sidecar 固定形状）
      diag.handleHealthEvent({
        sessions: e["sessions"] as HealthSnapshot["sessions"],
        processes: e["processes"] as HealthSnapshot["processes"],
        timestamp: e["timestamp"] as number,
      });
      break;
    }
    case "permission_modes_available": {
      store.permissionModes = e["modes"] as PermissionModeOption[];
      store.currentPermissionMode = e["current"] as string;
      sharedPermissionModes.value = store.permissionModes;
      break;
    }
    case "slash_commands_available": {
      store.slashCommands = e["commands"] as string[];
      break;
    }
    case "subagent_start": {
      const msg = getOrCreateAssistant(store);
      stampMessageModel(msg, e);
      const saId = e["id"] as string;
      const block: SubagentBlock = {
        type: "subagent",
        id: saId,
        agentName: e["agentName"] as string,
        description: e["description"] as string,
        // task prompt 非空才带（主代理派发时塞进 Agent 工具 input 的完整任务描述）
        prompt: e["prompt"] ? (e["prompt"] as string) : undefined,
        entries: [],
        isPending: true,
      };
      msg.blocks.push(block);
      registerSubagent(sid, saId, block);
      break;
    }
    case "subagent_text_delta":
    case "subagent_thinking_delta": {
      const block = lookupSubagent(sid, e["id"] as string);
      if (block) {
        appendSubagentTextEntry(block, e["type"] === "subagent_text_delta" ? "text" : "thinking", e["delta"] as string);
      }
      break;
    }
    case "subagent_async_launched": {
      const block = lookupSubagent(sid, e["id"] as string);
      if (block) {
        block.asyncLaunched = { agentId: e["agentId"] as string, outputFile: e["outputFile"] as string };
      }
      break;
    }
    case "subagent_progress": {
      const block = lookupSubagent(sid, e["id"] as string);
      if (block) {
        block.entries.push({
          type: "tool",
          toolUseId: e["toolUseId"] as string,
          toolName: e["toolName"] as string,
          input: e["input"],
        });
        if (e["model"]) block.model = e["model"] as string;
      }
      break;
    }
    case "subagent_tool_result": {
      // 子代理内部某次工具的产出，按 toolUseId 回填到对应步骤——让步骤能显示输出，
      // 不只是工具名+入参摘要。找不到对应步骤（tool_use 没采到/乱序）时静默丢弃。
      const block = lookupSubagent(sid, e["id"] as string);
      if (block) {
        const toolUseId = e["toolUseId"] as string;
        const entry = block.entries.find(
          (en): en is Extract<SubagentEntry, { type: "tool" }> =>
            en.type === "tool" && en.toolUseId === toolUseId,
        );
        if (entry) {
          const content = e["content"] as string;
          if (content.length > SUBAGENT_ENTRY_CAP) {
            entry.truncated = { kind: "tool_result", originalBytes: (content.length - SUBAGENT_ENTRY_CAP) * 2 };
            entry.result = content.slice(-SUBAGENT_ENTRY_CAP);
          } else {
            entry.result = content;
          }
          entry.isError = e["is_error"] as boolean;
        }
      }
      break;
    }
    case "subagent_end": {
      const saId = e["id"] as string;
      const block = lookupSubagent(sid, saId);
      if (block) {
        const result = e["result"] as string;
        if (result.length > SUBAGENT_ENTRY_CAP) {
          block.resultTruncated = { kind: "subagent_result", originalBytes: (result.length - SUBAGENT_ENTRY_CAP) * 2 };
          block.result = result.slice(-SUBAGENT_ENTRY_CAP);
        } else {
          block.result = result;
        }
        block.isError = e["is_error"] as boolean;
        block.isPending = false;
        unregisterSubagent(sid, saId);
      }
      break;
    }
    case "subagent_nesting_warning": {
      // runtime 检测到子代理嵌套深度超阈值（warn-only，不阻止调用）——推给诊断面板显示。
      diag.handleNestingWarning({ depth: e["depth"] as number, threshold: e["threshold"] as number });
      break;
    }
    case "message_stop": {
      const usage = e["usage"] as ChatMessage["usage"] | null;
      const turnEffort = e["effort"] as string | undefined;
      if (usage || turnEffort) {
        const last = store.messages[store.messages.length - 1];
        if (last?.role === "assistant") {
          if (usage) last.usage = usage;
          // 本轮实际生效的 effort（sidecar 从 Stop hook 读到的权威值，含静默
          // 降级）——usage 行徽标的数据源；模型不支持 effort 时不带。
          if (turnEffort) last.turnEffort = turnEffort;
        }
        if (usage) diag.accumulateUsage(usage);
      }
      finishStreaming(store);
      // 失败状态留在会话尾部，直到用户真正发起下一轮，避免被紧随其后的
      // message_stop 一闪而过；进行中/成功状态仍在本轮结束时撤掉。
      if (store.contextCompaction?.stage !== "failed") store.contextCompaction = null;
      store.isBusy = false;
      setSessionState(sid, "waiting");
      // 本轮 agent 的 Edit/Write 可能改了文件——防抖触发一次增量重扫，
      // 保持 CodeGraph 索引新鲜（否则改动累积超 20% 阈值，下次构建退全量）。
      useCodeGraphProgress().scheduleRescan();
      break;
    }
    case "jump_queued": {
      // dispatchSend 在忙碌排队时已把消息暂存进 pendingJumps 并显示提示条——
      // sidecar 此处回传仅作确认（工具在跑、需等安全边界），不再重复 push，否则
      // 提示条会重复出现两条。工具空闲路径不发此事件，直接走 jump_promoted。
      break;
    }
    case "jump_promoted": {
      // 安全边界到达：排队的消息已被 sidecar 接入模型。这里**只清提示条**——气泡
      // 由紧邻其前的 user_message 事件渲染（sidecar 逐条入队、逐条广播 user_message，
      // 全部发完才发 jump_promoted）。新轮次由 sidecar 直接发起、不经过
      // dispatchSend，这里把忙碌态补回来（否则按钮区会闪"发送"且没有停止按钮）。
      // 上一轮若留下失败说明，也不能覆盖已经开始的下一轮。
      store.pendingJumps.length = 0;
      store.contextCompaction = null;
      store.isBusy = true;
      setSessionState(sid, "running");
      // 落盘已在发送前（settleOnSend）完成，此处不再落盘。
      break;
    }
    case "user_message": {
      // 用户气泡的**唯一渲染点**——本地、手机、PWA 发的消息全部落到这里。发送方
      // 不再本地乐观渲染（buildUserDisplay 只构造描述随命令下发），所以不会重复，
      // 也不需要 message_id 去重；代价是本地发送也多一个 RTT 才出气泡。
      //
      // finishStreaming 收尾上一条 assistant：无论谁发的，气泡都必须插在上一条
      // assistant 之后，否则流式续写会误把新回合内容接进上一条消息里。
      finishStreaming(store);
      store.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        blocks: blocksFromDisplay(
          e["display"] as UserMessageBlock[] | undefined,
          e["text"] as string,
        ),
        timestamp: Date.now(),
      });
      maybeEvict(sid, store);
      // 远程客户端（手机/PWA）发的消息不经过本地 prepareSend，忙碌态必须在这里
      // 补——否则桌面端看着消息出现，按钮区却仍显示"发送"、没有停止按钮。
      // 本地发送路径已设过同值，重复设置幂等。
      store.isBusy = true;
      setSessionState(sid, "running");
      break;
    }
    case "notification": {
      // 非致命通知（如供应商切换后会话迁移提示）
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: `${e["message"]}` }],
        timestamp: Date.now(),
      });
      break;
    }
    case "image_input_rejected": {
      // sidecar 二次防线：视觉请求从未到达模型，保持当前任务快照并让纯文本可立即续发。
      resetRuntimeState(store, false);
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: String(e["message"]) }],
        timestamp: Date.now(),
      });
      setSessionState(sid, "waiting");
      setSessionHealth(sid, "warning");
      break;
    }
    case "image_input_rollback": {
      // 模型 400 不支持图片：sidecar 已处理会话历史（会话不报废）。两种形态：
      // - 用户发图（text 非空）：整条消息已移除，文本暂存 rollbackText 由
      //   ChatPanel 回填输入框，用户手动重发。
      // - 模型 Read 图片（text 空）：tool_result 图片已替换为错误文本回喂模型，
      //   模型会改读文本继续，无需用户介入。
      // 这里只落一条提示消息 + 解除 busy。
      resetRuntimeState(store, false);
      const rollbackText = String(e["text"] ?? "");
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{
          type: "text",
          text: rollbackText
            ? "当前模型不支持图片输入，已移除该消息。文本已放回输入框，可手动重发。"
            : "当前模型不支持图片输入，已移除图片内容并告知模型，对话继续。",
        }],
        timestamp: Date.now(),
      });
      store.rollbackText = rollbackText;
      setSessionState(sid, "waiting");
      setSessionHealth(sid, "warning");
      break;
    }
    case "error": {
      // fatal:false = 可恢复错误，sidecar 进程仍存活等下一条 → 保留任务列表（可能继续更新）；
      // 缺省/true 按致命处理（进程已死）→ 清任务，兼容未重建的旧 bundle。
      resetRuntimeState(store, e["fatal"] !== false);
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: `Error: ${e["message"]}` }],
        timestamp: Date.now(),
      });
      // fatal:false 落 waiting + 红点，不再谎报 stopped（灰点）。
      if (e["fatal"] === false) {
        setSessionState(sid, "waiting");
        setSessionHealth(sid, "warning");
      } else {
        setSessionState(sid, "stopped");
      }
      break;
    }
    case "session_dead": {
      // 进程真的没了（Rust 侧 reader EOF 或心跳看门狗超时合成）。
      resetRuntimeState(store);
      const reason = e["reason"] as string | undefined;
      const detail = e["detail"] as string | undefined;
      const label =
        reason === "heartbeat_timeout"
          ? "会话无响应，已终止进程"
          : "会话进程已退出";
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: detail ? `${label}\n${detail}` : label }],
        timestamp: Date.now(),
      });
      setSessionState(sid, "stopped");
      break;
    }
  }

  // P0-3：事件驱动增长（push + 就地 +=）后检查淘汰阈值（节流，单点覆盖全部 case）
  maybeEvict(sid, store);
}
