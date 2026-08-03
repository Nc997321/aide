import type { ChatEvent, ImageAttachment, ModelOption, PermissionModeOption, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { BgTaskTracker } from "./bgTasks.js";
import { BgTaskTail } from "./bgTaskOutputTail.js";
import { JumpQueueController } from "./jumpQueue.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";
import { generateSessionTitle } from "./titleGenerator.js";
import { applyModelSwitch } from "./modelSwitch.js";
import { applyEffortSwitch, normalizeEffort } from "./effortSwitch.js";
import type { EffortSettable } from "./effortSwitch.js";
import { cliSubagentModelEnvValue, makeSubagentModelHook } from "./subagentModelDefault.js";
import { makeSkillGuardHook } from "./skillGuard.js";
import { codegraphMcpRegistration, CODEGRAPH_ALLOW_RULE, makeCodegraphGrepNudgeHook } from "./codegraphTools.js";
import { cancelAllCodegraphQueries } from "./codegraphClient.js";
import {
  ImageInputCapabilityCache,
  imageCapabilityKey,
  isImagePath,
  probeImageInput,
} from "./imageInputCapability.js";
import {
  mapSdkMessage,
  buildUserMessage,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
  emitSubagentBlocks,
} from "./mapper.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { EffortLevel, HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { readFileSync } from "node:fs";
import { loadAideInstructions } from "./instructions.js";
import { buildProjectSkillOverrides } from "./skillsDiscovery.js";
import { evaluatePolicy } from "./policy/evaluate.js";
import type { PermissionPolicySnapshot } from "./policy/types.js";

// ---- 进程级常量（所有 SessionWorker 共享） ----

/** 读 Rust 维护的 enabled-plugins.json，构建 SDK options.plugins。 */
export function buildPluginsOption(): { type: "local"; path: string }[] {
  const file = process.env.AIDE_ENABLED_PLUGINS_FILE;
  if (!file) return [];
  try {
    const arr = JSON.parse(readFileSync(file, "utf8")) as { path: string }[];
    return arr
      .filter((e) => e.path && existsSync(e.path))
      .map((e) => ({ type: "local" as const, path: e.path }));
  } catch {
    return [];
  }
}

const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "default", displayName: "默认权限" },
  { value: "acceptEdits", displayName: "编辑模式" },
  { value: "plan", displayName: "计划模式" },
  { value: "auto", displayName: "自动模式" },
  { value: "bypassPermissions", displayName: "最高权限" },
];

const EXTRA_MODE_LABELS: Record<string, string> = {
  dontAsk: "本次会话不再询问",
};

/** 「进入编辑模式」按钮连带放行的工具集：acceptEdits 的语义就是编辑工具自动接受，
 *  切模式时队列里还挂着的同类请求一并放行——否则一轮并行 3 个 Edit，用户点完
 *  「进入编辑模式」还得把剩下 2 条逐个点掉，等于没切。 */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const IMAGE_INPUT_UNSUPPORTED_MESSAGE =
  "当前模型不支持图片输入，不能读取该图片。请改读 OCR/文本描述、跳过该文件，或切换到支持视觉的模型。";

	// ---- OutputTail（per-SessionWorker 实例） ----

/** 解析 .output 的一行 JSONL → 子代理事件。 */
function parseOutputLine(
  line: string, id: string, emit: (e: ChatEvent) => void, claimModel: () => boolean,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return; }
  emitSubagentBlocks(msg, id, emit, claimModel);
}

