import { ref, computed } from "vue";
import { api } from "../api";
import type { ProjectTaskCandidate, RunConfig } from "../types";

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

async function persist(next: RunConfig[]) {
  const wsKey = currentWsKey.value;
  if (!wsKey) throw new Error("请先打开工作区");
  await api.saveRunConfigs(wsKey, next);
  if (currentWsKey.value === wsKey) configs.value = next;
}

export function useRunConfigs() {
  async function load(wsKey: string) {
    currentWsKey.value = wsKey;
    const saved = await api.listRunConfigs(wsKey).catch((error) => {
      console.warn("[run-configs] load failed:", error);
      return null;
    });
    if (currentWsKey.value !== wsKey) return;  // stale: workspace switched mid-flight
    configs.value = saved ?? [];
    if (!saved) {
      activeId.value = "";
      return;
    }

    // Restore activeId if still valid; otherwise default to first config.
    if (!configs.value.find(c => c.id === activeId.value)) {
      activeId.value = configs.value[0]?.id ?? "";
    }
  }

  function setActive(id: string) {
    activeId.value = id;
  }

  async function add(partial: Omit<RunConfig, "id">): Promise<RunConfig> {
    const config: RunConfig = { id: generateId(), ...partial };
    await persist([...configs.value, config]);
    if (!activeId.value) activeId.value = config.id;
    return config;
  }

  async function update(updated: RunConfig): Promise<void> {
    await persist(configs.value.map(c => c.id === updated.id ? updated : c));
  }

  async function remove(id: string): Promise<void> {
    await persist(configs.value.filter(c => c.id !== id));
    if (activeId.value === id) {
      activeId.value = configs.value[0]?.id ?? "";
    }
  }

  async function applyCandidates(targets: ProjectTaskCandidate[], wsKey: string) {
    if (currentWsKey.value !== wsKey) throw new Error("工作区已切换，请重新识别");
    const next = [...configs.value];
    for (const target of targets) {
      const index = next.findIndex(config => taskDirectoryKey(config.cwd) === taskDirectoryKey(target.cwd));
      if (index < 0) {
        next.push({ ...target, id: generateId() });
        continue;
      }
      const previous = next[index];
      next[index] = {
        ...previous,
        command: target.command || previous.command,
        packageCommand: target.packageCommand || previous.packageCommand,
        cleanCommand: target.cleanCommand || previous.cleanCommand,
        requiredEnv: target.sources?.length ? target.requiredEnv : previous.requiredEnv,
        sources: target.sources?.length ? target.sources : previous.sources,
      };
    }
    await persist(next);
    if (currentWsKey.value !== wsKey) return;
    if (!activeId.value) activeId.value = next[0]?.id ?? "";
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
    applyCandidates,
  };
}

export function taskDirectoryKey(path: string) {
  const normalized = path.replaceAll("\\", "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || path.includes("\\") && normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
