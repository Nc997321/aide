<script setup lang="ts">
import { ref, watch, onMounted, computed } from "vue";
import { vOverlayLayer } from "../directives/overlayLayer";
import { useSettings } from "../composables/useSettings";
import { useOnboarding } from "../composables/useOnboarding";
import { useCustomizations } from "../composables/useCustomizations";
import { api } from "../api";
import type { OutputStyle, RemoteStatus, SessionListStyle, VimBindings } from "../types";
import { eventToVimKey } from "../extensions/vimKeybindings";
import type { CustomizationItem } from "../types/customization";
import CustomizationList from "./customizations/CustomizationList.vue";
import CustomizationDetail from "./customizations/CustomizationDetail.vue";
import DiagnosticsDashboard from "./DiagnosticsDashboard.vue";
import ProviderSettings from "./ProviderSettings.vue";
import ThemedSelect from "./ThemedSelect.vue";
import FontSelect from "./FontSelect.vue";
import Icon from "./Icon.vue";

const themeOptions = [
  { value: "warm-dark", label: "Warm Dark" },
  { value: "glass", label: "Glass（experimental）" },
  { value: "smoky-pink-glass", label: "Smoky Pink Glass（light）" },
];
const sessionListStyleOptions = [
  { value: "card", label: "卡片（渐变质感）" },
  { value: "row", label: "行式（简洁列表）" },
];
/** 输出样式（通用 tab）：值域与 @aide/sdk 的 OutputStyle 同形——内置四款 + 默认。
 *  自定义样式走插件通道（plugin 的 output-styles 目录），不在这里列。 */
const outputStyleOptions = [
  { value: "default", label: "默认（不改变输出风格）" },
  { value: "Proactive", label: "Proactive（多行动、少打断）" },
  { value: "Concise", label: "Concise（简洁作答）" },
  { value: "Explanatory", label: "Explanatory（附 Insight 讲解）" },
  { value: "Learning", label: "Learning（协作式，留 TODO(human) 给你写）" },
];
import { formatShortcut, detectConflicts } from "../utils/shortcut";
import { applyTheme, themes } from "../themes";