class OutputTail {
  private offset = 0;
  private leftover = "";
  private modelClaimed = false;
  private stopped = false;
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
  ) {}
  tick(): void {
    if (this.stopped) return;
    if (!existsSync(this.outputFile)) return;
    let fd: number | undefined;
    try {
      const st = statSync(this.outputFile);
      if (st.size < this.offset) { this.offset = 0; this.leftover = ""; }
      if (st.size === this.offset) return;
      fd = openSync(this.outputFile, "r");
      const buf = Buffer.allocUnsafe(st.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const data = this.leftover + buf.toString("utf8");
      const lines = data.split(/\r?\n/);
      this.leftover = lines.pop() ?? "";
      const claimModel = () => (this.modelClaimed ? false : (this.modelClaimed = true));
      for (const line of lines) parseOutputLine(line, this.id, this.emit, claimModel);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  stop(): void { this.stopped = true; }
}

// ---- SessionWorker ----

export interface SessionWorkerOptions {
  cwd?: string;
  btwMode?: boolean;
  lightweightMode?: boolean;
  initialModel?: string;
  envOverrides?: Record<string, string>;
  /** Runtime 级共享图片输入能力缓存；由 SessionManager 注入，禁止每会话各建一份。 */
  imageCapabilityCache: ImageInputCapabilityCache;
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
  /** Aide 权限策略快照（PreToolUse hook 据此评估）。revision 单调递增，落后于
   *  当前的快照被忽略；空策略 → 无匹配规则 → hook 返回 {}（回退原权限模式）。 */
  private permissionPolicy: PermissionPolicySnapshot = { revision: 0, rules: [] };
  readonly taskTracker = new TaskTracker();
  readonly subagentTracker = new SubagentTracker();
  readonly toolLifecycle = new ToolLifecycleTracker();
  readonly jumpQueueCtl = new JumpQueueController();
  readonly coalescer: DeltaCoalescer;
  readonly imageCapabilityCache: ImageInputCapabilityCache;

  // ---- SDK 查询状态 ----
  private currentQuery: Awaited<ReturnType<typeof query>> | null = null;
  private currentModel = process.env.ANTHROPIC_MODEL ?? "";
  /** 会话级 effort（low/medium/high/xhigh/max，小写）。绝不以 env 形式传给 CLI
   * （CLAUDE_CODE_EFFORT_LEVEL 会压过 applyFlagSettings、与 options.effort 就高合并，
   * 2026-08-01 smoke 实锤）——只走 options.effort + applyFlagSettings 两条官方通道。 */
  private currentEffort = "";
  /** Stop hook 读到的本轮实际 effort（含静默降级）；message_stop 盖戳后清零。 */
  private lastStopEffort = "";
  private lastConcreteModel = "";
  private lastModels: ModelOption[] = [];
  private aliasByResolvedPrefix: { value: string; resolvedPrefix: string }[] = [];
  private currentPermissionMode = "default";
  private pendingFork = false;
  private shouldForkNextConnect = false;
  private turnActive = false;
  private stopped = false;

  // ---- 会话自动命名（首轮回复开始时小模型生成标题，见 titleGenerator.ts） ----
  /** 设置面板开关（send.auto_title 下发），缺省开启。 */
  private autoTitle = true;
  /** 每个 worker 只尝试一次（防止 resume/多轮重复生成）。 */
  private titleAttempted = false;
  /** 首轮回复触发：新会话首条 send 置 collectingTitle，收到首条主线程 assistant 消息时触发。 */
  private collectingTitle = false;
  private titleUserText = "";

  // ---- BTW / 轻量模式 ----
  readonly btwMode: boolean;
  readonly lightweightMode: boolean;

  // ---- 工作目录 ----
  private cwd?: string;

  // ---- Provider env 覆盖（per-session） ----
  private envOverrides: Record<string, string>;

  // ---- 输出尾部轮询（per-session，替代模块级全局） ----
  private outputTails = new Map<string, OutputTail>();
  private outputTailTimer: NodeJS.Timeout | undefined;

  // ---- 后台 shell 任务：tracker + 输出 tail（per-session） ----
  readonly bgTaskTracker = new BgTaskTracker();
  private bgTaskTails = new Map<string, BgTaskTail>();
  private bgTaskTailTimer: NodeJS.Timeout | undefined;

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
    this.currentModel = opts.initialModel ?? this.envOverrides.ANTHROPIC_MODEL ?? this.currentModel;
    // provider env 通道携带的 effort 初始值（Rust 把 provider effort_level / 前端选择器
    // 值都注入 CLAUDE_CODE_EFFORT_LEVEL，与 ANTHROPIC_MODEL 同形）——只作初始值读出来，
    // 绝不会以 env 形式透传给 CLI（见 currentEffort 字段注释）。
    this.currentEffort = normalizeEffort(this.envOverrides.CLAUDE_CODE_EFFORT_LEVEL);
    this.imageCapabilityCache = opts.imageCapabilityCache;

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

  private async imageInputSupported(): Promise<true | false | null> {
    const model = this.currentModel || this.envOverrides.ANTHROPIC_MODEL || "";
    const key = imageCapabilityKey(this.envOverrides, model);
    // probe 的 CLI 子进程需要 PATH/SystemRoot 等基础环境，不能只给 provider 连接参数
    // （SDK 的 env 选项传了就替换 process.env，不是合并）。这里以 process.env 为底再叠加
    // per-session provider 覆盖，和主 query 的 cliEnv 构造保持一致。
    const probeEnv = { ...process.env, ...this.envOverrides };
    const result = await this.imageCapabilityCache.ensure(
      key,
      () => probeImageInput(this.queryFn, { env: probeEnv, model }),
    );
    return result;
  }

  private async guardImageInput(images?: ImageAttachment[]): Promise<boolean> {
    if (!images?.length) return true;
    return (await this.imageInputSupported()) !== false;
  }

  /** 每条 send 都携带 Rust 当前计算出的 provider 环境；在命令真正执行时更新，
   * 防止等待前一条图片 probe 时提前覆盖其连接身份。 */
  private applySendRuntimeConfig(env: Record<string, string> | undefined): void {
    this.envOverrides = env ?? {};
    const selectedModel = this.envOverrides.ANTHROPIC_MODEL;
    if (selectedModel) this.currentModel = selectedModel;
    // 前端选择器每条消息都带当前 effort（同 initialModel 语义，同值幂等无回执）；
    // 没带的调用方回落 provider env 默认。
    this.applyEffort(this.envOverrides.CLAUDE_CODE_EFFORT_LEVEL);
  }

  /** set_effort 命令 / send env 通道共用的切换入口：query 未起存本地（startLoop
   *  建 query 时经 options.effort 带上），在跑走 applyFlagSettings。成败都有回声。 */
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

  /** 从当前轮安全边界接入插队消息；会话已关闭时丢弃，禁止向 closed queue 写入。 */
  private promoteJumpQueue(): boolean {
    const jumps = this.jumpQueueCtl.takeAll();
    if (!jumps.length || this.stopped) return false;
    // 多条插队逐条 push（不合并）：/compact 这类斜杠命令作为独立用户消息才能
    // 被 CLI 正确执行。权限模式不在此回放——存活期间用户切模式走
    // set_permission_mode 实时通道已生效，入队快照只会把新模式回退成旧值。
    for (const jump of jumps) {
      this.queue.push({
        type: "user",
        message: buildUserMessage(jump.prompt, jump.images ?? []),
        parent_tool_use_id: null,
      } as any);
    }
    this.emit({ type: "jump_promoted" } as any);
    this.turnActive = true;
    return true;
  }

  private makeCanUseToolCallback() {
    const permissionCallback = this.permMgr.makeCallback(
      (e) => this.emit(e),
      this.subagentTracker,
    );
    // canUseTool 只对需要授权的工具（Write/Edit/Bash…）触发；Read 这种只读工具 CLI 在
    // allowDangerouslySkipPermissions 下自动放行、根本不调 canUseTool，所以图片 Read 守卫
    // 不能放这里——改用 makeImageGuardHook 的 PreToolUse hook（对所有工具都触发）。
    return async (toolName: string, input: unknown, opts?: unknown) =>
      permissionCallback(toolName, input, opts as any);
  }

  /** PreToolUse hook：在 Read 执行前拦截图片路径。hook 对所有工具都触发（含 CLI 自动
   *  放行的只读工具），不像 canUseTool 只覆盖需授权工具，所以图片 Read 守卫必须放这里。
   *  返回 permissionDecision:"deny" 会把 permissionDecisionReason 作为工具错误回喂模型，
   *  模型可据此改读 OCR/文本或跳过，且真实图片字节永不进入会话。 */
  private makeImageGuardHook(): HookCallback {
    return async (input: HookInput) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (input.tool_name !== "Read") return {};
      const toolInput = input.tool_input;
      if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return {};
      const fp = (toolInput as Record<string, unknown>).file_path;
      if (!isImagePath(fp)) return {};
      const supported = await this.imageInputSupported();
      if (supported === false) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: IMAGE_INPUT_UNSUPPORTED_MESSAGE,
          },
        };
      }
      return {};
    };
  }

  // ================================================================
  // Aide 权限策略
  // ================================================================

  /** Apply a fresh permission-policy snapshot. Snapshots with `revision`
   *  strictly less than the current one are ignored (no rollback). The first
   *  `send` carries the initial snapshot; `update_permission_policy` pushes
   *  subsequent updates without restarting the worker. */
  applyPermissionPolicy(snapshot: PermissionPolicySnapshot): void {
    if (!snapshot || snapshot.revision < this.permissionPolicy.revision) return;
    this.permissionPolicy = snapshot;
  }

  /** Authoritative PreToolUse hook: evaluates the Aide policy snapshot before
   *  any other hook (image guard, skill guard, etc.) runs. `allow`/`deny` are
   *  returned directly; `ask` opens the human confirmation flow via
   *  `permMgr.request`; no-match returns `{}` (no opinion) so the CLI falls
   *  back to its normal permission flow. Applies to every tool including Read.
   *  `allowDangerouslySkipPermissions` does NOT bypass this hook — the hook is
   *  registered unconditionally on `matcher: ".*"`.
   *  NB: the no-match branch must NOT return `permissionDecision:"defer"` — the
   *  CLI doesn't honor it and breaks tool execution ("Tool result missing due
   *  to internal error"). `{}` is the correct "defer to normal flow" response. */
  private makePolicyHook(cwd: string | undefined): HookCallback {
    return async (input: HookInput) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolName = input.tool_name;
      const toolInput = input.tool_input;
      if (!toolName) return {};
      const decision = await evaluatePolicy(this.permissionPolicy, {
        tool: toolName,
        input: (toolInput ?? {}) as Record<string, unknown>,
        cwd: cwd ?? this.cwd,
      });
      switch (decision.disposition) {
        case "allow":
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "allow" as const,
              permissionDecisionReason: decision.reason,
            },
          };
        case "deny":
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: decision.reason,
            },
          };
        case "ask": {
          const answer = await this.permMgr.request(
            toolName,
            toolInput,
            {},
            (e) => this.emit(e),
            this.subagentTracker,
          );
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: answer.approved ? ("allow" as const) : ("deny" as const),
              permissionDecisionReason: answer.approved
                ? "Aide policy requires confirmation"
                : "User denied Aide policy confirmation",
              ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
            },
          };
        }
        default:
          // No Aide policy rule matched → return {} (no opinion) so the CLI proceeds
          // with its normal permission flow (here allowDangerouslySkipPermissions
          // auto-allows). Do NOT return permissionDecision:"defer": the claude.exe CLI
          // does NOT honor "defer" from a PreToolUse hook and silently breaks tool
          // execution — every tool_use comes back as "Tool result missing due to
          // internal error" (repro confirmed 2026-07-29 vs control). {} leaves the
          // decision to canUseTool/permissionMode, which is exactly the defer intent.
          return {};
      }
    };
  }

  // ================================================================
  // 权限模式
  // ================================================================

  private emitPermissionModes(): void {
    const modes = PERMISSION_MODES.some((m) => m.value === this.currentPermissionMode)
      ? PERMISSION_MODES
      : [
          ...PERMISSION_MODES,
          {
            value: this.currentPermissionMode,
            displayName: EXTRA_MODE_LABELS[this.currentPermissionMode] ?? this.currentPermissionMode,
          },
        ];
    this.emit({ type: "permission_modes_available", modes, current: this.currentPermissionMode });
  }

  private applyPermissionMode(mode: string): void {
    if (!PERMISSION_MODES.some((m) => m.value === mode) && !(mode in EXTRA_MODE_LABELS)) return;
    if (mode === this.currentPermissionMode) return;
    const q = this.currentQuery;
    if (q) {
      q.setPermissionMode(mode as any)
        .then(() => {
          this.currentPermissionMode = mode;
          this.emitPermissionModes();
        })
        .catch(() => {});
    } else {
      this.currentPermissionMode = mode;
      this.emitPermissionModes();
    }
  }

  // ================================================================
  // 模型相关
  // ================================================================

  private async emitModelsAvailable(q: Awaited<ReturnType<typeof query>>): Promise<void> {
    try {
      const init = await q.initializationResult();
      const selectable = filterSelectableModels(init.models);
      this.lastModels = selectable.map((m) => ({ value: m.value, displayName: m.displayName }));
      this.aliasByResolvedPrefix = selectable
        .filter((m) => m.resolvedModel)
        .map((m) => ({ value: m.value, resolvedPrefix: m.resolvedModel as string }));
      this.emit({ type: "models_available", models: this.lastModels, current: this.currentModel });
    } catch {
      // SDK 版本不支持时静默跳过
    }
  }

  private resolveDropdownValue(concreteModel: string): string {
    const hit = this.aliasByResolvedPrefix.find(
      (a) => concreteModel === a.resolvedPrefix || concreteModel.startsWith(`${a.resolvedPrefix}-`),
    );
    return hit ? hit.value : concreteModel;
  }

  // ================================================================
  // 上下文用量 / 速率限制
  // ================================================================

  private async emitContextUsage(q: Awaited<ReturnType<typeof query>>): Promise<void> {
    try {
      const usage = await q.getContextUsage();
      this.emit({
        type: "context_usage",
        total_tokens: usage.totalTokens,
        max_tokens: usage.maxTokens,
        percentage: usage.percentage,
      });
    } catch {
      // 拿不到就跳过
    }
  }

  private lastRateLimitAt = 0;
  private async emitRateLimit(q: Awaited<ReturnType<typeof query>>): Promise<void> {
    if (Date.now() - this.lastRateLimitAt < 15_000) return;
    try {
      const anyQ = q as any;
      if (typeof anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return;
      const usage = await anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      this.lastRateLimitAt = Date.now();
      this.emit(buildRateLimitEvent(usage));
    } catch {
      // 实验性/不支持：跳过
    }
  }

  // ================================================================
  // OutputTail（per-SessionWorker，替代模块级全局）
  // ================================================================

  startOutputTail(id: string, outputFile: string): void {
    if (this.outputTails.has(id)) return;
    this.outputTails.set(id, new OutputTail(id, outputFile, (e) => this.emit(e)));
    this.ensureOutputTailTimer();
  }

  stopOutputTail(id: string): void {
    const t = this.outputTails.get(id);
    if (t) { t.stop(); this.outputTails.delete(id); }
    if (this.outputTails.size === 0 && this.outputTailTimer) {
      clearInterval(this.outputTailTimer);
      this.outputTailTimer = undefined;
    }
  }

  stopAllOutputTails(): void {
    for (const t of this.outputTails.values()) t.stop();
    this.outputTails.clear();
    if (this.outputTailTimer) { clearInterval(this.outputTailTimer); this.outputTailTimer = undefined; }
  }

  private ensureOutputTailTimer(): void {
    if (this.outputTailTimer) return;
    this.outputTailTimer = setInterval(() => {
      for (const t of this.outputTails.values()) {
        try { t.tick(); } catch { /* 单条 tail 出错不影响其它 */ }
      }
    }, 600);
    if (typeof (this.outputTailTimer as any).unref === "function") (this.outputTailTimer as any).unref();
  }

  // ================================================================
  // BgTaskTail（后台 shell 任务输出，per-SessionWorker）
  // ================================================================

  startBgTaskTail(id: string, outputFile: string): void {
    if (this.bgTaskTails.has(id)) return; // 幂等：ack 重复到达不重启
    this.bgTaskTails.set(id, new BgTaskTail(id, outputFile, (e) => this.emit(e)));
    this.ensureBgTaskTailTimer();
  }

  stopBgTaskTail(id: string): void {
    const t = this.bgTaskTails.get(id);
    if (t) { t.finalFlush(); this.bgTaskTails.delete(id); } // finalFlush 内含 stop
    if (this.bgTaskTails.size === 0 && this.bgTaskTailTimer) {
      clearInterval(this.bgTaskTailTimer);
      this.bgTaskTailTimer = undefined;
    }
  }

  stopAllBgTaskTails(): void {
    for (const t of this.bgTaskTails.values()) t.stop();
    this.bgTaskTails.clear();
    if (this.bgTaskTailTimer) { clearInterval(this.bgTaskTailTimer); this.bgTaskTailTimer = undefined; }
  }

  private ensureBgTaskTailTimer(): void {
    if (this.bgTaskTailTimer) return;
    this.bgTaskTailTimer = setInterval(() => {
      for (const t of this.bgTaskTails.values()) {
        try { t.tick(); } catch { /* 单条 tail 出错不影响其它 */ }
      }
    }, 600);
    if (typeof (this.bgTaskTailTimer as any).unref === "function") (this.bgTaskTailTimer as any).unref();
  }

  // ================================================================
  // 命令处理（替代原先 index.ts 的 rl.on("line",...)）
  // ================================================================

  private enqueueSend(cmd: Extract<SidecarCommand, { cmd: "send" }>): void {
    if (this.sendQueue) {
      const next = this.sendQueue.then(() => this.handleSend(cmd));
      const tracked = next.catch(() => {});
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

    const tracked = pending.catch(() => {});
    this.sendQueue = tracked;
    void tracked.finally(() => {
      if (this.sendQueue === tracked) this.sendQueue = null;
    });
  }

  handleCommand(cmd: SidecarCommand): void {
    if (cmd.cmd === "send") {
      this.enqueueSend(cmd);

    } else if (cmd.cmd === "permission_response") {
      const outcome = this.permMgr.resolve(cmd.id, cmd.approved, cmd.answers);
      if (cmd.approved && outcome?.toolName === "ExitPlanMode") {
        this.applyPermissionMode(cmd.nextMode || "default");
      } else if (cmd.approved && outcome?.toolName === "EnterPlanMode") {
        // 模型主动进入计划模式（非用户预选）：对齐本地账本并广播，让前端下拉同步
        this.applyPermissionMode("plan");
      } else if (cmd.approved && cmd.nextMode) {
        // 「进入编辑模式」：编辑工具的权限弹窗提供的一劳永逸选项——放行本次 +
        // 切到 acceptEdits，之后编辑不再逐条确认（对齐 CLI 的 "allow all edits
        // this session"）。切完把还挂着的其它编辑请求连带放行，别让用户逐条点。
        this.applyPermissionMode(cmd.nextMode);
        if (cmd.nextMode === "acceptEdits") this.permMgr.approveMatching(EDIT_TOOL_NAMES);
      }

    } else if (cmd.cmd === "update_permission_policy") {
      this.applyPermissionPolicy(cmd.policy);

    } else if (cmd.cmd === "interrupt") {
      // 用户主动打断：待插队消息一并作废（对齐旧"排队消息作废"语义）；挂起的权限确认
      // 也一并撤销（policy hook 的 ask 路径没有 SDK signal，靠 cancelAll 兜底）。
      this.permMgr.cancelAll();
      this.jumpQueueCtl.clear();
      cancelAllCodegraphQueries("interrupted");
      this.currentQuery?.interrupt().catch(() => {});

    } else if (cmd.cmd === "stop_bg_task") {
      // 终止后台任务：SDK stopTask 后 CLI 会发 task_notification(status:"stopped")，
      // 终态走 mapper 既有通道（停 tail + bg_task_ended），这里不合成任何事件。
      // query 未起（会话还没发过消息）或任务不存在时安静吞掉。
      this.currentQuery?.stopTask(cmd.task_id).catch(() => {});

    } else if (cmd.cmd === "set_permission_mode") {
      this.applyPermissionMode(cmd.mode);
      // 与「进入编辑模式」按钮同语义：切到 acceptEdits 时把切换之前已挂起的
      // 编辑请求连带放行——否则旧弹窗留在屏幕上，而前端 currentMode 已是
      // acceptEdits，「进入编辑模式」按钮又被藏起来，用户只能逐条点掉。
      if (cmd.mode === "acceptEdits") this.permMgr.approveMatching(EDIT_TOOL_NAMES);

    } else if (cmd.cmd === "set_model") {
      applyModelSwitch({
        model: cmd.model,
        query: this.currentQuery,
        models: this.lastModels,
        currentModel: this.currentModel,
        emit: (e) => this.emit(e),
        commit: (m) => { this.currentModel = m; },
      });

    } else if (cmd.cmd === "set_effort") {
      this.applyEffort(cmd.effort);
    }
  }

  private async handleSend(cmd: Extract<SidecarCommand, { cmd: "send" }>): Promise<void> {
    if (this.stopped) return;
    this.applySendRuntimeConfig(cmd.env);
    if (cmd.auto_title !== undefined) this.autoTitle = cmd.auto_title;
    // 首条 send 携带的策略快照在 query 起来前落地——PreToolUse hook 首次评估就能用。
    if (cmd.permission_policy) this.applyPermissionPolicy(cmd.permission_policy);

    if (cmd.images?.length && !(await this.guardImageInput(cmd.images))) {
      this.emit({ type: "image_input_rejected", message: IMAGE_INPUT_UNSUPPORTED_MESSAGE });
      return;
    }
    // 图片 probe 是异步的；等待期间会话可能已关闭，不能让已移除的 worker 重新启动 query。
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
      (this as any).btwMode = true;
      (this as any).lightweightMode = !!cmd.lightweight;
      // BTW forks from `fork_from`, not `session_id`（session_id 是 BTW 自己的路由键）
      const forkFrom = (cmd as any).fork_from as string | undefined;
      if (forkFrom) this.resumeSource = forkFrom;
    }

    // 新一轮用户消息：清 TODO 快照
    this.taskTracker.reset();
    this.emit({ type: "tasks_update", tasks: [] });

    // 首条消息：启动 query 循环
    if (!this.currentQuery) {
      if (cmd.permission_mode) this.applyPermissionMode(cmd.permission_mode);
      // 重开已有会话：resume_session_id → resumeSource，startLoop 据此 resume。
      // 普通新会话不带这字段，resumeSource 保持空 → 全新会话。
      if (cmd.resume_session_id) this.resumeSource = cmd.resume_session_id;
      // 自动命名触发：只有「全新会话」（非 resume / 非 btw / 非供应商切换 fork）
      // 才在首轮回复开始时生成标题——老会话已有名字，fork 会话语义上属于源会话。
      if (
        this.autoTitle &&
        !this.titleAttempted &&
        !cmd.resume_session_id &&
        !cmd.btw &&
        !cmd.provider_switched
      ) {
        this.collectingTitle = true;
        this.titleUserText = cmd.prompt;
      }
      this.startLoop(cmd.cwd ?? this.cwd, cmd.trusted !== false);
      this.queue.push({
        type: "user",
        message: buildUserMessage(cmd.prompt, cmd.images ?? []),
        parent_tool_use_id: null,
      } as any);
      this.turnActive = true;
      return;
    }

    // 插队
    if (cmd.jump_queue && this.currentQuery && this.turnActive) {
      this.jumpQueueCtl.request({
        prompt: cmd.prompt,
        images: cmd.images,
      });
      if (this.toolLifecycle.isIdle()) {
        this.currentQuery.interrupt().catch(() => {});
      } else {
        // 有工具在跑：要等安全边界，通知前端显示"待发出"提示条
        this.emit({ type: "jump_queued", prompt: cmd.prompt } as any);
      }
      return;
    }

    // 普通续发。注意不回放 cmd.permission_mode：query 存活期间权限模式由
    // set_permission_mode 实时通道独占（前端下拉切换必发），消息里带的只是
    // 发送时刻的快照——handleSend 可能被图片 probe 推迟（enqueueSend 串行化），
    // 等待期间用户切的新模式会被这里的旧值回退。模式随消息携带只保留给
    // 上面「首条消息」分支（进程未起时 set_permission_mode 静默失败的兜底）。
    this.queue.push({
      type: "user",
      message: buildUserMessage(cmd.prompt, cmd.images ?? []),
      parent_tool_use_id: null,
    } as any);
    this.turnActive = true;
  }

  // ================================================================
  // 主循环
  // ================================================================

  async startLoop(cwd?: string, trusted = true): Promise<void> {
    try {
      while (!this.stopped) {
        try {
          // 构造显式 env 传给 CLI subprocess
          const cliEnv: Record<string, string | undefined> = { ...process.env };
          for (const k of [
            "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL",
            // 注意：CLAUDE_CODE_EFFORT_LEVEL 刻意不透传——它会压过 applyFlagSettings、
            // 并与 options.effort 就高合并（2026-08-01 smoke 实锤），会让会话内
            // effort 切换被 env 搅乱。effort 只走 options.effort + applyFlagSettings。
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
          ]) {
            if (process.env[k]) cliEnv[k] = process.env[k];
          }
          // per-session env 覆盖（provider 连接参数）
          for (const [k, v] of Object.entries(this.envOverrides)) {
            if (v) cliEnv[k] = v;
          }
          // {...process.env} 的扩散和 envOverrides 都可能带进 CLAUDE_CODE_EFFORT_LEVEL
          // （用户全局 env / Rust provider 注入），必须在最后显式删除。
          delete cliEnv.CLAUDE_CODE_EFFORT_LEVEL;
          cliEnv.CLAUDE_CODE_SUBAGENT_MODEL = cliSubagentModelEnvValue(process.env);

          const subagentModelHook = makeSubagentModelHook(process.env);
          // 子代理重型 skill 守卫：子代理上下文里拦截名单内重型 skill（默认 claude-api），
          // 防 fan-out × 逐轮重发撑爆 input。返回 null（关闭/名单空）则不注册。
          const skillGuardHook = makeSkillGuardHook(process.env);

          // codegraph agent 工具：默认注册（AIDE_CODEGRAPH_TOOLS=off 关闭）。
          // handler 闭包持有本会话的 emit（经 DeltaCoalescer，红线）与 cwd。
          // 轻量 btw 是纯问答，必须跳过：tools:[] 只禁内建工具，MCP 工具照样进
          // 工具列表，模型会真去调（2026-08-02 实锤「先看一眼链路」并卡在调用上）。
          const effectiveCwd = cwd ?? this.cwd ?? "";
          // 受限模式（!trusted）：项目 .aide/claude/skills/ 里的 skill 经
          // managedSettings.skillOverrides 从模型列表/Skill 工具隐藏——
          // user/plugin skill 不受影响（skills 仍为 "all"）。
          const projectSkillOverrides = trusted ? {} : buildProjectSkillOverrides(effectiveCwd);
          const codegraphMcp = this.lightweightMode
            ? null
            : codegraphMcpRegistration(effectiveCwd, (e) => this.emit(e), process.env, trusted);

          if (this.resumeSource && this.shouldForkNextConnect && !this.btwMode) {
            this.pendingFork = true;
          }

          // Aide 指令加载：不依赖 SDK 文件系统 setting source，自己读 global + project
          // CLAUDE.md 追加到 preset system prompt。settingSources 必须为空，否则 SDK
          // 仍会去读 .claude/settings*.json，与 Aide 独立设置体系冲突。
          const instructions = await loadAideInstructions(
            effectiveCwd,
            process.env.CLAUDE_CONFIG_DIR ?? "",
            trusted,
          );
          // Aide 权限策略 hook：排在所有其它 PreToolUse hook 之前（含图片守卫），
          // allowDangerouslySkipPermissions 也不绕过——matcher ".*" 对每个工具都触发。
          const policyHook = this.makePolicyHook(effectiveCwd);

          const q = this.queryFn({
            prompt: this.queue[Symbol.asyncIterator](),
            options: {
              permissionMode: this.currentPermissionMode as any,
              allowDangerouslySkipPermissions: true,
              canUseTool: this.makeCanUseToolCallback() as any,
              settingSources: [],
              // 受限模式（!trusted）：strictMcpConfig 忽略项目 .mcp.json 等外部 MCP
              // 配置；managedSettings.skillOverrides 隐藏项目 .aide/claude/skills/ 里的 skill。
              // user 级 / plugin 级不受影响（plugins 经 AIDE_ENABLED_PLUGINS_FILE 注入）。
              ...(trusted ? {} : { strictMcpConfig: true }),
              ...(projectSkillOverrides && Object.keys(projectSkillOverrides).length > 0
                ? { managedSettings: { skillOverrides: projectSkillOverrides } as any }
                : {}),
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: instructions,
              },
              ...(this.lightweightMode
                ? { allowedTools: [] as string[] }
                : { allowedTools: ["Agent", "Task", CODEGRAPH_ALLOW_RULE] }),
              // 轻量 btw：skills/plugins 同样关闭（Skill 工具虽被 tools:[] 禁掉，
              // 但 skill 清单会白进上下文；plugins 可能自带 MCP 工具漏进工具列表）。
              skills: this.lightweightMode ? [] : "all",
              plugins: this.lightweightMode ? [] : buildPluginsOption(),
              hooks: {
                PreToolUse: [
                  // Aide 权限策略是权威前置层，必须最先评估。
                  { matcher: ".*", hooks: [policyHook] },
                  ...(subagentModelHook
                    ? [{ matcher: "^(Agent|Task)$", hooks: [subagentModelHook] }]
                    : []),
                  // 图片 Read 守卫：canUseTool 对只读工具不触发，必须用 hook。
                  { matcher: "^Read$", hooks: [this.makeImageGuardHook()] },
                  ...(skillGuardHook
                    ? [{ matcher: "^Skill$", hooks: [skillGuardHook] }]
                    : []),
                  // codegraph Grep 纠偏：符号状 pattern 时注入「先用索引工具」提示。
                  // 与 MCP 注册同生同灭（AIDE_CODEGRAPH_TOOLS=off 时不挂）。
                  ...(codegraphMcp
                    ? [{ matcher: "^Grep$", hooks: [makeCodegraphGrepNudgeHook()] }]
                    : []),
                ],
                // 回合结束读本轮实际 effort（含静默降级）→ emit 盖到 message_stop 上。
                Stop: [{ hooks: [this.makeStopEffortHook()] }],
              },
              ...(codegraphMcp ? { mcpServers: codegraphMcp as any } : {}),
              includePartialMessages: false,
              ...(this.currentModel ? { model: this.currentModel } : {}),
              // effort 的 spawn 通道（会话中切换走 set_effort → applyFlagSettings）。
              ...(this.currentEffort ? { effort: this.currentEffort as EffortLevel } : {}),
              ...(cwd ? { cwd } : {}),
              ...(this.cwd && !cwd ? { cwd: this.cwd } : {}),
              ...(process.env.AIDE_CLAUDE_EXE
                ? { pathToClaudeCodeExecutable: process.env.AIDE_CLAUDE_EXE }
                : {}),
              ...forkResumeOptions(this.resumeSource ?? "", this.shouldForkNextConnect),
              ...btwQueryOverrides(this.btwMode, this.lightweightMode),
              env: cliEnv,
            },
          });
          this.currentQuery = q;
          this.shouldForkNextConnect = false;

          for await (const msg of q) {
            if ((msg as any).type === "result") {
              this.turnActive = false;
              // 兜底：首轮未收到任何主线程 assistant 消息就结束（出错/空轮），
              // 放弃命名，仅清理标志，避免泄漏到下一轮。正常流程下标志已在
              // 首条 assistant 消息时清掉，这里是 no-op。
              if (this.collectingTitle) {
                this.collectingTitle = false;
              }
              if (this.promoteJumpQueue()) {
                this.toolLifecycle.reset();
                void this.emitContextUsage(q);
                void this.emitRateLimit(q);
                continue;
              }
            }

            // 检测模型主动进入计划模式（auto 等模式下 SDK 可能不经 canUseTool
            // 自动批准 EnterPlanMode）：主线程 assistant 消息里出现 EnterPlanMode
            // 工具调用时，对齐本地账本并广播。子代理内部不计（不污染主线程模式）。
            if (
              (msg as any).type === "assistant" &&
              !(msg as any).parent_tool_use_id
            ) {
              const blocks = (msg as any).message?.content as any[] | undefined;
              if (blocks?.some((b: any) => b.type === "tool_use" && b.name === "EnterPlanMode")) {
                this.applyPermissionMode("plan");
              }
            }

            mapSdkMessage(
              msg,
              (e) => this.emit(e),
              this.taskTracker,
              this.subagentTracker,
              this.toolLifecycle,
              (m) => this.resolveDropdownValue(m),
              {
                start: (id, outputFile, _emit, _onStop) => {
                  // SessionWorker 的 emit 已绑定到实例，忽略传入的 emit/onStop
                  this.startOutputTail(id, outputFile);
                },
                stop: (id) => this.stopOutputTail(id),
              },
              {
                tracker: this.bgTaskTracker,
                startTail: (id, outputFile) => this.startBgTaskTail(id, outputFile),
                stopTail: (id) => this.stopBgTaskTail(id),
              },
            );

            if (this.jumpQueueCtl.has() && this.toolLifecycle.isIdle()) {
              this.currentQuery?.interrupt().catch(() => {});
            }

            // 首轮回复开始：收到第一条主线程 assistant 消息即触发自动命名
            // （fire-and-forget，不阻塞后续轮次）。提前到"回复时"而非"整轮
            // 结束的 result"——标题几乎与回复同时出现；标题仅基于用户输入
            // （userText），不等助手文本。置 false 保证只触发一次；子代理消息
            // （parent_tool_use_id 非空）不计——它不是主线程回复。
            if (
              this.collectingTitle &&
              (msg as any).type === "assistant" &&
              !(msg as any).parent_tool_use_id
            ) {
              this.collectingTitle = false;
              void this.emitSessionTitle();
            }

            if ((msg as any).type === "system" && (msg as any).subtype === "init") {
              const newSid = (msg as any).session_id as string | undefined;
              if (this.pendingFork && newSid && newSid !== this.resumeSource) {
                this.emit({
                  type: "notification",
                  message: "已切换供应商，对话历史已迁移到新会话。",
                  notification_type: "provider_switch",
                } as any);
                this.pendingFork = false;
              }
              this.resumeSource = newSid ?? this.resumeSource;
              void this.emitModelsAvailable(q);
            } else if (
              (msg as any).type === "assistant" &&
              !(msg as any).parent_tool_use_id &&
              isAdoptableAssistantModel(msg) &&
              (msg as any).message.model !== this.lastConcreteModel
            ) {
              this.lastConcreteModel = (msg as any).message.model;
              this.currentModel = this.resolveDropdownValue(this.lastConcreteModel);
              if (this.lastModels.length > 0) {
                this.emit({ type: "models_available", models: this.lastModels, current: this.currentModel });
              }
            } else if ((msg as any).type === "result") {
              this.toolLifecycle.reset();
              void this.emitContextUsage(q);
              void this.emitRateLimit(q);
              // btw 是一次性支线：回合结束即自毁释放 claude.exe。streaming-input
              // 的 query 不主动关会连进程一起永远挂着——CLI 的 pid 元数据留在
              // ~/.aide/claude/sessions/ 被 list_sessions 扫成侧栏幽灵空会话，
              // 且每条 btw 白占几百 MB（2026-08-02 实锤 pid 9464 挂 12min+）。
              // message_stop 已在本轮迭代经 mapSdkMessage 发出；setImmediate
              // 推迟到迭代体外，避免在 for-await 迭代中 close 自己。
              if (this.btwMode) setImmediate(() => this.selfTeardown());
            }
          }
          // for await 正常结束（queue closed）
          break;
        } catch (e: any) {
          this.currentQuery = null;
          this.pendingFork = false;
          this.turnActive = false;
          this.toolLifecycle.reset();
          if (e?.name !== "AbortError") {
            this.emit({ type: "error", message: String(e?.message ?? e), fatal: false });
          }
          this.promoteJumpQueue();
        }
      }
    } finally {
      this.currentQuery = null;
    }
  }

  // ================================================================
  // 会话自动命名
  // ================================================================

  /** 首轮回复开始时后台生成会话标题（fire-and-forget）。独立的小模型 query——
   *  全新 SDK 会话，不占主对话上下文；标题模型默认 haiku，AIDE_TITLE_MODEL
   *  可覆盖。标题仅基于用户输入（userText），不等助手回复。任何失败（超时/
   *  空响应/provider 不支持）generateSessionTitle 内部静默返回 null，这里就
   *  不发事件，会话保留默认名。 */
  private async emitSessionTitle(): Promise<void> {
    if (this.titleAttempted) return;
    this.titleAttempted = true;
    const title = await generateSessionTitle(this.queryFn, {
      userText: this.titleUserText,
      model: process.env.AIDE_TITLE_MODEL || "haiku",
      env: { ...process.env, ...this.envOverrides },
      cwd: this.cwd,
      executablePath: process.env.AIDE_CLAUDE_EXE,
    });
    if (title && !this.stopped) this.emit({ type: "session_title", title });
  }

  // ================================================================
  // 生命周期
  // ================================================================

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

  /** 测试用：暴露图片 Read 守卫的 PreToolUse hook，验证 deny/allow 决策。 */
  _testImageGuardHook() {
    return this.makeImageGuardHook();
  }

  /** 测试用：暴露 Aide 权限策略 PreToolUse hook，验证 allow/deny/ask/无匹配({})。
   *  包装成单参签名：HookCallback 类型上 toolUseID/options 是必填，但策略 hook
   *  只读 input——与其让十来个测试调用点各补两个占位实参，在这里一次适配。 */
  _testPolicyHook(cwd?: string): (input: HookInput) => ReturnType<HookCallback> {
    const hook = this.makePolicyHook(cwd);
    return (input) => hook(input, undefined, { signal: new AbortController().signal });
  }

  /** 测试用：直接注入策略快照（不经过 send/update_permission_policy 命令路径）。 */
  _testApplyPermissionPolicy(snapshot: PermissionPolicySnapshot): void {
    this.applyPermissionPolicy(snapshot);
  }

  /** 测试用：暴露待发送用户消息数，验证拒绝图片时不会入队。 */
  _testQueueLength(): number {
    return ((this.queue as any).queue as unknown[] | undefined)?.length ?? 0;
  }

  /** btw 支线回合结束自毁：关 query/queue 释放 claude.exe，并通知 manager 把自己
   *  摘出注册表。静默路径——stop() 本身不发 session_dead，前端 done 态不被打扰。 */
  private selfTeardown(): void {
    if (this.stopped) return;
    this.stop();
    this.onSelfStop?.(this);
  }

  /** 停止会话：关闭 query，释放 claude.exe，清理资源 */
  stop(): void {
    this.stopped = true;
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
  }
}
