import { reactive, ref } from "vue";
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
 * L2a 会话身份仓库（全局一份，按 sid 存储）。
 *
 * 只回答一件事：**这条会话是什么身份**（绑定了哪个供应商、记住/坐实的模型是什么）。
 * 它不知道"谁正在看这条会话"——那是 L2b 视图层（`./view.ts`）的事。
 *
 * 拆分动机：此前这两类状态共用一个模块级单例（`currentSid` / `lastProviderState`
 * / `pendingDraft` 是单值），而分屏布局下多个面板同时挂载（`App.vue` 的 PaneLayout
 * 用 v-show 保活），谁最后切面板谁就改全局 → 下拉显示错会话的模型、草稿写进别人
 * 会话、门控基线串。按归属拆开后这些都不再可能。
 *
 * 依赖红线：store → persistence（L1）+ useSessionProviders 注册表 + utils 纯函数 + @/api。
 * 不依赖 view、不依赖 gate。
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
/** 上次发送坐实的供应商 id，**按 sid** 记录（门控基线）。
 *  此前是单值导致跨会话串：A 面板的门控去比 B 会话的基线 → 误弹/漏弹。 */
const lastProviderBySid = reactive<Record<string, string>>({});
const defaultModels = ref<ModelOption[]>([]);

// 模块级 composable 依赖（与 useSessionProviders 同构：返回模块级共享 ref，无 lifecycle）
const { allProviders, activeProviderId, SYSTEM_DEFAULT_ID } = useProviders();
const { setProvider, providerOf, clearProvider, migrateProvider } = useSessionProviders();

function emptyBinding(): Binding {
  return { meta: null, runtimeModel: "", draft: "", restored: "", sdkModels: [] };
}

function providerConfigOf(pid: string): ProviderConfig | null {
  // 可达兜底（非不可达）：pid 来自 providerOf / activeProviderId，但会话绑定可
  // 悬空指向已删除的供应商（deleteProvider 不清会话注册表，快路径也不修正）
  // ——find 可能 undefined，调用方回退空列表（见 providerModelsOf）。
  return allProviders.value.find((x) => x.id === pid) ?? null;
}

/** 第三方供应商的模型列表（providerModelList）。pid 悬空（供应商已删）→ 空列表。 */
function providerModelsOf(pid: string): ModelOption[] {
  const p = providerConfigOf(pid);
  return p ? providerModelList(p).map((v) => ({ value: v, displayName: v })) : [];
}

/** 全局口径的模型选项（无会话归属时用）：系统默认用 defaultModels，
 *  第三方用 providerModelList。不传 sid——这里不牵涉会话身份。 */
function activeProviderModels(): ModelOption[] {
  const pid = activeProviderId.value;
  if (pid === SYSTEM_DEFAULT_ID) return defaultModels.value;
  return providerModelsOf(pid);
}

/** 会话口径的模型选项：系统默认用 SDK 动态列表（无则 defaultModels 静态兜底），
 *  第三方用 providerModelList（静态配置）。 */
function displayModelsOf(sid: string): ModelOption[] {
  const pid = resolveEffectiveProvider(providerOf(sid), activeProviderId.value);
  if (pid === SYSTEM_DEFAULT_ID) {
    const sdk = bindings[sid]?.sdkModels ?? [];
    return sdk.length ? sdk : defaultModels.value;
  }
  return providerModelsOf(pid);
}

/** 会话的生效供应商：绑定 id > 全局 active。sid 为空 → 全局 active。 */
function effectiveProviderOf(sid: string | null): string {
  if (!sid) return activeProviderId.value; // 不传空串给 providerOf
  return resolveEffectiveProvider(providerOf(sid), activeProviderId.value);
}

/** 会话的生效模型：draft > runtime > restored > 列表首项（详见 resolver 的兜底链）。
 *  sid 为空的空白面板分支不在这里——草稿是视图态，由 view 处理。 */
function effectiveModelOf(sid: string): string {
  const b = bindings[sid] ?? emptyBinding();
  return resolveEffectiveModel(
    { draft: b.draft, runtime: b.runtimeModel, restored: b.restored },
    displayModelsOf(sid).map((m) => m.value),
  );
}

