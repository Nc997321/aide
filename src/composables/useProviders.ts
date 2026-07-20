import { ref, computed } from "vue";
import { api } from "../api";
import type { ProviderConfig, ProviderModelMappings } from "../types";

const SYSTEM_DEFAULT_ID = "__system_default__";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

// 模块级单例状态。SystemDefault 现在是 allProviders 里 id=__system_default__ 的真实条目
// （Plan 1 后 Rust get_providers 返回的第一项），不再硬编码 const + 独立 mappings ref。
const allProviders = ref<ProviderConfig[]>([]);
const activeProviderId = ref<string>(SYSTEM_DEFAULT_ID);
const loaded = ref(false);
const refreshing = ref(false);

const displayList = computed<ProviderConfig[]>(() => {
  // SystemDefault 恒置首（即使 get_providers 顺序变了也稳）
  const sd = allProviders.value.find((p) => p.id === SYSTEM_DEFAULT_ID);
  const rest = allProviders.value.filter((p) => p.id !== SYSTEM_DEFAULT_ID);
  return sd ? [sd, ...rest] : rest;
});

const systemDefault = computed<ProviderConfig>(
  () => allProviders.value.find((p) => p.id === SYSTEM_DEFAULT_ID) ?? fallbackSystemDefault(),
);

const systemDefaultMappings = computed<ProviderModelMappings>(
  () => systemDefault.value.modelMappings,
);

const activeProvider = computed<ProviderConfig>(() => {
  const found = allProviders.value.find((p) => p.id === activeProviderId.value);
  if (found) return found;
  return systemDefault.value ?? fallbackSystemDefault();
});

// 仅当 providers[] 里竟然没有 SystemDefault 条目时用（异常降级，不崩）
function fallbackSystemDefault(): ProviderConfig {
  return {
    id: SYSTEM_DEFAULT_ID, kind: "system_default", name: "系统默认", icon: "provider", baseUrl: "",
    apiKey: "", authToken: "", model: "", modelMappings: emptyMappings(),
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
  };
}

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
    kind: partial.kind ?? "custom",
    name: partial.name ?? "新供应商",
    icon: partial.icon ?? "provider",
    baseUrl: partial.baseUrl ?? "",
    apiKey: partial.apiKey ?? "",
    authToken: partial.authToken ?? "",
    model: partial.model ?? "",
    modelMappings: partial.modelMappings ?? emptyMappings(),
    effortLevel: partial.effortLevel ?? "",
    autoCompactWindow: partial.autoCompactWindow ?? "",
    autocompactPctOverride: partial.autocompactPctOverride ?? "",
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

// —— SystemDefault facade（保持既有导出形状，ProviderSettings.vue 模板暂不崩；
//    Task 9 重构模板后若不再用，可删 facade）——
async function saveSystemDefaultMappings(mappings: ProviderModelMappings): Promise<void> {
  await updateProvider(SYSTEM_DEFAULT_ID, { modelMappings: mappings });
}

async function refreshSystemDefaultModels(): Promise<void> {
  refreshing.value = true;
  try {
    await api.refreshModels(SYSTEM_DEFAULT_ID);
    // 拉回最新 providers（refresh_models 持久化到 providers[]，前端 ref 要同步）
    allProviders.value = await api.getProviders();
  } catch (e) {
    console.warn("刷新系统默认模型列表失败:", e);
  } finally {
    refreshing.value = false;
  }
}

function __resetForTest(): void {
  allProviders.value = [];
  activeProviderId.value = SYSTEM_DEFAULT_ID;
  loaded.value = false;
  refreshing.value = false;
}

export function useProviders() {
  return {
    allProviders,
    activeProviderId,
    displayList,
    activeProvider,
    systemDefault,
    systemDefaultMappings,
    loaded,
    load,
    addProvider,
    updateProvider,
    deleteProvider,
    setActiveProvider,
    saveSystemDefaultMappings,
    refreshSystemDefaultModels,
    refreshing,
    SYSTEM_DEFAULT_ID,
    __resetForTest,
  };
}