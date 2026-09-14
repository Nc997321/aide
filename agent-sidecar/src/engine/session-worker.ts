import type {
  ChatEvent,
  ImageAttachment,
  SidecarCommand,
  UserMessageBlock,
} from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager, makeGuardedCanUseTool } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { BgTaskTracker } from "../desktop/bgTasks.js";
import { BgTaskTail } from "../desktop/bgTaskOutputTail.js";
import { JumpQueueController } from "../desktop/jumpQueue.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import { removeSessionRegistryEntryFromEnv } from "./claudeRegistry.js";
import {
  automationHookVerdict,
  buildAutomationConfig,
  type AutomationConfig,
} from "../desktop/automation.js";
import { titleFromContent } from "./titleGenerator.js";
import { applyModelSwitch } from "./modelSwitch.js";
import {
  createUserSwitchIntentTracker,
  makeModelSwitchGuard,
  makeRosterCommitHandler,
  type ModelSwitchGuard,
} from "./modelSwitchGuard.js";
import { applyEffortSwitch, normalizeEffort } from "./effortSwitch.js";
import type { EffortSettable } from "./effortSwitch.js";
import { applyOutputStyle, normalizeOutputStyle, type OutputStyle } from "./session-worker/outputStyle.js";
import { buildCliEnv } from "./cliEnv.js";
import { prepareQueryContext } from "./session-worker/queryContext.js";
import { buildSpawnQueryOptions } from "./session-worker/queryOptions.js";
import { parseMcpHeaders, type McpHeaderMap, type SessionMetadata } from "./sessionMetadata.js";
import { cancelAllCodegraphQueries } from "../extensions/codegraphClient.js";
import { rollbackImageHistory } from "./imageRollback.js";
import {
  buildUserMessage,
  isAdoptableAssistantModel,
  type MapperDeps,
} from "./mapper.js";
import { handleQueryMessage, type TurnContext } from "./session-worker/turnMessages.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, HookInput, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { OutputTail } from "./subagentOutputTail.js";
import { TailPool } from "./tailPool.js";
import type { PermissionPolicySnapshot } from "./policy/types.js";
import { SessionPolicy } from "./policy/sessionHook.js";
import {
  EDIT_TOOL_NAMES,
  EDIT_AUTO_MODE_NAMES,
  PermissionModeController,
  resolveApprovedTransition,
} from "./permissionModes.js";
import { ModelRoster } from "./modelRoster.js";
import { emitContextUsage, RateLimitReporter } from "./queryTelemetry.js";
import type { PermissionRuleDraft } from "./types.js";

// ---- 进程级常量已归位各自域模块（拆分迁出） ----
// buildPluginsOption → extensions/dispatchPlugins.ts（插件域，批 1）
// PERMISSION_MODES / EXTRA_MODE_LABELS / EDIT_* → engine/permissionModes.ts（批 2）
// FILE_FAMILY_TOOLS → engine/policy/sessionHook.ts（批 2）

// OutputTail（子代理 .output 回放）复用 engine/subagentOutputTail.ts 导出类
//（历史这里是逐字节重复的第二份副本，批 1 去重；池化见 engine/tailPool.ts）

// ---- SessionWorker ----

export interface SessionWorkerOptions {
  cwd?: string;
  btwMode?: boolean;
  lightweightMode?: boolean;
  initialModel?: string;
  envOverrides?: Record<string, string>;
  /** 会话元数据（headless 网关下发，引擎不解释；hooks 经 HookBuildContext 读取）。 */
  metadata?: SessionMetadata;
  /** MCP 头注入表（构造器过 parseMcpHeaders 收窄——stdin 是协议面，类型不等于可信，N1）。 */
  mcpHeaders?: McpHeaderMap;
  /** 测试缝：覆盖 SDK query 实现。生产省略用真 query。 */
  queryFn?: typeof query;
  /** btw 支线回合结束自毁回调：worker 自停后由 SessionManager 把自己摘出注册表。 */
  onSelfStop?: (worker: SessionWorker) => void;
}

export class SessionWorker {
  /** fork/resume 源：SDK 会话 ID。空串=全新会话不 resume。
   *  仅 btw / provider_switched / 重开会话时设置（在 handleCommand 或 session_init 里）。
   *  注意：这不是路由键——路由键是 routingKey，由 SessionManager 管理。 */
  resumeSource = "";
  /** 当前在 SessionManager.workers Map 里的 key。构造时=tempId，
   *  session_init 到达后由 SessionManager re-key 成 SDK 真实会话 ID。
   *  emit 闭包读这个字段注入 session_id，所以 re-key 后事件自动带新 key。 */
  routingKey: string;
  readonly queue = new MessageQueue();
  readonly permMgr = new PermissionManager();
  /** 会话策略状态（快照 + 会话级规则 + 权威 PreToolUse hook，见 policy/sessionHook.ts）。
   *  支线状态不归它所有——注入活值 getter，hook 每次调用时读（handleSend 会动态翻转）。 */
  private readonly policy = new SessionPolicy({
    branchState: () => ({
      btwMode: this.btwMode,
      lightweightMode: this.lightweightMode,
      taskTools: this.taskTools,
      automationConfig: this.automationConfig,
      cwd: this.cwd,
    }),
    automationVerdict: automationHookVerdict,
  });
  readonly taskTracker = new TaskTracker();
  readonly subagentTracker = new SubagentTracker();
  readonly toolLifecycle = new ToolLifecycleTracker();
  readonly jumpQueueCtl = new JumpQueueController();
  readonly coalescer: DeltaCoalescer;
  /** 图片 400 回滚：检测到 synthetic 400 后置位，abort 当前 query，catch 里执行回滚。 */
  private rollbackPending = false;
  /** 当前 query 的 abort 信号（每次 while 迭代新建；回滚时 abort 杀 CLI 停写入）。 */
  private abortController: AbortController | null = null;
  /** 场景 B 注入消息（预置槽）：不 push 进共享 queue——MessageQueue 的 resolveNext
   *  是单槽，abort 后旧迭代器还挂在 await 上，push 会被它 shift 走并卡死在 yield
   *  （SDK 已 abort 不再 next()），下一轮新迭代器就永远拿不到（2026-08-21 实锤：
   *  注入未达 CLI → resume 0 事件退出，会话无后续）。改由下一轮 query 的私有
   *  迭代器首条 yield。 */
  private rollbackInjection: SDKUserMessage | null = null;

