import type { ChatEvent, ModelOption, PermissionModeOption, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import { JumpQueueController } from "./jumpQueue.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";
import { applyModelSwitch } from "./modelSwitch.js";
import { cliSubagentModelEnvValue, makeSubagentModelHook } from "./subagentModelDefault.js";
import {
  mapSdkMessage,
  buildUserMessage,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
  emitSubagentBlocks,
} from "./mapper.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { readFileSync } from "node:fs";

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
  { value: "acceptEdits", displayName: "自动接受编辑" },
  { value: "plan", displayName: "Plan 模式" },
  { value: "auto", displayName: "Auto：模型自动判断" },
  { value: "bypassPermissions", displayName: "跳过所有确认（危险）" },
];

const EXTRA_MODE_LABELS: Record<string, string> = {
  dontAsk: "本次会话不再询问",
};

/** 卡死判定的纯逻辑——抽出可单测，不依赖 Date.now() / 私有 currentQuery。
 *  hasQuery: 是否有 SDK query 在跑；lastMessageAt/now: 毫秒时间戳。 */
export function isStalledRelativeTo(
  lastMessageAt: number,
  now: number,
  hasQuery: boolean,
): boolean {
  if (!hasQuery) return false;
  return now - lastMessageAt > 90_000;
}

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
    private readonly onStop: (id: string) => void,
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
  sessionId?: string; // fork 源
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
  readonly taskTracker = new TaskTracker();
  readonly subagentTracker = new SubagentTracker();
  readonly toolLifecycle = new ToolLifecycleTracker();
  readonly jumpQueueCtl = new JumpQueueController();
  readonly coalescer: DeltaCoalescer;

  // ---- SDK 查询状态 ----
  private currentQuery: Awaited<ReturnType<typeof query>> | null = null;
  private currentModel = process.env.ANTHROPIC_MODEL ?? "";
  private lastConcreteModel = "";
  private lastModels: ModelOption[] = [];
  private aliasByResolvedPrefix: { value: string; resolvedPrefix: string }[] = [];
  private currentPermissionMode = "default";
  private pendingFork = false;
  private shouldForkNextConnect = false;
  private turnActive = false;
  private stopped = false;

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

  // ---- 注入的 stdout 输出回调 ----
  private readonly emitToStdout: (event: ChatEvent) => void;

  constructor(
    routingId: string,
    emitToStdout: (event: ChatEvent) => void,
    opts: SessionWorkerOptions = {},
  ) {
    this.emitToStdout = emitToStdout;
    this.routingKey = routingId;
    this.btwMode = opts.btwMode ?? false;
    this.lightweightMode = opts.lightweightMode ?? false;
    this.cwd = opts.cwd;
    this.envOverrides = opts.envOverrides ?? {};

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
    this.coalescer.push(event);
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

  startOutputTail(id: string, outputFile: string, onStop: (id: string) => void): void {
    if (this.outputTails.has(id)) return;
    this.outputTails.set(id, new OutputTail(id, outputFile, (e) => this.emit(e), onStop));
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
  // 命令处理（替代原先 index.ts 的 rl.on("line",...)）
  // ================================================================

  handleCommand(cmd: SidecarCommand): void {
    if (cmd.cmd === "send") {
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
        this.startLoop(cmd.cwd ?? this.cwd);
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
          permissionMode: cmd.permission_mode,
        });
        if (this.toolLifecycle.isIdle()) {
          this.currentQuery.interrupt().catch(() => {});
        }
        return;
      }

      // 普通续发
      if (cmd.permission_mode) this.applyPermissionMode(cmd.permission_mode);
      this.queue.push({
        type: "user",
        message: buildUserMessage(cmd.prompt, cmd.images ?? []),
        parent_tool_use_id: null,
      } as any);
      this.turnActive = true;

    } else if (cmd.cmd === "permission_response") {
      const outcome = this.permMgr.resolve(cmd.id, cmd.approved, cmd.always, cmd.answers);
      if (outcome?.appliedMode) {
        this.currentPermissionMode = outcome.appliedMode;
        this.emitPermissionModes();
      } else if (cmd.approved && outcome?.toolName === "ExitPlanMode") {
        this.applyPermissionMode(cmd.nextMode || "default");
      }

    } else if (cmd.cmd === "interrupt") {
      this.currentQuery?.interrupt().catch(() => {});

    } else if (cmd.cmd === "set_permission_mode") {
      this.applyPermissionMode(cmd.mode);

    } else if (cmd.cmd === "set_model") {
      applyModelSwitch({
        model: cmd.model,
        query: this.currentQuery,
        models: this.lastModels,
        currentModel: this.currentModel,
        emit: (e) => this.emit(e),
        commit: (m) => { this.currentModel = m; },
      });
    }
  }

  // ================================================================
  // 主循环
  // ================================================================

  async startLoop(cwd?: string): Promise<void> {
    try {
      while (!this.stopped) {
        try {
          // 构造显式 env 传给 CLI subprocess
          const cliEnv: Record<string, string | undefined> = { ...process.env };
          for (const k of [
            "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_EFFORT_LEVEL",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
          ]) {
            if (process.env[k]) cliEnv[k] = process.env[k];
          }
          // per-session env 覆盖（provider 连接参数）
          for (const [k, v] of Object.entries(this.envOverrides)) {
            if (v) cliEnv[k] = v;
          }
          cliEnv.CLAUDE_CODE_SUBAGENT_MODEL = cliSubagentModelEnvValue(process.env);

          const subagentModelHook = makeSubagentModelHook(process.env);

          if (this.resumeSource && this.shouldForkNextConnect && !this.btwMode) {
            this.pendingFork = true;
          }

          const q = query({
            prompt: this.queue[Symbol.asyncIterator](),
            options: {
              permissionMode: this.currentPermissionMode as any,
              allowDangerouslySkipPermissions: true,
              canUseTool: this.permMgr.makeCallback(
                (e) => this.emit(e),
                this.subagentTracker,
              ) as any,
              settingSources: ["project", "user"],
              ...(this.lightweightMode
                ? { allowedTools: [] as string[] }
                : { allowedTools: ["Agent", "Task"] }),
              skills: "all",
              plugins: buildPluginsOption(),
              ...(subagentModelHook
                ? {
                    hooks: {
                      PreToolUse: [{ matcher: "^(Agent|Task)$", hooks: [subagentModelHook] }],
                    },
                  }
                : {}),
              includePartialMessages: false,
              ...(this.currentModel ? { model: this.currentModel } : {}),
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
            this.lastSdkMessageAt = Date.now();
            if ((msg as any).type === "result") {
              this.turnActive = false;
              const jump = this.jumpQueueCtl.take();
              if (jump) {
                this.toolLifecycle.reset();
                if (jump.permissionMode) this.applyPermissionMode(jump.permissionMode);
                this.queue.push({
                  type: "user",
                  message: buildUserMessage(jump.prompt, jump.images ?? []),
                  parent_tool_use_id: null,
                } as any);
                this.turnActive = true;
                void this.emitContextUsage(q);
                void this.emitRateLimit(q);
                continue;
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
                  // SessionWorker 的 emit 已绑定到实例，忽略传入的 emit
                  this.startOutputTail(id, outputFile, (_onStopId) => {});
                },
                stop: (id) => this.stopOutputTail(id),
              },
            );

            if (this.jumpQueueCtl.has() && this.toolLifecycle.isIdle()) {
              this.currentQuery?.interrupt().catch(() => {});
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
          const jump = this.jumpQueueCtl.take();
          if (jump) {
            if (jump.permissionMode) this.applyPermissionMode(jump.permissionMode);
            this.queue.push({
              type: "user",
              message: buildUserMessage(jump.prompt, jump.images ?? []),
              parent_tool_use_id: null,
            } as any);
            this.turnActive = true;
          }
        }
      }
    } finally {
      this.currentQuery = null;
    }
  }

  // ================================================================
  // 生命周期
  // ================================================================

  /** 活跃状态：有 query 在跑 */
  isActive(): boolean {
    return this.currentQuery !== null && this.turnActive;
  }

  /** 卡死检测：上次 SDK 消息距今超过 90s */
  private lastSdkMessageAt = Date.now();
  isStalled(): boolean {
    return isStalledRelativeTo(this.lastSdkMessageAt, Date.now(), this.currentQuery !== null);
  }

  /** 测试用：暴露 fork 源（SDK resume 的会话 ID）和 fork 标记。 */
  _testForkState(): { forkSource: string; shouldFork: boolean } {
    return { forkSource: this.resumeSource, shouldFork: this.shouldForkNextConnect };
  }

  /** 测试用：暴露 stopped 标志（验证 stop() 设了标志，startLoop 会退出）。 */
  _testIsStopped(): boolean {
    return this.stopped;
  }

  /** 停止会话：关闭 query，释放 claude.exe，清理资源 */
  stop(): void {
    this.stopped = true;
    this.currentQuery?.close?.();
    this.currentQuery = null;
    this.queue.close();
    this.stopAllOutputTails();
  }
}
