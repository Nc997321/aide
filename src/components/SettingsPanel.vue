<script setup lang="ts">
import { ref, watch, onMounted, computed } from "vue";
import { useSettings } from "../composables/useSettings";
import { useCustomizations } from "../composables/useCustomizations";
import { api } from "../api";
import type { JdkEntry, SecretMutation } from "../types";
import CustomizationList from "./customizations/CustomizationList.vue";
import CustomizationDetail from "./customizations/CustomizationDetail.vue";
import MarketplaceTab from "./marketplace/MarketplaceTab.vue";
import PermissionsSettings from "./settings/PermissionsSettings.vue";
import DiagnosticsDashboard from "./DiagnosticsDashboard.vue";
import ProviderSettings from "./ProviderSettings.vue";
import ThemedSelect from "./ThemedSelect.vue";
import Icon from "./Icon.vue";

const themeOptions = [
  { value: "warm-dark", label: "Warm Dark" },
  { value: "catppuccin", label: "Catppuccin Mocha" },
  { value: "glass", label: "Glass（experimental）" },
  { value: "smoky-pink-glass", label: "Smoky Pink Glass（light）" },
];
const cgBackendOptions = [
  { value: "fastembed", label: "fastembed（本地 ONNX）" },
  { value: "http", label: "HTTP（Ollama / 云端）" },
];
const cgFormatOptions = [
  { value: "ollama", label: "ollama（/api/embed）" },
  { value: "openai", label: "openai（/v1/embeddings）" },
];
import { formatShortcut, detectConflicts } from "../utils/shortcut";
import { applyTheme, themes } from "../themes";

