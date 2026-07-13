import { useWorkbenchTerminal } from "./useWorkbenchTerminal";
import { useRunConfigs } from "./useRunConfigs";
import type { RunConfig } from "../types";

export function useRunProject() {
  const wb = useWorkbenchTerminal();

  async function runConfig(cfg: RunConfig) {
    wb.visible.value = true;
    // Small delay so the workbench slide-in animation starts before terminal mounts.
    await new Promise<void>(r => setTimeout(r, 80));
    wb.createSession(cfg.cwd, cfg.cwd, cfg.command);
  }

  async function run() {
    const { activeConfig } = useRunConfigs();
    const cfg = activeConfig.value;
    if (!cfg) return;
    await runConfig(cfg);
  }

  return { run, runConfig };
}
