import { ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { useWorkbenchTerminal } from "./useWorkbenchTerminal";
import { useWorkspaces } from "./useWorkspaces";
import type { RunConfig } from "../types";

export type RunStatus = "idle" | "running" | "stopped" | "crashed";

// Module-level singleton state
const runStatus = ref<RunStatus>("idle");
const runningConfigId = ref<string>("");
const activeSessionId = ref<string>("");

let unlistenExit: UnlistenFn | null = null;
let isRestarting = false;

async function ensureExitListener(): Promise<void> {
  if (unlistenExit) return;
  unlistenExit = await listen<string>("pty-exit", (event) => {
    try {
      const p = JSON.parse(event.payload) as { session_id: string; success?: boolean };
      if (p.session_id === activeSessionId.value && !isRestarting) {
        runStatus.value = p.success ? "stopped" : "crashed";
      }
    } catch (_) { /* ignore malformed events */ }
  });
}

export function useRunProcess() {
  const wb = useWorkbenchTerminal();
  const { activeKey } = useWorkspaces();
  function currentWs(): string { return activeKey.value ?? ""; }

  async function start(config: RunConfig): Promise<void> {
    await ensureExitListener();
    const sessionId = await api.runProcessStart(config.id, config.cwd, config.command);
    runningConfigId.value = config.id;
    activeSessionId.value = sessionId;
    runStatus.value = "running";

    // Show workbench and attach a terminal tab for the spawned PTY
    wb.visible.value = true;
    await new Promise<void>(r => setTimeout(r, 80));
    wb.attachSession(currentWs(), sessionId, config.name);
  }

  async function stop(): Promise<void> {
    if (!runningConfigId.value) return;
    await api.runProcessStop(runningConfigId.value);
    // pty-exit event will update runStatus asynchronously
  }

  async function restart(config: RunConfig): Promise<void> {
    isRestarting = true;
    try {
      await api.runProcessStop(config.id).catch(() => {});
      // Brief pause to let the old PTY flush before reopening with the same ID
      await new Promise<void>(r => setTimeout(r, 150));
      const sessionId = await api.runProcessStart(config.id, config.cwd, config.command);
      runningConfigId.value = config.id;
      activeSessionId.value = sessionId;
      runStatus.value = "running";

      wb.visible.value = true;
      wb.attachSession(currentWs(), sessionId, config.name, true /* clearFirst */);
    } finally {
      isRestarting = false;
    }
  }

  return {
    runStatus,
    runningConfigId,
    start,
    stop,
    restart,
  };
}
