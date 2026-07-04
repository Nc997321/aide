import * as readline from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ModelOption, PermissionModeOption, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import {
  mapSdkMessage,
  buildUserMessage,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
} from "./mapper.js";

function emit(event: ChatEvent) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// 存活心跳：每 5s 一次。Rust 侧读到任意 stdout 行（含心跳）即证明进程存活并重置
// 看门狗；连续 15s 无任何行 → 判死。unref() 让心跳本身不阻止进程自然退出。
const HEARTBEAT_INTERVAL_MS = 5_000;
setInterval(() => emit({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS).unref();

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const queue = new MessageQueue();
const permMgr = new PermissionManager();
const taskTracker = new TaskTracker();
const subagentTracker = new SubagentTracker();
let currentQuery: Awaited<ReturnType<typeof query>> | null = null;
let sessionId: string | undefined;
// 模型选择只存内存，不落盘——重开会话回落到 provider 默认模型。
let currentModel = "";
/** 最近一次从 assistant 消息里坐实的具体 wire model id，用来判断是否需要重新映射+广播。 */
let lastConcreteModel = "";
let lastModels: ModelOption[] = [];
// 内部用：alias(value) → resolvedModel 前缀，用来把 assistant 消息里的具体
// wire model id（如 "claude-sonnet-5-20260101"）反查回下拉里对应的别名选项。
let aliasByResolvedPrefix: { value: string; resolvedPrefix: string }[] = [];

// Claude 专属的权限模式清单（bypassPermissions 需要额外的危险开关，不提供）。
// 前端只拿到 value/displayName，语义完全由本 sidecar 解释。
const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", displayName: "默认权限" },
  { value: "acceptEdits", displayName: "自动接受编辑" },
  { value: "plan", displayName: "Plan 模式" },
];
// 同模型选择：只存内存，不落盘；重开会话回落到 default。
let currentPermissionMode = "default";

function emitPermissionModes() {
  emit({ type: "permission_modes_available", modes: PERMISSION_MODES, current: currentPermissionMode });
}

/** 切权限模式：query 已在跑就走 SDK 运行时接口（成功才广播）；还没起 query
 *  时只改本地状态（startLoop 创建 query 时带上），立即广播让前端下拉同步。 */
function applyPermissionMode(mode: string) {
  if (!PERMISSION_MODES.some((m) => m.value === mode)) return;
  if (mode === currentPermissionMode) return;
  const q = currentQuery;
  if (q) {
    q.setPermissionMode(mode as any)
      .then(() => {
        currentPermissionMode = mode;
        emitPermissionModes();
      })
      .catch(() => {});
  } else {
    currentPermissionMode = mode;
    emitPermissionModes();
  }
}

async function emitModelsAvailable(q: Awaited<ReturnType<typeof query>>) {
  try {
    const init = await q.initializationResult();
    // 剔除 CLI 报上来的内部占位符条目（如额度耗尽期间出现的 "<synthetic>"）——
    // 那不是真实可选模型，选中它会导致后续请求显式要一个不存在的模型而 404。
    const selectable = filterSelectableModels(init.models);
    lastModels = selectable.map((m) => ({ value: m.value, displayName: m.displayName }));
    aliasByResolvedPrefix = selectable
      .filter((m) => m.resolvedModel)
      .map((m) => ({ value: m.value, resolvedPrefix: m.resolvedModel as string }));
    emit({ type: "models_available", models: lastModels, current: currentModel });
  } catch {
    // SDK 版本不支持时静默跳过，前端下拉直接隐藏
  }
}

/** 把 assistant 消息里的具体 wire model id 映射回下拉框里能选中的别名值；
 *  找不到对应别名时原样返回（下拉显示为空，属于已知的展示边界情况）。 */
function resolveDropdownValue(concreteModel: string): string {
  const hit = aliasByResolvedPrefix.find(
    (a) => concreteModel === a.resolvedPrefix || concreteModel.startsWith(`${a.resolvedPrefix}-`),
  );
  return hit ? hit.value : concreteModel;
}

/** 每轮结束后查一次当前上下文窗口用量，喂前端的进度条。SDK 版本不支持
 *  `getContextUsage` 时静默跳过——前端没收到事件就不显示这块 UI。 */
async function emitContextUsage(q: Awaited<ReturnType<typeof query>>) {
  try {
    const usage = await q.getContextUsage();
    emit({
      type: "context_usage",
      total_tokens: usage.totalTokens,
      max_tokens: usage.maxTokens,
      percentage: usage.percentage,
    });
  } catch {
    // 同上：拿不到就跳过
  }
}

// 订阅额度：查 SDK `/usage` 结构化端点（会打 claude.ai usage 接口）。节流到至少
// 隔 RATE_LIMIT_MIN_INTERVAL_MS 才查一次，避免每轮都打网络。API Key / 三方 provider
// 或 SDK 版本不支持时静默跳过（响应里 rate_limits_available=false → windows 为空）。
const RATE_LIMIT_MIN_INTERVAL_MS = 15_000;
let lastRateLimitAt = 0;
async function emitRateLimit(q: Awaited<ReturnType<typeof query>>) {
  if (Date.now() - lastRateLimitAt < RATE_LIMIT_MIN_INTERVAL_MS) return;
  try {
    // 实验性 API，名字带 DO_NOT_RELY——用可选链 + try/catch 兜底，缺了就跳过。
    const anyQ = q as any;
    if (typeof anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return;
    const usage = await anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    lastRateLimitAt = Date.now();
    emit(buildRateLimitEvent(usage));
  } catch {
    // 实验性/不支持/非订阅会话：跳过，前端 windows 为空即隐藏
  }
}

async function startLoop(cwd?: string) {
  try {
    // 出错后继续循环，等待下一条消息（避免 queue 无消费者）
    while (true) {
      try {
        const q = query({
          prompt: queue[Symbol.asyncIterator](),
          options: {
            permissionMode: currentPermissionMode as any,
            canUseTool: permMgr.makeCallback(emit) as any,
            settingSources: ["project", "user"],
            allowedTools: ["Agent", "Task"],
            skills: "all",
            // 真流式：文本以 stream_event 增量到达，mapper 只转发 text_delta、
            // 跳过最终 assistant 消息里的整块文本（两处必须同开同关）。
            includePartialMessages: true,
            // 出错重建 query 时保留用户已切换的模型，不回落到 env 默认值
            ...(currentModel ? { model: currentModel } : {}),
            ...(cwd ? { cwd } : {}),
            // release 打包：Rust 侧把随 app 分发的原生 CLI 路径通过环境变量传入；
            // 未设置时 SDK 从 node_modules 解析（dev 模式）
            ...(process.env.AIDE_CLAUDE_EXE
              ? { pathToClaudeCodeExecutable: process.env.AIDE_CLAUDE_EXE }
              : {}),
            ...(sessionId ? { resume: sessionId } : {}),
          },
        });
        currentQuery = q;

        for await (const msg of q) {
          mapSdkMessage(msg, emit, taskTracker, subagentTracker);
          if ((msg as any).type === "system" && (msg as any).subtype === "init") {
            sessionId = (msg as any).session_id;
            void emitModelsAvailable(q);
          } else if (
            // 主线程（非子代理）assistant 消息自带实际用的模型——SDK 没有别的渠道
            // 告诉我们"没手动切换时默认用的是哪个"，只能从这里坐实。但错误回声
            // （msg.error，如 model_not_found）和本地生成的占位通知（额度耗尽时
            // model 字段可能是 "<synthetic>" 这类内部记号）都不代表"真的在用这个
            // 模型"——采信会把 currentModel 污染成一个不存在的模型 id，之后每轮
            // 都显式请求它而永久 404，见 isAdoptableAssistantModel 的注释。
            (msg as any).type === "assistant" &&
            !(msg as any).parent_tool_use_id &&
            isAdoptableAssistantModel(msg) &&
            (msg as any).message.model !== lastConcreteModel
          ) {
            lastConcreteModel = (msg as any).message.model;
            currentModel = resolveDropdownValue(lastConcreteModel);
            if (lastModels.length > 0) {
              emit({ type: "models_available", models: lastModels, current: currentModel });
            }
          } else if ((msg as any).type === "result") {
            // 每轮结束后上下文用量才稳定，这里查一次刷新进度条 + 订阅额度
            void emitContextUsage(q);
            void emitRateLimit(q);
          }
        }
        // for await 正常结束（queue closed）
        break;
      } catch (e: any) {
        currentQuery = null;
        if (e?.name !== "AbortError") {
          // 进程在此 catch 后继续循环、等下一条消息——是可恢复错误，非致命。
          // 标 fatal:false，前端落 waiting+warning（红点）而非 stopped。
          emit({ type: "error", message: String(e?.message ?? e), fatal: false });
        }
        // AbortError（用户中断）或普通错误后继续循环，等待下一条消息
      }
    }
  } finally {
    currentQuery = null;
  }
}

const rl = readline.createInterface({ input: process.stdin });
let loopStarted = false;

// 进程一起来就广播一次模式清单——前端不用等第一条消息就能渲染下拉框
emitPermissionModes();

rl.on("line", (line) => {
  let cmd: SidecarCommand;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  if (cmd.cmd === "send") {
    if (cmd.session_id) sessionId = cmd.session_id;
    // 先应用随消息带来的权限模式，再起 loop——首条消息选的模式要进 query 初始选项
    if (cmd.permission_mode) applyPermissionMode(cmd.permission_mode);
    if (!loopStarted) {
      loopStarted = true;
      startLoop(cmd.cwd);
    }
    queue.push({
      type: "user",
      message: buildUserMessage(cmd.prompt, cmd.images ?? []),
      parent_tool_use_id: null,
    } as any);
  } else if (cmd.cmd === "permission_response") {
    const toolName = permMgr.resolve(cmd.id, cmd.approved, cmd.always, cmd.answers);
    // Plan 模式的出口：ExitPlanMode 被批准 = 用户认可计划、进入执行——SDK 不会
    // 自己切模式（那是交互式 CLI 的 TUI 行为），这里显式切回 default。
    if (cmd.approved && toolName === "ExitPlanMode") {
      applyPermissionMode("default");
    }
  } else if (cmd.cmd === "interrupt") {
    currentQuery?.interrupt().catch(() => {});
  } else if (cmd.cmd === "set_permission_mode") {
    applyPermissionMode(cmd.mode);
  } else if (cmd.cmd === "set_model") {
    currentQuery
      ?.setModel(cmd.model)
      .then(() => {
        currentModel = cmd.model;
        emit({ type: "models_available", models: lastModels, current: currentModel });
      })
      .catch(() => {});
  }
});

rl.on("close", () => {
  queue.close();
  process.exit(0);
});