  // ---- SDK 查询状态 ----
  private currentQuery: Awaited<ReturnType<typeof query>> | null = null;
  private currentModel = process.env.ANTHROPIC_MODEL ?? "";
  /** 会话级 effort（low/medium/high/xhigh/max，小写）。绝不以 env 形式传给 CLI
   * （CLAUDE_CODE_EFFORT_LEVEL 会压过 applyFlagSettings、与 options.effort 就高合并，
   * 2026-08-01 smoke 实锤）——只走 options.effort + applyFlagSettings 两条官方通道。 */
  private currentEffort = "";
  /** Stop hook 读到的本轮实际 effort（含静默降级）；message_stop 盖戳后清零。 */
  private lastStopEffort = "";
  /** 可选模型名册（列表 + 真名/别名互译，见 modelRoster.ts）；currentModel 账面留 worker。 */
  private readonly modelRoster = new ModelRoster();
  /** 权限模式账本（清单常量与切换语义见 permissionModes.ts）。 */
  private readonly permModes = new PermissionModeController((e) => this.emit(e));
  /** 订阅额度/速率上报（15s 节流，见 queryTelemetry.ts）。 */
  private readonly rateLimitReporter = new RateLimitReporter();
  private pendingFork = false;
  private shouldForkNextConnect = false;
  private turnActive = false;
  private stopped = false;

  // ---- 会话自动命名（截取首条用户消息内容作标题，见 titleGenerator.ts） ----
  /** 缺省开启，普通会话无开关、恒命名。auto_title:false 是内部 opt-out——
   *  自动化/headless 运行（scheduler、smoke）不给会话起标题。 */
  private autoTitle = true;
  /** 思考开关（send.thinking_enabled 下发），缺省开启。关闭 = 从能力上禁用思考：
   *  ① 请求层——spawn 时 thinking: disabled（官方 API 真正不思考、省 token）；
   *  ② 展示层——mapper 剥除 thinking 块（thinking_delta 流 / assistant 整块 /
   *  子代理块），立即生效。例外：ollama 兼容端点不认 thinking 参数（请求体不带
   *  thinking 字段=端点默认，模型总会出思考块，2026-08-21 mock 端点实锤），
   *  无法能力级禁用，仅靠 ② 隐藏显示。 */
  private thinkingEnabled = true;
  /** 输出样式（send.output_style 下发，handleSend 归一后存这里）。null = 默认/未知，
   *  建 query 后不下发。与 thinkingEnabled 同款：值每条 send 都刷新，但只在**新建
   *  会话**（建 query）时落地——改动不影响已在跑的会话（见 session-worker/outputStyle.ts）。 */
  private outputStyle: OutputStyle | null = null;
  /** 每个 worker 只命名一次（防止 resume/多轮重复生成）。 */
  private titleAttempted = false;

  // ---- BTW / 轻量模式 ----
  // 非 readonly：btw send 命令在 handleSend 里动态置 true（构造期选项还拿不到
  // btw 标志——它是随命令到达的），见 handleSend 的 cmd.btw 分支。
  btwMode: boolean;
  lightweightMode: boolean;
  /** btw 任务支线(git-commit)的内建工具白名单:非空时 query() 的
   *  tools/allowedTools 收成它 + skills/plugins/codegraph 全关(全新会话,
   *  前缀最小化)。与 lightweightMode 互斥——问答支线保持与主会话前缀一致。 */
  private taskTools?: string[];

  // ---- 自动化运行（无人值守 headless，调度器发起） ----
  // 非空时：policy hook 白名单裁决 + skills/plugins 关 + thinking 关 + partial 关
  // + 终态自毁。与 btwMode 互斥（调度器永不发 btw 标志）。
  private automationConfig?: AutomationConfig;

  // ---- 工作目录 ----
  private cwd?: string;

  // ---- Provider env 覆盖（per-session） ----
  private envOverrides: Record<string, string>;

  // ---- 会话级元数据 / MCP 头注入（headless 网关机制，见 sessionMetadata.ts） ----
  // 每条 send 刷新（缺席 = 清空，与 envOverrides 同形）；元数据只暴露给进程内
  // hooks（HookBuildContext.session.metadata），绝不进 cliEnv（Bash 工具子进程
  // 继承 env，模型可外带凭据——安全红线）。
  private metadata: SessionMetadata;
  private mcpHeaders: McpHeaderMap | undefined;

  // ---- 输出尾部轮询（per-session，替代模块级全局；池实现见 engine/tailPool.ts） ----
  private readonly outputTails = new TailPool<OutputTail>(
    (id, outputFile, emit) => new OutputTail(id, outputFile, emit),
  );
  /** 模型切换守卫（PreModelSwitch/PostModelSwitch 一对）：懒建单例，见 makeModelSwitchGuard。 */
  private modelSwitchGuard: ModelSwitchGuard | null = null;
  /** 用户切换意图（因果门）：set_model 下发前记、PreModelSwitch 到达时单次消费——
   *  区分「用户点了下拉」与进程内部对账切换（见 createUserSwitchIntentTracker）。 */
  private readonly userSwitchIntent = createUserSwitchIntentTracker();

  // ---- 后台 shell 任务：tracker + 输出 tail（per-session） ----
  readonly bgTaskTracker = new BgTaskTracker();
  // 摘除收尾差异点：bgTask 先 finalFlush 冲掉文件尾巴再摘（不立即 stop——
  // finalFlush 内部完成后自置 stopped），OutputTail 池缺省直接 stop。
  private readonly bgTaskTails = new TailPool<BgTaskTail>(
    (id, outputFile, emit) => new BgTaskTail(id, outputFile, emit),
    (t) => {
      // fire-and-forget：异步 finalFlush 不阻塞命令处理；内部吞错，末尾置 stopped。
      // 删除发生在 flush 完成前——tail 对象仍被该 promise 持有，emit 照常生效。
      void t.finalFlush().catch(() => { /* flush 失败（文件已删等）：尾部内容放弃 */ });
    },
  );

  // ---- 注入的 stdout 输出回调 ----
  private readonly emitToStdout: (event: ChatEvent) => void;

  // ---- 测试缝：可替换的 SDK query 实现 ----
  private queryFn: typeof query;
  /** btw 自毁回调（SessionManager 注入，见 SessionWorkerOptions.onSelfStop）。 */
  private readonly onSelfStop?: (worker: SessionWorker) => void;
  /** send 命令串行化：只在存在未完成的异步 send（例如图片 probe）时启用。 */
  private sendQueue: Promise<void> | null = null;