const props = defineProps<{
  initialTab?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

type Tab = "general" | "providers" | "permissions" | "extensions" | "marketplace" | "codegraph" | "java" | "diagnostics";

const activeTab = ref<Tab>((props.initialTab as Tab) || "general");

// ── Settings (通用) ──

const { settings, update, setCodegraphEmbedder, setJdkRegistry } = useSettings();
const fontSizeLocal = ref(settings.fontSize);
const fontFamilyLocal = ref(settings.fontFamily);
const notificationsEnabledLocal = ref(settings.notificationsEnabled);
const autoNamingLocal = ref(settings.autoNaming);
const proxyLocal = ref(settings.proxy);
const shellPathLocal = ref(settings.shellPath);
const recentLimitLocal = ref(settings.recentLimit);

watch(fontSizeLocal, (v) => { settings.fontSize = v; update({ fontSize: v }); });
watch(fontFamilyLocal, (v) => { settings.fontFamily = v; update({ fontFamily: v }); });
watch(notificationsEnabledLocal, (v) => { settings.notificationsEnabled = v; update({ notificationsEnabled: v }); });
watch(autoNamingLocal, (v) => { settings.autoNaming = v; update({ autoNaming: v }); });
watch(proxyLocal, (v) => { settings.proxy = v; update({ proxy: v }); });
watch(shellPathLocal, (v) => { settings.shellPath = v; update({ shellPath: v }); });
watch(recentLimitLocal, (v) => {
  const clamped = Math.max(1, Math.min(50, Math.floor(v) || 10));
  recentLimitLocal.value = clamped;
  settings.recentLimit = clamped;
  update({ recentLimit: clamped });
});

// ── CodeGraph embedding 后端 ──
// 整块写入：任一字段变动都把完整的 codegraphEmbedder 回写后端。下次 build
// 读新配置；model_name/dim 变 → meta 不匹配 → 自动全量重建（KISS，无 reinit 命令）。

const cgBackend = ref(settings.codegraphEmbedder.backend);
const cgBaseUrl = ref(settings.codegraphEmbedder.baseUrl);
// Credentials never join the global settings singleton: this is always blank on load.
const cgApiKey = ref("");
const cgModel = ref(settings.codegraphEmbedder.model);
const cgFormat = ref(settings.codegraphEmbedder.format);
const cgDim = ref(settings.codegraphEmbedder.dim);

function codegraphConfig() {
  return {
    backend: cgBackend.value,
    baseUrl: cgBaseUrl.value,
    apiKeyConfigured: settings.codegraphEmbedder.apiKeyConfigured,
    model: cgModel.value,
    format: cgFormat.value,
    dim: cgDim.value,
  } as const;
}

function flushCodegraphEmbedder() {
  void setCodegraphEmbedder(codegraphConfig());
}

async function saveCodegraphApiKey() {
  const value = cgApiKey.value;
  const mutation: SecretMutation = value ? { action: "set", value } : { action: "unchanged" };
  await setCodegraphEmbedder(codegraphConfig(), mutation);
  cgApiKey.value = "";
}

async function clearCodegraphApiKey() {
  await setCodegraphEmbedder(codegraphConfig(), { action: "clear" });
  cgApiKey.value = "";
}
watch(cgBackend, flushCodegraphEmbedder);
watch(cgBaseUrl, flushCodegraphEmbedder);
watch(cgModel, flushCodegraphEmbedder);
watch(cgFormat, flushCodegraphEmbedder);
watch(cgDim, (v) => {
  const clamped = Math.max(0, Math.floor(v) || 0);
  cgDim.value = clamped;
  flushCodegraphEmbedder();
});

// ── JDK 注册表（按项目选 JDK）──
// 机器级资源：扫描本机已装 JDK + 手动登记，存 AppSettings.jdkRegistry。
// 运行配置编辑器据此列出可选 JDK；选某条 → 该配置 env 注入 JAVA_HOME。
// 扫描结果与现有注册表按 path 去重合并（保留用户手动加的条目），整块写回。

const jdkScanning = ref(false);
const jdkScanMsg = ref("");
const manualPath = ref("");
const manualName = ref("");
const jdkResolving = ref(false);

function jdkEntries(): JdkEntry[] {
  return settings.jdkRegistry ?? [];
}

async function scanJdks() {
  jdkScanning.value = true;
  jdkScanMsg.value = "";
  try {
    const found = await api.scanJdks();
    // 按 path 去重合并：扫描结果覆盖同 path 条目（版本可能更新），保留扫描未覆盖的手动条目
    const byPath = new Map<string, JdkEntry>();
    for (const e of jdkEntries()) byPath.set(e.path, e);
    for (const e of found) byPath.set(e.path, e);
    const merged = Array.from(byPath.values());
    await setJdkRegistry(merged);
    jdkScanMsg.value = `扫描完成，发现 ${found.length} 个 JDK（共 ${merged.length} 个已登记）`;
  } catch (e) {
    jdkScanMsg.value = `扫描失败：${e}`;
  } finally {
    jdkScanning.value = false;
  }
}

async function addManualJdk() {
  const p = manualPath.value.trim();
  if (!p) return;
  jdkResolving.value = true;
  try {
    const resolved = await api.resolveJdk(p);
    if (!resolved) {
      jdkScanMsg.value = `未在 ${p} 找到有效的 JDK（缺少 release 文件）`;
      return;
    }
    // 用户给名优先，否则用解析出的目录名
    const name = manualName.value.trim() || resolved.name;
    const entry: JdkEntry = { name, version: resolved.version, path: resolved.path };
    // 同 path 替换，避免重复
    const filtered = jdkEntries().filter(e => e.path !== entry.path);
    await setJdkRegistry([...filtered, entry]);
    manualPath.value = "";
    manualName.value = "";
    jdkScanMsg.value = `已添加 ${name}（Java ${resolved.version}）`;
  } catch (e) {
    jdkScanMsg.value = `添加失败：${e}`;
  } finally {
    jdkResolving.value = false;
  }
}

async function removeJdk(path: string) {
  await setJdkRegistry(jdkEntries().filter(e => e.path !== path));
}

// ── Keybindings ──

const recordingKey = ref<string | null>(null);

const keybindingDefs: Array<{ key: string; label: string }> = [
  { key: "searchOpen", label: "打开搜索" },
  { key: "paneSplitRight", label: "会话 tab 向右拆分" },
  { key: "paneSplitDown", label: "会话 tab 向下拆分" },
  { key: "paneCloseTab", label: "关闭会话 tab" },
];

const keybindingDefaults: Record<string, string> = {
  searchOpen: "Ctrl+P",
  paneSplitRight: "Ctrl+\\",
  paneSplitDown: "Ctrl+Shift+\\",
  paneCloseTab: "Ctrl+W",
};

function keybindingValue(key: string): string {
  return settings.keybindings[key as keyof typeof settings.keybindings] || "";
}

const keybindingConflicts = computed(() => {
  const bindings: Record<string, string> = {};
  for (const def of keybindingDefs) {
    bindings[def.key] = settings.keybindings[def.key as keyof typeof settings.keybindings] || "";
  }
  return detectConflicts(bindings);
});

function startRecording(key: string) {
  recordingKey.value = key;
}

function onRecordKeydown(e: KeyboardEvent) {
  if (!recordingKey.value) return;
  e.preventDefault();
  e.stopPropagation();
  // Only record when a modifier key is held (to avoid recording plain letters)
  if (e.ctrlKey || e.metaKey || (e.altKey && e.key !== "Alt")) {
    const shortcut = formatShortcut(e);
    const kb = { ...settings.keybindings };
    (kb as any)[recordingKey.value] = shortcut;
    settings.keybindings = kb;
    update({ keybindings: kb });
  }
  recordingKey.value = null;
}

function onRecordBlur() {
  recordingKey.value = null;
}

function resetKeybinding(key: string) {
  const kb = { ...settings.keybindings };
  (kb as any)[key] = keybindingDefaults[key] ?? "";
  settings.keybindings = kb;
  update({ keybindings: kb });
}

// ── Theme ──

function onThemeChange(themeId: string) {
  const tokens = themes[themeId];
  if (tokens) {
    applyTheme(tokens);
    update({ theme: themeId });
    // 同步缓存主题 id，供 App.vue 启动时首屏直接应用，避免暗色兜底闪烁
    try { localStorage.setItem("aide.theme", themeId); } catch { /* ignore */ }
  }
}

// ── Customizations (扩展) ──

const {
  categories,
  items,
  activeType,
  activeItemId,
  editingItem,
  loading,
  loadAll,
  selectCategory,
  selectItem,
  clearSelection,
  createItem,
  updateItem,
  deleteItem,
  toggleItem,
} = useCustomizations();

onMounted(() => { loadAll(); });

function handleCreate(data: any) {
  if (activeType.value) createItem(activeType.value, data);
}

function handleUpdate(data: any) {
  if (activeType.value && activeItemId.value) updateItem(activeType.value, activeItemId.value, data);
}

function handleDelete() {
  if (activeType.value && activeItemId.value) deleteItem(activeType.value, activeItemId.value);
}

function handleToggle(id: string, enabled: boolean) {
  if (activeType.value) toggleItem(activeType.value, id, enabled);
}

function handleBack() {
  if (editingItem.value) {
    clearSelection();
  } else if (activeType.value) {
    activeType.value = null;
  }
}

// ── Overlay ──

function onKeydown(e: KeyboardEvent) {
  if (recordingKey.value) {
    onRecordKeydown(e);
    return;
  }
  if (e.key === "Escape") emit("close");
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains("settings-overlay")) {
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="settings-overlay" @click="onOverlayClick" @keydown="onKeydown">
      <div class="settings-dialog" @click.stop>
        <!-- Header -->
        <div class="dialog-header">
          <span class="dialog-title">设置</span>
          <button class="dialog-close" @click="emit('close')"><Icon name="close" :size="13" :stroke-width="1.4" /></button>
        </div>

        <div class="dialog-body">
          <!-- Left nav -->
          <nav class="side-nav">
            <button
              class="nav-item"
              :class="{ active: activeTab === 'general' }"
              @click="activeTab = 'general'"
            >
              <Icon class="nav-icon" name="general" :size="16" />
              <span class="nav-label">通用</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'providers' }"
              @click="activeTab = 'providers'"
            >
              <Icon class="nav-icon" name="model" :size="16" />
              <span class="nav-label">模型</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'permissions' }"
              @click="activeTab = 'permissions'"
            >
              <Icon class="nav-icon" name="key" :size="16" />
              <span class="nav-label">权限</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'extensions' }"
              @click="activeTab = 'extensions'"
            >
              <Icon class="nav-icon" name="extension" :size="16" />
              <span class="nav-label">扩展</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'marketplace' }"
              @click="activeTab = 'marketplace'"
            >
              <Icon class="nav-icon" name="market" :size="16" />
              <span class="nav-label">市场</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'codegraph' }"
              @click="activeTab = 'codegraph'"
            >
              <Icon class="nav-icon" name="cube" :size="16" />
              <span class="nav-label">代码索引</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'java' }"
              @click="activeTab = 'java'"
            >
              <Icon class="nav-icon" name="java" :size="16" />
              <span class="nav-label">Java</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'diagnostics' }"
              @click="activeTab = 'diagnostics'"
            >
              <Icon class="nav-icon" name="agent" :size="16" />
              <span class="nav-label">诊断</span>
            </button>
          </nav>

          <!-- Right content -->
          <div class="main-content">
            <!-- ── 通用 Tab ── -->
            <div v-if="activeTab === 'general'" class="tab-general">
              <div class="settings-field">
                <label class="field-label">代码字号</label>
                <div class="field-control">
                  <input
                    v-model.number="fontSizeLocal"
                    type="range"
                    min="11"
                    max="24"
                    class="slider"
                  />
                  <span class="field-value">{{ fontSizeLocal }}px</span>
                </div>
                <span class="field-hint">作用于文件编辑器与工作台终端</span>
              </div>

              <div class="settings-field">
                <label class="field-label">代码字体</label>
                <input
                  v-model="fontFamilyLocal"
                  class="text-input"
                  placeholder="输入等宽字体名称..."
                />
                <span class="field-hint">作用于文件编辑器与工作台终端，建议等宽字体</span>
              </div>

              <div class="settings-field">
                <label class="field-label">桌面通知</label>
                <div class="toggle-row">
                  <span class="field-hint">Claude 回复完成后发送通知</span>
                  <label class="toggle">
                    <input v-model="notificationsEnabledLocal" type="checkbox" />
                    <span class="toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">自动命名会话</label>
                <div class="toggle-row">
                  <span class="field-hint">首轮对话后根据内容自动生成会话标题（用户手动改过的名字不会被覆盖）</span>
                  <label class="toggle">
                    <input v-model="autoNamingLocal" type="checkbox" />
                    <span class="toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">最近访问保留条数</label>
                <div class="field-control">
                  <input
                    v-model.number="recentLimitLocal"
                    type="number"
                    min="1"
                    max="50"
                    class="text-input"
                    style="width: 80px"
                  />
                  <span class="field-hint">会话与文件各保留的最近条数（1–50）</span>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">网络代理</label>
                <input
                  v-model="proxyLocal"
                  class="text-input"
                  placeholder="例如 http://127.0.0.1:7890（Clash）"
                />
              </div>

              <div class="settings-field">
                <label class="field-label">工作台终端 Shell</label>
                <input
                  v-model="shellPathLocal"
                  class="text-input"
                  placeholder="留空自动探测（Windows: PowerShell / Linux: bash）"
                />
                <span class="field-hint">填绝对路径覆盖默认，如 C:\Program Files\Git\bin\bash.exe</span>
              </div>

              <div class="settings-field">
                <label class="field-label">主题</label>
                <ThemedSelect
                  :model-value="settings.theme"
                  :options="themeOptions"
                  @update:model-value="onThemeChange"
                />
              </div>

              <!-- ── Keybindings ── -->
              <div class="settings-section">
                <div class="section-title">快捷键</div>

                <div
                  v-for="def in keybindingDefs"
                  :key="def.key"
                  class="kb-row"
                >
                  <span class="kb-label">{{ def.label }}</span>
                  <div class="kb-control">
                    <input
                      class="kb-input"
                      :class="{ recording: recordingKey === def.key }"
                      :value="keybindingValue(def.key)"
                      readonly
                      :placeholder="recordingKey === def.key ? '按下快捷键...' : ''"
                      @click="startRecording(def.key)"
                      @blur="onRecordBlur"
                    />
                    <button
                      v-if="recordingKey === def.key"
                      class="kb-recording-hint"
                    >
                      录制中...
                    </button>
                    <button
                      v-else
                      class="kb-record-btn"
                      v-tooltip="'录制新快捷键'"
                      @click="startRecording(def.key)"
                    >
                      <Icon name="cursor" :size="13" />
                    </button>
                    <button
                      class="kb-reset-btn"
                      v-tooltip="'恢复默认'"
                      @click="resetKeybinding(def.key)"
                    >
                      <Icon name="reset" :size="13" />
                    </button>
                  </div>
                </div>

                <div v-if="keybindingConflicts.length > 0" class="kb-conflict-warn">
                  <Icon name="warning" :size="13" /> 快捷键冲突：
                  <span v-for="(pair, i) in keybindingConflicts" :key="i">
                    {{ keybindingDefs.find(d => d.key === pair[0])?.label }} 与
                    {{ keybindingDefs.find(d => d.key === pair[1])?.label }}
                    {{ i < keybindingConflicts.length - 1 ? '、' : '' }}
                  </span>
                </div>
              </div>

            </div>

            <!-- ── 模型 Tab ── -->
            <div v-else-if="activeTab === 'providers'" class="tab-providers">
              <ProviderSettings />
            </div>

            <!-- ── 权限 Tab ── -->
            <PermissionsSettings v-else-if="activeTab === 'permissions'" />

            <!-- ── 扩展 Tab ── -->
            <div v-else-if="activeTab === 'extensions'" class="tab-extensions">
              <!-- Back button (when not at category root) -->
              <div v-if="activeType" class="ext-back">
                <button class="back-btn" @click="handleBack"><Icon name="back" :size="13" /> {{ categories.find(c => c.type === activeType)?.label || '返回' }}</button>
              </div>

              <!-- Category grid -->
              <div v-if="!activeType" class="category-grid">
                <button
                  v-for="cat in categories"
                  :key="cat.type"
                  class="category-card"
                  @click="selectCategory(cat.type)"
                >
                  <Icon class="cat-icon" :name="cat.icon" :size="20" />
                  <div class="cat-info">
                    <div class="cat-label">{{ cat.label }}</div>
                    <div class="cat-desc">{{ cat.description }}</div>
                  </div>
                  <span class="cat-badge">{{ items[cat.type].length }}</span>
                </button>
              </div>

              <!-- Item list -->
              <CustomizationList
                v-else-if="!editingItem"
                :type="activeType"
                :items="items[activeType]"
                :loading="loading[activeType]"
                @select="selectItem"
                @create="handleCreate"
                @toggle="handleToggle"
              />

              <!-- Item detail -->
              <CustomizationDetail
                v-else
                :type="activeType"
                :item="editingItem"
                @update="handleUpdate"
                @delete="handleDelete"
                @back="clearSelection"
              />
            </div>

            <!-- ── 市场 Tab ── -->
            <div v-else-if="activeTab === 'marketplace'" class="tab-marketplace">
              <MarketplaceTab @go-settings="activeTab = 'general'" />
            </div>

            <!-- ── 代码索引 Tab ── -->
            <div v-else-if="activeTab === 'codegraph'" class="tab-codegraph">
              <div class="settings-field">
                <label class="field-label">Embedding 后端</label>
                <ThemedSelect
                  :model-value="cgBackend"
                  :options="cgBackendOptions"
                  @update:model-value="(v: string) => (cgBackend = v as 'fastembed' | 'http')"
                />
                <span class="field-hint">
                  fastembed = 本地 ONNX 离线推理（首次会下载模型）；http = Ollama / OpenAI 兼容云端，速度更快
                </span>
              </div>

              <template v-if="cgBackend === 'http'">
                <div class="settings-field">
                  <label class="field-label">API 格式</label>
                  <ThemedSelect
                    :model-value="cgFormat"
                    :options="cgFormatOptions"
                    @update:model-value="(v: string) => (cgFormat = v as 'ollama' | 'openai')"
                  />
                  <span class="field-hint">
                    ollama：原生 /api/embed（本地或远程 Ollama）；openai：/v1/embeddings（OpenAI / Jina 等兼容）
                  </span>
                </div>

                <div class="settings-field">
                  <label class="field-label">服务地址</label>
                  <input
                    v-model="cgBaseUrl"
                    class="text-input"
                    placeholder="http://localhost:11434（Ollama）或 https://api.openai.com"
                  />
                  <span class="field-hint">Ollama 本地默认 http://localhost:11434，也支持远程 HTTP 地址</span>
                </div>

                <div class="settings-field">
                  <label class="field-label">API Key</label>
                  <input
                    v-model="cgApiKey"
                    class="text-input"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="settings.codegraphEmbedder.apiKeyConfigured ? '已配置；输入新值后替换' : 'OpenAI / Jina 必填；Ollama 原生可空'"
                  />
                  <div class="cg-secret-actions">
                    <span class="field-hint">{{ settings.codegraphEmbedder.apiKeyConfigured ? '已配置（密钥不会回显）' : '未配置' }}</span>
                    <button class="cg-secret-btn" :disabled="!cgApiKey" @click="saveCodegraphApiKey">替换</button>
                    <button v-if="settings.codegraphEmbedder.apiKeyConfigured" class="cg-secret-btn" @click="clearCodegraphApiKey">清除</button>
                  </div>
                </div>

                <div class="settings-field">
                  <label class="field-label">模型</label>
                  <input
                    v-model="cgModel"
                    class="text-input"
                    placeholder="nomic-embed-text（Ollama）/ text-embedding-3-small（OpenAI）"
                  />
                </div>

                <div class="settings-field">
                  <label class="field-label">向量维度</label>
                  <div class="field-control">
                    <input
                      v-model.number="cgDim"
                      type="number"
                      min="0"
                      class="text-input"
                      style="width: 100px"
                    />
                    <span class="field-hint">0 = 自动从首次响应探测；nomic-embed-text=768，text-embedding-3-small=1536</span>
                  </div>
                </div>
              </template>

              <div v-else class="cg-info">
                <span class="field-hint">
                  本地 ONNX 推理（all-MiniLM-L6-v2，384 维）。首次使用会从 HuggingFace 下载 ~23MB 模型到本地缓存。
                  慢（约 50 个/秒）但离线可用——结构层（精确跳转）始终先就绪，语义搜索后台补全。
                </span>
              </div>

              <div class="cg-rebuild-note">
                <Icon name="warning" :size="13" />
                切换后端或模型会触发全量重建索引（向量维度 / 模型空间不兼容）。
              </div>
            </div>

            <!-- ── Java / JDK Tab ── -->
            <div v-else-if="activeTab === 'java'" class="tab-java">
              <div class="jdk-intro">
                <span class="field-hint">
                  登记 JDK 注册表（机器级，所有工作区共享）。在运行配置里按项目选不同 JDK，
                  启动时注入 JAVA_HOME——系统全局环境保持不动，Java 8 与 21 项目可并行编译。
                </span>
              </div>

              <div class="settings-field">
                <label class="field-label">扫描已安装 JDK</label>
                <div class="jdk-scan-row">
                  <button
                    class="jdk-scan-btn"
                    :disabled="jdkScanning"
                    @click="scanJdks"
                  >
                    <svg v-if="jdkScanning" class="jdk-spin" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M6 1.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <span>{{ jdkScanning ? "扫描中…" : "扫描本机 JDK" }}</span>
                  </button>
                  <span v-if="jdkScanMsg" class="jdk-scan-msg">{{ jdkScanMsg }}</span>
                </div>
                <span class="field-hint">扫描 Program Files / .jdks / sdkman 等常见安装位置（读取 release 文件取版本，不启动子进程）</span>
              </div>

              <div v-if="jdkEntries().length > 0" class="settings-field">
                <label class="field-label">已登记 JDK（{{ jdkEntries().length }}）</label>
                <div class="jdk-list">
                  <div v-for="jdk in jdkEntries()" :key="jdk.path" class="jdk-item">
                    <div class="jdk-item-main">
                      <span class="jdk-item-name">{{ jdk.name }}</span>
                      <span class="jdk-item-version">Java {{ jdk.version }}</span>
                    </div>
                    <span class="jdk-item-path" v-tooltip="jdk.path">{{ jdk.path }}</span>
                    <button
                      class="jdk-remove"
                      v-tooltip="'移除'"
                      @click="removeJdk(jdk.path)"
                    >－</button>
                  </div>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">手动添加</label>
                <div class="jdk-manual-row">
                  <input
                    v-model="manualName"
                    class="text-input jdk-manual-name"
                    placeholder="名称（可空，默认取目录名）"
                  />
                  <input
                    v-model="manualPath"
                    class="text-input jdk-manual-path"
                    placeholder="JDK home 路径，如 C:\Program Files\Java\jdk-21"
                  />
                  <button
                    class="jdk-scan-btn"
                    :disabled="jdkResolving || !manualPath.trim()"
                    @click="addManualJdk"
                  >
                    <span>{{ jdkResolving ? "校验中…" : "添加" }}</span>
                  </button>
                </div>
                <span class="field-hint">填 JDK home（含 release 文件的目录）→ 自动校验并解析版本号</span>
              </div>
            </div>

            <!-- ── 诊断 Tab ── -->
            <div v-else-if="activeTab === 'diagnostics'" class="tab-diagnostics">
              <DiagnosticsDashboard />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay ── */

