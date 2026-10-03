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
// 静态初始值保证扩展 tab 无活跃会话时也能看到 5 个内建 hook；
// sidecar 会话 query 启动时 emit builtin_hooks_manifest 动态覆盖（反映实际挂载，
// subagentModel/skillGuard 条件挂）。
export const builtinHooks = ref<BuiltinHookManifest[]>([
  { id: "policy", event: "PreToolUse", matcher: ".*", purpose: "工具权限门控（权威前置层，不可越过）" },
  { id: "subagentModel", event: "PreToolUse", matcher: "^(Agent|Task)$", purpose: "子代理模型选择兜底（条件挂）" },
  { id: "skillGuard", event: "PreToolUse", matcher: "^Skill$", purpose: "子代理重型 skill 名单拦截（条件挂）" },
  { id: "kbMemoryGuard", event: "PreToolUse", matcher: "^(Write|Edit|MultiEdit|NotebookEdit)$", purpose: "知识库圈选改写那一轮不写记忆（拦 Write/Edit 落在 memory 目录；本轮用户消息不带圈选即恢复；条件挂）" },
  { id: "memoryEvents", event: "PostToolUse", matcher: "^(Read|Write|Edit|MultiEdit)$", purpose: "记忆观测台事件台账（memory 目录读写埋点，只记录不干预）" },
  { id: "lspGlance", event: "PostToolUse", matcher: "^(Grep|Bash)$", purpose: "grep 顺带作答：搜代码标识符时附上语言服务器的定义位置与真实引用数（语言服务器热了才附，不改工具结果；条件挂）" },
  { id: "stopEffort", event: "Stop", matcher: "—", purpose: "读本轮 effort 盖到 message_stop" },
  { id: "modelSwitchGuard", event: "PreModelSwitch", matcher: "—", purpose: "模型切换成本确认（缓存热+大体量才问，条件挂，支线不挂）" },
  { id: "modelSwitchCommitted", event: "PostModelSwitch", matcher: "—", purpose: "模型切换坐实上报（前端落盘依据，条件挂，支线不挂）" },
]);

// 内置 MCP server 静态清单（前端展示镜像）——in-process server 不写 settings.json、
// 不出现在 list_mcp_server，前端静态显示让用户知道有此内置 MCP。sidecar 每新增一个
// 内置 MCP（docsMcpRegistration 等）必须在此同步登记，否则面板不显示。
export interface BuiltinMcpServer {
  id: string;
  transport: string;
  purpose: string;
}
export const builtinMcpServers = ref<BuiltinMcpServer[]>([
  { id: "aide-docs", transport: "in-process", purpose: "内置文档工具（read_docx / write_docx / read_pdf，docx↔markdown、pdf→markdown），受信任工作区时挂载" },
  { id: "aide-knowledge", transport: "in-process", purpose: "内置知识库读写（读 search / read_document / list_spaces / list_documents 自动放行；写 create_document / create_folder / move_document / append_document / update_document / ingest_file / delete_document / edit_selection（只改你在文档里圈选的那一段，圈选生效期间其余写工具一律被拒）每次要你确认 —— 其中 move_document 会改变目录结构、delete_document 连带子文件夹与子文档且界面无恢复入口），受信任工作区挂载；未登录时工具返回登录引导" },
  { id: "aide-memory", transport: "in-process", purpose: "内置跨工作区记忆（read_memory：只读地参考其他工作区的记忆——你用 @ 附加的目录，以及知识库文档关联的项目；不带 id 看索引与条目名，带 id 读一条正文；不授予那些工作区的任何文件访问），自动放行；受信任工作区挂载" },
  { id: "aide-lsp", transport: "in-process", purpose: "内置代码导航（语言服务器）：lsp_definition 定义 + 整个函数体 / lsp_references 每处真实引用 + 所在函数 / lsp_symbols 一次定位多个名字 / lsp_outline 文件结构 + 行区间 / lsp_implementations 接口实现，全部自动放行；语言服务器没答上时同一发里给文本兜底（标明未验证）。受信任且有可用语言服务器的工作区挂载；要关掉用 AIDE_LSP_TOOLS=off" },
  { id: "aide-browser", transport: "in-process", purpose: "内置内嵌浏览器读写（browser_tabs 列视图 / browser_read 读页面骨架 / browser_act 点击·填值·悬停·按键（Enter/Esc/Tab 这类真实按键） / browser_wait 等条件成立或页面加载完 / browser_eval 在页面里执行脚本取回 JSON / browser_screenshot 截图 / browser_tab 自己开·关标签页、导航、把某个 tab 推到前台 / browser_network 列最近的 XHR/fetch（方法/URL/状态/耗时/响应片段）/ browser_console 列 console 与未捕获异常），全部自动放行 —— browser_eval 能读你已登录的任意页面、能发任意请求，信任级别等同于 Bash 工具；要关掉用 AIDE_BROWSER_TOOLS=off。agent 可以拥有自己的后台 tab：不显示的视图照常渲染（不被抢前台），只有 browser_tab 的 focus 动作才会切走你正在看的页面。受信任工作区挂载；只在桌面端有效" },
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
  // activeType 未选时（防御，UI 上选中项前必有分类）空列表兜底，不压 ! 断言
  editingItem.value = (activeType.value ? items[activeType.value] : []).find((i) => i.id === id) || null;
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