const props = defineProps<{
  initialTab?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

type Tab = "general" | "appearance" | "editor" | "providers" | "extensions" | "diagnostics" | "about" | "remote";

const activeTab = ref<Tab>((props.initialTab as Tab) || "general");

// ── 关于 ──
const appVersion = ref("");
onMounted(async () => {
  appVersion.value = await api.appVersion().catch(() => "");
  // 网络代理为空时探测本机活代理（env / git 配置 / 常见端口，Rust 侧 ~1-2s 后台跑），
  // 命中则提示一键填入——自动发现的「建议」交给用户确认，不静默生效。
  if (!settings.proxy) {
    const found = await api.detectAvailableProxy().catch(() => null);
    if (found) proxyHint.value = found;
  }
});

// ── Settings (通用) ──

const { settings, update } = useSettings();
const onboarding = useOnboarding();

/** 重新运行首次引导：置 onboarded=false + 打开向导 + 关闭设置面板。 */
function rerunOnboarding() {
  update({ onboarded: false });
  onboarding.open();
  emit("close");
}
function applyProxyHint() {
  proxyLocal.value = proxyHint.value || "";
  proxyHintDismissed.value = true;
}
const fontSizeLocal = ref(settings.fontSize);
const fontFamilyLocal = ref(settings.fontFamily);
const editorFontFamilyLocal = ref(settings.editorFontFamily);
const terminalFontFamilyLocal = ref(settings.terminalFontFamily);
const notificationsEnabledLocal = ref(settings.notificationsEnabled);
const proxyLocal = ref(settings.proxy);
/** 本机自动检测到的活代理（设置在空时提示一键填入）；null = 未检测到。 */
const proxyHint = ref<string | null>(null);
const proxyHintDismissed = ref(false);
const shellPathLocal = ref(settings.shellPath);
const recentLimitLocal = ref(settings.recentLimit);

// ── 编辑器 ──
// 整块写入：任一字段变动都把完整 editor 回写后端（后端 set_settings 按 top-level
// key 整体覆盖），与 codegraphEmbedder / jdkRegistry 同模式。缩进字符固定 Tab。
const indentSizeLocal = ref(settings.editor.indentSize);
const vimModeLocal = ref(settings.editor.vimMode);

watch(fontSizeLocal, (v) => { settings.fontSize = v; update({ fontSize: v }); });
watch(fontFamilyLocal, (v) => { settings.fontFamily = v; update({ fontFamily: v }); });
watch(editorFontFamilyLocal, (v) => { settings.editorFontFamily = v; update({ editorFontFamily: v }); });
watch(terminalFontFamilyLocal, (v) => { settings.terminalFontFamily = v; update({ terminalFontFamily: v }); });
watch(notificationsEnabledLocal, (v) => { settings.notificationsEnabled = v; update({ notificationsEnabled: v }); });
watch(proxyLocal, (v) => { settings.proxy = v; update({ proxy: v }); });
watch(shellPathLocal, (v) => { settings.shellPath = v; update({ shellPath: v }); });
watch(recentLimitLocal, (v) => {
  const clamped = Math.max(1, Math.min(50, Math.floor(v) || 10));
  recentLimitLocal.value = clamped;
  settings.recentLimit = clamped;
  update({ recentLimit: clamped });
});
watch(indentSizeLocal, (v) => {
  const clamped = Math.max(1, Math.min(16, Math.floor(v) || 4));
  indentSizeLocal.value = clamped;
  const editor = { ...settings.editor, indentSize: clamped };
  update({ editor });
});
watch(vimModeLocal, (v) => {
  const editor = { ...settings.editor, vimMode: v };
  update({ editor });
});

// ── Vim 键位映射（VSCodeVim 风格）──
// 行编辑直接改 settings.editor.vimKeybindings（CodeEditor deep watch 即时热
// 更新），随后整块 editor 回写持久化。
const vimKeymapModes: Array<{ key: keyof VimBindings; label: string }> = [
  { key: "normal", label: "Normal" },
  { key: "insert", label: "Insert" },
  { key: "visual", label: "Visual" },
];
const recordingVimKey = ref<{ mode: keyof VimBindings; index: number } | null>(null);

function persistVimBindings() {
  update({ editor: { ...settings.editor } });
}

/** 录制超时兜底：挂起后 30s 未按键自动取消——录制监听是 window capture、
 * 期间会吞掉所有按键（preventDefault + 写入 keys），挂起不放会「编辑器按键
 * 无法输入 + 映射被意外覆写」（曾发生：用户录完忘了，i/a 输入被吞、设置
 * 里的键被编辑器按键覆盖）。 */
const RECORD_TIMEOUT_MS = 30_000;

/**
 * 录制状态唯一收口：挂监听 / 卸监听 / 超时全部经由此处。
 * 不用 watchEffect 的 return-cleanup——实测（2026-08-24，jsdom 探针）rec 置
 * null 时 cleanup 不触发，keydown 监听残留，之后所有按键被吞并覆写 keys。
 */
let recordKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let recordTimer: ReturnType<typeof setTimeout> | null = null;

function teardownKeyRecording() {
  if (recordTimer) clearTimeout(recordTimer);
  recordTimer = null;
  if (recordKeydownHandler) {
    window.removeEventListener("keydown", recordKeydownHandler, true);
    recordKeydownHandler = null;
  }
}

function setRecordingState(next: { mode: keyof VimBindings; index: number } | null): void {
  if (!next) {
    teardownKeyRecording();
    recordingVimKey.value = null;
    return;
  }
  // 换行重录：先卸旧的再挂新的（幂等）
  teardownKeyRecording();
  recordingVimKey.value = next;
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const key = eventToVimKey(e);
    if (!key) return; // 纯修饰键 / 识别不了：继续录
    const rec = recordingVimKey.value;
    if (!rec) return;
    const bindings = settings.editor.vimKeybindings[rec.mode];
    if (bindings[rec.index]) bindings[rec.index].keys = key;
    setRecordingState(null); // 命中即收口：卸监听 + 清超时
    persistVimBindings();
  };
  recordKeydownHandler = onKey;
  window.addEventListener("keydown", onKey, true);
  recordTimer = setTimeout(() => setRecordingState(null), RECORD_TIMEOUT_MS);
}

