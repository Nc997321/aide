import type { ProviderConfig } from "../types";

/** 系统默认供应商哨兵 id——唯一权威定义处（useProviders 从此 import，不再本地定义）。 */
export const SYSTEM_DEFAULT_ID = "__system_default__";

/** 供应商可选的模型列表（去重、去空）：顶层 model + 模型变量映射 + knownModels。
 *  ChatPanel 的下拉（providerModels）与会话一致性校验（consistentProviderId）共用
 *  同一口径——两处逻辑漂移会让「下拉看到什么」与「校验认定什么」不一致。 */
export function providerModelList(p: ProviderConfig): string[] {
  const m = p.modelMappings;
  const vals = [
    p.model,
    m?.anthropicModel,
    m?.defaultOpusModel,
    m?.defaultSonnetModel,
    m?.defaultHaikuModel,
    m?.subagent,
    ...p.knownModels,
  ].filter((v): v is string => !!v && typeof v === "string");
  return [...new Set(vals)];
}

/** 反查：哪个 provider 的模型列表里含该模型（一致性命中的修正方向）。多个命中取
 *  列表第一个（确定性——歧义场景下选谁没有本质差别，都是「模型归属可疑」）；
 *  没有命中返回 null。 */
export function findProviderForModel(providers: ProviderConfig[], model: string): ProviderConfig | null {
  if (!model) return null;
  return providers.find((p) => providerModelList(p).includes(model)) ?? null;
}

/** provider 的模型「可信」判定：系统默认（模型列表为空是常态，SDK 动态模型不下沉
 *  到配置）与「会话没记过模型」都直接信任；其余按模型是否在列表里校验。 */
function trustsProviderModel(p: ProviderConfig, model: string | null): boolean {
  if (p.id === SYSTEM_DEFAULT_ID || !model) return true;
  return providerModelList(p).includes(model);
}

/** 会话 provider 身份一致性解析（纯函数，唯一的「会话属于哪个供应商」判定）：
 *
 *  - 持久化 provider 存在且仍在列表：模型为空 / 在列表（系统默认特判）→ 信任；
 *    模型不在列表（污染特征：provider 字段被全局 active 盖写过、model 却还是原
 *    供应商的）→ 按模型反查修正。
 *  - 持久化 provider 不存在（新会话）或已被删除 → 按模型反查；找不到 → null
 *    （无身份，回落全局 active）。
 *  - 反查无果时保守保持原 provider（不动拿不准的数据）。
 *
 * 返回 null = 无会话身份（新会话 / 供应商全无）。
 */
export function consistentProviderId(
  providers: ProviderConfig[],
  persistedProvider: string | null,
  persistedModel: string | null,
): string | null {
  if (!persistedProvider) return providerFromModel(providers, persistedModel);
  const p = providers.find((x) => x.id === persistedProvider);
  if (!p) return providerFromModel(providers, persistedModel);
  if (trustsProviderModel(p, persistedModel)) return persistedProvider;
  return providerFromModel(providers, persistedModel) ?? persistedProvider;
}

/** model 反查（无 provider 身份 / provider 被删时的修正方向）；model 空 → null。 */
function providerFromModel(providers: ProviderConfig[], model: string | null): string | null {
  if (!model) return null;
  return findProviderForModel(providers, model)?.id ?? null;
}
