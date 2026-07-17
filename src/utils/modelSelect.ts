import type { ModelOption } from "../types/chat";

/**
 * 在模型下拉的可选项里解析出一个「一定在列表里」的选中值，绝不让下拉显示空。
 *
 * 解决两类「收到回复后下拉变空」根因：
 *  - 第三方 provider：下拉列表装的是真实模型 id（deepseek-v4-flash），而 sidecar
 *    回报的 current 往往是 Claude 别名（sonnet/opus）或对不上的 id —— 不在列表里。
 *    若无脑采信会写下拉没有的值，ThemedSelect 找不到匹配项 → 显示空。
 *  - 系统默认 Claude：会话启动后列表从静态兜底切到 SDK 真实列表，用户先前选的
 *    模型可能不在新列表里（如静态列表有 fable、SDK 没报）。需要退化到默认/首项。
 *
 * 优先级（任一命中即返回，保证返回值 ∈ 列表；列表空返回 ""）：
 *  1. sdkCurrent —— SDK 坐实的当前模型，若在列表里则采信（反映真实在跑的模型）。
 *     applyDefaultModel 调用时传 "" 以跳过此项，保留「重置/列表变更」语义不变。
 *  2. existing —— 用户已选 / 上次坐实的值，若仍在列表里则保留（尊重用户选择）。
 *  3. providerDefault —— 供应商配置里显式指定的默认模型，若在列表里。
 *  4. 列表第一项。
 *
 * 任意优先级的候选值本身为空串即视为不命中（`has("")` → false）。
 */
export function pickModelValue(
  models: ModelOption[],
  existing: string,
  sdkCurrent: string,
  providerDefault: string,
): string {
  if (!models.length) return "";
  const has = (v: string): boolean => !!v && models.some((m) => m.value === v);
  if (has(sdkCurrent)) return sdkCurrent;
  if (has(existing)) return existing;
  if (has(providerDefault)) return providerDefault;
  return models[0].value;
}

/** value 是否在当前可选模型列表里——恢复会话记忆的模型、采信 remembered
 *  候选前的统一校验（换过 provider 后旧记忆不在新列表里，必须不采信）。 */
export function isModelInList(models: ModelOption[], value: string | null | undefined): boolean {
  return !!value && models.some((m) => m.value === value);
}