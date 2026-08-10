import { ref, computed } from "vue";
import { api } from "../api";
import type { ProviderConfig, ProviderConfigInput, ProviderKind, ProviderModelMappings, SecretMutation } from "../types";
import { useProviderCatalog } from "./useProviderCatalog";

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
  // systemDefault 已是非 undefined 的 ComputedRef<ProviderConfig>（见上 ?? fallbackSystemDefault），
  // 此处直接返回，不再重复兜底。
  return systemDefault.value;
});

// 仅当 providers[] 里竟然没有 SystemDefault 条目时用（异常降级，不崩）
function fallbackSystemDefault(): ProviderConfig {
  return {
    id: SYSTEM_DEFAULT_ID, kind: "system_default", name: "系统默认", icon: "provider", baseUrl: "",
    apiKeyConfigured: false, authTokenConfigured: false, model: "", modelMappings: emptyMappings(),
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
  };
}

function generateId(): string {
  return crypto.randomUUID?.() ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function providerInput(
  provider: ProviderConfig,
  mutations: Partial<Pick<ProviderConfigInput, "apiKey" | "authToken">> = {},
): ProviderConfigInput {
  const { apiKeyConfigured: _apiKeyConfigured, authTokenConfigured: _authTokenConfigured, ...publicFields } = provider;
  return {
    ...publicFields,
    apiKey: mutations.apiKey ?? { action: "unchanged" },
    authToken: mutations.authToken ?? { action: "unchanged" },
  };
}

async function persist(mutations: Record<string, Partial<Pick<ProviderConfigInput, "apiKey" | "authToken">>> = {}): Promise<void> {
  await api.setProviders(allProviders.value.map((provider) => providerInput(provider, mutations[provider.id])));
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
    apiKeyConfigured: false,
    authTokenConfigured: false,
    model: partial.model ?? "",
    modelMappings: partial.modelMappings ?? emptyMappings(),
    effortLevel: partial.effortLevel ?? "",
    autoCompactWindow: partial.autoCompactWindow ?? "",
    autocompactPctOverride: partial.autocompactPctOverride ?? "",
    knownModels: partial.knownModels ?? [],
  };
  allProviders.value = [...allProviders.value, p];
  await persist();
  return p;
}

/**
 * 新增预置 kind 实例。单实例约束：同 kind 已存在则抛错（picker 也会置灰，这是双保险）。
 * 身份字段（name/icon/baseUrl）从 catalog 富化填入——仅显示用；落盘时 Rust strip 只存
 * kind + 凭证 + mappings + 行为字段。凭证留空待用户填。
 */
async function addPresetProvider(kind: ProviderKind): Promise<ProviderConfig> {
  if (allProviders.value.some((p) => p.kind === kind)) {
    throw new Error(`该供应商类型已存在（单实例约束）：${kind}`);
  }
  const { enrichForDisplay } = useProviderCatalog();
  const p: ProviderConfig = enrichForDisplay({
    id: generateId(),
    kind,
    name: "", icon: "", baseUrl: "",
    apiKeyConfigured: false, authTokenConfigured: false, model: "",
    modelMappings: emptyMappings(),
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "",
    knownModels: [],
  });
  allProviders.value = [...allProviders.value, p];
  await persist();
  return p;
}

/** 新增 Custom 实例——全部字段可编辑，身份由用户填。 */
async function addCustomProvider(): Promise<ProviderConfig> {
  return addProvider({ kind: "custom" });
}

async function updateProvider(
  id: string,
  partial: Partial<ProviderConfig>,
  secrets: Partial<Pick<ProviderConfigInput, "apiKey" | "authToken">> = {},
): Promise<void> {
  const idx = allProviders.value.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const current = allProviders.value[idx];
  const next = {
    ...current,
    ...partial,
    apiKeyConfigured: secrets.apiKey?.action === "clear" ? false : current.apiKeyConfigured || secrets.apiKey?.action === "set",
    authTokenConfigured: secrets.authToken?.action === "clear" ? false : current.authTokenConfigured || secrets.authToken?.action === "set",
  };
  const providers = [...allProviders.value];
  providers[idx] = next;
  await api.setProviders(providers.map((provider) => providerInput(provider, provider.id === id ? secrets : undefined)));
  allProviders.value = providers;
}

async function deleteProvider(id: string): Promise<void> {
  allProviders.value = allProviders.value.filter((p) => p.id !== id);
  await persist();
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

/** 保存 SystemDefault（Anthropic 官方直连）的 API key 到 keyring。引导登录步 + 上下文兜底用。 */
async function saveSystemDefaultApiKey(key: string): Promise<void> {
  await updateProvider(SYSTEM_DEFAULT_ID, {}, { apiKey: { action: "set", value: key } });
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
    addPresetProvider,
    addCustomProvider,
    updateProvider,
    deleteProvider,
    setActiveProvider,
    saveSystemDefaultMappings,
    saveSystemDefaultApiKey,
    refreshSystemDefaultModels,
    refreshing,
    SYSTEM_DEFAULT_ID,
    __resetForTest,
  };
}