function startRecordVimKey(mode: keyof VimBindings, index: number) {
  // toggle：再次点击同一行 = 取消（录制中必须可逆，见超时注释）
  if (isRecordingVimKey(mode, index)) {
    setRecordingState(null);
    return;
  }
  setRecordingState({ mode, index });
}

function isRecordingVimKey(mode: keyof VimBindings, index: number): boolean {
  return recordingVimKey.value?.mode === mode && recordingVimKey.value.index === index;
}

// 快捷目标（替代 datalist——原生下拉弹层不受 CSS 控制、无法主题化）。
// 每模式一组 chip，点击填到该模式最后一行（通常是刚「添加映射」的空行）。
const VIM_TARGET_SUGGESTIONS: readonly string[] = ["<Esc>", ":w", ":wq", ":q", ":q!", "gg", "G"];

function setVimTarget(mode: keyof VimBindings, target: string) {
  const bindings = settings.editor.vimKeybindings[mode];
  if (bindings.length === 0) bindings.push({ keys: "", to: "" });
  bindings[bindings.length - 1].to = target;
  persistVimBindings();
}

function addVimBinding(mode: keyof VimBindings) {
  settings.editor.vimKeybindings[mode].push({ keys: "", to: "" });
  persistVimBindings();
}

function removeVimBinding(mode: keyof VimBindings, index: number) {
  settings.editor.vimKeybindings[mode].splice(index, 1);
  // 正在录制被删的行 → 收口（卸监听 + 清超时），不留挂起监听吞键
  if (isRecordingVimKey(mode, index)) setRecordingState(null);
  persistVimBindings();
}

// ── 远程控制 ──
// 开关走专用命令（remote_set_enabled 同时启停网关）；URL/权限模式走 update 落盘。
// 状态快照（配对码/连接/已签发 token）每次进入 tab 时刷新。
const remotePermissionModeOptions = [
  { value: "auto", label: "自动模式（自动批准非危险工具）" },
  { value: "manual", label: "手动模式（不推荐远程使用）" },
];
const remoteEnabled = ref(settings.remote.enabled);
const remoteRelayUrl = ref(settings.remote.relayUrl);
/** 旧值迁移：权限模式 id 由 `default` 更名为 `manual`（对齐 CLI 命名）。已存盘的
 *  "default" 读回来匹配不上新清单，映射成 manual，别让下拉显示空白。 */
function normalizePermissionMode(v: string | undefined): string {
  return !v || v === "default" ? "manual" : v;
}
const remotePermissionMode = ref(normalizePermissionMode(settings.remote.permissionMode));
const remoteStatus = ref<RemoteStatus | null>(null);

/** 配对时间相对描述。粒度随间隔变粗：分钟 → 小时 → 天 → 具体日期。 */
function describeIssuedAt(ms: number): string {
  const diff = Date.now() - ms;
  // 时钟回拨/未来时间戳不猜，直接给绝对时间
  if (diff < 0) return new Date(ms).toLocaleString();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toLocaleDateString();
}

/** 「已配对设备」摘要：当前是单设备模型（新配对踢旧设备），所以最多一台。
 *  旧版签发的 token 没有时间戳记录，降级显示「时间未知」而非编一个。 */
const pairedDeviceSummary = computed(() => {
  const st = remoteStatus.value;
  if (!st?.tokenConfigured) return "无";
  if (st.tokenIssuedAt == null) return "1 台（配对时间未知）";
  return `1 台 · 配对於 ${describeIssuedAt(st.tokenIssuedAt)}`;
});

async function refreshRemoteStatus() {
  remoteStatus.value = await api.remoteGetStatus();
}
onMounted(() => { if (props.initialTab === "remote") refreshRemoteStatus(); });
watch(activeTab, (t) => { if (t === "remote") refreshRemoteStatus(); });

