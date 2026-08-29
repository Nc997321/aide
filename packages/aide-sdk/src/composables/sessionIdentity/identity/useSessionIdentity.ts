import { computed, reactive, ref, type ComputedRef } from "vue";
import { api } from "../../../api";
import { useProviders } from "../../../composables/useProviders";
import { useSessionProviders } from "../../../composables/useSessionProviders";
import { consistentProviderId, providerModelList } from "../../../utils/provider";
import { readSessionMeta, writeSessionMeta, type SessionMeta } from "../persistence";
import { resolveEffectiveModel, resolveEffectiveProvider } from "./resolver";
import { restoreModel } from "./restoreModel";
import type { ProviderConfig } from "../../../types";
import type { ModelOption } from "../../../types/chat";

/**
 * L2 身份层：会话供应商/模型身份的单一真相源（SSOT）。
 *
 * 取代 useSessionContinuity（lastUsed 基线）+ useChatSession 的 stampProvider/
 * commitPendingModel/pendingModelCommit（落盘草稿）+ ChatInputBox 的 selectedModel
 * （4 watcher 维护）。模块级状态 + 工厂访问器（与 useSessionProviders:15 同构），
 * 任意组件 useSessionIdentity() 共享同一份 bindings/lastIdentity。
 *
 * 依赖红线：identity → persistence（L1）+ useSessionProviders 注册表 + utils 纯函数
 * （consistentProviderId/providerModelList）+ @/api（defaultModels）。不依赖 gate。
 *
 * 治本点：settleOnSend 一处同时落盘 + 推进基线，落盘值 = 门控基线 = 发送值三者同源，
 * 根除"lastUsedModel=null 被抹成 '' 与真实模型比"的误判（本次 bug 温床）。
 */

export interface Identity {
  provider: string;
  model: string;
}

interface Binding {
  meta: SessionMeta | null;   // resolve 读回的盘上身份
  runtimeModel: string;       // bindRuntime 写入（sidecar 坐实）
  draft: string;              // setUserChoice 写入（用户手选草稿）
  restored: string;           // resolve 恢复通道选定的模型
  sdkModels: ModelOption[];   // 系统默认的 SDK 动态列表（models_available 写入）
}

const bindings = reactive<Record<string, Binding>>({});
const lastIdentityState = ref<Identity | null>(null);
const currentSid = ref<string | null>(null);
const defaultModels = ref<ModelOption[]>([]);
// 空白面板（无会话）时用户手选的模型——不绑 sid（会话还没创建），首条发送后落到 pending 会话。
const pendingDraft = ref("");

// 模块级 composable 依赖（与 useSessionProviders 同构：返回模块级共享 ref，无 lifecycle）
const { allProviders, activeProviderId, SYSTEM_DEFAULT_ID } = useProviders();
const { setProvider, providerOf, clearProvider, migrateProvider } = useSessionProviders();

function emptyBinding(): Binding {
  return { meta: null, runtimeModel: "", draft: "", restored: "", sdkModels: [] };
}

function providerConfigOf(pid: string): ProviderConfig | null {
  // 可达兜底（非不可达）：pid 来自 effectiveProvider（providerOf / activeProviderId），
  // 但会话绑定可悬空指向已删除的供应商（deleteProvider 不清会话注册表，快路径也不修正）
  // ——find 可能 undefined，调用方回退空列表（见 providerModelsOf）。
  return allProviders.value.find((x) => x.id === pid) ?? null;
}

/** 第三方供应商的模型列表（providerModelList）。pid 悬空（供应商已删）→ 空列表。 */
function providerModelsOf(pid: string): ModelOption[] {
  const p = providerConfigOf(pid);
  return p ? providerModelList(p).map((v) => ({ value: v, displayName: v })) : [];
}

/** 空白面板（无会话）下拉选项：无 binding，系统默认用 defaultModels（无 sdkModels），
 *  第三方用 providerModelList(activeProvider)。不传 sid——空白面板没有会话身份。 */
function activeProviderModels(): ModelOption[] {
  const pid = activeProviderId.value;
  if (pid === SYSTEM_DEFAULT_ID) return defaultModels.value;
  return providerModelsOf(pid);
}

/** 当前会话下拉选项：系统默认用 SDK 动态列表（无则 defaultModels 静态兜底），
 *  第三方用 providerModelList（静态配置）。取代 ChatPanel.displayModels + providerModels。 */
function currentDisplayModels(sid: string): ModelOption[] {
  const pid = resolveEffectiveProvider(providerOf(sid), activeProviderId.value);
  if (pid === SYSTEM_DEFAULT_ID) {
    const sdk = bindings[sid]?.sdkModels ?? [];
    return sdk.length ? sdk : defaultModels.value;
  }
  return providerModelsOf(pid);
}