async function healProviderIfDirty(sid: string, meta: SessionMeta | null, resolved: string): Promise<void> {
  if (meta?.provider && meta.provider !== resolved) {
    await writeSessionMeta(sid, { provider: { op: "set", value: resolved } }).catch((e) => {
      console.warn("[sessionIdentity] self-heal provider failed:", sid, resolved, e);
    });
  }
}

// resolve 慢路径：无内存绑定 → 读盘 + 一致性校验 + self-heal + 恢复模型 + 置基线。
//
// **不 setProvider**：注册表的写入方只有「发送 / spawn」一个（见 useSessionProviders
// 的契约注释），此处若写，等于把「仅仅打开预览」也变成绑定时机 —— 未启动会话就
// 被锁死在盘上记的供应商，全局切了供应商下拉也不动它，且无从改回。
// 现在的语义统一为：**有活进程才锁定（spawn 时写），没活进程就跟随全局**。
async function restoreBinding(sid: string): Promise<void> {
  const meta = await readSessionMeta(sid);
  const resolved = consistentProviderId(allProviders.value, meta?.provider ?? null, meta?.model ?? null)
    ?? activeProviderId.value;
  await healProviderIfDirty(sid, meta, resolved);
  const restored = restoreModel(displayModelsOf(sid), meta?.model ?? null);
  bindings[sid] = { meta, runtimeModel: "", draft: "", restored, sdkModels: [] };
  lastProviderBySid[sid] = resolved;
}

// resolve 快路径：有内存绑定 → 只读盘刷基线，不动注册表不写盘。
async function refreshBinding(sid: string, bound: string): Promise<void> {
  const meta = await readSessionMeta(sid);
  const resolved = consistentProviderId(allProviders.value, meta?.provider ?? null, meta?.model ?? null)
    ?? bound;
  const restored = restoreModel(displayModelsOf(sid), meta?.model ?? null);
  const prev = bindings[sid];
  bindings[sid] = { ...prev, meta, restored };
  lastProviderBySid[sid] = resolved;
}

/** 会话身份恢复入口（由 view 在切会话时驱动）。有绑定走快路径，无绑定走慢路径。 */
async function resolve(sid: string): Promise<void> {
  const bound = providerOf(sid);
  if (bound) await refreshBinding(sid, bound);
  else await restoreBinding(sid);
}

/** 发送前统一收尾（供应商维度）：绑定确保 + provider 落盘 + 门控基线推进，三者同源。
 *  模型身份的落盘不在这里——由 model_committed 事件驱动（commitModelFromRuntime）。
 *  sid 空（空白面板首发）：只推进基线（会话还没创建，落盘推迟到 finalize 用 realId）。 */
async function settleOnSend(sid: string, effectiveProvider: string): Promise<void> {
  if (sid) lastProviderBySid[sid] = effectiveProvider;
  if (!sid) return;
  if (!providerOf(sid)) setProvider(sid, effectiveProvider);
  const prev = bindings[sid] ?? emptyBinding();
  if (prev.meta?.provider === effectiveProvider) return;
  try {
    await writeSessionMeta(sid, { provider: { op: "set", value: effectiveProvider } });
    bindings[sid] = { ...prev, meta: { provider: effectiveProvider, model: prev.meta?.model ?? null } };
  } catch (e) {
    // 落盘失败也建绑定（空绑定，meta 保持盘上状态）：provider 已在 try 前 setProvider，
    // 绑定不建则 resolve 快路径"providerOf 非空 ⟹ binding 已建"不变式被失败打破。
    if (!bindings[sid]) bindings[sid] = emptyBinding();
    console.warn("[sessionIdentity] settleOnSend persist failed:", sid, e);
  }
}

/** 模型身份的进程坐实落盘（model_committed 事件驱动）：bindRuntime + 落盘一体。
 *  requestedModel=null（CLI 内部切换）→ 只 bindRuntime 不落盘（没有用户选择可恢复）。 */
async function commitModelFromRuntime(
  sid: string,
  committed: { fromModel: string; toModel: string; requestedModel: string | null; source: string },
): Promise<void> {
  if (!sid) return;
  if (committed.requestedModel) bindRuntime(sid, committed.requestedModel);
  const prev = bindings[sid] ?? emptyBinding();
  if (!committed.requestedModel || prev.meta?.model === committed.requestedModel) return;
  try {
    await writeSessionMeta(sid, { model: { op: "set", value: committed.requestedModel } });
    bindings[sid] = { ...prev, meta: { provider: prev.meta?.provider ?? null, model: committed.requestedModel } };
  } catch (e) {
    if (!bindings[sid]) bindings[sid] = emptyBinding();
    console.warn("[sessionIdentity] commitModelFromRuntime persist failed:", sid, e);
  }
}