async function onRemoteEnabledChange(e: Event) {
  const enabled = (e.target as HTMLInputElement).checked;
  remoteEnabled.value = enabled;
  // 同步单例：面板 v-if 重挂载时 remoteEnabled 从单例初始化，不同步则重开设置显示旧值
  settings.remote.enabled = enabled;
  await api.remoteSetEnabled(enabled);
  refreshRemoteStatus();
}
function onRemoteRelayUrlChange(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  remoteRelayUrl.value = v;
  update({ remote: { ...settings.remote, relayUrl: v } });
}
function onRemotePermissionModeChange(v: string) {
  remotePermissionMode.value = v;
  update({ remote: { ...settings.remote, permissionMode: v } });
}
async function refreshPairingCode() {
  await api.remoteRefreshPairingCode();
  refreshRemoteStatus();
}
async function revokeRemote() {
  await api.remoteRevoke();
  refreshRemoteStatus();
}

// ── JDK 注册表（已搬走）──
// 2026-08-08：JDK 管理（注册表扫描/手动添加/移除 + 工作区 JDK 选择）整体迁入
// 标题栏 LspIndicator 面板的 JDK 区块；JDK 语义同时从 per-config 升级为工作区级
// （state.json workspace_jdks）。本面板不再承载 Java tab。

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
    // 录制的是任意键（含自定义 key），Keybindings 是固定字段接口——扩成
    // Record<string, string> 写入后再还原类型（单跳断言，字段集不受影响）
    const kb = { ...settings.keybindings } as Record<string, string>;
    kb[recordingKey.value] = shortcut;
    const merged = kb as typeof settings.keybindings;
    settings.keybindings = merged;
    update({ keybindings: merged });
  }
  recordingKey.value = null;
}

function onRecordBlur() {
  recordingKey.value = null;
}

function resetKeybinding(key: string) {
  const kb = { ...settings.keybindings } as Record<string, string>;
  kb[key] = keybindingDefaults[key] ?? "";
  const merged = kb as typeof settings.keybindings;
  settings.keybindings = merged;
  update({ keybindings: merged });
}

// ── Theme ──

/** 会话列表样式切换（主题样式 tab）：ThemedSelect 值域由 sessionListStyleOptions
 *  约束在 "card" | "row"，收窄安全。纯皮肤设置，侧栏响应式即时切换。 */
function onSessionListStyleChange(v: string) {
  update({ sessionListStyle: v as SessionListStyle });
}

/** 输出样式切换（通用 tab）：值域由 outputStyleOptions 约束在 OutputStyle 内，
 *  收窄安全（同 onSessionListStyleChange）。生效时机与「启用思考」同款——新会话起。 */
function onOutputStyleChange(v: string) {
  const style = v as OutputStyle;
  settings.outputStyle = style;
  update({ outputStyle: style });
}