async function healProviderIfDirty(sid: string, meta: SessionMeta | null, resolved: string): Promise<void> {
  if (meta?.provider && meta.provider !== resolved) {
    await writeSessionMeta(sid, { provider: resolved }).catch((e) => {
      console.warn("[sessionIdentity] self-heal provider failed:", sid, resolved, e);
    });
  }
}

// resolve 慢路径：无内存绑定 → 读盘 + 一致性校验 + setProvider + self-heal + 恢复模型 + 置基线
async function restoreBinding(sid: string): Promise<void> {
  const meta = await readSessionMeta(sid);
  const resolved = consistentProviderId(allProviders.value, meta?.provider ?? null, meta?.model ?? null)
    ?? activeProviderId.value;
  setProvider(sid, resolved);
  await healProviderIfDirty(sid, meta, resolved);
  const restored = restoreModel(currentDisplayModels(sid), meta?.model ?? null);
  bindings[sid] = { meta, runtimeModel: "", draft: "", restored, sdkModels: [] };
  lastIdentityState.value = { provider: resolved, model: restored };
}

// resolve 快路径：有内存绑定 → 只读盘刷基线，不动注册表不写盘。
// bound 由 resolve 传入——快路径门控（providerOf(sid) 真值）即证明，不再重读重兜底。
async function refreshBinding(sid: string, bound: string): Promise<void> {
  const meta = await readSessionMeta(sid);
  const resolved = consistentProviderId(allProviders.value, meta?.provider ?? null, meta?.model ?? null)
    ?? bound;
  const restored = restoreModel(currentDisplayModels(sid), meta?.model ?? null);
  // 不变式：快路径 ⟹ binding 已建——restoreBinding 建 provider 时同块建 binding；
  // settleOnSend 建 provider 后落盘成败都建（见 settleOnSend catch）。类型层已非空，
  // 不再 ?? emptyBinding 兜底。
  const prev = bindings[sid];
  bindings[sid] = { ...prev, meta, restored };
  lastIdentityState.value = { provider: resolved, model: restored };
}

/** sid 切换入口（取代 restoreBinding + refreshLastUsed）。有绑定走快路径，无绑定走慢路径。
 *  await 必须在模型恢复前完成（同现 ChatInputBox:180 语义）。 */
async function resolve(sid: string): Promise<void> {
  currentSid.value = sid;
  const bound = providerOf(sid);
  if (bound) await refreshBinding(sid, bound);
  else await restoreBinding(sid);
}

/** 发送前统一收尾（取代 noteSent + stampProvider + pendingModelCommit 落盘）。
 *  sid 非空：绑定确保 + 落盘 + 基线推进，三者同源。sid 空（空白面板首发）：只推进基线
 *  （会话还没创建，落盘推迟到 finalize 用 realId）。
 *  落盘失败：基线照常推进（本次发送照用 chosen），但 binding.meta 不更新——内存 meta
 *  与盘一致（盘没写成，内存也不记 chosen），重开读盘回落而非读到假身份。setProvider 仍
 *  在落盘前调用：本次发送 providerOf(sid) 要是 chosen 传 Rust，落盘失败只影响跨重启。
 *  失败时若尚无 binding 则建空绑定——保证 resolve 快路径"providerOf 非空 ⟹ binding 已建"
 *  不变式不被失败打破。 */
async function settleOnSend(sid: string, chosen: Identity): Promise<void> {
  lastIdentityState.value = chosen;
  if (!sid) return;
  if (!providerOf(sid)) setProvider(sid, chosen.provider);
  const prev = bindings[sid] ?? emptyBinding();
  const newMeta = { provider: chosen.provider, model: chosen.model || null };
  // 只落盘变化的字段——provider/model 与上次盘上一致则跳过对应 IPC（省冗余写）。
  // prev.meta 是上次成功落盘值（落盘失败时不更新），与盘一致，故"没变"=盘已是目标值。
  const providerChanged = prev.meta?.provider !== newMeta.provider;
  const modelChanged = (prev.meta?.model ?? null) !== newMeta.model;
  if (!providerChanged && !modelChanged) return;
  try {
    await writeSessionMeta(sid, {
      provider: providerChanged ? newMeta.provider : undefined,
      model: modelChanged ? newMeta.model : undefined,
    });
    bindings[sid] = { ...prev, meta: newMeta };
  } catch (e) {
    // 落盘失败也建绑定（空绑定，meta 保持盘上状态）：provider 已在 try 前 setProvider，
    // 绑定不建则 resolve 快路径"providerOf 非空 ⟹ binding 已建"不变式被失败打破。
    if (!bindings[sid]) bindings[sid] = emptyBinding();
    console.warn("[sessionIdentity] settleOnSend persist failed:", sid, e);
  }
}

