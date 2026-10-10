/** 自动化任务的「供应商 → 模型」级联选项——任务自持供应商，与聊天面板同源。
 *
 *  一级 = 全部供应商（`useProviders().displayList`），二级 = 该供应商的模型列表
 *  （`providerModelList`：顶层 model + 5 个模型变量映射 + knownModels；系统默认
 *  供应商的 knownModels 由 Rust `view()` 从 catalog 预设读）。
 *  这里**不写死任何模型名**：写死过一版 Claude 名单（claude-sonnet-5 / -opus-5 /
 *  -fable-5），配第三方供应商时既不是该供应商的模型、也可能被端点 400/404 直接拒。
 *
 *  选中值是一对 `(providerId, model)`：
 *  - providerId 空 = 没钉过供应商（新任务 / 存量任务）→ 按**当前激活供应商**展示与保存；
 *  - model 空 = 用该供应商自己的默认模型（Rust 侧据此不覆盖 ANTHROPIC_MODEL，
 *    见 automation/scheduler.rs 的 `task_env`）。
 */
import { useProviders } from "@/composables/useProviders";
import { providerModelList } from "@aide/sdk/utils/provider";

export interface ModelSelectOption {
  value: string;
  label: string;
}

export interface ProviderModelGroup {
  id: string;
  name: string;
  /** 首项恒为「默认模型」（value 空）；供应商没有模型清单时只有这一项。 */
  models: ModelSelectOption[];
}

export interface ProviderModelSelection {
  providerId: string;
  model: string;
}

const DEFAULT_MODEL_LABEL = "默认模型";

/** 没钉过供应商的任务按当前激活供应商算。 */
export function effectiveProviderId(providerId: string): string {
  return providerId || useProviders().activeProviderId.value;
}

/** 全部供应商及各自的模型，再兜住列表外的当前值。 */
export function automationProviderGroups(current: ProviderModelSelection): ProviderModelGroup[] {
  const currentPid = effectiveProviderId(current.providerId);
  return useProviders().displayList.value.map((p) => {
    const configuredDefault = p.modelMappings?.anthropicModel || p.model;
    const models: ModelSelectOption[] = [
      {
        value: "",
        label: configuredDefault ? `${DEFAULT_MODEL_LABEL}（${configuredDefault}）` : DEFAULT_MODEL_LABEL,
      },
      ...providerModelList(p).map((m) => ({ value: m, label: m })),
    ];
    // 编辑旧任务时当前值可能已不在该供应商列表里（供应商改了模型清单）：
    // 原样保留成一项，用户看得见也改得掉——不静默改写任务。
    if (p.id === currentPid && current.model && !models.some((o) => o.value === current.model)) {
      models.push({ value: current.model, label: current.model });
    }
    return { id: p.id, name: p.name, models };
  });
}

/** 触发器上的文案：「供应商」或「供应商 · 模型」。供应商已被删除时如实说，不冒充别家。 */
export function automationSelectionLabel(current: ProviderModelSelection): string {
  const pid = effectiveProviderId(current.providerId);
  const provider = useProviders().displayList.value.find((p) => p.id === pid);
  // 供应商还没加载完时 pid 也查不到：只有任务**明确钉过**的 id 查不到才算「已删除」
  const name = provider?.name ?? (current.providerId ? "供应商已删除" : "");
  return [name, current.model].filter(Boolean).join(" · ");
}
