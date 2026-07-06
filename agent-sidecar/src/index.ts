import * as readline from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ModelOption, PermissionModeOption, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { JumpQueueController } from "./jumpQueue.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import {
  mapSdkMessage,
  buildUserMessage,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
} from "./mapper.js";

// 所有事件统一经过增量合并层再落 stdout：逐字 delta 压成 ≤25 条/秒，
// 非增量事件保持相对顺序原样透传（见 deltaCoalescer.ts 顶部注释）。
const coalescer = new DeltaCoalescer((event) => {
  process.stdout.write(JSON.stringify(event) + "\n");
});

function emit(event: ChatEvent) {
  coalescer.push(event);
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
const toolLifecycle = new ToolLifecycleTracker();
const jumpQueueCtl = new JumpQueueController();
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

// Claude 专属的权限模式清单。bypassPermissions（SDK 里跳过所有 canUseTool 确认的
// "自动模式"）现在暴露出来，但刻意只存内存（见下方 currentPermissionMode 注释）：
// 选中只对当前会话生效，切会话/重开进程一律回落 default，不做任何持久化，前端
// 还会在选中时给出持续的醒目提示（危险信号靠 UI 常驻可见，而不是靠一次性确认框）。
const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", displayName: "默认权限" },
  { value: "acceptEdits", displayName: "自动接受编辑" },
  { value: "plan", displayName: "Plan 模式" },
  { value: "bypassPermissions", displayName: "自动模式（跳过所有确认，请谨慎使用）" },
];
// 同模型选择：只存内存，不落盘；重开会话回落到 default——bypassPermissions 因此
// 天然是"会话级临时开关"，不会意外沿用到下一个会话。
let currentPermissionMode = "default";
// forkSession=true 时标记：下一个 session_init 如果 session ID 变了就是 fork，
// 发一条通知告知用户会话已因供应商切换而迁移。
let pendingFork = false;
// 只有 Rust 显式告知"这次是供应商连接身份真的漂移了"（"send" 命令带
// provider_switched:true）才置真；下一次建 query() 时消费掉就清空，不会被后续
// 中断/错误触发的内部重连误用。单纯"这个会话当前没有存活进程"（新会话/重开
// 历史对话）不会经过这里，天然走普通 resume，不 fork。
let shouldForkNextConnect = false;
// 当前是否有一轮对话在跑（用户消息已入队、还没收到这一轮的 result/异常）。
// 插队靠它区分两种情况：轮内 → 记入 jumpQueueCtl 等安全边界 interrupt 截断；
// 轮外（消息刚好赶在上一轮结束后的竞态窗口到达）→ 没有轮可打断，interrupt
// 会空打、插队消息永远滞留，必须退化成普通消息直接入队。
let turnActive = false;

// SDK 还认识但不放进常驻下拉清单的模式（"总是允许"的 setMode 建议可能切过去）。
// 广播时若当前模式不在常驻清单里，用这里的文案动态补一项，避免下拉显示空白。
const EXTRA_MODE_LABELS: Record<string, string> = {
  dontAsk: "本次会话不再询问",
  auto: "自动判断（本次会话）",
};

function emitPermissionModes() {
  const modes = PERMISSION_MODES.some((m) => m.value === currentPermissionMode)
    ? PERMISSION_MODES
    : [
        ...PERMISSION_MODES,
        {
          value: currentPermissionMode,
          displayName: EXTRA_MODE_LABELS[currentPermissionMode] ?? currentPermissionMode,
        },
      ];
  emit({ type: "permission_modes_available", modes, current: currentPermissionMode });
}

/** 切权限模式：query 已在跑就走 SDK 运行时接口（成功才广播）；还没起 query
 *  时只改本地状态（startLoop 创建 query 时带上），立即广播让前端下拉同步。 */
