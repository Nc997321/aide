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

// ── 内置 hook 清单（由 sidecar builtin_hooks_manifest 事件填充，会话启动时） ──
export interface BuiltinHookManifest {
  id: string;
  event: string;
  matcher: string;
  purpose: string;
}
// 内建 hook 静态清单（前端展示镜像，与 sidecar builtinHooks 注册表同源）。
// 静态初始值保证扩展 tab 无活跃会话时也能看到 6 个内建 hook；
// sidecar 会话 query 启动时 emit builtin_hooks_manifest 动态覆盖（反映实际挂载，
// 如 codegraphGrep 仅 codegraph 开时挂、subagentModel/skillGuard 条件挂）。
export const builtinHooks = ref<BuiltinHookManifest[]>([
  { id: "policy", event: "PreToolUse", matcher: ".*", purpose: "工具权限门控（权威前置层，不可越过）" },
  { id: "subagentModel", event: "PreToolUse", matcher: "^(Agent|Task)$", purpose: "子代理模型选择兜底（条件挂）" },
  { id: "imageGuard", event: "PreToolUse", matcher: "^Read$", purpose: "读图保护（image input 不可用时 deny）" },
  { id: "skillGuard", event: "PreToolUse", matcher: "^Skill$", purpose: "子代理重型 skill 名单拦截（条件挂）" },
  { id: "codegraphGrep", event: "PreToolUse", matcher: "^Grep$", purpose: "Grep 符号状 pattern 注入索引工具提示（条件挂：codegraph 开时）" },
  { id: "stopEffort", event: "Stop", matcher: "—", purpose: "读本轮 effort 盖到 message_stop" },
]);

// 内置 MCP server 静态清单（前端展示镜像）。codegraph 是 in-process server，
// 不写 settings.json、不出现在 list_mcp_server，前端静态显示让用户知道有此内置 MCP。
export interface BuiltinMcpServer {
  id: string;
  transport: string;
  purpose: string;
}
export const builtinMcpServers = ref<BuiltinMcpServer[]>([
  { id: "aide-codegraph", transport: "in-process", purpose: "内置代码索引（find_symbol / semantic_search / call_graph），codegraph 开 + 受信任工作区时挂载" },
]);

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
    builtinHooks,
    builtinMcpServers,
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
