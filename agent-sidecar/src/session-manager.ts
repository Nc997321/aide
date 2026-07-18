import type { ChatEvent, SidecarCommand } from "./types.js";
import { SessionWorker } from "./session-worker.js";

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

  // ---- stdout 输出 ----

  /** 把事件序列化并写入 stdout。注入 session_id 让 Rust 侧 route 到前端。
   *
   * 关键：session_init 事件的 session_id 是 SDK 返回的真实会话 ID——
   * 前端 finalizeSession 靠它把临时 key 换成真 ID。这里不能覆盖，否则前端
   * 拿到的是路由键、永远找不到真 ID，发第二条消息时还在用临时 key、找不到 worker。
   */
  emitToStdout(sessionId: string, event: ChatEvent): void {
    const out = { ...event } as Record<string, unknown>;
    if (event.type === "session_init") {
      // SDK 已设 session_id = 真实会话 ID，不能覆盖。路由键单独传。
      out._routing_id = sessionId;
    } else {
      out.session_id = sessionId;
    }
    process.stdout.write(JSON.stringify(out) + "\n");
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
    // session_stop 特殊处理：不需要 getOrCreate，直接查已有 worker 停止
    if (cmd.cmd === "session_stop") {
      this.stopSession(cmd.session_id);
      return;
    }

    const sid = (cmd as any).session_id as string | undefined;

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
      return this.workers.get(sid)!;
    }

    // 新建 SessionWorker
    const sessionId = sid ?? `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = new SessionWorker(sessionId, (event) => {
      this.emitToStdout(sessionId, event);
    }, {
      cwd: cmd.cwd,
      btwMode: !!(cmd as any).btw,
      lightweightMode: !!(cmd as any).lightweight,
      envOverrides: (cmd as any).env ?? {},
    });

    this.workers.set(sessionId, worker);
    return worker;
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
      const stalled = workers.filter(w => !w.isActive() && w.isStalled()).length;
      const idle = workers.length - active - stalled;

      this.emitToStdout("_runtime", {
        type: "health",
        sessions: { active, idle, stalled: Math.max(0, stalled), total: workers.length },
        processes: { claudeExeCount: active },
        timestamp: Date.now(),
      });
    }, 30_000);
    if (typeof (this.healthTimer as any).unref === "function") {
      (this.healthTimer as any).unref(); // 不阻止进程自然退出
    }
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