  constructor(
    routingId: string,
    emitToStdout: (event: ChatEvent) => void,
    opts: SessionWorkerOptions,
  ) {
    this.emitToStdout = emitToStdout;
    this.routingKey = routingId;
    this.queryFn = opts.queryFn ?? query;
    this.onSelfStop = opts.onSelfStop;
    this.btwMode = opts.btwMode ?? false;
    this.lightweightMode = opts.lightweightMode ?? false;
    this.cwd = opts.cwd;
    this.envOverrides = opts.envOverrides ?? {};
    this.metadata = opts.metadata ?? {};
    this.mcpHeaders = this.sanitizeMcpHeaders(opts.mcpHeaders);
    this.currentModel = opts.initialModel ?? this.envOverrides.ANTHROPIC_MODEL ?? this.currentModel;
    // provider env 通道携带的 effort 初始值（Rust 把 provider effort_level / 前端选择器
    // 值都注入 CLAUDE_CODE_EFFORT_LEVEL，与 ANTHROPIC_MODEL 同形）——只作初始值读出来，
    // 绝不会以 env 形式透传给 CLI（见 currentEffort 字段注释）。
    this.currentEffort = normalizeEffort(this.envOverrides.CLAUDE_CODE_EFFORT_LEVEL);

    // DeltaCoalescer 的输出经注入回调写 stdout（带上 session_id）
    this.coalescer = new DeltaCoalescer((event) => {
      this.emitToStdout(event);
    });

    if (opts.initialModel) {
      this.currentModel = opts.initialModel;
    }
  }

  // ---- emit 快捷方法 ----

  private emit(event: ChatEvent): void {
    // message_stop 盖本轮 effort 戳：Stop hook 已把 API 侧坐实的档位（含静默降级）
    // 存进 lastStopEffort（时序：Stop hook → result → message_stop）。读取即清零——
    // 中断/出错轮次 Stop 不触发时，不会把上一轮的档位泄漏到这一轮。
    if (event.type === "message_stop") {
      if (this.lastStopEffort) event.effort = this.lastStopEffort;
      this.lastStopEffort = "";
    }
    this.coalescer.push(event);
  }

  /** Stop hook：回合结束时读 API 侧坐实的本轮 effort（SDK hook input 的 effort.level），
   *  由 emit 盖到紧随其后的 message_stop 上。模型不支持 effort 时字段缺席 → 不盖戳。 */
  private makeStopEffortHook(): HookCallback {
    return async (input) => {
      const effort = (input as { effort?: { level?: string } }).effort;
      this.lastStopEffort = effort?.level ?? "";
      return {};
    };
  }

  /** 模型切换守卫（SDK PreModelSwitch/PostModelSwitch 一对）：懒建单例。
   *  btw/automation 一次性支线返回 null（无切换语义，hook 不注册）。 */
  private makeModelSwitchGuard(): ModelSwitchGuard | null {
    if (this.btwMode || this.automationConfig) return null;
    if (!this.modelSwitchGuard) {
      this.modelSwitchGuard = makeModelSwitchGuard({
        emit: (e) => this.emit(e),
        // 坐实回执编排归位 modelSwitchGuard.ts 的 makeRosterCommitHandler
        //（拆分批 3）；名册查询与账面写入的所有权留 worker，闭包注入。
        consumeUserSwitchIntent: (resolvedTo) =>
          this.userSwitchIntent.take(this.modelRoster.resolveDropdownValue(resolvedTo)),
        onCommitted: makeRosterCommitHandler({
          emit: (e) => this.emit(e),
          resolveDropdown: (w) => this.modelRoster.resolveDropdownValue(w),
          models: () => this.modelRoster.models,
          setModel: (v) => { this.currentModel = v; },
        }),
      });
    }
    return this.modelSwitchGuard;
  }

  /** MCP 头注入表的边界收窄 + 失败可见（N1）：非法形状整体忽略（fail-closed，
   *  半对半错的注入表比没有更糟）。错误只报形状不报值——值是凭据（N5）。 */
  private sanitizeMcpHeaders(raw: McpHeaderMap | undefined): McpHeaderMap | undefined {
    if (raw === undefined) return undefined;
    const parsed = parseMcpHeaders(raw);
    if (parsed === undefined) {
      console.error(`[session ${this.routingKey}] send.mcp_headers 形状非法，已忽略本次注入（值不落日志，N5）`);
    }
    return parsed;
  }

  /** 每条 send 都携带宿主当前计算出的运行时配置（Rust provider 环境 / headless
   * 网关的会话元数据与 MCP 头注入）；在命令真正执行时更新，防止等待前一条图片
   * probe 时提前覆盖其连接身份。元数据/注入表每条 send 刷新（缺席 = 清空，
   * token 轮换语义）；新头在下一次 query() 重连才生效（mcpServers 随 spawn 固化）。 */
  private applySendRuntimeConfig(cmd: Extract<SidecarCommand, { cmd: "send" }>): void {
    this.envOverrides = cmd.env ?? {};
    const selectedModel = this.envOverrides.ANTHROPIC_MODEL;
    if (selectedModel) this.currentModel = selectedModel;
    // 前端选择器每条消息都带当前 effort（同 initialModel 语义，同值幂等无回执）；
    // 没带的调用方回落 provider env 默认。
    this.applyEffort(this.envOverrides.CLAUDE_CODE_EFFORT_LEVEL);
    this.metadata = cmd.metadata ?? {};
    this.mcpHeaders = this.sanitizeMcpHeaders(cmd.mcp_headers);
  }

  /** set_effort 命令 / send env 通道共用的入口：query 未起存本地（startLoop
   *  建 query 时经 options.effort 带上），在跑走 applyFlagSettings。成败都有回声。
   *  思考开关与 effort 解耦：这里只改 effort（见 effortSwitch.ts 注释）。 */
  private applyEffort(raw: string | undefined): void {
    applyEffortSwitch({
      effort: raw ?? "",
      // SDK Query 的 applyFlagSettings 类型把 effortLevel 限在 xhigh 以内；
      // max 是类型外但运行时可用的值（smoke-effort.ts 验证），这里结构化收窄。
      query: this.currentQuery as EffortSettable | null,
      currentEffort: this.currentEffort,
      emit: (e) => this.emit(e),
      commit: (v) => { this.currentEffort = v; },
    });
  }

  /**
   * 用户消息入队（喂给模型）+ 权威广播（喂给所有客户端 UI）。三处入队点——首条、
   * 续发、插队 promote——**必须**都走这里：「模型收到」与「各端看见」是同一个
   * 动作的两个面，漏掉广播就是「只有发起方能看见自己提的问题」（远程客户端发
   * 的消息在桌面端消失，反之亦然）。方案 C 的核心：三端都不再本地乐观渲染，
   * 只认这条事件，因此不存在重复渲染、也不需要 message_id 去重。
   *
   * 为什么是入队时广播、而不是 send 命令到达时：插队消息登记（jump_queued）后
   * 要等安全边界才真正接入，提前广播会让气泡插在上一个回合的回复中间。
   *
   * text 优先取 display 里的原始输入而非展开后的 prompt——@引用内容已混进
   * prompt，只渲染 text 的接收端（鸿蒙 v1）不该看到那一坨。
   */
  private pushUserMessage(
    prompt: string,
    images: ImageAttachment[] | undefined,
    display: UserMessageBlock[] | undefined,
  ): void {
    const text =
      display?.find((b): b is Extract<UserMessageBlock, { type: "text" }> => b.type === "text")
        ?.text ?? prompt;
    this.queue.push({
      type: "user",
      message: buildUserMessage(prompt, images ?? []),
      parent_tool_use_id: null,
    });
    this.emit({ type: "user_message", text, ...(display?.length ? { display } : {}) });
  }