/** 定名搬迁后 currentSid 跟到 realId（finalizeSession 已 migrateBinding 迁绑定，
 *  这里不读盘，只让 effectiveModel 指向新 sid 的 binding）。 */
function adoptSid(sid: string): void {
  currentSid.value = sid;
}

/** 用户手选草稿（取代 handleModelChange 直写 selectedModel）。只写 draft，不落盘。
 *  空白面板（currentSid null）写 pendingDraft——会话还没创建，draft 无 sid 可绑。 */
function setUserChoice(model: string): void {
  const sid = currentSid.value;
  if (!sid) {
    pendingDraft.value = model;
    return;
  }
  const prev = bindings[sid] ?? emptyBinding();
  bindings[sid] = { ...prev, draft: model };
}

/** models_available 事件坐实 SDK 动态模型列表（系统默认下拉用）。不落盘。 */
function setSdkModels(sid: string, models: ModelOption[]): void {
  const prev = bindings[sid] ?? emptyBinding();
  bindings[sid] = { ...prev, sdkModels: models };
}

/** sidecar 运行时坐实当前模型（取代 currentModel watcher 直写 selectedModel）。不落盘。 */
function bindRuntime(sid: string, model: string): void {
  const prev = bindings[sid] ?? emptyBinding();
  bindings[sid] = { ...prev, runtimeModel: model };
}

/** 释放绑定（取代 clearProvider，stop 会话用）。删注册表 + binding；落盘身份保留。
 *  不动 currentSid/lastIdentity：会话还在面板（只是进程停了），effectiveModel 自动回落 activeProvider。 */
function releaseBinding(sid: string): void {
  clearProvider(sid);
  delete bindings[sid];
}

/** 定名搬迁（取代 migrateProvider）。绑定随 sid 迁移。 */
function migrateBinding(oldSid: string, newSid: string): void {
  migrateProvider(oldSid, newSid);
  if (bindings[oldSid]) {
    bindings[newSid] = bindings[oldSid];
    delete bindings[oldSid];
  }
  if (currentSid.value === oldSid) currentSid.value = newSid;
}

/** 面板无会话（sid 清空，取代 continuity.clear）。清当前 + 基线。 */
function clearCurrent(): void {
  currentSid.value = null;
  lastIdentityState.value = null;
}

/** @internal 测试重置模块级状态（与 useProviders.__resetForTest 同构）。 */
function __resetIdentityForTest(): void {
  for (const k of Object.keys(bindings)) delete bindings[k];
  lastIdentityState.value = null;
  currentSid.value = null;
  defaultModels.value = [];
  pendingDraft.value = "";
}

/** 读系统默认静态兜底模型列表（ChatPanel onMounted 调，取代原 ChatPanel:185-198）。 */
async function refreshDefaultModels(): Promise<void> {
  try {
    defaultModels.value = await api.getDefaultModels();
  } catch (e) {
    console.warn("[sessionIdentity] load default models failed:", e);
  }
}

const effectiveProvider = computed<string>(() => {
  const sid = currentSid.value;
  // 空白面板（currentSid null）直接用 activeProviderId——不传空串给 providerOf
  return sid ? resolveEffectiveProvider(providerOf(sid), activeProviderId.value) : activeProviderId.value;
});

const displayModels = computed<ModelOption[]>(() => {
  const sid = currentSid.value;
  // 空白面板/新建 pending（currentSid null）用 activeProvider 列表——下拉要能选模型
  return sid ? currentDisplayModels(sid) : activeProviderModels();
});

const effectiveModel = computed<string>(() => {
  const sid = currentSid.value;
  if (!sid) {
    // 空白面板：pendingDraft（在 activeProvider 列表里）> 列表首项
    const list = activeProviderModels();
    if (pendingDraft.value && list.some((m) => m.value === pendingDraft.value)) return pendingDraft.value;
    return list[0]?.value ?? "";
  }
  const b = bindings[sid] ?? emptyBinding();
  return resolveEffectiveModel(
    { draft: b.draft, runtime: b.runtimeModel, restored: b.restored },
    currentDisplayModels(sid).map((m) => m.value),
  );
});

const lastIdentity: ComputedRef<Identity | null> = computed(() => lastIdentityState.value);

/** 访问器（模块级状态共享，任意实例同一组）。 */
export function useSessionIdentity() {
  return {
    resolve,
    settleOnSend,
    setUserChoice,
    setSdkModels,
    bindRuntime,
    releaseBinding,
    migrateBinding,
    clearCurrent,
    adoptSid,
    __resetIdentityForTest,
    refreshDefaultModels,
    effectiveModel,
    effectiveProvider,
    displayModels,
    lastIdentity,
    providerOf,
  };
}