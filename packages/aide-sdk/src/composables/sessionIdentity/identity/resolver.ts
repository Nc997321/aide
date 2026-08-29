/**
 * L2 纯函数：effectiveModel 兜底链 + effectiveProvider 口径。输入全显式，无副作用，
 * 可独立单测。被 useSessionIdentity 的 computed 调用。
 *
 * effectiveModel 优先级（一处写清，取代散落在 ChatInputBox 4 watcher + modelFallback
 * + applyDefaultModel 的多源解析）：
 *   draft > runtime > restored > currentList[0] > ""
 * restored 在 resolve 时由 restoreModel 算定（已含 meta 的 isModelInList 校验 + 列表兜底），
 * 故 effectiveModel 不再单独校验 meta。currentList 由调用方按 provider 归属算好
 * （第三方 providerModelList / 系统默认 SDK 动态列表），本函数不碰 ProviderConfig。
 */

/** effectiveModel 兜底链。binding 是候选聚合，currentList 是当前可选模型 id 列表。
 *  2 输入，符合 ts 规范 §一.2 数量红线。
 *  draft/runtime/restored 都校验在 currentList——sidecar 回报的 runtime 常是 Claude 别名
 *  （第三方 wire id → sonnet/opus），不在真实列表里，不校验会让下拉显示空。 */
export function resolveEffectiveModel(
  binding: { draft: string; runtime: string; restored: string },
  currentList: string[],
): string {
  if (binding.draft && currentList.includes(binding.draft)) return binding.draft;
  if (binding.runtime && currentList.includes(binding.runtime)) return binding.runtime;
  if (binding.restored && currentList.includes(binding.restored)) return binding.restored;
  return currentList[0] ?? "";
}

/** effectiveProvider 口径（纯函数）：绑定 id > activeProviderId。
 *  SYSTEM_DEFAULT 特判由调用方完成。 */
export function resolveEffectiveProvider(bound: string | null, active: string): string {
  return bound ?? active;
}