  /** 从当前轮安全边界接入插队消息；会话已关闭时丢弃，禁止向 closed queue 写入。 */
  private promoteJumpQueue(): boolean {
    const jumps = this.jumpQueueCtl.takeAll();
    if (!jumps.length || this.stopped) return false;
    // 多条插队逐条 push（不合并）：/compact 这类斜杠命令作为独立用户消息才能
    // 被 CLI 正确执行。权限模式不在此回放——存活期间用户切模式走
    // set_permission_mode 实时通道已生效，入队快照只会把新模式回退成旧值。
    for (const jump of jumps) {
      this.pushUserMessage(jump.prompt, jump.images, jump.display);
    }
    this.emit({ type: "jump_promoted" });
    this.turnActive = true;
    return true;
  }

  /** SDK canUseTool 回调：无人应答支线守卫逻辑归位 permissions.ts 的
   *  makeGuardedCanUseTool（域归位，拆分批 3）——这里只组装：permMgr 人工确认
   *  回调 + 支线活值 getter（btw/automation 会在 handleSend 里动态翻转）。 */
  private makeCanUseToolCallback(): CanUseTool {
    return makeGuardedCanUseTool({
      permissionCallback: this.permMgr.makeCallback(
        (e) => this.emit(e),
        this.subagentTracker,
      ),
      isBtw: () => this.btwMode,
      isAutomation: () => !!this.automationConfig,
    });
  }

  // ---- Aide 权限策略 ----

  /** 策略快照入口（send 首带 / update_permission_policy 推送）：委托 SessionPolicy
   *  （revision 单调不回退、会话级规则去重入库、权威 hook 生成，见 policy/sessionHook.ts）。 */
  applyPermissionPolicy(snapshot: PermissionPolicySnapshot): void {
    this.policy.applySnapshot(snapshot);
  }

  addSessionRules(drafts: PermissionRuleDraft[]): void {
    this.policy.addSessionRules(drafts);
  }

  // ---- 权限模式 ----

  /** 薄委托：绑定当前 query 交给 PermissionModeController（账本与切换语义见 permissionModes.ts）。 */
  private applyPermissionMode(mode: string): void {
    this.permModes.apply(mode, this.currentQuery);
  }

  // ---- 模型相关 ----

  private async emitModelsAvailable(q: Awaited<ReturnType<typeof query>>): Promise<void> {
    const models = await this.modelRoster.adoptFromInit(q);
    // adoptFromInit 失败（SDK 版本不支持）返回 null——静默跳过（原语义）
    if (models) this.emit({ type: "models_available", models, current: this.currentModel });
  }

  // ---- OutputTail（per-SessionWorker，替代模块级全局；池逻辑见 engine/tailPool.ts） ----

  startOutputTail(id: string, outputFile: string): void {
    this.outputTails.start(id, outputFile, (e) => this.emit(e));
  }

  stopOutputTail(id: string): void {
    this.outputTails.stop(id);
  }

  stopAllOutputTails(): void {
    this.outputTails.stopAll();
  }

  // ---- BgTaskTail（后台 shell 任务输出，per-SessionWorker；finalFlush 差异 注入在 bgTaskTails 池的构造处，见字段声明） ----

  startBgTaskTail(id: string, outputFile: string): void {
    this.bgTaskTails.start(id, outputFile, (e) => this.emit(e));
  }

  stopBgTaskTail(id: string): void {
    this.bgTaskTails.stop(id);
  }

  stopAllBgTaskTails(): void {
    this.bgTaskTails.stopAll();
  }

  // ---- 命令处理（替代原先 index.ts 的 rl.on("line",...)） ----

  private enqueueSend(cmd: Extract<SidecarCommand, { cmd: "send" }>): void {
    // send 处理链抛错（handleSend 同步段异常，如 buildUserMessage）不能静默吞：
    // 报 error 帧（对齐 startLoop:1254 的错误上报）；catch 后 promise 恢复
    // resolved，队列照常推进（吞拒绝是队列语义需要，不是吞错误）。
    const reportSendError = (e: unknown) => {
      this.emit({ type: "error", message: String((e as Error)?.message ?? e), fatal: false });
    };
    if (this.sendQueue) {
      const next = this.sendQueue.then(() => this.handleSend(cmd));
      const tracked = next.catch(reportSendError);
      this.sendQueue = tracked;
      void tracked.finally(() => {
        if (this.sendQueue === tracked) this.sendQueue = null;
      });
      return;
    }

    const pending = this.handleSend(cmd);
    if (!cmd.images?.length) {
      void pending;
      return;
    }

    const tracked = pending.catch(reportSendError);
    this.sendQueue = tracked;
    void tracked.finally(() => {
      if (this.sendQueue === tracked) this.sendQueue = null;
    });
  }

