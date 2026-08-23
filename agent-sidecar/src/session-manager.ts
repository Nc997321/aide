import type { ChatEvent, SidecarCommand } from "./types.js";
import { SessionWorker } from "./session-worker.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCodegraphResult } from "./codegraphClient.js";
import { isDroppableEvent, writeStdoutFrame } from "./stdoutFrames.js";

export interface SessionManagerOptions {
  /** 测试缝：覆盖 stdout 写入；生产省略则 JSONL 写 process.stdout。 */
  emit?: (sessionId: string, event: ChatEvent) => void;
}

/**
 * Agent Runtime 的会话管理器。
 *
 * 拥有 Map<session_id, SessionWorker>，负责：
 * 1. stdin 命令按 session_id 路由到对应 SessionWorker
 * 2. 统一 stdout 输出（注入 session_id）
 * 3. 会话生命周期：创建 / 停止 / 崩溃清理
 * 4. 顶层诊断（遍历所有 worker 聚合健康信息）
 */
export class SessionManager {
  private workers = new Map<string, SessionWorker>();
  private readonly outputOverride?: (sessionId: string, event: ChatEvent) => void;

  constructor(opts: SessionManagerOptions = {}) {
    this.outputOverride = opts.emit;
  }

  // ---- stdout 输出 ----

  /** 把事件序列化并写入 stdout。注入 session_id 让 Rust 侧 route 到前端。
   *
   * session_init 特判：SDK 给的 event.session_id 是真实会话 ID，路由键在
   * _routing_id——Rust 据此把 session_id 重写回路由键、真 ID 放 sdk_session_id
   * （btw 的 isBtwSid 靠 session_id=路由键命中，再从 sdk_session_id 取真 ID）。
   * 其他事件 session_id 即路由键，直接注入。
   *
   * 注意：调用方传入的 sessionId 必须是 worker 当前的 routingKey——re-key 后
   * 自动跟着变（见 getOrCreate 的 emit 闭包，读 worker.routingKey）。
   */
  emitToStdout(sessionId: string, event: ChatEvent): void {
    if (this.outputOverride) {
      this.outputOverride(sessionId, event);
      return;
    }

    const out = { ...event } as Record<string, unknown>;
    if (event.type === "session_init") {
      // SDK 已设 session_id = 真实会话 ID，不能覆盖。路由键单独传。
      out._routing_id = sessionId;
    } else {
      out.session_id = sessionId;
    }
    // 背压检测在最后一层做：write 返回 false = 内核缓冲满 → 增量帧丢弃、熔断超时
    // 兜底（见 stdoutFrames.ts）。sessionId 随帧带给通知回调，error 帧可带会话上下文。
    writeStdoutFrame(JSON.stringify(out) + "\n", isDroppableEvent(event), sessionId);
  }

  // ---- 命令路由 ----

  /**
   * 顶层入口：收到 Rust 发来的一条 JSON 命令，按 cmd.session_id 路由。
   *
   * 命令类型：
   * - send：有 session_id 则路由到已有 worker；无则新建 worker（temp id）
   * - permission_response / interrupt / set_model / set_permission_mode：按 session_id 路由
   * - session_stop：停止并移除 worker
   */
  handleCommand(cmd: SidecarCommand): void {
    // codegraph MCP 工具的 Rust 回包：按 request_id 结算挂起查询，无会话路由。
    if (cmd.cmd === "codegraph_result") {
      resolveCodegraphResult(cmd);
      return;
    }

    // session_stop 特殊处理：不需要 getOrCreate，直接查已有 worker 停止
    if (cmd.cmd === "session_stop") {
      this.stopSession(cmd.session_id);
      return;
    }

    const sid = cmd.session_id;

    if (cmd.cmd === "send") {
      // send 可能没有预先存在的 worker（新会话）
      const worker = this.getOrCreate(sid, cmd);
      worker.handleCommand(cmd);
    } else {
      // 所有其他命令必须有 session_id
      if (!sid) {
        // 兼容：无 session_id 时丢弃（旧版命令格式）
        return;
      }
      const worker = this.workers.get(sid);
      if (!worker) {
        // 命令到达但 worker 不存在（已停止或从未创建）：静默丢弃
        return;
      }
      worker.handleCommand(cmd);
    }
  }