.settings-overlay {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 1100：高于 RunConfigsDialog(1000)，使「从运行配置对话框跳转来扫描 JDK」时
   * 设置面板覆盖在对话框之上；对话框保持在下方挂载，靠 reactive 单例
   * settings.jdkRegistry 扫描后自动刷新下拉选项，关闭设置即回到对话框选 JDK。 */
  z-index: 1100;
  animation: fadeIn 0.12s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── Dialog ── */

.settings-dialog {
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  /* 按 aide 窗口百分比计算（overlay Teleport 到 body，vw/vh 即窗口尺寸），
   * 配 clamp 上下限：小窗不被撑爆（min 保底可读），大窗不铺满屏（max 封顶）。
   * 原 680×520 在大屏上偏小，现 80vw / 82vh 跟随窗口放大。 */
  width: clamp(680px, 80vw, 1180px);
  height: clamp(520px, 82vh, 820px);
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  animation: scaleIn var(--aide-ease-t);
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* ── Header ── */

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--aide-border-subtle);
  flex-shrink: 0;
  background: linear-gradient(180deg, var(--aide-border-subtle) 0%, transparent 100%), var(--aide-bg-raised);
}

.dialog-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

.dialog-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.12s;
  font-family: inherit;
}

.dialog-close:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

/* ── Body ── */

.dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ── Left nav ── */

.side-nav {
  width: 150px;
  flex-shrink: 0;
  background: var(--aide-bg-deep);
  padding: 10px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--aide-border-subtle);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--aide-radius-sm);
  border: none;
  background: transparent;
  color: var(--aide-text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: all var(--aide-ease-t);
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.nav-item.active {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
  font-weight: 500;
  box-shadow: inset 2px 0 0 var(--aide-accent);
}

.nav-icon {
  width: 18px;
  flex-shrink: 0;
  color: var(--aide-accent);
}

.nav-label {
  white-space: nowrap;
}

/* ── Main content ── */

.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-width: 0;
}

/* ── General tab ── */

.tab-general {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.settings-field {
  margin-bottom: 20px;
}

.settings-field:last-child {
  margin-bottom: 0;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--aide-text-primary);
  margin-bottom: 8px;
  font-weight: 500;
}

.field-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.slider {
  flex: 1;
  accent-color: var(--aide-accent);
  height: 4px;
  cursor: pointer;
}

.field-value {
  font-size: 12px;
  color: var(--aide-text-secondary);
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.text-input::placeholder {
  color: var(--aide-text-muted);
}

.text-input:focus {
  border-color: var(--aide-accent);
}

/* ── Toggle ── */

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-hint {
  font-size: 12px;
  color: var(--aide-text-muted);
}

.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.toggle-track {
  position: absolute;
  inset: 0;
  background: var(--aide-surface-hover);
  border-radius: 10px;
  transition: background 0.15s;
}

.toggle-track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--aide-text-primary);
  border-radius: 50%;
  transition: transform 0.15s;
}

