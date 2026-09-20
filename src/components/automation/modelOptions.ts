/** 自动化任务的模型下拉选项——**跟随当前供应商**，与聊天面板同源。
 *
 *  模型列表唯一来源 = `sessionIdentityStore.activeProviderModels()`
 *  （= providerModelList(活动供应商)：顶层 model + 5 个模型变量映射 + knownModels；
 *  系统默认供应商的 knownModels 由 Rust `view()` 从 catalog 预设读）。
 *  这里**不写死任何模型名**：写死过一版 Claude 名单（claude-sonnet-5 / -opus-5 /
 *  -fable-5），配第三方供应商时既不是该供应商的模型、也可能被端点 400/404 直接拒。
 */
import { sessionIdentityStore } from "@/composables/sessionIdentity";

export interface ModelSelectOption {
  value: string;
  label: string;
}

/** 空模型 = 跟随提供商默认：Rust 侧据此不下发 ANTHROPIC_MODEL（见 automation/scheduler.rs）。 */
const FOLLOW_PROVIDER: ModelSelectOption = { value: "", label: "跟随提供商默认" };

/** 供应商模型列表 + 「跟随提供商默认」，再兜住列表外的当前值。 */
export function automationModelOptions(current: string): ModelSelectOption[] {
  const fromProvider = sessionIdentityStore
    .activeProviderModels()
    .map((m) => ({ value: m.value, label: m.displayName }));
  const opts = [FOLLOW_PROVIDER, ...fromProvider];
  // 编辑旧任务时当前值可能已不在供应商列表里（换过供应商 / 供应商改了模型清单）：
  // 原样保留成一项，用户看得见也改得掉——不静默改写任务。
  if (current && !opts.some((o) => o.value === current)) {
    opts.push({ value: current, label: current });
  }
  return opts;
}
