import { ref, computed } from "vue";
import { api } from "../api";
import type { ProviderConfig } from "../types";

const SYSTEM_DEFAULT_ID = "__system_default__";

const allProviders = ref<ProviderConfig[]>([]);
const activeProviderId = ref<string>(SYSTEM_DEFAULT_ID);
const loaded = ref(false);

const systemDefault: ProviderConfig = {
  id: SYSTEM_DEFAULT_ID,
  name: "系统默认",
  icon: "🖥",
  baseUrl: "",
  apiKey: "",
  authToken: "",
  model: "",
  modelMappings: { opus: "", sonnet: "", haiku: "", subagent: "" },
  effortLevel: "",
  knownModels: [],
};

const displayList = computed<ProviderConfig[]>(() => [
  systemDefault,
  ...allProviders.value,
]);

const activeProvider = computed<ProviderConfig>(() => {
  if (activeProviderId.value === SYSTEM_DEFAULT_ID) return systemDefault;
  return (
    allProviders.value.find((p) => p.id === activeProviderId.value) ??
    systemDefault
  );
});

function generateId(): string {
  return crypto.randomUUID?.() ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function load(): Promise<void> {
  try {
    const [providers, id] = await Promise.all([
      api.getProviders(),
      api.getActiveProviderId(),
    ]);
    allProviders.value = providers;
    activeProviderId.value = id;
  } catch {
    // keep defaults
  }
  loaded.value = true;
}

async function addProvider(partial: Partial<ProviderConfig> = {}): Promise<ProviderConfig> {
  const p: ProviderConfig = {
    id: generateId(),
    name: partial.name ?? "新供应商",
    icon: partial.icon ?? "🤖",
    baseUrl: partial.baseUrl ?? "",
    apiKey: partial.apiKey ?? "",
    authToken: partial.authToken ?? "",
    model: partial.model ?? "",
    modelMappings: partial.modelMappings ?? { opus: "", sonnet: "", haiku: "", subagent: "" },
    effortLevel: partial.effortLevel ?? "",
    knownModels: partial.knownModels ?? [],
  };
  allProviders.value = [...allProviders.value, p];
  await api.setProviders(allProviders.value);
  return p;
}

async function updateProvider(id: string, partial: Partial<ProviderConfig>): Promise<void> {
  const idx = allProviders.value.findIndex((p) => p.id === id);
  if (idx === -1) return;
  allProviders.value[idx] = { ...allProviders.value[idx], ...partial };
  allProviders.value = [...allProviders.value];
  await api.setProviders(allProviders.value);
}

async function deleteProvider(id: string): Promise<void> {
  allProviders.value = allProviders.value.filter((p) => p.id !== id);
  await api.setProviders(allProviders.value);
  if (activeProviderId.value === id) {
    activeProviderId.value = SYSTEM_DEFAULT_ID;
    await api.setActiveProviderId(SYSTEM_DEFAULT_ID);
  }
}

async function setActiveProvider(id: string): Promise<void> {
  activeProviderId.value = id;
  await api.setActiveProviderId(id);
}

export function useProviders() {
  return {
    allProviders,
    activeProviderId,
    displayList,
    activeProvider,
    loaded,
    load,
    addProvider,
    updateProvider,
    deleteProvider,
    setActiveProvider,
    SYSTEM_DEFAULT_ID,
  };
}
