import { ref, computed } from "vue";
import { api } from "../api";
import type { RunConfig, RunTarget } from "../types";

// Module-level singleton — shared across all callers.
const configs = ref<RunConfig[]>([]);
const activeId = ref<string>("");
const currentWsKey = ref<string>("");

const activeConfig = computed<RunConfig | null>(() =>
  configs.value.find(c => c.id === activeId.value) ?? null
);

function generateId(): string {
  return `rc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function persist() {
  if (!currentWsKey.value) return;
  // 落盘失败降级提示：配置仍在内存中生效，但切工作区/重启后丢失
  await api.saveRunConfigs(currentWsKey.value, configs.value).catch((e) => {
    console.warn("[run-configs] persist failed, changes lost on workspace switch/restart:", e);
  });
}

export function useRunConfigs() {
  // Load configs for a workspace. Auto-detects and saves on first open.
  async function load(wsKey: string, cwd: string) {
    currentWsKey.value = wsKey;
    const saved = await api.listRunConfigs(wsKey).catch(() => [] as RunConfig[]);
    if (currentWsKey.value !== wsKey) return;  // stale: workspace switched mid-flight
    configs.value = saved;

    // Restore activeId if still valid; otherwise default to first config.
    if (!configs.value.find(c => c.id === activeId.value)) {
      activeId.value = configs.value[0]?.id ?? "";
    }

    // First time for this workspace: auto-detect and silently populate.
    if (configs.value.length === 0 && cwd) {
      const targets = await api.detectRunTargets(cwd).catch(() => [] as RunTarget[]);
      if (currentWsKey.value !== wsKey) return;  // stale: workspace switched mid-flight
      if (targets.length > 0) {
        configs.value = targets.map(t => ({
          id: generateId(),
          name: t.name,
          cwd: t.cwd,
          command: t.command,
        }));
        activeId.value = configs.value[0]?.id ?? "";
        await persist();
      }
    }
  }

  function setActive(id: string) {
    activeId.value = id;
  }

  async function add(partial: Omit<RunConfig, "id">): Promise<RunConfig> {
    const config: RunConfig = { id: generateId(), ...partial };
    configs.value = [...configs.value, config];
    if (!activeId.value) activeId.value = config.id;
    await persist();
    return config;
  }

  async function update(updated: RunConfig): Promise<void> {
    configs.value = configs.value.map(c => c.id === updated.id ? updated : c);
    await persist();
  }

  async function remove(id: string): Promise<void> {
    configs.value = configs.value.filter(c => c.id !== id);
    if (activeId.value === id) {
      activeId.value = configs.value[0]?.id ?? "";
    }
    await persist();
  }

  // Returns detected targets without saving (used by dialog for user review).
  async function detectAndAdd(cwd: string): Promise<RunTarget[]> {
    return api.detectRunTargets(cwd).catch(() => [] as RunTarget[]);
  }

  // Adds a list of RunTargets as new RunConfigs and persists.
  async function addTargets(targets: RunTarget[]): Promise<void> {
    const newConfigs: RunConfig[] = targets.map(t => ({
      id: generateId(),
      name: t.name,
      cwd: t.cwd,
      command: t.command,
    }));
    configs.value = [...configs.value, ...newConfigs];
    if (!activeId.value && configs.value.length > 0) {
      activeId.value = configs.value[0].id;
    }
    await persist();
  }

  return {
    configs,
    activeId,
    activeConfig,
    currentWsKey,
    load,
    setActive,
    add,
    update,
    remove,
    detectAndAdd,
    addTargets,
  };
}
