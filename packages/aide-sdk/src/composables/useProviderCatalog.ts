import { ref } from "vue";
import { api } from "../api";
import type { CatalogPreset, ProviderConfig, ProviderKind } from "../types";

const catalog = ref<CatalogPreset[]>([]);

/** 找 kind 对应的 preset；Custom / 未加载时返回 undefined。 */
function presetForKind(kind: ProviderKind): CatalogPreset | undefined {
  return catalog.value.find((p) => p.kind === kind);
}

/**
 * 单实例约束：返回还没被添加的 preset（addedKinds 里的置灰排除）。
 * catalog 不含 Custom——Custom 永远可加，由 picker 的「自定义」入口单独处理。
 */
function availablePresets(addedKinds: ProviderKind[]): CatalogPreset[] {
  return catalog.value.filter((p) => !addedKinds.includes(p.kind));
}

/**
 * 显示富化：预置 kind 的 name/icon/baseUrl 从 catalog 派生（内存态，对应 Rust enrich）。
 * ⚠️ CatalogPreset.base_url (snake) → ProviderConfig.baseUrl (camel) 映射。
 * Custom / catalog 未加载 / 未命中 → 原样返回（不崩）。
 * 不动凭证与 modelMappings——只富化身份三件套。
 */
function enrichForDisplay(p: ProviderConfig): ProviderConfig {
  if (p.kind === "custom") return p;
  const preset = presetForKind(p.kind);
  if (!preset) return p;
  return { ...p, name: preset.name, icon: preset.icon, baseUrl: preset.base_url };
}

async function loadCatalog(): Promise<void> {
  try {
    catalog.value = await api.getProviderCatalog();
  } catch (e) {
    console.warn("加载 provider catalog 失败:", e);
    // 保留空 catalog，UI 降级——预置 kind 显示空身份，不崩
  }
}

function __resetForTest(): void {
  catalog.value = [];
}

export function useProviderCatalog() {
  return { catalog, presetForKind, availablePresets, enrichForDisplay, loadCatalog, __resetForTest };
}
