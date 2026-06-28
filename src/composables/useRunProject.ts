import { ref } from "vue";
import { api } from "../api";
import { useWorkbenchTerminal } from "./useWorkbenchTerminal";

// Module-level singleton — state shared across all callers.
const lastCommand = ref<string | null>(null);

export function useRunProject() {
  const wb = useWorkbenchTerminal();

  async function run(cwd: string) {
    const cmd = await api.detectRunCommand(cwd).catch(() => null);
    lastCommand.value = cmd;

    // Show workbench first so the slide-in begins before we mount terminal DOM.
    wb.visible.value = true;
    await new Promise<void>(r => setTimeout(r, 80));

    // Create a new terminal session; if a command was detected, it will be
    // written to the shell automatically after spawn.
    wb.createSession(cwd, cmd ?? undefined);
  }

  return {
    run,
    lastCommand,
  };
}
