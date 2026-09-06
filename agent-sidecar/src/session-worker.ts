import type {
  ChatEvent,
  ImageAttachment,
  ModelOption,
  PermissionModeOption,
  SidecarCommand,
  UserMessageBlock,
} from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { BgTaskTracker } from "./bgTasks.js";
import { BgTaskTail } from "./bgTaskOutputTail.js";
import { JumpQueueController } from "./jumpQueue.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import { removeSessionRegistryEntryFromEnv } from "./claudeRegistry.js";
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";
import {
  automationHookVerdict,
  automationQueryOverrides,
  filterMcpServers,
  type AutomationConfig,
} from "./automation.js";
import { titleFromContent } from "./titleGenerator.js";
import { applyModelSwitch } from "./modelSwitch.js";
import { makeModelSwitchGuard, type ModelSwitchGuard } from "./modelSwitchGuard.js";
import { applyEffortSwitch, normalizeEffort } from "./effortSwitch.js";
import type { EffortSettable } from "./effortSwitch.js";
import { cliSubagentModelEnvValue } from "./subagentModelDefault.js";
import { codegraphMcpRegistration, CODEGRAPH_ALLOW_RULE } from "./codegraphTools.js";
import { docsMcpRegistration, DOCS_ALLOW_RULE } from "./docsMcp.js";
import { buildBuiltinHooks } from "./builtinHooks/index.js";
import { loadUserMcpServers, loadUserHooks, assembleMcpServers, assembleHooks } from "./userExtensions.js";
import { cancelAllCodegraphQueries } from "./codegraphClient.js";
import { detectImageUnsupported, findSessionJsonl, rollbackImageMessage } from "./imageRollback.js";
import { resolveClaudeExe } from "./claudeExe.js";
import {
  mapSdkMessage,
  buildUserMessage,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
  emitSubagentBlocks,
} from "./mapper.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, EffortLevel, HookCallback, HookInput, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadAideInstructions } from "./instructions.js";
import { buildDispatchPluginsOption } from "./dispatchPlugins.js";
import { evaluatePolicy } from "./policy/evaluate.js";
import type { PermissionPolicySnapshot, PermissionRule } from "./policy/types.js";
import type { PermissionRuleDraft } from "./types.js";
import { randomUUID } from "node:crypto";

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

/** 会话级规则的文件工具家族：Edit/Write/MultiEdit 共享同一份 file_path 精确文件规则
 *  （同一文件是同一操作对象，工具差异只是写入方式——Write 新文件放行后，Edit 同文件
 *  不再询问）。NotebookEdit 的输入字段是 notebook_path，不在家族内。 */
const FILE_FAMILY_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

	// ---- OutputTail（per-SessionWorker 实例） ----

/** 单次 tick 的读上限（1MB）：超限截断、剩余下次续读——防大输出文件一次读爆
 *  内存（sync 全量 allocUnsafe 曾是 OOM 与事件循环卡死的来源，审查 P0-2）。 */
