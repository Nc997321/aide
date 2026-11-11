import type { ProviderConfig } from "@aide/sdk/types";
import { providerModelList } from "@aide/sdk/utils/provider";

/** 用当前草稿生成默认模型选项；包含旧独立默认值，不因映射变动清空选择。 */
export function defaultModelOptions(provider: ProviderConfig) {
  return [
    { value: "", label: "使用供应商默认" },
    ...providerModelList(provider).map((value) => ({
      value,
      label: provider.modelLabels?.[value] ?? value,
    })),
  ];
}
