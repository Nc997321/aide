import { ref, type Ref } from "vue";
import { api } from "@/api";
import { useSessionProviders } from "./useSessionProviders";
import { consistentProviderId } from "@/utils/provider";
import type { ProviderConfig } from "@/types";

/**
 * 会话供应商/模型延续性 + 发送前确认门控。
 *
 * 解决两个相关问题（见 plan「跨会话串修复 + 会话供应商/模型延续 + 发送前确认提示」）：
 *
 * 1. **重开旧会话自动切回原供应商**：会话 spawn 时的供应商落盘进 `<sid>.json` 的
 *    `provider` 字段（由 useChatSession 的 provider 持久化 watcher 写）。重开（停止态、
 *    内存绑定丢失）时 `restoreBinding` 读回，若该供应商仍在 `allProviders` 里则
 *    `setProvider` 恢复该会话绑定——只恢复这一个会话，不动全局激活供应商，之后新建
 *    会话仍用全局激活。供应商被删则不恢复（sessionProvider 计算属性回落全局激活），
 *    发送时与会话上次不同 → `needsConfirm` 触发确认提示。
 *
 * 2. **发送前 fork/冷缓存确认**：`lastUsedModel`/`lastUsedProvider` 跟踪当前会话上次
 *    用的模型/供应商（重开时读回、发送后用 `noteSent` 推进）。停止/重开会话发送会
 *    respawn，若本次发送的 provider/模型与会话上次不同（fork + 提示缓存失效），
 *    `needsConfirm` 返回 true——ChatPanel 据此弹 PermissionDialog 的确认形态（变体 C：
 *    信息卡 + 取消/继续发送），确认才发、取消则保留输入。存活会话发送不 respawn，
 *    天然不弹；首次 spawn（无 lastUsed）也不弹。
 *
 * 不在此处管 UI——确认提示由 ChatPanel 经 PermissionDialog 渲染，本 composable 只
 * 负责「要不要弹」的判定与 lastUsed 状态。effort 不参与（不碰 prompt 缓存，不弹）。
 */
export function useSessionContinuity(allProviders: Ref<ProviderConfig[]>) {
  const { setProvider } = useSessionProviders();

  /** 当前会话上次持久化的模型（确认提示的基线之一）。null=没记过（首次 spawn）。 */
  const lastUsedModel = ref<string | null>(null);
  /** 当前会话上次持久化的供应商。null=没记过。 */
  const lastUsedProvider = ref<string | null>(null);

  /** 无内存绑定时（重开 / 新开）：读 session_provider + session_model → 一致性校验
   *  （consistentProviderId）后 setProvider 恢复该会话绑定（不动全局激活）；校验修
   *  正了身份时把修正值写回 `<sid>.json`（self-heal，防污染永久化）。
   *  同时把 lastUsed 置位。须在 ChatPanel 模型恢复前 await，让 displayModels 反映
   *  恢复后的供应商。 */
  async function restoreBinding(sid: string): Promise<void> {
    const [persistedProvider, persistedModel] = await Promise.all([
      api.sessionProvider(sid).catch(() => null),
      api.sessionModel(sid).catch(() => null),
    ]);
    const resolved = consistentProviderId(allProviders.value, persistedProvider, persistedModel);
    lastUsedProvider.value = resolved;
    lastUsedModel.value = persistedModel;
    if (resolved) {
      setProvider(sid, resolved);
      // 持久化 provider 与一致性校验结果不一致 = 元数据被污染（模型归属可疑），
      // 写回修正值，避免下次重开再走一遍污染路径。
      if (persistedProvider !== resolved) {
        void api.setSessionProvider(sid, resolved).catch((e) => {
          console.warn("[continuity] self-heal session provider failed:", sid, resolved, e);
        });
      }
    }
  }

  /** 有内存绑定时（存活会话 / 同一 app 运行内切走又切回）：只读 lastUsed，不重设绑定。
   *  lastUsedProvider 与 restoreBinding 同一解析口径（consistentProviderId）——两处
   *  不一致会让污染会话（provider 字段被盖写）在 needsConfirm 里把「解析身份 vs 原始
   *  持久化值」误判成切换，明明身份没变却弹确认。 */
  async function refreshLastUsed(sid: string): Promise<void> {
    const [persistedProvider, persistedModel] = await Promise.all([
      api.sessionProvider(sid).catch(() => null),
      api.sessionModel(sid).catch(() => null),
    ]);
    lastUsedProvider.value = consistentProviderId(allProviders.value, persistedProvider, persistedModel);
    lastUsedModel.value = persistedModel;
  }

  /** sid 清空（面板无会话）时清 lastUsed，避免上个会话的基线漏到下次比较。 */
  function clear(): void {
    lastUsedProvider.value = null;
    lastUsedModel.value = null;
  }

  /** 发送后推进基线：把 lastUsed 置成本次发送的 effective 值，下次发送比较新基线
   *  （避免「同模型连发被误判为切换」的假阳性）。 */
  function noteSent(effectiveProviderId: string, effectiveModel: string): void {
    lastUsedProvider.value = effectiveProviderId;
    lastUsedModel.value = effectiveModel;
  }

  /** 是否需要弹发送前确认：lastUsedProvider 存在（非首次 spawn）且本次发送的
   *  provider 或模型与会话上次不同（fork / 冷缓存代价）。 */
  function needsConfirm(effectiveProviderId: string, effectiveModel: string): boolean {
    const lp = lastUsedProvider.value;
    if (!lp) return false;
    if (effectiveProviderId !== lp) return true;
    if (effectiveModel !== (lastUsedModel.value ?? "")) return true;
    return false;
  }

  return { lastUsedModel, lastUsedProvider, restoreBinding, refreshLastUsed, clear, noteSent, needsConfirm };
}