  handleCommand(cmd: SidecarCommand): void {
    if (cmd.cmd === "send") {
      this.enqueueSend(cmd);

    } else if (cmd.cmd === "permission_response") {
      const outcome = this.permMgr.resolve(cmd.id, cmd.approved, cmd.answers, cmd.message);
      // 会话级规则随放行原子入库（「允许」文件工具 → 同文件本会话自动放行）。
      // 拒绝/取消不带 sessionRules，天然只走允许路径。
      if (cmd.approved && cmd.sessionRules?.length) {
        this.addSessionRules(cmd.sessionRules);
      }
      if (cmd.approved) {
        // 放行后的模式迁移决议（ExitPlanMode / EnterPlanMode / nextMode 三分支，
        // 原注释随迁）收拢在 permissionModes.ts 的 resolveApprovedTransition（拆分批 3）。
        const transition = resolveApprovedTransition(outcome?.toolName, cmd.nextMode);
        if (transition) {
          this.applyPermissionMode(transition.mode);
          if (transition.approveEdits) this.permMgr.approveMatching(EDIT_TOOL_NAMES);
        }
      }

    } else if (cmd.cmd === "update_permission_policy") {
      this.applyPermissionPolicy(cmd.policy);

    } else if (cmd.cmd === "interrupt") {
      // 用户主动打断：待插队消息一并作废（对齐旧"排队消息作废"语义）；挂起的权限确认
      // 也一并撤销（policy hook 的 ask 路径没有 SDK signal，靠 cancelAll 兜底）。
      this.permMgr.cancelAll();
      this.jumpQueueCtl.clear();
      cancelAllCodegraphQueries("interrupted");
      // interrupt 的拒绝是预期结果（用户已点中断，SDK 侧无事可打断）——契约性吞掉。
      this.currentQuery?.interrupt().catch(() => {});

    } else if (cmd.cmd === "stop_bg_task") {
      // 终止后台任务：SDK stopTask 后 CLI 会发 task_notification(status:"stopped")，
      // 终态走 mapper 既有通道（停 tail + bg_task_ended），这里不合成任何事件。
      // query 未起（会话还没发过消息）或任务不存在时安静吞掉——stopTask 拒绝
      // （任务已终态等）同样是预期结果，契约性吞掉。
      this.currentQuery?.stopTask(cmd.task_id).catch(() => {});

    } else if (cmd.cmd === "set_permission_mode") {
      this.applyPermissionMode(cmd.mode);
      // 与「进入自动模式」按钮同语义：切到 auto/bypass 时把切换之前已挂起的
      // 编辑请求连带放行——否则旧弹窗留在屏幕上，而前端 currentMode 已是新模式，
      // 「进入自动模式」按钮又被藏起来，用户只能逐条点掉。
      if (EDIT_AUTO_MODE_NAMES.has(cmd.mode)) this.permMgr.approveMatching(EDIT_TOOL_NAMES);

    } else if (cmd.cmd === "set_model") {
      const q = this.currentQuery;
      // 因果门意图记笔：仅 query 在跑时记（deferred 分支不触 hook，记了会残留误认）。
      if (q) this.userSwitchIntent.note(cmd.model);
      applyModelSwitch({
        // cmd.model 是下拉 value = 真名。SDK 的 setModel 认的是它自己那份别名，
        // 这里包一层翻译——modelSwitch 内部只跟真名打交道，不需要知道别名存在。
        model: cmd.model,
        query: q ? { setModel: (m) => q.setModel(this.modelRoster.toSdkModel(m)) } : null,
        models: this.modelRoster.models,
        currentModel: this.currentModel,
        emit: (e) => this.emit(e),
        commit: (m) => { this.currentModel = m; },
      });
    } else if (cmd.cmd === "model_switch_confirm_decision") {
      // 模型切换成本确认的用户决定 → 挂起的 PreModelSwitch hook 裁决。
      // ID 对不上（过期弹窗晚到）是正常时序：guard 内部静默忽略。
      this.modelSwitchGuard?.resolveConfirm(cmd.confirm_id, cmd.approve);

    } else if (cmd.cmd === "set_effort") {
      this.applyEffort(cmd.effort);
    }
  }

  private async handleSend(cmd: Extract<SidecarCommand, { cmd: "send" }>): Promise<void> {
    if (this.stopped) return;
    this.applySendRuntimeConfig(cmd);
    if (cmd.auto_title !== undefined) this.autoTitle = cmd.auto_title;
    if (cmd.thinking_enabled !== undefined) this.thinkingEnabled = cmd.thinking_enabled;
    // 归一在入口完成（守门）：非法/未知值绝不进 worker 状态，applyOutputStyle 只
    // 面对值域内的值或 null。
    if (cmd.output_style !== undefined) this.outputStyle = normalizeOutputStyle(cmd.output_style);
    // 首条 send 携带的策略快照在 query 起来前落地——PreToolUse hook 首次评估就能用。
    if (cmd.permission_policy) this.applyPermissionPolicy(cmd.permission_policy);

    if (this.stopped) return;

    // session_id 在命令里是路由键（SessionManager 用它找 worker）。
    // this.resumeSource 的含义是 fork 源——只在 btw / provider_switched 时
    // 才从命令里读取；普通 send 不设（否则 SDK 会尝试 resume 不存在的会话）。
    if (cmd.provider_switched) {
      this.shouldForkNextConnect = true;
      if (cmd.session_id) this.resumeSource = cmd.session_id;
    }

    if (cmd.btw) {
      this.shouldForkNextConnect = true;
      this.btwMode = true;
      this.lightweightMode = !!cmd.lightweight;
      // BTW forks from `fork_from`, not `session_id`（session_id 是 BTW 自己的路由键）
      if (cmd.fork_from) this.resumeSource = cmd.fork_from;
      // btw 任务支线(git-commit):工具白名单 → 全新会话 + 前缀最小化。
      if (cmd.tools?.length) this.taskTools = cmd.tools;
      // 轻量问答支线:行为层禁工具(policy hook 全 deny)+ prompt 尾部指令,
      // 请求前缀保持与主会话逐字节一致以命中 prompt cache——绝不能再动
      // tools/skills/plugins 选项(2026-08-09 缓存前缀实锤)。
      if (cmd.lightweight) {
        cmd = {
          ...cmd,
          prompt:
            cmd.prompt +
            "\n\n[这是纯问答支线:直接根据已有上下文回答,不要调用任何工具。]",
        };
      }
    }

    // 自动化运行（调度器发起的无人值守会话）：存配置，白名单裁决在
    // makePolicyHook / makeCanUseToolCallback 里读它。转录落盘（不动
    // persistSession）；resume_session_id（蒸馏轮）走下方既有通道。
    if (cmd.automation) {
      this.automationConfig = buildAutomationConfig(cmd.automation);
      // 蒸馏轮 fork：resume 运行会话的上下文但写成新 SDK 会话——worker re-key
      // 到运行会话 id 会让「关运行 tab → session_stop」之类的命令误杀蒸馏轮
      if (cmd.automation.fork) this.shouldForkNextConnect = true;
    }

    // 新一轮用户消息：不立即清 TODO——让旧轮在过渡期仍可见，等本轮首个新
    // TaskCreate 落地时再覆盖式清空（用户要的「有新 todo 才覆盖」）。无新
    // TaskCreate 则旧 task 保留；新轮 Claude 用 TaskUpdate 推进旧 task 时旧
    // taskId 仍在表里能命中（原 reset() 会清掉导致推进被吞——mark 保留 tasks 修这个）。
    this.taskTracker.markResetOnNextCreate();

    // 首条消息：启动 query 循环
    if (!this.currentQuery) {
      if (cmd.permission_mode) this.applyPermissionMode(cmd.permission_mode);
      // 重开已有会话：resume_session_id → resumeSource，startLoop 据此 resume。
      // 普通新会话不带这字段，resumeSource 保持空 → 全新会话。
      if (cmd.resume_session_id) this.resumeSource = cmd.resume_session_id;
      // 自动命名：只有「全新会话」（非 resume / 非 btw / 非供应商切换 fork）
      // 才生成标题——老会话已有名字，fork 会话语义上属于源会话。标题即首条
      // 用户消息的内容截取，发消息时同步产出，不等回复、不调模型。
      if (
        this.autoTitle &&
        !this.titleAttempted &&
        !cmd.resume_session_id &&
        !cmd.btw &&
        !cmd.provider_switched
      ) {
        this.emitSessionTitle(cmd.prompt);
      }
      // 开关兜底方向与「每工作区默认关」一致（=== true）：主进程四条下发路径
      // （chat send/btw + automation build/distill）都恒发该 key，缺 key =
      // 新路径忘了下发 → fail-closed 不挂 MCP，而不是静默开启。
      this.startLoop(cmd.cwd ?? this.cwd, cmd.trusted !== false, cmd.codegraph_enabled === true);
      this.pushUserMessage(cmd.prompt, cmd.images, cmd.display);
      this.turnActive = true;
      return;
    }

    // 插队
    if (cmd.jump_queue && this.currentQuery && this.turnActive) {
      this.jumpQueueCtl.request({
        prompt: cmd.prompt,
        images: cmd.images,
        display: cmd.display,
      });
      if (this.toolLifecycle.isIdle()) {
        // interrupt 拒绝 = 没有可打断的回合（用户已插队）——契约性吞掉。
        this.currentQuery.interrupt().catch(() => {});
      } else {
        // 有工具在跑：要等安全边界，通知前端显示"待发出"提示条
        this.emit({ type: "jump_queued", prompt: cmd.prompt });
      }
      return;
    }

    // 普通续发。注意不回放 cmd.permission_mode：query 存活期间权限模式由
    // set_permission_mode 实时通道独占（前端下拉切换必发），消息里带的只是
    // 发送时刻的快照——handleSend 可能被图片 probe 推迟（enqueueSend 串行化），
    // 等待期间用户切的新模式会被这里的旧值回退。模式随消息携带只保留给
    // 上面「首条消息」分支（进程未起时 set_permission_mode 静默失败的兜底）。
    this.pushUserMessage(cmd.prompt, cmd.images, cmd.display);
    this.turnActive = true;
  }

