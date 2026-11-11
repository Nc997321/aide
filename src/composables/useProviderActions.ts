import { ref } from "vue";
import { api, openExternal } from "../api";
import type {
  ConnectionStatus, PortProbeResult, LoginStatusResult, ProviderModelMappings, ProviderUsage,
} from "../types";

const lastError = ref<string | null>(null);
const probing = ref(false);
const testing = ref(false);
const refreshing = ref(false);
const loginChecking = ref(false);
const usageLoading = ref(false);

const probeResult = ref<PortProbeResult | null>(null);
const connectionResult = ref<ConnectionStatus | null>(null);
const loginResult = ref<LoginStatusResult | null>(null);
const usageResult = ref<ProviderUsage | null>(null);

async function run<T>(flag: { value: boolean }, fn: () => Promise<T>): Promise<T | null> {
  flag.value = true;
  lastError.value = null;
  try {
    return await fn();
  } catch (e) {
    lastError.value = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    flag.value = false;
  }
}

async function testConnection(providerId: string): Promise<ConnectionStatus | null> {
  const r = await run(testing, () => api.testProviderConnection(providerId));
  if (r) connectionResult.value = r;
  return r;
}

async function cpaProbe(): Promise<PortProbeResult | null> {
  const r = await run(probing, () => api.cpaProbePort());
  if (r) probeResult.value = r;
  return r;
}

async function cpaOpenManagement(): Promise<void> {
  const url = await run({ value: false }, () => api.cpaOpenManagement());
  if (url) {
    try {
      await openExternal(url);
    } catch (e) {
      lastError.value = `打开管理面板失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

async function cpaLoginStatus(): Promise<LoginStatusResult | null> {
  const r = await run(loginChecking, () => api.cpaLoginStatus());
  if (r) loginResult.value = r;
  return r;
}

async function viewUsage(providerId: string): Promise<ProviderUsage | null> {
  const r = await run(usageLoading, () => api.viewProviderUsage(providerId));
  if (r) usageResult.value = r;
  return r;
}

async function refreshModels(providerId: string): Promise<ProviderModelMappings | null> {
  return run(refreshing, () => api.refreshModels(providerId));
}

function __resetForTest(): void {
  lastError.value = null;
  probing.value = testing.value = refreshing.value = loginChecking.value = usageLoading.value = false;
  probeResult.value = connectionResult.value = loginResult.value = null;
  usageResult.value = null;
}

export function useProviderActions() {
  return {
    lastError, probing, testing, refreshing, loginChecking, usageLoading,
    probeResult, connectionResult, loginResult, usageResult,
    testConnection, cpaProbe, cpaOpenManagement, cpaLoginStatus, viewUsage, refreshModels,
    __resetForTest,
  };
}