function onThemeChange(themeId: string) {
  const tokens = themes[themeId];  if (tokens) {
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

// LSP 设置已搬到标题栏（LspIndicator）：开关 + 排除目录在标题栏面板操作。

function handleCreate(data: Partial<CustomizationItem>) {
  if (activeType.value) createItem(activeType.value, data);
}

function handleUpdate(data: Partial<CustomizationItem>) {
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
  // 消费标记（preventDefault）：PermissionDialog 的 window 级 Esc 见 defaultPrevented
  // 让路——设置面板开着时按 Esc 只关设置，不同时拒绝背后的权限请求。
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains("settings-overlay")) {
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="settings-overlay" v-overlay-layer @click="onOverlayClick" @keydown="onKeydown">
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
              :class="{ active: activeTab === 'appearance' }"
              @click="activeTab = 'appearance'"
            >
              <Icon class="nav-icon" name="spark" :size="16" />
              <span class="nav-label">主题样式</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'editor' }"
              @click="activeTab = 'editor'"
            >
              <Icon class="nav-icon" name="bracket" :size="16" />
              <span class="nav-label">编辑器</span>
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
              :class="{ active: activeTab === 'extensions' }"
              @click="activeTab = 'extensions'"
            >
              <Icon class="nav-icon" name="extension" :size="16" />
              <span class="nav-label">扩展</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'diagnostics' }"
              @click="activeTab = 'diagnostics'"
            >
              <Icon class="nav-icon" name="agent" :size="16" />
              <span class="nav-label">诊断</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'remote' }"
              @click="activeTab = 'remote'"
            >
              <Icon class="nav-icon" name="globe" :size="16" />
              <span class="nav-label">远程控制</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'about' }"
              @click="activeTab = 'about'"
            >
              <Icon class="nav-icon" name="info" :size="16" />
              <span class="nav-label">关于</span>
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
                <label class="field-label">界面字体</label>
                <FontSelect v-model="fontFamilyLocal" />
                <span class="field-hint">作用于界面正文（按钮/标签/面板）与聊天区，建议等宽字体</span>
              </div>

              <div class="settings-field">
                <label class="field-label">工作台终端字体</label>
                <FontSelect v-model="terminalFontFamilyLocal" />
                <span class="field-hint">作用于工作台终端、聊天流 Bash 输出块与后台任务面板</span>
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
                <label class="field-label">输出样式</label>
                <ThemedSelect
                  :model-value="settings.outputStyle"
                  :options="outputStyleOptions"
                  @update:model-value="onOutputStyleChange"
                />
                <span class="field-hint">改变 Claude 的角色/语气/输出格式（系统提示层），不改它知道什么。新会话起生效</span>
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
                <div v-if="proxyHint && !proxyHintDismissed && !proxyLocal" class="proxy-hint">
                  <span>检测到本机可用代理 {{ proxyHint }}</span>
                  <button class="cg-secret-btn" @click="applyProxyHint">应用</button>
                  <button class="cg-secret-btn" @click="proxyHintDismissed = true">忽略</button>
                </div>
                <span v-else-if="!proxyLocal" class="field-hint">留空 = 直连；聊天流量仅使用此处显式配置的代理</span>
              </div>

              <div class="settings-field">
                <label class="field-label">工作台终端 Shell</label>
                <input
                  v-model="shellPathLocal"
                  class="text-input"
                  placeholder="留空自动探测（Windows: PowerShell / macOS: zsh / Linux: bash）"
                />
                <span class="field-hint">填绝对路径覆盖默认，如 C:\Program Files\Git\bin\bash.exe 或 /bin/zsh</span>
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

            <!-- ── 主题样式 Tab ── -->
            <div v-else-if="activeTab === 'appearance'" class="tab-general">
              <div class="settings-field">
                <label class="field-label">主题</label>
                <ThemedSelect
                  :model-value="settings.theme"
                  :options="themeOptions"
                  @update:model-value="onThemeChange"
                />
                <span class="field-hint">界面整体配色主题，切换即时生效</span>
              </div>

              <div class="settings-field">
                <label class="field-label">会话列表样式</label>
                <ThemedSelect
                  :model-value="settings.sessionListStyle ?? 'card'"
                  :options="sessionListStyleOptions"
                  @update:model-value="onSessionListStyleChange"
                />
                <span class="field-hint">侧栏会话条目的呈现：卡片 = 渐变质感卡片；行式 = 简洁列表行</span>
              </div>
            </div>

            <!-- ── 编辑器 Tab ── -->
            <div v-else-if="activeTab === 'editor'" class="tab-editor">
              <div class="settings-field">
                <label class="field-label">缩进格数</label>
                <div class="field-control">
                  <input
                    v-model.number="indentSizeLocal"
                    type="number"
                    min="1"
                    max="16"
                    class="text-input indent-size-input"
                  />
                  <span class="field-value">{{ indentSizeLocal }} 格</span>
                </div>
                <span class="field-hint">回车自动缩进与 Tab 键每层插入一个 Tab 字符，此值控制其显示列宽（作用于文件编辑器）</span>
              </div>

              <div class="settings-field">
                <label class="field-label">Vim 模式</label>
                <div class="toggle-row">
                  <span class="field-hint">使用 Vim 键位编辑文件（normal / insert / visual 模式，支持 / 搜索与 : 命令；:w 保存、:wq 保存并关闭、:q 关闭需确认修改、:q! 放弃修改直接关）。第三方输入法会把按键截成组合输入导致直接写入字符，遇此情况请用系统自带输入法</span>
                  <label class="toggle">
                    <input v-model="vimModeLocal" type="checkbox" />
                    <span class="toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">Vim 键位映射</label>
                <span class="field-hint">把按键绑成 vim 键序列（如 jj → &lt;Esc&gt;）或内置命令（如 &lt;C-s&gt; → :w 保存、:wq 保存并关闭、:q/:q! 关闭）。点「录制」录入键；目标以 : 开头为内置命令（单键生效），否则为 vim 键序列（支持多键）</span>
                <div
                  v-if="recordingVimKey"
                  class="vim-recording-banner"
                  role="status"
                >
                  <span>正在录制「{{ vimKeymapModes.find((m) => m.key === recordingVimKey?.mode)?.label }}」模式第 {{ (recordingVimKey?.index ?? 0) + 1 }} 行：按要绑定的键（期间按键会被吞，30 秒无操作自动取消）</span>
                  <button class="vim-recording-cancel" @click="setRecordingState(null)">取消</button>
                </div>
                <div class="vim-keymap-list">
                  <div v-for="mode in vimKeymapModes" :key="mode.key" class="vim-keymap-mode">
                    <div class="vim-keymap-mode-label">{{ mode.label }}</div>
                    <div
                      v-for="(b, idx) in settings.editor.vimKeybindings[mode.key]"
                      :key="idx"
                      class="vim-keymap-row"
                    >
                      <button
                        class="vim-key-rec"
                        :class="{ recording: isRecordingVimKey(mode.key, idx) }"
                        @click="startRecordVimKey(mode.key, idx)"
                      >
                        {{ isRecordingVimKey(mode.key, idx) ? "按快捷键…" : b.keys || "点击录制" }}
                      </button>
                      <span class="vim-keymap-arrow">→</span>
                      <input
                        v-model="b.to"
                        class="vim-key-target"
                        placeholder="如 <Esc> 或 :w"
                        @change="persistVimBindings"
                      />
                      <button class="vim-key-del" @click="removeVimBinding(mode.key, idx)">×</button>
                    </div>
                    <div class="vim-keymap-suggest">
                      <button
                        v-for="t in VIM_TARGET_SUGGESTIONS"
                        :key="t"
                        class="vim-key-suggest"
                        @click="setVimTarget(mode.key, t)"
                      >
                        {{ t }}
                      </button>
                    </div>
                    <button class="vim-key-add" @click="addVimBinding(mode.key)">＋ 添加映射</button>
                  </div>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">文件编辑器字体</label>
                <FontSelect v-model="editorFontFamilyLocal" />
                <span class="field-hint">作用于文件编辑器与文件 diff 查看器</span>
              </div>
            </div>

            <!-- ── 模型 Tab ── -->
            <div v-else-if="activeTab === 'providers'" class="tab-providers">
              <ProviderSettings />
            </div>

            <!-- ── 扩展 Tab ── -->
            <div v-else-if="activeTab === 'extensions'" class="tab-extensions">
              <!-- 新会话生效提示（MCP/钩构） -->
              <div
                v-if="activeType === 'mcp_server' || activeType === 'hook'"
                class="ext-notice"
              >
                已保存的 MCP / 钩构配置<b>下次新会话生效</b>。点「测试连接」即时验证 MCP。
              </div>
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

            <!-- ── 诊断 Tab ── -->
            <div v-else-if="activeTab === 'diagnostics'" class="tab-diagnostics">
              <DiagnosticsDashboard />
            </div>

            <!-- ── 远程控制 Tab ── -->
            <div v-else-if="activeTab === 'remote'" class="tab-remote">
              <div class="settings-field">
                <label class="field-label">启用远程控制</label>
                <div class="toggle-row">
                  <span class="field-hint">手机 APP 通过自建中继远程控制本机 aide（发消息、看回复、看历史）</span>
                  <label class="toggle">
                    <input type="checkbox" :checked="remoteEnabled" @change="onRemoteEnabledChange" />
                    <span class="toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">中继 URL</label>
                <input
                  :value="remoteRelayUrl"
                  class="text-input"
                  placeholder="wss://relay.example.com"
                  @change="onRemoteRelayUrlChange"
                />
                <span class="field-hint">自建中继服务器地址（wss://…），手机 APP 填同一地址</span>
              </div>

              <div class="settings-field">
                <label class="field-label">远程会话权限模式</label>
                <ThemedSelect
                  :model-value="remotePermissionMode"
                  :options="remotePermissionModeOptions"
                  @update:model-value="onRemotePermissionModeChange"
                />
                <span class="field-hint">远程会话每次执行时读取，可随时切换、立即生效</span>
              </div>

              <div class="settings-field">
                <label class="field-label">配对码（10 分钟有效）</label>
                <div class="field-control">
                  <span class="remote-code">{{ remoteStatus?.pairingCode ?? "—" }}</span>
                  <button class="cg-secret-btn" @click="refreshPairingCode">刷新</button>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">连接状态</label>
                <span class="field-hint">{{ remoteStatus?.connected ? "已连接" : "未连接" }}</span>
                <!-- dev 构建默认不连中继（避免与安装版抢同一台设备身份互踢）：
                     不点破的话，这里会一直显示「未连接」，看起来像网络故障。 -->
                <span v-if="remoteStatus?.relaySuppressed" class="field-hint">
                  dev 构建不连中继——它与安装版共用同一台设备身份，同时注册会在中继上互踢。
                  要调试远程链路：先从托盘退出安装版，再用 AIDE_DEV_REMOTE=1 启动 dev。
                </span>
              </div>

              <div class="settings-field">
                <label class="field-label">已配对设备</label>
                <div class="field-control">
                  <span class="field-hint">{{ pairedDeviceSummary }}</span>
                  <button class="cg-secret-btn" @click="revokeRemote">吊销设备</button>
                </div>
                <span class="field-hint">
                  同时只允许一台：新设备配对会自动顶掉当前这台，旧设备将提示重新配对
                </span>
              </div>
            </div>

            <!-- ── 关于 Tab ── -->
            <div v-else-if="activeTab === 'about'" class="tab-about">
              <div class="about-card">
                <div class="about-name">
                  Aide
                  <span v-if="appVersion" class="about-version">v{{ appVersion }}</span>
                </div>
                <p class="about-desc">基于 Claude Agent SDK 构建的 Claude Code 非官方桌面客户端。</p>
                <p class="about-desc">
                  对话能力由内置的 Claude Agent SDK 提供，无需单独安装命令行工具；
                  在「设置 → 模型」中配置供应商凭证即可开始使用。
                </p>
                <div class="about-legal">
                  本项目与 Anthropic 无隶属、背书或赞助关系；"Claude" 是 Anthropic PBC 的商标。
                  Aide 以 MIT 协议开源。
                </div>
                <button class="rerun-onboarding" @click="rerunOnboarding">重新运行首次引导</button>
              </div>
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
  /* 1100：高于 RunConfigsDialog(1000)——对话框开着时打开设置，设置覆盖其上。
   * （JDK 跳转流程 2026-08-08 已随 Java tab 迁往标题栏 LspIndicator，此处仅保留
   * 层级关系本身。） */
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

