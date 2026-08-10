import { ref, reactive } from "vue";
import type {
  CustomizationType,
  CustomizationItem,
  CustomizationCategory,
} from "../types/customization";
import { customizationApi } from "../api/customization";

// ── Category Config ──

export const CUSTOMIZATION_CATEGORIES: CustomizationCategory[] = [
  {
    type: "agent",
    label: "智能体",
    // icon = Icon.vue 的字形 key（见 utils/icons.ts），不再是 emoji 字符
    icon: "agent",
    description: "管理 Claude Code 智能体配置",
  },
  {
    type: "skill",
    label: "技能",
    icon: "skill",
    description: "管理 Claude Code 技能脚本",
  },
  {
    type: "instruction",
    label: "指令",
    icon: "instruction",
    description: "编辑全局和项目指令",
  },
  {
    type: "hook",
    label: "钩构",
    icon: "hook",
    description: "管理事件钩子配置",
  },
  {
    type: "mcp_server",
    label: "MCP 服务器",
    icon: "mcp",
    description: "管理 MCP 服务器连接",
  },
];

// ── State ──

const items = reactive<Record<CustomizationType, CustomizationItem[]>>({
  agent: [],
  skill: [],
  instruction: [],
  hook: [],
  mcp_server: [],
});

const loading = reactive<Record<CustomizationType, boolean>>({
  agent: false,
  skill: false,
  instruction: false,
  hook: false,
  mcp_server: false,
});

const activeType = ref<CustomizationType | null>(null);
const activeItemId = ref<string | null>(null);
const editingItem = ref<CustomizationItem | null>(null);

// ── Computed ──

const activeItems = ref<CustomizationItem[]>([]);

// ── Actions ──

function deriveSource(path: string): NonNullable<CustomizationItem["source"]> {
  // 插件来源：路径含 plugins/cache（marketplace 装的插件包内）。其余暂归 user（项目级细分留后续）。
  if (path.includes("plugins") && path.includes("cache")) return "plugin";
  return "user";
}

async function loadItems(type: CustomizationType) {
  loading[type] = true;
  try {
    const list = await customizationApi.list(type);
    items[type] = list.map((it) => ({ ...it, source: it.source ?? deriveSource(it.path) }));
  } catch (e) {
    console.error(`Failed to load ${type}s:`, e);
    items[type] = [];
  } finally {
    loading[type] = false;
  }
}

async function loadAll() {
  await Promise.all(
    CUSTOMIZATION_CATEGORIES.map((cat) => loadItems(cat.type))
  );
}

function selectCategory(type: CustomizationType) {
  activeType.value = type;
  activeItems.value = items[type];
  activeItemId.value = null;
  editingItem.value = null;
}

function selectItem(id: string) {
  activeItemId.value = id;
  editingItem.value = items[activeType.value!].find((i) => i.id === id) || null;
}

function clearSelection() {
  activeItemId.value = null;
  editingItem.value = null;
}

async function createItem(type: CustomizationType, data: Partial<CustomizationItem>) {
  try {
    const item = await customizationApi.create(type, data);
    items[type].push(item);
    return item;
  } catch (e) {
    console.error(`Failed to create ${type}:`, e);
    throw e;
  }
}

async function updateItem(type: CustomizationType, id: string, data: Partial<CustomizationItem>) {
  try {
    await customizationApi.update(type, id, data);
    const index = items[type].findIndex((i) => i.id === id);
    if (index !== -1) {
      items[type][index] = { ...items[type][index], ...data };
    }
    if (editingItem.value?.id === id) {
      editingItem.value = { ...editingItem.value, ...data };
    }
  } catch (e) {
    console.error(`Failed to update ${type}:`, e);
    throw e;
  }
}

async function deleteItem(type: CustomizationType, id: string) {
  try {
    await customizationApi.delete(type, id);
    items[type] = items[type].filter((i) => i.id !== id);
    if (activeItemId.value === id) {
      clearSelection();
    }
  } catch (e) {
    console.error(`Failed to delete ${type}:`, e);
    throw e;
  }
}

async function toggleItem(type: CustomizationType, id: string, enabled: boolean) {
  try {
    await customizationApi.toggle(type, id, enabled);
    const item = items[type].find((i) => i.id === id);
    if (item) {
      item.enabled = enabled;
    }
  } catch (e) {
    console.error(`Failed to toggle ${type}:`, e);
    throw e;
  }
}

// ── Export ──

export function useCustomizations() {
  return {
    // State
    items,
    loading,
    activeType,
    activeItemId,
    editingItem,
    activeItems,

    // Categories
    categories: CUSTOMIZATION_CATEGORIES,

    // Actions
    loadItems,
    loadAll,
    selectCategory,
    selectItem,
    clearSelection,
    createItem,
    updateItem,
    deleteItem,
    toggleItem,
  };
}
