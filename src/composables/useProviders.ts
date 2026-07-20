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

const allProviders = ref<ProviderConfig[]>([]);
const activeProviderId = ref<string>(SYSTEM_DEFAULT_ID);
const loaded = ref(false);

// 系统默认的模型变量映射——独立持久化（与 providers 数组并列），系统默认不是
// provider 条目但需要可配，否则子代理全继承主会话模型。systemDefault.modelMappings
// 由本 ref 驱动。
const systemDefaultMappings = ref<ProviderModelMappings>(emptyMappings());

// refresh 系统默认模型变量的 loading 状态——模块级（与 systemDefaultMappings
// 同级），App.vue 启动时拉取和 ProviderSettings 的"手动刷新"按钮共享同一实例。
const refreshing = ref(false);

const systemDefault: ProviderConfig = {
  id: SYSTEM_DEFAULT_ID,
  kind: "system_default",
  name: "系统默认",
  icon: "provider",
  baseUrl: "",
  apiKey: "",
  authToken: "",
  model: "",
  modelMappings: emptyMappings(),
  effortLevel: "",
  autoCompactWindow: "",
  autocompactPctOverride: "",
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
    const [providers, id, sysMappings] = await Promise.all([
      api.getProviders(),
      api.getActiveProviderId(),
      api.getSystemDefaultModelMappings(),
    ]);
    allProviders.value = providers;
    activeProviderId.value = id;
    systemDefaultMappings.value = sysMappings;
    systemDefault.modelMappings = sysMappings;
  } catch {
    // keep defaults
  }
  loaded.value = true;
}

async function saveSystemDefaultMappings(mappings: ProviderModelMappings): Promise<void> {
  await api.setSystemDefaultModelMappings(mappings);
  systemDefaultMappings.value = { ...mappings };
  systemDefault.modelMappings = { ...mappings };
}

// 调 Anthropic GET /v1/models 拉最新模型，让 Rust 侧按省钱档映射覆盖"系统默认"
// 5 字段并写回 config。失败时保留旧 systemDefaultMappings 不动（Rust 侧无认证
// 返回旧值、网络/解析错误返回 Err）。启动时 fire-and-forget 调，刷新按钮 await。
async function refreshSystemDefaultModels(): Promise<void> {
  refreshing.value = true;
  try {
    const mappings = await api.refreshSystemDefaultModels();
    systemDefaultMappings.value = { ...mappings };
    systemDefault.modelMappings = { ...mappings };
  } catch (e) {
    // 保留旧值；Rust 侧已记日志，前端仅 warn 不阻塞 UI
    console.warn("刷新系统默认模型列表失败:", e);
  } finally {
    refreshing.value = false;
  }
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
  };
}