  // ---- 主循环 ----

  async startLoop(cwd?: string, trusted = true, codegraphEnabled = true): Promise<void> {
    // 本循环最后 spawn 的 query（代际守卫用，见 finally）。
    let loopQuery: Awaited<ReturnType<typeof query>> | null = null;
    try {
      while (!this.stopped) {
        try {
          // 构造显式 env 传给 CLI subprocess（组装规矩见 engine/cliEnv.ts：白名单
          // 透传 → per-session 覆盖 → automation 会话目录 → effort 显式删除 → 固定注入）
          const cliEnv = buildCliEnv({
            processEnv: process.env,
            envOverrides: this.envOverrides,
            automationSessionDir: this.automationConfig?.sessionDir,
          });

          // pendingFork 只服务「供应商切换」通知——自动化蒸馏轮也 fork（隔离
          // 运行会话 id），但那是内部机制，不该冒出「已切换供应商」提示。
          if (this.resumeSource && this.shouldForkNextConnect && !this.btwMode && !this.automationConfig) {
            this.pendingFork = true;
          }

          // query 前置准备：内建 MCP 注册 / Aide 指令 / hooks 与 mcpServers 终装
          //（装配细节与历史注释随迁 session-worker/queryContext.ts）。session 适配器
          // 闭包桥接 private 成员（直接传 this 会被名义类型规则挡掉）。
          const effectiveCwd = cwd ?? this.cwd ?? "";
          const queryCtx = await prepareQueryContext({
            cwd: effectiveCwd,
            trusted,
            codegraphEnabled,
            processEnv: process.env,
            emit: (e) => this.emit(e),
            taskTools: this.taskTools,
            automationConfig: this.automationConfig,
            mcpHeaders: this.mcpHeaders,
            session: {
              makePolicyHook: (hookCwd) => this.policy.makeHook(hookCwd),
              makeStopEffortHook: () => this.makeStopEffortHook(),
              makeModelSwitchGuard: () => this.makeModelSwitchGuard(),
              // 会话元数据读取口（函数形式读活值——每条 send 刷新后可见）。
              metadata: () => this.metadata,
            },
          });

          // 每次迭代新建 abort 信号：abort 过的 controller 不能复用（回滚后
          // 下一轮 query 需要全新的）。回滚时 abort 杀 CLI 进程、停一切写入。
          this.abortController = new AbortController();
          // 场景 B 注入走预置槽：先 yield 注入（私有迭代器，无共享 queue 竞态），
          // 再 yield* 共享 queue（后续用户消息走 MessageQueue 正常通道）。
          const rollbackInjection = this.rollbackInjection;
          this.rollbackInjection = null;
          const queueIter = this.queue[Symbol.asyncIterator]();
          const promptIter = (async function* () {
            if (rollbackInjection) yield rollbackInjection;
            yield* queueIter;
          })();
          const q = this.queryFn({
            prompt: promptIter,
            // spawn options 装配迁 session-worker/queryOptions.ts（字段与展开链
            // 顺序是承重语义，注释随迁）——这里只组装 parts。
            options: buildSpawnQueryOptions({
              runtime: {
                abortController: this.abortController,
                // permModes.current 在 PermissionModeController.apply 里按白名单校验后才写，
                // 断言为 SDK 字面量联合（含 auto/dontAsk）只表达"必然是合法值"。
                permissionMode: this.permModes.current as PermissionMode,
                canUseTool: this.makeCanUseToolCallback(),
                ctx: queryCtx,
                cliEnv,
              },
              workspace: { trusted, cwd: effectiveCwd, cwdParam: cwd, cwdWorker: this.cwd },
              branch: {
                btwMode: this.btwMode,
                taskTools: this.taskTools,
                automationConfig: this.automationConfig,
                lightweightMode: this.lightweightMode,
              },
              model: {
                sdkModel: this.currentModel ? this.modelRoster.toSdkModel(this.currentModel) : "",
                effort: this.currentEffort,
                thinkingEnabled: this.thinkingEnabled,
              },
              fork: { resumeSource: this.resumeSource ?? "", shouldFork: this.shouldForkNextConnect },
            }),
          });
          this.currentQuery = q;
          loopQuery = q;
          this.shouldForkNextConnect = false;
          // 输出样式：必须在首轮 prompt 被 CLI 取走之前落地（晚一步 = 第一条消息
          // 不变样，故不能挪到 session_init 之后）。只在建 query 时应用这一次——
          // 值虽每条 send 都刷新，但刻意不做会话中热切（见 outputStyle.ts 头注）。
          await applyOutputStyle(this.outputStyle, q);
          // 内建 hook 清单回传前端（扩展设置页 hook 列表用；Task 10 消费，重复 emit 幂等）。
          this.emit({ type: "builtin_hooks_manifest", manifest: queryCtx.hookManifest });

          // 回合消息分派（顺序语义与历史注释见 session-worker/turnMessages.ts；
          // 状态经 TurnContext 闭包注入，模块本身无状态）。
          const turn: TurnContext = {
            btwMode: () => this.btwMode,
            markImageRollback: () => { this.rollbackPending = true; this.abortController?.abort(); },
            setTurnActive: (v) => { this.turnActive = v; },
            promoteJumpQueue: () => this.promoteJumpQueue(),
            resetToolLifecycle: () => this.toolLifecycle.reset(),
            telemetry: (qq) => {
              void emitContextUsage(qq, (e) => this.emit(e));
              void this.rateLimitReporter.report(qq, (e) => this.emit(e));
            },
            applyPlanMode: () => this.applyPermissionMode("plan"),
            emit: (e) => this.emit(e),
            mapperDeps: this.buildMapperDeps(),
            shouldInterruptForJump: () => this.jumpQueueCtl.has() && this.toolLifecycle.isIdle(),
            interruptQuery: () => { this.currentQuery?.interrupt().catch(() => {}); },
            onSessionInit: (newSid, qq) => this.handleSessionInit(newSid, qq),
            onMainThreadAssistant: (m) => this.adoptAssistantModel(m),
            onResult: (qq) => this.finishTurn(qq),
          };
          let errorTerminated = false;
          for await (const msg of q) {
            const verdict = handleQueryMessage(msg, q, turn);
            if (verdict === "continue") continue;
            if (verdict === "terminate") {
              errorTerminated = true;
              // 同步置空 currentQuery：错误帧在 mapSdkMessage 时已发往宿主，续发
              // 可能抢在 break 隐含的 await gen.return()（异步清理，可达数十 ms）
              // 完成之前到达——那一刻必须看到「query 已终」走 !currentQuery 重启
              // 分支，而不是把消息喂进僵尸 query（F3 竞态窗口封闭）。
              this.currentQuery = null;
              break;
            }
          }
          if (errorTerminated) {
            // 错误终态（F3）：主动回收 CLI 子进程（N4 孤儿红线）。close 放在迭代
            // 结束之后——迭代中 close 自己是已知陷阱（见 finishTurn 的 setImmediate
            // 先例）。worker 不 stopped：下一条 send 走 handleSend 的 !currentQuery
            // 分支以 resume 重启，env/mcp_headers 随新 spawn 重新定装（C4 token
            // 轮换的异常恢复路径由此闭环）。
            q.close();
          }
          // for await 结束（queue closed 或错误终态）→ 退出 while
          break;
        } catch (e: unknown) {
          this.currentQuery = null;
          this.pendingFork = false;
          this.turnActive = false;
          this.toolLifecycle.reset();
          if (this.rollbackPending) {
            // 图片 400：abort 已杀 CLI，回滚历史后下一轮重放干净历史。
            // 回滚本身失败时静默（会话保持现状），不把 AbortError 当错误上报。
            this.rollbackPending = false;
            this.performImageRollback();
          } else if ((e as Error)?.name !== "AbortError") {
            this.emit({ type: "error", message: String((e as Error)?.message ?? e), fatal: false });
            // 自动化一次性会话：query 循环抛错（SDK 初始化失败等）即终态，
            // 没有「用户下一条消息重试」的后续——自毁防幽灵 worker。
            if (this.automationConfig) setImmediate(() => this.selfTeardown());
            // 非 AbortError = 会话级故障（SDK 初始化失败等）：break 退出循环，
            // 等用户下一条消息重新 startLoop。继续循环会无限快速重试——
            // 2026-08-21 实锤 "Native CLI binary not found" 每秒几十次风暴。
            // fatal:false 语义不变：进程仍存活、等下一条。
            break;
          }
          this.promoteJumpQueue();
        }
      }
    } finally {
      // 代际守卫：只回收仍属于本循环的句柄。terminate 路径已在循环体内同步置空，
      // 窗口期续发可能已抢先 startLoop 换上下一代 query——无守卫会把新句柄误清
      // （isActive/interrupt/stop 全部失联，而新循环还活着）。stop() 先置空的
      // 常规路径在守卫下语义不变。
      if (this.currentQuery === loopQuery) this.currentQuery = null;
    }
  }