  // ---- 会话生命周期 ----

  /** 获取已有 worker 或为 send 命令创建新 worker。 */
  private getOrCreate(sid: string | undefined, cmd: SidecarCommand & { cmd: "send" }): SessionWorker {
    if (sid && this.workers.has(sid)) {
      // has(sid) 已确认在表内——get 必非空，契约注释，勿删 !。
      return this.workers.get(sid)!;
    }

    // 新建 SessionWorker
    const sessionId = sid ?? `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let worker: SessionWorker;
    const emit = (event: ChatEvent) => {
      // 读 worker.routingKey 而非捕获固定 sessionId——re-key 后事件自动带新 key
      this.emitToStdout(worker.routingKey, event);
      // session_init：SDK 确认真实会话 ID，把 worker 从 tempId 原子迁移到 realId，
      // 与前端 finalizeSession 切到 realId 对齐。否则第二条消息带 realId 进来
      // getOrCreate 找不到 worker、新建一个全新 SDK 会话，上一轮上下文全丢。
      if (event.type === "session_init") {
        const realId = (event as { session_id?: string }).session_id;
        if (realId && realId !== worker.routingKey) {
          this.rekeyWorker(worker, worker.routingKey, realId);
        }
      }
    };
    worker = new SessionWorker(sessionId, emit, {
      cwd: cmd.cwd,
      btwMode: !!cmd.btw,
      lightweightMode: !!cmd.lightweight,
      envOverrides: cmd.env ?? {},
      // btw 回合结束自毁：按当前 routingKey 摘除（可能已 re-key 成真实会话 ID）。
      onSelfStop: (w) => {
        this.workers.delete(w.routingKey);
      },
    });

    this.workers.set(sessionId, worker);
    return worker;
  }

  /** 原子 re-key：从 Map 删旧 key、改 worker.routingKey、写新 key。 */
  private rekeyWorker(worker: SessionWorker, oldKey: string, newKey: string): void {
    this.workers.delete(oldKey);
    worker.routingKey = newKey;
    this.workers.set(newKey, worker);
  }

  /** 测试专用：通过 getOrCreate 建 worker 但不调 handleCommand（不 startLoop、
   *  不 spawn claude.exe）。返回带 re-key emit 闭包的 worker，供测试 emit session_init。
   *  生产代码不调用。 */
  __testCreateWorker(tempId: string): SessionWorker {
    return this.getOrCreate(tempId, {
      cmd: "send",
      session_id: tempId,
      prompt: "",
      cwd: "/tmp",
      env: {},
    } as SidecarCommand & { cmd: "send" });
  }

  /** 停止一个会话：关闭 query，释放 claude.exe，从注册表移除。 */
  stopSession(sessionId: string): void {
    const worker = this.workers.get(sessionId);
    if (worker) {
      worker.stop();
      this.workers.delete(sessionId);
    }
  }

  // ---- 诊断 ----

  /** 获取所有 worker（用于健康聚合）。 */
  getAllWorkers(): ReadonlyMap<string, SessionWorker> {
    return this.workers;
  }

  /** 获取活跃 worker 数（有 query 在跑）。 */
  activeCount(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.isActive()) count++;
    }
    return count;
  }

  // ---- 健康定时器 ----

  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** 启动定时健康检查：每 30s emit 一次 health 事件给前端仪表盘。 */
  startHealthTimer(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      const workers = Array.from(this.workers.values());
      const active = workers.filter(w => w.isActive()).length;
      const idle = workers.length - active;

      this.emitToStdout("_runtime", {
        type: "health",
        sessions: { active, idle, stalled: 0, total: workers.length },
        processes: { claudeExeCount: active },
        timestamp: Date.now(),
      });
    }, 30_000);
    this.healthTimer?.unref(); // 不阻止进程自然退出
  }

  // ---- 关闭 ----

  /** 关闭所有会话并清理资源。Rust kill runtime 时调用。 */
  shutdown(): void {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    for (const [sid, worker] of this.workers) {
      try { worker.stop(); } catch { /* 吞错：确保所有 worker 都遍历到 */ }
    }
    this.workers.clear();
  }
}