/* ── Vim 键位映射 ── */
.vim-recording-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aide-space-2);
  margin-top: var(--aide-space-2);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 10%, transparent);
  border: 1px solid var(--aide-accent);
  border-radius: var(--aide-radius-sm);
}
.vim-recording-cancel {
  padding: 2px 10px;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.vim-recording-cancel:hover {
  background: var(--aide-surface-hover);
}
.vim-keymap-list {
  display: flex;
  flex-direction: column;
  gap: var(--aide-space-2);
  margin-top: var(--aide-space-2);
}
.vim-keymap-mode {
  display: flex;
  flex-direction: column;
  gap: var(--aide-space-1);
}
.vim-keymap-mode-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.vim-keymap-row {
  display: flex;
  align-items: center;
  gap: var(--aide-space-1);
}
.vim-key-rec {
  min-width: 96px;
  padding: 3px 8px;
  font-family: var(--cm-font-family, monospace);
  font-size: 12.5px;
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  text-align: center;
}
.vim-key-rec:hover {
  background: var(--aide-surface-hover);
}
.vim-key-rec.recording {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
  animation: vim-key-pulse 1s ease-in-out infinite;
}
@keyframes vim-key-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.vim-keymap-arrow {
  color: var(--aide-text-muted);
  font-size: 13px;
}
.vim-key-target {
  flex: 1;
  min-width: 0;
  padding: 3px 8px;
  font-size: 12.5px;
  font-family: var(--cm-font-family, monospace);
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
}
.vim-key-target:focus {
  outline: none;
  border-color: var(--aide-accent);
}
.vim-keymap-suggest {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aide-space-1);
  /* 对齐 target 输入框起点：rec 按钮 min-width(96px) + row gap(space-1=4px) */
  margin-left: 100px;
}
.vim-key-suggest {
  padding: 1px 7px;
  font-size: 11.5px;
  font-family: var(--cm-font-family, monospace);
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
}
.vim-key-suggest:hover {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}
.vim-key-del {
  padding: 2px 8px;
  font-size: 14px;
  line-height: 1;
  color: var(--aide-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
}
.vim-key-del:hover {
  color: var(--aide-danger);
  background: var(--aide-surface-hover);
}
.vim-key-add {
  align-self: flex-start;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: transparent;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
}
.vim-key-add:hover {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}

.tab-editor {
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

/* 缩进格数：窄数字输入，不占满整行 */
.indent-size-input {
  width: 80px;
  flex: 0 0 auto;
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

/* 网络代理「检测到活代理」提示条——建议交给用户确认，不静默生效 */
.proxy-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--aide-radius-sm);
  background: color-mix(in srgb, var(--aide-accent) 13%, transparent);
  border: 1px solid var(--aide-border-strong);
  color: var(--aide-text-secondary);
  font-size: 12px;
}
.proxy-hint span {
  flex: 1;
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
  /* 开关是 accentGradient 槽位的既定消费场景（「主按钮/开关/选中条渐变」），
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

.ext-notice {
  padding: 8px 12px;
  border-radius: var(--aide-radius-sm);
  background: color-mix(in srgb, var(--aide-accent) 13%, transparent);
  border: 1px solid var(--aide-border-strong);
  color: var(--aide-text-secondary);
  font-size: 12px;
  margin-bottom: 12px;
}
.ext-notice b {
  color: var(--aide-accent);
  font-weight: 600;
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

.remote-code {
  font-family: var(--aide-font-mono);
  font-size: 13px;
  letter-spacing: 0.08em;
  color: var(--aide-text-primary);
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

/* ── 关于 Tab ── */

.tab-about {
  display: flex;
  justify-content: center;
  padding: 56px 24px 24px;
}

.about-card {
  max-width: 420px;
  text-align: center;
}

.about-name {
  font-size: 22px;
  font-weight: 600;
  color: var(--aide-text-primary);
  letter-spacing: 0.02em;
}

.about-version {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--aide-accent);
}

.about-desc {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
}

.about-legal {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--aide-border-subtle);
  font-size: 11px;
  line-height: 1.7;
  color: var(--aide-text-muted);
}
.rerun-onboarding {
  margin-top: 14px;
  padding: 8px 16px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface);
  border: 1px solid var(--aide-border);
  color: var(--aide-text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all var(--aide-ease-t);
}
.rerun-onboarding:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
  border-color: var(--aide-border-strong);
}
</style>