  /** mapper 依赖包（每轮迭代重建——partialMode/showThinking 捕获当轮支线状态）。 */
  private buildMapperDeps(): MapperDeps {
    return {
      tasks: this.taskTracker,
      subagents: this.subagentTracker,
      tools: this.toolLifecycle,
      resolveModelLabel: (m) => this.modelRoster.resolveDropdownValue(m),
      outputTailHooks: {
        start: (id, outputFile, _emit) => {
          // SessionWorker 的 emit 已绑定到实例，忽略传入的 emit
          this.startOutputTail(id, outputFile);
        },
        stop: (id) => this.stopOutputTail(id),
      },
      bgTaskHooks: {
        tracker: this.bgTaskTracker,
        startTail: (id, outputFile) => this.startBgTaskTail(id, outputFile),
        stopTail: (id) => this.stopBgTaskTail(id),
      },
      partialMode: !this.btwMode,
      // 思考展示开关：关闭时剥掉 thinking 块（ollama 端点不认 thinking 参数，
      // API 层关不掉，只能展示层剥——见 mapper.ts emitSubagentBlocks 注释）。
      showThinking: this.thinkingEnabled,
    };
  }

  /** system/init：供应商切换 fork 通知 + resumeSource 过户 + 模型名册采纳
   *  （原循环 system/init 分支，批 3 纯移动）。 */
  private handleSessionInit(newSid: string | undefined, q: Awaited<ReturnType<typeof query>>): void {
    if (this.pendingFork && newSid && newSid !== this.resumeSource) {
      this.emit({
        type: "notification",
        message: "已切换供应商，对话历史已迁移到新会话。",
        notification_type: "provider_switch",
      });
      this.pendingFork = false;
    }
    this.resumeSource = newSid ?? this.resumeSource;
    void this.emitModelsAvailable(q);
  }

  /** 主线程 assistant 消息的模型坐实采纳（原循环 else-if 分支，批 3 纯移动；
   *  分派条件 assistant && !parent_tool_use_id 在 turnMessages，adoptable/去重判定在此）。 */
  private adoptAssistantModel(msg: SDKAssistantMessage): void {
    if (!isAdoptableAssistantModel(msg)) return;
    if (msg.message.model === this.modelRoster.lastConcreteModel) return;
    this.modelRoster.lastConcreteModel = msg.message.model;
    this.currentModel = this.modelRoster.resolveDropdownValue(this.modelRoster.lastConcreteModel);
    if (this.modelRoster.models.length > 0) {
      this.emit({ type: "models_available", models: this.modelRoster.models, current: this.currentModel });
    }
  }

  /** result 终态：工具生命周期复位 + 遥测 + 一次性支线自毁调度（原循环 result
   *  分支，批 3 纯移动）。 */
  private finishTurn(q: Awaited<ReturnType<typeof query>>): void {
    this.toolLifecycle.reset();
    void emitContextUsage(q, (e) => this.emit(e));
    void this.rateLimitReporter.report(q, (e) => this.emit(e));
    // btw/自动化都是一次性会话：回合结束即自毁释放 claude.exe。streaming-input
    // 的 query 不主动关会连进程一起永远挂着——CLI 的 pid 元数据留在
    // ~/.aide/claude/sessions/ 被 list_sessions 扫成侧栏幽灵空会话，
    // 且每条 btw 白占几百 MB（2026-08-02 实锤 pid 9464 挂 12min+）。
    // message_stop 已在本轮迭代经 mapSdkMessage 发出；setImmediate
    // 推迟到迭代体外，避免在 for-await 迭代中 close 自己。
    // （result 成功与错误子类型都走到这里，两条路都自毁。）
    if (this.btwMode || this.automationConfig) setImmediate(() => this.selfTeardown());
  }

