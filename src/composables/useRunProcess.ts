import { ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { useWorkbenchTerminal } from "./useWorkbenchTerminal";
import { useWorkspaces } from "./useWorkspaces";
import { markRunRestarting, markRunRestarted, isRunRestarting } from "./workbenchTerminalState";
import type { RunConfig } from "../types";

export type RunStatus = "idle" | "running" | "stopped" | "crashed";

// 每配置独立运行状态——支持同时启动多个模块。键 = RunConfig.id，值 = 该配置
// 对应 run 进程的当前状态。run 进程的 session_id 是确定性的 `run__{config_id}`
//（见 run_process.rs::run_session_id），故 pty-exit 可直接从 session_id 反查回
// configId 回填状态，无需单例 activeSessionId / runningConfigId（那是「同时只能
// 跑一个」的假设，会堵死多模块并行——启动 B 不应停掉 A）。终端层本就是多 tab
// 的（每个 run__{id} 独立 session + 独立 tab），这里把状态层也对齐成多实例。
const runStates = ref<Record<string, RunStatus>>({});
let unlistenExit: UnlistenFn | null = null;

function sessionOf(configId: string): string {
  return `run__${configId}`;
}

function setStatus(configId: string, s: RunStatus): void {
  // 整体替换对象确保新增键也触发响应式（computed 读 runStates.value[id] 会重算）。
  runStates.value = { ...runStates.value, [configId]: s };
}

async function ensureExitListener(): Promise<void> {
  if (unlistenExit) return;
  unlistenExit = await listen<string>("pty-exit", (event) => {
    try {
      const p = JSON.parse(event.payload) as { session_id: string; success?: boolean };
      const sid = p.session_id;
      if (!sid.startsWith("run__")) return;          // 非 run 进程（shell tab 等）忽略
      const configId = sid.slice(5);                  // 确定性 session_id → configId
      // run 重启中：被 kill 的老进程发的 pty-exit 与新进程共用同一 session_id，
      // 跳过这条陈旧退出（否则把刚重启的进程误判为已退出）。新进程的退出会另发一条。
      if (isRunRestarting(sid)) return;
      setStatus(configId, p.success ? "stopped" : "crashed");
    } catch (_) { /* ignore malformed events */ }
  });
}

export function useRunProcess() {
  const wb = useWorkbenchTerminal();
  const { activeKey } = useWorkspaces();
  function currentWs(): string { return activeKey.value ?? ""; }

  /** 启动指定配置的 run 进程。不触碰其他在跑的配置——多模块可并行。 */
  async function start(config: RunConfig): Promise<void> {
    await ensureExitListener();
    const sessionId = await api.runProcessStart(config.id, config.cwd, config.command, config.env ?? {});
    setStatus(config.id, "running");
    // 打开 workbench 并为这个 PTY 挂一个独立终端 tab（每个 run__{id} 一个 tab）
    wb.visible.value = true;
    await new Promise<void>(r => setTimeout(r, 80));
    wb.attachSession(currentWs(), sessionId, config.name);
  }

  /** 停止指定配置的 run 进程（仅这一个，不影响其他并行模块）。状态由 pty-exit 异步回填。 */
  async function stop(configId: string): Promise<void> {
    await api.runProcessStop(configId).catch(() => {});
  }

  /** 重启指定配置：kill 老进程 → 复用同一 session_id 起新进程。重启守卫防止老
   *  进程的 pty-exit 把新进程误判为已退出（与 useWorkbenchTerminal 共用 per-session
   *  守卫 markRunRestarting/isRunRestarting）。 */
  async function restart(config: RunConfig): Promise<void> {
    const sid = sessionOf(config.id);
    markRunRestarting(sid);
    try {
      await api.runProcessStop(config.id).catch(() => {});
      // 短暂停顿让老 PTY 冲刷尾部输出后再以同一 id 重开
      await new Promise<void>(r => setTimeout(r, 150));
      const sessionId = await api.runProcessStart(config.id, config.cwd, config.command, config.env ?? {});
      setStatus(config.id, "running");
      wb.visible.value = true;
      wb.attachSession(currentWs(), sessionId, config.name, true /* clearFirst */);
    } finally {
      markRunRestarted(sid);
    }
  }

  return {
    runStates,
    start,
    stop,
    restart,
  };
}