const MAX_TAIL_READ_BYTES = 1024 * 1024;

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
  /** 在途读守卫：异步 tick 与定时器下轮互斥，防并发重复读同一区间。 */
  private ticking = false;
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
  ) {}
  /** 异步增量读（fs/promises，不阻塞事件循环）；单次最多读 MAX_TAIL_READ_BYTES，
   *  超出部分下次 tick 续读——大输出文件不再一次 allocUnsafe 全量 + 同步 readSync
   *  卡死事件循环（审查 P0-2）。读失败/文件消失由调用方 catch，下次轮询重试。 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    if (!existsSync(this.outputFile)) return;
    this.ticking = true;
    let fd: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const st = await stat(this.outputFile);
      if (st.size < this.offset) { this.offset = 0; this.leftover = ""; }
      if (st.size === this.offset) return;
      fd = await open(this.outputFile, "r");
      const want = Math.min(st.size - this.offset, MAX_TAIL_READ_BYTES);
      const buf = Buffer.allocUnsafe(want);
      // 注意：不用 fs/promises 顶层 read()——Node 22.22 无此导出（2026-08-23 实测
      // undefined），用 FileHandle.read 方法（两 API 同语义：位置读，返回 bytesRead）。
      const { bytesRead } = await fd.read(buf, 0, want, this.offset);
      this.offset += bytesRead;
      const data = this.leftover + buf.subarray(0, bytesRead).toString("utf8");
      const lines = data.split(/\r?\n/);
      this.leftover = lines.pop() ?? "";
      const claimModel = () => (this.modelClaimed ? false : (this.modelClaimed = true));
      for (const line of lines) parseOutputLine(line, this.id, this.emit, claimModel);
    } finally {
      this.ticking = false;
      if (fd !== undefined) await fd.close();
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

  // ---- 会话级权限规则（内存态，worker 销毁即消失） ----
  // 「允许」文件工具时前端推导的精确文件规则落在这里：policy hook 评估前合并进
  // 快照（session 作用域天然最高优先级），同文件后续调用自动放行。不持久化、
  // 不进 Rust 快照、不随会话 resume 存活——会话停止即清空。
  private sessionRules: PermissionRule[] = [];
  private sessionRuleOrder = 0;

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

  // ---- 输出尾部轮询（per-session，替代模块级全局） ----
  private outputTails = new Map<string, OutputTail>();
  /** 模型切换守卫（PreModelSwitch/PostModelSwitch 一对）：懒建单例，见 makeModelSwitchGuard。 */
  private modelSwitchGuard: ModelSwitchGuard | null = null;
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
        onCommitted: (p) => {
          // requested 是用户命名空间（下拉别名，restoreModel 可恢复）——优先落账；
          // to_model 是 CLI resolved 全名，经 resolveDropdownValue 归一回下拉 value。
          // 账面（currentModel）与回执只在用户显式切换（source='sdk'）时更新/发出：
          // resume/auto 是 CLI 内部动作（恢复会话/自动兜底），发 ok 回执会让前端弹
          // 用户没做的「已切换」提示，且 resolved 全名直写账面会与下拉别名命名空间
          // 混注（同值守卫跨命名空间比较会误吞/漏判）。
          const value = p.requested ?? this.resolveDropdownValue(p.to);
          const display = this.lastModels.find((m) => m.value === value)?.displayName ?? value;
          this.emit({
            type: "model_committed",
            from_model: p.from,
            to_model: p.to,
            requested_model: p.requested,
            source: p.source,
          });
          if (p.source === "sdk") {
            if (value) this.currentModel = value;
            // 回执=事实：成功回执由 model_committed 到达驱动（setModel.then 直发会把
            //「hook 阻塞中/未生效」当成功——设计稿 §3 的回执换轴）
            this.emit({ type: "model_switch_result", ok: true, model: value, display });
          }
        },
      });
    }
    return this.modelSwitchGuard;
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

  /** SDK canUseTool 回调：返回类型对齐 CanUseTool 契约（input/opts 由 SDK 传入）。 */
  private makeCanUseToolCallback(): CanUseTool {
    const permissionCallback = this.permMgr.makeCallback(
      (e) => this.emit(e),
      this.subagentTracker,
    );
    return async (toolName, input, opts) => {
      // btw 支线没有权限弹窗通路(permission_request 会被前端 btw 路由吞掉,
      // 干等 resolve → 永久挂起):落到这里的一律 deny。注意这是兜底死代码——
      // allowDangerouslySkipPermissions 下 CLI 实则不会调 canUseTool(2026-08-09
      // 实测),真正的白名单拦截在 makePolicyHook 的 taskTools defer→deny 分支。
      if (this.btwMode) {
        return {
          behavior: "deny" as const,
          message: "btw 支线无人应答权限请求(仅策略白名单内操作可用)",
        };
      }
      // 自动化运行同理无人应答：policy hook 已对白名单内操作 allow、其余 deny，
      // 能落到这里的都是 hook 未覆盖的边角——一律 deny（绝不 defer 等弹窗）。
      if (this.automationConfig) {
        return {
          behavior: "deny" as const,
          message: "自动化运行无人值守(仅白名单内工具可用)",
        };
      }
      return permissionCallback(toolName, input, opts);
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

  /** 把前端推导的会话级规则草稿入库（随 permission_response 放行原子到达）。
   *  只收 allow；按 (tool, matcher) 去重——同一文件被再次允许时不堆积重复规则。
   *  规则 id 用随机 UUID（无持久化、无跨 worker 语义，无需可读性）。 */
  addSessionRules(drafts: PermissionRuleDraft[]): void {
    for (const d of drafts) {
      if (d.effect !== "allow") continue;
      // 文件工具家族展开：一条精确文件规则 → 家族内每个工具各一条同路径规则。
      // 这样 Write 放行后 Edit/MultiEdit 同文件不再询问，反过来也一样。
      const tools: readonly string[] =
        d.matcher.kind === "path" && d.matcher.file !== undefined &&
        (FILE_FAMILY_TOOLS as readonly string[]).includes(d.tool)
          ? FILE_FAMILY_TOOLS
          : [d.tool];
      for (const tool of tools) {
        const dup = this.sessionRules.some(
          (r) => r.tool === tool && JSON.stringify(r.matcher) === JSON.stringify(d.matcher),
        );
        if (dup) continue;
        this.sessionRules.push({
          id: `session-${randomUUID()}`,
          scope: "session",
          order: this.sessionRuleOrder++,
          effect: d.effect,
          tool,
          matcher: d.matcher,
          source: { label: "session", readOnly: true },
        });
      }
    }
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
      // 轻量 btw 是纯问答:行为层禁掉一切工具(matcher ".*" 覆盖 MCP 工具)。
      // 在请求前缀之外实现——工具列表保持与主会话一致,prompt cache 才能命中;
      // deny 即时返回,也根治了 2026-08-02「模型调 MCP 工具卡住」(不再 tools:[]
      // 之后模型可能尝试调用,但每次都吃到明确 deny,立刻转文字回答)。
      if (this.lightweightMode) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason:
              "轻量支线为纯问答,工具已禁用,请直接根据上下文回答",
          },
        };
      }
      // 自动化运行：三值裁决。MCP 工具按连接器白名单（与预设无关）；内建工具
      // full 预设 allow、auto 预设返回 {} 不表态——交还 CLI auto 模式（安全自动
      // 放行，高危询问 → canUseTool 自动化分支兜底 deny，无人值守没人应答弹窗）。
      if (this.automationConfig) {
        const verdict = automationHookVerdict(toolName, toolInput, this.automationConfig);
        if (verdict === "defer") return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: verdict === "allow" ? ("allow" as const) : ("deny" as const),
            permissionDecisionReason:
              verdict === "allow"
                ? "自动化任务预授权"
                : `连接器未预授权（可用: ${this.automationConfig.mcpAllowlist.join(", ") || "无"}）`,
          },
        };
      }
      // 会话级规则（「允许」文件工具时前端推导）合并进快照再评估——session 作用域
      // 在 SCOPE_PRIORITY 里最高，天然压过持久化规则；无会话规则时零拷贝走原快照。
      const snapshot =
        this.sessionRules.length > 0
          ? { ...this.permissionPolicy, rules: [...this.sessionRules, ...this.permissionPolicy.rules] }
          : this.permissionPolicy;
      const decision = await evaluatePolicy(snapshot, {
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
          // btw 支线没有权限弹窗通路(permission_request 会被前端 btw 路由吞掉,
          // permMgr.request 干等 resolve → 永久挂起)——ask 一律当 deny 处理。
          if (this.btwMode) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  "btw 支线无人应答权限请求(需确认的操作一律拒绝)",
              },
            };
          }
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
                // 用户拒绝附理由：理由作为 hook 原因反馈给模型，模型按理由直接调整，
                // 不用再停下追问一轮。无理由时保持旧缺省文案。
                : (answer.message ?? "User denied Aide policy confirmation"),
              ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
            },
          };
        }
        default:
          // btw 任务支线(git-commit):白名单外的命令必须在这里 deny——defer 会在
          // allowDangerouslySkipPermissions 下被 CLI 静默放行,canUseTool 根本不会被
          // 调用(2026-08-09 运行时任真:ipconfig 在 btw 任务里直接执行,策略日志
          // disposition=defer 之后没有任何 canUseTool 回调)。不加这道 = 支线开 bypass。
          // 问答支线(full btw)保持旧行为:defer → {} → CLI 放行(fork 主会话的
          // 既有语义,政策快照本来也不推给 btw)。
          if (this.taskTools) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  "btw 任务支线仅允许白名单内的命令(git 只读 + add/commit)",
              },
            };
          }
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

  private emitPermissionModes(error?: string): void {
    const modes = PERMISSION_MODES.some((m) => m.value === this.currentPermissionMode)
      ? PERMISSION_MODES
      : [
          ...PERMISSION_MODES,
          {
            value: this.currentPermissionMode,
            displayName: EXTRA_MODE_LABELS[this.currentPermissionMode] ?? this.currentPermissionMode,
          },
        ];
    this.emit({
      type: "permission_modes_available",
      modes,
      current: this.currentPermissionMode,
      ...(error !== undefined ? { error } : {}),
    });
  }

  private applyPermissionMode(mode: string): void {
    if (!PERMISSION_MODES.some((m) => m.value === mode) && !(mode in EXTRA_MODE_LABELS)) return;
    if (mode === this.currentPermissionMode) return;
    const q = this.currentQuery;
    if (q) {
      // mode 已在上方按 PERMISSION_MODES/EXTRA_MODE_LABELS 校验过，断言为 SDK
      // 字面量联合（含 auto/dontAsk 等前端可选项）只表达"校验后必然是合法值"。
      q.setPermissionMode(mode as PermissionMode)
        .then(() => {
          this.currentPermissionMode = mode;
          this.emitPermissionModes();
        })
        .catch((e: unknown) => {
          // setPermissionMode 失败（SDK/CLI 拒绝切换）：模式未生效——回滚广播旧值
          // 并附 error 让前端提示（对齐 effortSwitch.ts:62 失败回执模式）。
          this.emitPermissionModes(`权限模式切换失败：${String((e as Error)?.message ?? e)}`);
        });
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
      // DTO 拍平：categories 只留 name/tokens/isDeferred——SDK 的 color 是 CLI 品牌
      // 色，前端按主题 token 上色，不透传（provider-agnostic，见 types.ts 注释）。
      this.emit({
        type: "context_usage",
        total_tokens: usage.totalTokens,
        max_tokens: usage.maxTokens,
        percentage: usage.percentage,
        raw_max_tokens: usage.rawMaxTokens,
        categories: usage.categories?.map((c) => ({
          name: c.name,
          tokens: c.tokens,
          isDeferred: c.isDeferred,
        })),
      });
    } catch {
      // 拿不到就跳过（旧 CLI/SDK 版本不支持时静默，前端按缺省降级）
    }
  }

  private lastRateLimitAt = 0;
  private async emitRateLimit(q: Awaited<ReturnType<typeof query>>): Promise<void> {
    if (Date.now() - this.lastRateLimitAt < 15_000) return;
    try {
      // 方法在类型上恒存在，但旧 CLI 二进制可能没实现——运行时守卫兜底。
      if (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return;
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
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
        // fire-and-forget：异步读不阻塞事件循环；单条 tail 出错（文件被删/读失败）
        // 不影响其它 tail，下次轮询自动重试。
        void t.tick().catch(() => { /* 单条 tail 出错不影响其它 */ });
      }
    }, 600);
    this.outputTailTimer.unref(); // 不阻止进程自然退出
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
    if (t) {
      // fire-and-forget：异步 finalFlush 不阻塞命令处理；内部吞错，末尾置 stopped。
      // 删除发生在 flush 完成前——tail 对象仍被该 promise 持有，emit 照常生效。
      void t.finalFlush().catch(() => { /* flush 失败（文件已删等）：尾部内容放弃 */ });
      this.bgTaskTails.delete(id);
    }
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
        // fire-and-forget：异步读不阻塞事件循环；单条 tail 出错（文件被删/读失败）
        // 不影响其它 tail，下次轮询自动重试。
        void t.tick().catch(() => { /* 单条 tail 出错不影响其它 */ });
      }
    }, 600);
    this.bgTaskTailTimer.unref(); // 不阻止进程自然退出
  }

  // ================================================================
  // 命令处理（替代原先 index.ts 的 rl.on("line",...)）
  // ================================================================

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
    this.applySendRuntimeConfig(cmd.env);
    if (cmd.auto_title !== undefined) this.autoTitle = cmd.auto_title;
    if (cmd.thinking_enabled !== undefined) this.thinkingEnabled = cmd.thinking_enabled;
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
      this.automationConfig = {
        taskId: cmd.automation.task_id,
        runId: cmd.automation.run_id,
        preset: cmd.automation.preset === "full" ? "full" : "auto",
        tools: cmd.automation.tools ?? ["*"],
        mcpAllowlist: cmd.automation.mcp_allowlist ?? [],
        taskDir: cmd.automation.task_dir ?? "",
        maxTurns: cmd.automation.max_turns,
        maxBudgetUsd: cmd.automation.max_budget_usd,
      };
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

  // ================================================================
  // 主循环
  // ================================================================

  async startLoop(cwd?: string, trusted = true, codegraphEnabled = true): Promise<void> {
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
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
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
          // SDK 0.3.233 起 Todo/task 工具(TaskCreate/TaskGet/TaskUpdate/TaskList/
          // TodoWrite)在新模型(Opus 4.8/Sonnet 5/Fable 5)上不再默认进工具面——Aide
          // 的 TaskListPanel 与轮间 TODO 覆盖逻辑依赖它们，显式 env 保持默认可用。
          // 选 env 而非 query.tools：只恢复这一组的默认地位，不触碰 tools 白名单
          // (btw taskTools/automation 收窄语义不变，白名单没列的照样不注入)。
          cliEnv.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";

          // codegraph agent 工具：默认注册（AIDE_CODEGRAPH_TOOLS=off 关闭）。
          // handler 闭包持有本会话的 emit（经 DeltaCoalescer，红线）与 cwd。
          // btw 任务支线(taskTools,全新会话)跳过:任务用不上代码索引,前缀最小化。
          // 轻量 btw 不再跳过——问答支线要保持与主会话请求前缀逐字节一致,
          // 少注册 MCP 工具 = 工具列表不同 = prompt cache 必崩(2026-08-09 实锤);
          // 模型误调由 policy hook 的轻量全 deny 兜底,不会卡。
          // 挂载还随工作区索引开关（codegraph_enabled，主进程下发，每工作区默认关）。
          const effectiveCwd = cwd ?? this.cwd ?? "";
          const codegraphMcp = this.taskTools
            ? null
            : codegraphMcpRegistration(
                effectiveCwd,
                (e) => this.emit(e),
                process.env,
                trusted,
                codegraphEnabled,
              );
          // 文档工具(docx + pdf):注册条件=任务支线跳过、!trusted 跳过、AIDE_DOCX_TOOLS=off
          // 跳过——**不跟随 codegraph_enabled**（docx/pdf 不扫盘不建索引，见 docsMcp.ts）。
          // 无 emit 参数——docx/pdf 一次性同步解析,不像 codegraph 要 IPC 客户端。
          const docsMcp = this.taskTools
            ? null
            : docsMcpRegistration(effectiveCwd, process.env, trusted);

          // pendingFork 只服务「供应商切换」通知——自动化蒸馏轮也 fork（隔离
          // 运行会话 id），但那是内部机制，不该冒出「已切换供应商」提示。
          if (this.resumeSource && this.shouldForkNextConnect && !this.btwMode && !this.automationConfig) {
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
          // 内建 hooks 统一走 builtinHooks 注册表：policy 恒为 PreToolUse[0]
          // （权威前置层，用户 hook 不可越过），subagentModel/skillGuard
          // 按条件挂载。builtinHookManifest 经清单通道回传前端（Task 3 接线）。
          const { hooks: builtinHooks, manifest: builtinHookManifest } = buildBuiltinHooks({
            cwd: effectiveCwd,
            env: process.env,
            // makePolicyHook/makeStopEffortHook 是 private 方法：直接传 this 会被
            // private 成员的名义类型规则挡掉，这里经闭包适配成最小接口（见
            // builtinHooks/index.ts 的 HookBuildContext.session）。
            session: {
              makePolicyHook: (cwd) => this.makePolicyHook(cwd),
              makeStopEffortHook: () => this.makeStopEffortHook(),
              makeModelSwitchGuard: () => this.makeModelSwitchGuard(),
            },
          });
          // 用户扩展（settings.json 的 mcpServers/hooks）：mcpServers 与 codegraph 按
          // name 共存；hooks 内建在前、用户追加（内建 policy 恒为 PreToolUse[0]，不可越过）。
          const userMcp = loadUserMcpServers();
          const userHooks = loadUserHooks();

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
            options: {
              abortController: this.abortController,
              // currentPermissionMode 在 applyPermissionMode 里按白名单校验后才写，
              // 断言为 SDK 字面量联合（含 auto/dontAsk）只表达"必然是合法值"。
              permissionMode: this.currentPermissionMode as PermissionMode,
              allowDangerouslySkipPermissions: true,
              canUseTool: this.makeCanUseToolCallback(),
              settingSources: [],
              // 受限模式（!trusted）：strictMcpConfig 忽略项目 .mcp.json 等外部 MCP 配置；
              // buildDispatchPluginsOption 不注入项目级散装 plugin（项目 skills/agents
              // 不进 agent）。user 级不受影响。
              ...(trusted ? {} : { strictMcpConfig: true }),
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: instructions,
              },
              // allowedTools 统一:问答支线(轻量/完整)与主会话同形,保持前缀一致;
              // btw 任务支线由 btwQueryOverrides 在后方覆盖成白名单。
              allowedTools: ["Agent", "Task", CODEGRAPH_ALLOW_RULE, DOCS_ALLOW_RULE],
              // btw 任务支线:skills/plugins 全关——全新会话没有缓存可吃,
              // 前缀最小化(skill 清单/plugin 自带 MCP 工具都不进上下文)。
              // 轻量 btw 保持 "all"/全量:与主会话前缀对齐吃 prompt cache。
              // 自动化运行同理全关：每次都是全新会话，精简基座 = 省钱 + 行为确定。
              skills: this.taskTools || this.automationConfig ? [] : "all",
              plugins: this.taskTools || this.automationConfig
                ? []
                : [...buildPluginsOption(), ...buildDispatchPluginsOption(effectiveCwd, trusted, this.lightweightMode)],
              hooks: assembleHooks(builtinHooks, userHooks),
              // 自动化：未预授权的连接器（MCP server）不挂载——其工具对模型根本
              // 不存在（第一层收口）；policy hook 白名单裁决是第二层。
              mcpServers: this.automationConfig
                ? filterMcpServers(
                    assembleMcpServers({ ...(codegraphMcp ?? {}), ...(docsMcp ?? {}) }, userMcp),
                    this.automationConfig.mcpAllowlist,
                  )
                : assembleMcpServers({ ...(codegraphMcp ?? {}), ...(docsMcp ?? {}) }, userMcp),
              // 主会话开 partial：让 thinking_delta 逐字流式（mapper 只放 thinking_delta，
              // text 仍走整块，避开历史 partial 卡死坑，见 2026-08-07-thinking-streaming-design）。
              // btw 轻量支线保持 partial=off（mapper 的子代理隔离守卫也对 btw 生效）。
              includePartialMessages: !this.btwMode && !this.automationConfig,
              ...(this.currentModel ? { model: this.currentModel } : {}),
              // effort 的 spawn 通道（会话中切换走 set_effort → applyFlagSettings）。
              ...(this.currentEffort ? { effort: this.currentEffort as EffortLevel } : {}),
              // 请求可读思考文本：Claude 官方模型 thinking.display 默认 omitted（block
              // 在但 text 空），显式 summarized 才回可读摘要。GLM 等第三方不一定认此
              // 参数但无害——主线程思考展示的兜底保险（诊断见 docs/mockups/）。
              // 思考开关（send.thinking_enabled 下发，「设置→通用」）：请求层只在这里
              // spawn 时生效——官方 API 关思考靠这里（请求体无 thinking 字段）；ollama
              // 等兼容端点不认 thinking 参数（无字段=模型自决，推理模型必出思考块，
              // 2026-08-21 mock 端点实锤），API 层关不掉，靠下方 mapSdkMessage 的
              // showThinking 展示层剥除兜底。btw 支线恒 disabled（轻量问答省 token）；
              // 与 effort 解耦（2026-08-21 决策：effort 切换不再联动 thinking）。
              thinking: this.btwMode || this.automationConfig
                ? { type: "disabled" }
                : this.thinkingEnabled
                  ? { type: "adaptive", display: "summarized" }
                  : { type: "disabled" },
              ...(cwd ? { cwd } : {}),
              ...(this.cwd && !cwd ? { cwd: this.cwd } : {}),
              ...(resolveClaudeExe()
                ? { pathToClaudeCodeExecutable: resolveClaudeExe() }
                : {}),
              ...forkResumeOptions(this.resumeSource ?? "", this.shouldForkNextConnect),
              // 任务支线(tools 白名单)在此覆盖前面的统一 allowedTools;问答支线
              // 只带 persistSession:false,不碰工具列表(缓存前缀红线)。
              ...btwQueryOverrides(this.btwMode, this.taskTools),
              // 自动化:tools 收成白名单 + maxTurns/maxBudgetUsd 护栏透传。
              ...automationQueryOverrides(this.automationConfig),
              env: cliEnv,
            },
          });
          this.currentQuery = q;
          this.shouldForkNextConnect = false;
          // 内建 hook 清单回传前端（扩展设置页 hook 列表用；Task 10 消费，重复 emit 幂等）。
          this.emit({ type: "builtin_hooks_manifest", manifest: builtinHookManifest });

          for await (const msg of q) {
            // 图片 400 回滚：模型不支持图片时，历史里带图消息重放必 400（会话报废）。
            // 检测到即 abort 杀 CLI（停一切写入），catch 里执行回滚（去图重写历史），
            // 下一轮 query 重放干净历史。btw 是一次性支线（400 后自毁），无需回滚。
            if (!this.btwMode && detectImageUnsupported(msg)) {
              this.rollbackPending = true;
              this.abortController?.abort();
            }
            if (msg.type === "result") {
              this.turnActive = false;
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
              msg.type === "assistant" &&
              !msg.parent_tool_use_id
            ) {
              // assistant content 可能是字符串（罕见），Array.isArray 防御后再扫块
              const blocks = msg.message?.content;
              if (
                Array.isArray(blocks) &&
                blocks.some((b) => b.type === "tool_use" && b.name === "EnterPlanMode")
              ) {
                this.applyPermissionMode("plan");
              }
            }

            mapSdkMessage(
              msg,
              (e) => this.emit(e),
              {
                tasks: this.taskTracker,
                subagents: this.subagentTracker,
                tools: this.toolLifecycle,
                resolveModelLabel: (m) => this.resolveDropdownValue(m),
                outputTailHooks: {
                  start: (id, outputFile, _emit, _onStop) => {
                    // SessionWorker 的 emit 已绑定到实例，忽略传入的 emit/onStop
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
              },
            );

            if (this.jumpQueueCtl.has() && this.toolLifecycle.isIdle()) {
              // interrupt 拒绝 = 无在跑回合（首条消息后插队）——契约性吞掉。
              this.currentQuery?.interrupt().catch(() => {});
            }

            if (msg.type === "system" && msg.subtype === "init") {
              const newSid = msg.session_id;
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
            } else if (
              msg.type === "assistant" &&
              !msg.parent_tool_use_id &&
              isAdoptableAssistantModel(msg) &&
              msg.message.model !== this.lastConcreteModel
            ) {
              this.lastConcreteModel = msg.message.model;
              this.currentModel = this.resolveDropdownValue(this.lastConcreteModel);
              if (this.lastModels.length > 0) {
                this.emit({ type: "models_available", models: this.lastModels, current: this.currentModel });
              }
            } else if (msg.type === "result") {
              this.toolLifecycle.reset();
              void this.emitContextUsage(q);
              void this.emitRateLimit(q);
              // btw/自动化都是一次性会话：回合结束即自毁释放 claude.exe。streaming-input
              // 的 query 不主动关会连进程一起永远挂着——CLI 的 pid 元数据留在
              // ~/.aide/claude/sessions/ 被 list_sessions 扫成侧栏幽灵空会话，
              // 且每条 btw 白占几百 MB（2026-08-02 实锤 pid 9464 挂 12min+）。
              // message_stop 已在本轮迭代经 mapSdkMessage 发出；setImmediate
              // 推迟到迭代体外，避免在 for-await 迭代中 close 自己。
              // （result 成功与错误子类型都走到这里，两条路都自毁。）
              if (this.btwMode || this.automationConfig) setImmediate(() => this.selfTeardown());
            }
          }
          // for await 正常结束（queue closed）
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
            await this.performImageRollback();
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
      this.currentQuery = null;
    }
  }

  // ================================================================
  // 图片 400 回滚
  // ================================================================

  /** 场景 B 自动继续的注入消息：CLI resume 会话后必须收到输入才会重放历史
   *  （2026-08-21 实锤：resume 无输入 → CLI 0 事件直接退出）。注入这条 user
   *  消息触发 CLI 重放历史（含错误文本 tool_result）→ 模型自行判断下一步：
   *  能读就读，不能读就自然告知用户跳过。措辞刻意不预设"有文本可读"
   *  （图片可能是纯视觉内容，OCR 无效），并引导模型回复时别复述技术细节
   *  （"模型不支持图片输入"这类内部错误，用户看到会一头雾水）。该消息只进
   *  会话 jsonl，SDK 事件流不回显 user 消息，前端不会出现多余气泡。 */
  private static readonly ROLLBACK_TOOL_CONTINUE =
    "请继续处理用户的问题。刚才读取图片文件未获得可用内容，请忽略该次操作。" +
    "若该文件内容确实无法读取，可自然地向用户说明无法查看该文件并继续，不要提及任何技术细节。";

  /** 从 SDK 会话历史移除带图消息（含 synthetic 400 行），让下一轮 query 重放干净历史。
   *  调用时机：abort 之后（CLI 已退出，文件不再被写）。失败静默——会话保持现状，
   *  至少不 crash。 */
  private async performImageRollback(): Promise<void> {
    try {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const sid = this.resumeSource;
      if (!configDir || !sid) return;
      const jsonl = findSessionJsonl(join(configDir, "projects"), sid);
      if (!jsonl) return;
      const result = rollbackImageMessage(jsonl);
      if (result.removed) {
        this.emit({ type: "image_input_rollback", text: result.text });
        if (result.kind === "tool") {
          // 场景 B（模型 Read 图片）：回滚只替换了 tool_result，模型还没回复——
          // resume 后 CLI 等输入，不注入消息模型不会自动继续。注入后 CLI 重放
          // 历史（含错误文本 tool_result）→ 模型改读文本/跳过。
          // 注意：不能 queue.push——旧迭代器挂起的 resolveNext 会把消息吞掉
          // （见 rollbackInjection 字段注释），必须预置到下一轮私有迭代器。
          this.rollbackInjection = {
            type: "user",
            message: buildUserMessage(SessionWorker.ROLLBACK_TOOL_CONTINUE, []),
            parent_tool_use_id: null,
          };
        }
      }
    } catch {
      // 回滚失败（文件占用等）：会话保持现状，至少不 crash
    }
  }

  // ================================================================
  // 会话自动命名
  // ================================================================

  /** 用首条用户消息的内容截取会话标题（见 titleGenerator.ts）。本地纯截取——
   *  不调模型、零延迟，send 时同步发出 session_title。内容为空白时
   *  titleFromContent 返回 null，这里就不发事件，会话保留默认名。 */
  private emitSessionTitle(userText: string): void {
    if (this.titleAttempted) return;
    this.titleAttempted = true;
    const title = titleFromContent(userText);
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
    return this.queue.size;
  }

  /** 测试用：会话级规则条数（验证去重不堆积）。 */
  _testSessionRuleCount(): number {
    return this.sessionRules.length;
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
    removeSessionRegistryEntryFromEnv(process.env, this.routingKey);
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