.toggle input:checked + .toggle-track {
  /* 开关是 accentGradient 槽位的既定消费场景（theme-development.md §2.2「主按钮/开关/选中条渐变」），
     不用 success 绿——浅色主题下绿轨道与主题色割裂 */
  background: var(--aide-accent-gradient);
}

.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
  /* 滑球落在 accent 渐变轨道上，用 on-accent 前景（深色主题同理：
     深球压铜/蓝渐变，与主按钮深字同一配方）；未选中态保持 textPrimary */
  background: var(--aide-text-on-accent);
  transition: transform 0.15s, background 0.15s;
}

/* ── Extensions tab ── */

.tab-extensions {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ext-back {
  margin-bottom: 8px;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  color: var(--aide-text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: inherit;
  transition: all 0.12s;
}

.back-btn:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

/* Category grid */

.category-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.category-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: background 0.12s;
  width: 100%;
}

.category-card:hover {
  background: var(--aide-surface-default);
}

.cat-icon {
  width: 28px;
  flex-shrink: 0;
  color: var(--aide-accent);
}

.cat-info {
  flex: 1;
  min-width: 0;
}

.cat-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
}

.cat-desc {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 2px;
}

.cat-badge {
  font-size: 11px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

/* ── Providers tab ── */

.tab-providers {
  display: flex;
  height: 100%;
  margin: -20px;
}

/* ── Marketplace tab ── */

.tab-marketplace {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ── CodeGraph tab ── */

.tab-codegraph {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.cg-secret-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.cg-secret-btn {
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-base);
  color: var(--aide-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
}

.cg-secret-btn:hover:not(:disabled) {
  border-color: var(--aide-accent);
  color: var(--aide-text-primary);
}

.cg-secret-btn:disabled { opacity: 0.5; cursor: default; }

.cg-info {
  margin-top: 4px;
  margin-bottom: 16px;
}

.cg-rebuild-note {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  font-size: 11px;
  color: var(--aide-warning);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ── Java / JDK tab ── */

.tab-java {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.jdk-intro {
  margin-bottom: 18px;
}

.jdk-scan-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.jdk-scan-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-accent, var(--aide-info));
  color: var(--aide-bg-deep);
  border: none;
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.12s;
}
.jdk-scan-btn:hover:not(:disabled) {
  opacity: 0.9;
}
.jdk-scan-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.jdk-spin {
  animation: jdk-spin 0.8s linear infinite;
}
@keyframes jdk-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .jdk-spin { animation: none; }
}

.jdk-scan-msg {
  font-size: 12px;
  color: var(--aide-text-muted);
}

.jdk-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.jdk-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
}

.jdk-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.jdk-item-name {
  font-size: 13px;
  color: var(--aide-text-primary);
  font-weight: 500;
}

.jdk-item-version {
  font-size: 11px;
  color: var(--aide-accent, var(--aide-info));
  padding: 1px 6px;
  border-radius: var(--aide-radius-sm);
  background: color-mix(in srgb, var(--aide-accent, var(--aide-info)) 12%, transparent);
}

.jdk-item-path {
  flex: 1;
  font-size: 11px;
  color: var(--aide-text-muted);
  font-family: var(--aide-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jdk-remove {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.jdk-remove:hover {
  background: color-mix(in srgb, var(--aide-danger) 15%, transparent);
  color: var(--aide-danger);
}

.jdk-manual-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.jdk-manual-name {
  width: 160px;
  flex-shrink: 0;
}
.jdk-manual-path {
  flex: 1;
}

/* ── Scrollbar ── */

.main-content::-webkit-scrollbar {
  width: 4px;
}

.main-content::-webkit-scrollbar-track {
  background: transparent;
}

.main-content::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 2px;
}

/* ── Keybindings ── */

.settings-section {
  margin-top: 8px;
  border-top: 1px solid var(--aide-surface-default);
  padding-top: 16px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.kb-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.kb-label {
  font-size: 13px;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
}

.kb-control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.kb-input {
  width: 100px;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  padding: 4px 8px;
  font-size: 11px;
  color: var(--aide-text-primary);
  text-align: center;
  font-family: var(--aide-font-mono);
  cursor: pointer;
  transition: border-color 0.15s;
  outline: none;
}

.kb-input:hover {
  border-color: var(--aide-accent);
}

.kb-input.recording {
  border-color: var(--aide-success);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--aide-success) 30%, transparent);
  animation: kb-pulse 1s ease-in-out infinite;
}

@keyframes kb-pulse {
  0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--aide-success) 30%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-success) 15%, transparent); }
}

.kb-recording-hint {
  background: none;
  border: none;
  color: var(--aide-success);
  font-size: 10px;
  cursor: default;
  animation: kb-pulse 1s ease-in-out infinite;
  font-family: inherit;
}

.kb-record-btn,
.kb-reset-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 3px;
  transition: all 0.12s;
  font-family: inherit;
}

.kb-record-btn:hover,
.kb-reset-btn:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.kb-conflict-warn {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  font-size: 11px;
  color: var(--aide-warning);
}
</style>
