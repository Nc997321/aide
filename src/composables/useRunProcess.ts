import { ref } from "vue";
import { listen } from "../api";
import { api } from "../api";
import { useWorkbenchTerminal } from "./useWorkbenchTerminal";
import { useWorkspaces } from "./useWorkspaces";
import { useWorkspaceJdk } from "./useWorkspaceJdk";
import type { RunConfig } from "../types";

export type RunStatus = "idle" | "running" | "stopped" | "crashed";

// 每配置独立运行状态——支持同时启动多个模块。键 = RunConfig.id，值 = 该配置
// 对应 run 进程的当前状态。run 进程的 session_id 是确定性的 `run__{config_id}`
//（见 run_process.rs::run_session_id），故 pty-exit 可直接从 session_id 反查回
// configId 回填状态，无需单例 activeSessionId / runningConfigId（那是「同时只能
// 跑一个」的假设，会堵死多模块并行——启动 B 不应停掉 A）。终端层本就是多 tab
// 的（每个 run__{id} 独立 session + 独立 tab），这里把状态层也对齐成多实例。
const runStates = ref<Record<string, RunStatus>>({});
const pending = new Set<string>();
let exitListener: Promise<() => void> | undefined;

function sessionOf(configId: string): string {
  return `run__${configId}`;
}

function setStatus(configId: string, s: RunStatus): void {
  // 整体替换对象确保新增键也触发响应式（computed 读 runStates.value[id] 会重算）。
  runStates.value = { ...runStates.value, [configId]: s };
}

async function ensureExitListener(): Promise<void> {
  exitListener ??= listen<string>("pty-exit", (event) => {
    try {
      const p = JSON.parse(event.payload) as { session_id: string; success?: boolean };
      const sid = p.session_id;
      if (!sid.startsWith("run__")) return;          // 非 run 进程（shell tab 等）忽略
      const configId = sid.slice(5);                  // 确定性 session_id → configId
      setStatus(configId, p.success ? "stopped" : "crashed");
    } catch (_) { /* ignore malformed events */ }
  }).catch(error => {
    exitListener = undefined;
    throw error;
  });
  await exitListener;
}

export function useRunProcess() {
  const wb = useWorkbenchTerminal();
  const { activeKey } = useWorkspaces();
  const { jdkHome } = useWorkspaceJdk();
  function currentWs(): string { return activeKey.value ?? ""; }

  /** 启动 env：工作区级 JDK 注入（一个工作区一个 JDK，所有配置共享——
   *  Maven/Gradle 反应堆构建只有一个启动 JDK）。空 = 系统默认，同时剥掉
   *  存量 per-config JAVA_HOME（list_run_configs 迁移已写回，这里兜底）。 */
  function envForRun(config: RunConfig): Record<string, string> {
    const env = { ...(config.env ?? {}) };
    if (jdkHome.value) env.JAVA_HOME = jdkHome.value;
    else delete env.JAVA_HOME;
    return env;
  }

  async function start(config: RunConfig, restart = false): Promise<void> {
    if (pending.has(config.id) || (!restart && runStates.value[config.id] === "running")) return;
    pending.add(config.id);
    const previousStatus = runStates.value[config.id] ?? "idle";
    try {
      const ws = currentWs();
      const env = envForRun(config);
      const options = { envFile: config.envFile, requiredEnv: config.requiredEnv };
      await api.checkProjectTask(config.cwd, config.command, env, options);
      await ensureExitListener();
      const sid = sessionOf(config.id);
      wb.visible.value = true;
      await new Promise<void>(resolve => setTimeout(resolve, 80));
      const dim = wb.attachSession(ws, sid, config.name, restart) ?? { rows: 24, cols: 80 };
      setStatus(config.id, "running");
      try {
        // Host 校验环境后才替换旧进程。同一任务复用终端标签。
        await api.runProcessStart(config.id, config.cwd, config.command, env, dim, options);
        if (runStates.value[config.id] === "running") wb.markSpawned(sid);
      } catch (error) {
        setStatus(config.id, previousStatus);
        throw error;
      }
    } finally {
      pending.delete(config.id);
    }
  }

  async function stop(configId: string): Promise<void> {
    if (!pending.has(configId)) await api.runProcessStop(configId);
  }

  function runAction(config: RunConfig, action: "package" | "clean") {
    const command = action === "package" ? config.packageCommand : config.cleanCommand;
    if (!command) return;
    return start({
      ...config,
      id: `${config.id}__${action}`,
      name: `${config.name} · ${action === "package" ? "打包" : "清理"}`,
      command,
      requiredEnv: [],
    });
  }

  return {
    runStates,
    start,
    stop,
    restart: (config: RunConfig) => start(config, true),
    runAction,
  };
}