/** 用户手选草稿（带 sid）。只写 draft，不落盘——落盘由 model_committed 坐实事件驱动。 */
function setUserChoice(sid: string, model: string): void {
  if (!sid) return;
  const prev = bindings[sid] ?? emptyBinding();
  bindings[sid] = { ...prev, draft: model };
}

/** models_available 事件坐实 SDK 动态模型列表（系统默认下拉用）。不落盘。 */
function setSdkModels(sid: string, models: ModelOption[]): void {
  const prev = bindings[sid] ?? emptyBinding();
  bindings[sid] = { ...prev, sdkModels: models };
}

/** sidecar 运行时坐实当前模型。不落盘。 */
function bindRuntime(sid: string, model: string): void {
  const prev = bindings[sid] ?? emptyBinding();
  bindings[sid] = { ...prev, runtimeModel: model };
}

/** 释放绑定（stop 会话用）。删注册表 + binding；落盘身份保留。 */
function releaseBinding(sid: string): void {
  clearProvider(sid);
  delete bindings[sid];
}

/** 定名搬迁（tempId → realId）：绑定与基线随 sid 迁移。 */
function migrateBinding(oldSid: string, newSid: string): void {
  migrateProvider(oldSid, newSid);
  if (bindings[oldSid]) {
    bindings[newSid] = bindings[oldSid];
    delete bindings[oldSid];
  }
  if (lastProviderBySid[oldSid] !== undefined) {
    lastProviderBySid[newSid] = lastProviderBySid[oldSid];
    delete lastProviderBySid[oldSid];
  }
}

/** 本次 spawn 将使用的供应商（与 Rust `resolve_send_provider` 的回落顺序一致：
 *  会话绑定 > 全局 active）。spawn 前记录，定名后由 finalizeSpawn 落到 realId。 */
function spawnProviderOf(sid: string): string {
  return providerOf(sid) ?? activeProviderId.value;
}

/** 定名后坐实身份（tempId → realId 之后调用）：把 spawn 时记录的 provider 落盘 + 推进基线。
 *
 *  取代此前的 `settleOnSend(realId, identity.effectiveProvider.value)`——后者读的是
 *  **视图**状态（"某个面板正在看谁"）：新建会话首发后若用户切走 tab，effectiveProvider
 *  就成了别的会话的供应商 → **新会话被落盘成别人的供应商**。定名坐实只能用
 *  这条会话自己的记录，与面板无关。
 */
async function finalizeSpawn(realId: string): Promise<void> {
  const pid = lastProviderBySid[realId] ?? activeProviderId.value;
  await settleOnSend(realId, pid);
}

/** 读系统默认静态兜底模型列表（ChatPanel onMounted 调）。 */
async function refreshDefaultModels(): Promise<void> {
  try {
    defaultModels.value = await api.getDefaultModels();
  } catch (e) {
    console.warn("[sessionIdentity] load default models failed:", e);
  }
}

/** @internal 测试重置全部仓库状态。 */
function __resetForTest(): void {
  for (const k of Object.keys(bindings)) delete bindings[k];
  for (const k of Object.keys(lastProviderBySid)) delete lastProviderBySid[k];
  defaultModels.value = [];
}

/** 全局唯一的会话身份仓库。非组件调用方（事件 / stop / 发送收尾）一律用它——
 *  它们没有面板归属，也不该读视图状态。 */
export const sessionIdentityStore = {
  // ── 状态 ──
  defaultModels,
  // ── 查询 ──
  providerOf,
  activeProviderModels,
  displayModelsOf,
  effectiveProviderOf,
  effectiveModelOf,
  spawnProviderOf,
  lastProviderOf: (sid: string | null): string | null =>
    sid ? (lastProviderBySid[sid] ?? null) : null,
  // ── 写入 ──
  resolve,
  settleOnSend,
  finalizeSpawn,
  commitModelFromRuntime,
  setUserChoice,
  setSdkModels,
  bindRuntime,
  releaseBinding,
  migrateBinding,
  refreshDefaultModels,
  __resetForTest,
};

export type SessionIdentityStore = typeof sessionIdentityStore;