  // ---- 图片 400 回滚 ----

  /** 子进程实际生效的配置根（CLAUDE_CONFIG_DIR）：automation 下发了 session_dir
   *  就用它——注册条目（sessions/<pid>.json）与转录 jsonl 都写在它下面，
   *  收尾清理/路径解析必须与启动时一致；否则跟随 sidecar 全局。 */
  private subprocessConfigDir(): string | undefined {
    return this.automationConfig?.sessionDir || process.env.CLAUDE_CONFIG_DIR;
  }

  /** 薄接线：回滚执行体已迁 imageRollback.ts 的 rollbackImageHistory（纯移动，
   *  失败静默语义在内）。返回的场景 B 注入消息预置到下一轮私有迭代器——不能
   *  queue.push（旧迭代器挂起的 resolveNext 会吞消息，见 rollbackInjection 字段注释）。 */
  private performImageRollback(): void {
    const injection = rollbackImageHistory({
      configDir: this.subprocessConfigDir(),
      sessionId: this.resumeSource,
      emit: (e) => this.emit(e),
    });
    if (injection) this.rollbackInjection = injection;
  }

  // ---- 会话自动命名 ----

  /** 用首条用户消息的内容截取会话标题（见 titleGenerator.ts）。本地纯截取——
   *  不调模型、零延迟，send 时同步发出 session_title。内容为空白时
   *  titleFromContent 返回 null，这里就不发事件，会话保留默认名。 */
  private emitSessionTitle(userText: string): void {
    if (this.titleAttempted) return;
    this.titleAttempted = true;
    const title = titleFromContent(userText);
    if (title && !this.stopped) this.emit({ type: "session_title", title });
  }

  // ---- 生命周期 ----

  /** 活跃状态：有 query 在跑 */
  isActive(): boolean {
    return this.currentQuery !== null && this.turnActive;
  }

  /** 测试用：暴露 fork 源（SDK resume 的会话 ID）和 fork 标记。 */
  _testForkState(): { forkSource: string; shouldFork: boolean } {
    return { forkSource: this.resumeSource, shouldFork: this.shouldForkNextConnect };
  }

  /** 测试用：暴露 stopped 标志（验证 stop() 设了标志，startLoop 会退出）。 */
  _testIsStopped(): boolean {
    return this.stopped;
  }

  /** 测试专用：同步触发 emit 链路（→ coalescer → emit 闭包）。
   *  session_init 是非增量事件，deltaCoalescer.push 同步 flush+透传，
   *  所以调用后 SessionManager 的 re-key 立即生效。 */
  _emitForTest(event: ChatEvent): void {
    this.emit(event);
  }

  /** 测试用：暴露 SDK canUseTool callback，验证权限管理器委托。 */
  _testCanUseTool() {
    return this.makeCanUseToolCallback();
  }

  /** 测试用：暴露 Aide 权限策略 PreToolUse hook，验证 allow/deny/ask/无匹配({})。
   *  包装成单参签名：HookCallback 类型上 toolUseID/options 是必填，但策略 hook
   *  只读 input——与其让十来个测试调用点各补两个占位实参，在这里一次适配。 */
  _testPolicyHook(cwd?: string): (input: HookInput) => ReturnType<HookCallback> {
    const hook = this.policy.makeHook(cwd);
    return (input) => hook(input, undefined, { signal: new AbortController().signal });
  }

  /** 测试用：直接注入策略快照（不经过 send/update_permission_policy 命令路径）。 */
  _testApplyPermissionPolicy(snapshot: PermissionPolicySnapshot): void {
    this.applyPermissionPolicy(snapshot);
  }

  /** 测试用：暴露待发送用户消息数，验证拒绝图片时不会入队。 */
  _testQueueLength(): number {
    return this.queue.size;
  }

  /** 测试用：会话级规则条数（验证去重不堆积）。 */
  _testSessionRuleCount(): number {
    return this.policy.ruleCount;
  }

  /** btw 支线回合结束自毁：关 query/queue 释放 claude.exe，并通知 manager 把自己
   *  摘出注册表。静默路径——stop() 本身不发 session_dead，前端 done 态不被打扰。
   *  收尾再清掉本会话的 claude.exe pid 注册条目：条目是 claude.exe 启动时写的，
   *  强杀不清理，残留会被 list_sessions 第二遍扫描成侧栏幽灵会话
   *  （2026-09-02 实锤：git-commit 支线的 cypress-agent-c6）。 */
  private selfTeardown(): void {
    if (this.stopped) return;
    this.stop();
    this.onSelfStop?.(this);
    // 注册条目跟随子进程实际生效的配置根（automation 隔离后条目写在
    // <sessionDir>/sessions/ 下，清全局就漏了——幽灵会话回归）
    removeSessionRegistryEntryFromEnv(
      { CLAUDE_CONFIG_DIR: this.subprocessConfigDir() },
      this.routingKey,
    );
  }

  /** 停止会话：关闭 query，释放 claude.exe，清理资源 */
  stop(): void {
    // 自动化一次性会话在回合中途被硬停（session_stop 等）：补一条终态事件，
    // 否则调度器永远等不到 message_stop，运行卡「运行中」直到重启自愈。
    // 自然终态（result→message_stop 已发）时 turnActive=false，不会补这条；
    // 极小窗口的重复也会被执行侧幂等忽略（路由摘除后事件无处路由）。
    const emitSyntheticTerminal = !!this.automationConfig && this.turnActive;
    this.stopped = true;
    if (emitSyntheticTerminal) {
      this.emit({ type: "message_stop", stop_reason: "interrupted", total_cost_usd: null, usage: null });
    }
    // 进程没了，running 的后台任务永远等不到结束信号——统一收尾 stopped，
    // 先停 tail（finalFlush 冲掉尾巴）再发终态，UI 不会留「永远运行中」的僵尸任务。
    for (const ev of this.bgTaskTracker.stopAllRunning()) {
      if (ev.type === "bg_task_ended") this.stopBgTaskTail(ev.id);
      this.emit(ev);
    }
    this.currentQuery?.close?.();
    this.currentQuery = null;
    this.queue.close();
    cancelAllCodegraphQueries("session stopped");
    this.stopAllOutputTails();
    this.stopAllBgTaskTails();
    // 挂起中的切换确认按 deny 收尾（进程都没了，确认没有继续等的意义）
    this.modelSwitchGuard?.dispose();
  }
}