function applyPermissionMode(mode: string) {
  // 常驻清单 + setMode 建议可能引入的附加模式都合法；其余字符串一律拒绝
  // （值最终会进 SDK setPermissionMode / query 初始选项，不能透传任意输入）。
  if (!PERMISSION_MODES.some((m) => m.value === mode) && !(mode in EXTRA_MODE_LABELS)) return;
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
        // 构造显式 env 传给 CLI subprocess：process.env 作为基础（保证 PATH/HOME 等
        // 系统变量不丢），再把 provider 的连接参数叠上去——这样即使 CLI 从 session
        // 文件里读到了旧 provider 的缓存配置，这里显式传入的值也会覆盖它。
        const cliEnv: Record<string, string | undefined> = { ...process.env };
        for (const k of [
          "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL",
          "CLAUDE_CODE_EFFORT_LEVEL",
          "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
        ]) {
          if (process.env[k]) cliEnv[k] = process.env[k];
        }
        const q = query({
          prompt: queue[Symbol.asyncIterator](),
          options: {
            permissionMode: currentPermissionMode as any,
            // bypassPermissions（自动模式）是 SDK 的"跳过所有权限确认"能力，必须显式
            // 打开这个危险开关才允许使用——否则运行时 setPermissionMode("bypassPermissions")
            // 会失败。这里恒开的只是"能力闸门"，实际是否跳过完全由 permissionMode 决定：
            // 非 bypass 模式下工具照常走 canUseTool 确认，开关本身不放宽任何权限。
            allowDangerouslySkipPermissions: true,
            canUseTool: permMgr.makeCallback(emit, subagentTracker) as any,
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
            // forkSession=true：resume 旧会话时自动 fork 出新 session，保留旧会话
            // 对话历史但用新 provider 配置——CLI resume 时会从 session 文件读取创建时
            // 缓存的 provider 配置（base_url/api_key/model），覆盖 process.env 里的
            // 新值，导致切换供应商后仍用旧 base_url 返回 404。fork 绕过这个问题：
            // 新 session 文件不会缓存旧 provider 的配置。只有 Rust 显式判定这次是
            // 供应商真的漂移了才 fork（shouldForkNextConnect）——单纯 resume（包括
            // 中断/错误触发的内部重连、或重开一个历史会话）一律走普通 resume，
            // 不会误分裂出新 session 也不会误报"已切换供应商"。
            ...(sessionId
              ? shouldForkNextConnect
                ? (pendingFork = true, { resume: sessionId, forkSession: true })
                : { resume: sessionId }
              : {}),
            env: cliEnv,
          },
        });
        currentQuery = q;
        shouldForkNextConnect = false; // 一次性消费，不影响后续重连

        for await (const msg of q) {
          // 插队投递点：interrupt() 在流式输入模式下通常不抛异常——CLI 只是
          // 结束当前轮、吐一条"错误 result"（errors 里带 [ede_diagnostic] 内部
          // 面包屑），query 流继续活着。所以插队消息必须在这里（收到 result 的
          // 时刻）接上，不能只靠 catch 的 AbortError 分支（那是备用路径）。
          // 这条 result 是预期内的截断产物，整条吞掉不映射：既不该弹错误气泡，
          // 也不该发 message_stop——上一轮在观感上直接续到插队消息的新一轮。
          if ((msg as any).type === "result") {
            turnActive = false;
            const jump = jumpQueueCtl.take();
            if (jump) {
              toolLifecycle.reset();
              if (jump.permissionMode) applyPermissionMode(jump.permissionMode);
              queue.push({
                type: "user",
                message: buildUserMessage(jump.prompt, jump.images ?? []),
                parent_tool_use_id: null,
              } as any);
              turnActive = true;
              void emitContextUsage(q);
              void emitRateLimit(q);
              continue;
            }
          }
          mapSdkMessage(msg, emit, taskTracker, subagentTracker, toolLifecycle);
          // 插队安全边界：每处理完一条消息就检查一次——工具跑完（账本归零）的
          // 那一刻，如果还有一条插队消息在等，立刻打断这一轮，不用等到下一条
          // 消息才发现。
          if (jumpQueueCtl.has() && toolLifecycle.isIdle()) {
            currentQuery?.interrupt().catch(() => {});
          }
          if ((msg as any).type === "system" && (msg as any).subtype === "init") {
            const newSid = (msg as any).session_id as string | undefined;
            // forkSession 触发时 SDK 返回了新 session ID——通知用户会话已迁移
            if (pendingFork && newSid && newSid !== sessionId) {
              emit({
                type: "notification",
                message: "已切换供应商，对话历史已迁移到新会话。",
                notification_type: "provider_switch",
              } as any);
              pendingFork = false;
            }
            sessionId = newSid;
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
            // 轮次结束，不可能再有工具在飞——清掉账本里可能残留的僵尸条目
            // （如被 deny 后 SDK 不回 tool_result 的边界情况），自愈而不是累积。
            toolLifecycle.reset();
            // 每轮结束后上下文用量才稳定，这里查一次刷新进度条 + 订阅额度
            void emitContextUsage(q);
            void emitRateLimit(q);
          }
        }
        // for await 正常结束（queue closed）
        break;
      } catch (e: any) {
        currentQuery = null;
        pendingFork = false;
        turnActive = false;
        // 这一轮被打断/出错：在飞工具的 tool_result 永远不会到达，必须清账本，
        // 否则 isIdle() 永不为真，之后的插队安全边界判断永久失效。
        toolLifecycle.reset();
        if (e?.name !== "AbortError") {
          // 进程在此 catch 后继续循环、等下一条消息——是可恢复错误，非致命。
          // 标 fatal:false，前端落 waiting+warning（红点）而非 stopped。
          emit({ type: "error", message: String(e?.message ?? e), fatal: false });
        }
        // AbortError（用户中断）或普通错误后继续循环，等待下一条消息。
        // 插队投递的备用路径：主路径在循环内的 result 边界（interrupt 通常不
        // 抛异常）；某些 SDK/错误形态下 query 会直接抛出走到这里，插队消息
        // 同样要接上当作"下一轮"立刻续发，不能滞留。
        const jump = jumpQueueCtl.take();
        if (jump) {
          if (jump.permissionMode) applyPermissionMode(jump.permissionMode);
          queue.push({
            type: "user",
            message: buildUserMessage(jump.prompt, jump.images ?? []),
            parent_tool_use_id: null,
          } as any);
          turnActive = true;
        }
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
    // Rust 显式告知这次 resume 是供应商连接身份真的漂移了，才允许下一次建
    // query() 时 forkSession——见 shouldForkNextConnect 声明处的注释。
    if (cmd.provider_switched) shouldForkNextConnect = true;

    if (!loopStarted) {
      loopStarted = true;
      // 先应用随消息带来的权限模式，再起 loop——首条消息选的模式要进 query 初始选项
      if (cmd.permission_mode) applyPermissionMode(cmd.permission_mode);
      startLoop(cmd.cwd);
      queue.push({
        type: "user",
        message: buildUserMessage(cmd.prompt, cmd.images ?? []),
        parent_tool_use_id: null,
      } as any);
      turnActive = true;
      return;
    }

    // 插队只在"确实有一轮在跑"时才有意义；轮外（刚好赶在上一轮结束后的竞态
    // 窗口）interrupt 会空打、消息滞留在 jumpQueueCtl 永远没人取——退化成普通发送。
    if (cmd.jump_queue && currentQuery && turnActive) {
      // 插队：不立刻打断，先记下来，等 ToolLifecycleTracker 显示当前没有工具
      // 在跑（安全边界）再真正 interrupt。到达时如果本来就是空闲的（模型只是
      // 在说话，没有工具在跑），下面这个检查立刻命中，不用等下一条消息。
      jumpQueueCtl.request({
        prompt: cmd.prompt,
        images: cmd.images,
        permissionMode: cmd.permission_mode,
      });
      if (toolLifecycle.isIdle()) {
        currentQuery.interrupt().catch(() => {});
      }
      return;
    }

    if (cmd.permission_mode) applyPermissionMode(cmd.permission_mode);
    queue.push({
      type: "user",
      message: buildUserMessage(cmd.prompt, cmd.images ?? []),
      parent_tool_use_id: null,
    } as any);
    turnActive = true;
  } else if (cmd.cmd === "permission_response") {
    const outcome = permMgr.resolve(cmd.id, cmd.approved, cmd.always, cmd.answers);
    if (outcome?.appliedMode) {
      // "总是允许"携带的 setMode 建议已随 updatedPermissions 在 SDK 内生效，
      // 这里只对齐本地账本并广播——不能再调 setPermissionMode（重复应用），
      // 也不能走下面的 ExitPlanMode 分支强切 default（会覆盖用户刚选的模式，
      // 比如"批准计划并自动接受编辑"）。这是"权限按钮永远不会自动变"的根治点。
      currentPermissionMode = outcome.appliedMode;
      emitPermissionModes();
    } else if (cmd.approved && outcome?.toolName === "ExitPlanMode") {
      // Plan 模式的出口：ExitPlanMode 被普通批准 = 用户认可计划、进入执行——SDK
      // 不会自己切模式（那是交互式 CLI 的 TUI 行为），这里显式切回 default。
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
