<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useWorkspaceLsp } from "../../composables/useWorkspaceLsp";
import { useLspStatus, type LspServerStatus } from "../../composables/useLspStatus";
import { installGuideFor } from "../../lspInstallGuide";
import { api } from "../../api";
import FilePickerDialog from "../FilePickerDialog.vue";
import ExcludeDirsDialog from "../ExcludeDirsDialog.vue";

/**
 * 标题栏 LSP 入口（变体 B：常驻徽章 + 点击面板）。
 * 徽章显示各语言 server 状态；面板内每语言一行：状态点 + 语言名 + server 名 + 状态，
 * 行内联「路径 + 浏览文件 + 参数 + 保存/清除」（取代旧 install-box note 与底部服务器覆盖区）。
 * 排除目录走「浏览工作空间目录」多选弹窗。底部是整体开关 + 安装向导。
 */
const props = defineProps<{ workspaceRoot?: string }>();

const root = computed(() => props.workspaceRoot ?? "");
const lsp = useWorkspaceLsp(() => root.value);
const status = useLspStatus(() => root.value, lsp.enabled);

// ── 面板开关（NotificationBell 同款：点击外关闭 / Esc）──
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

function toggle() {
  open.value = !open.value;
  if (open.value) {
    void status.probe(); // 打开时刷新一次（ensure 幂等）
    void loadOverrides(); // 覆盖配置可能有外部改动，每次打开重读
  }
}
function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});

// ── 徽章内容 ──
const STATUS_MARK: Record<LspServerStatus, string> = {
  ok: "✓", missing: "✗", failed: "!", idle: "",
};
const STATUS_TEXT: Record<LspServerStatus, string> = {
  ok: "就绪", missing: "未安装", failed: "启动失败", idle: "待探测",
};
const STATUS_CLASS: Record<LspServerStatus, string> = {
  ok: "st-ok", missing: "st-miss", failed: "st-err", idle: "st-idle",
};

const MAX_BADGE_SEGS = 4;

/** 徽章文本：语言短名 + 状态符号，最多 4 段 + "+N"。 */
const badgeText = computed(() => {
  if (!root.value) return "LSP";
  if (!lsp.enabled.value) return "LSP 关";
  const list = status.langs.value;
  if (list.length === 0) return "LSP";
  const shown = list.slice(0, MAX_BADGE_SEGS);
  const segs = shown
    .map((x) => `${installGuideFor(x.lang)?.shortName ?? x.lang} ${STATUS_MARK[x.status]}`)
    .join(" · ");
  return list.length > MAX_BADGE_SEGS ? `${segs} · +${list.length - MAX_BADGE_SEGS}` : segs;
});
const badgeTone = computed(() => {
  if (!lsp.enabled.value) return "off";
  const list = status.langs.value;
  if (list.some((x) => x.status === "missing" || x.status === "failed")) return "warn";
  if (list.some((x) => x.status === "ok")) return "on";
  return "off";
});

// ── 语言行（面板）──
const langRows = computed(() => status.langs.value.map((x) => ({
  ...x,
  name: installGuideFor(x.lang)?.displayName ?? x.lang,
  server: installGuideFor(x.lang)?.serverBinary ?? "—",
})));

// ── 排除目录（浏览工作空间多选弹窗；chips 单个 ✕ 删 + 保存）──
const localExcludes = ref<string[]>([...lsp.excludes.value]);
watch(
  () => lsp.excludes.value,
  (v) => {
    if (!lsp.excludesDirty.value) localExcludes.value = [...v];
  }
);
watch(root, () => {
  localExcludes.value = [...lsp.excludes.value];
});

function removeExclude(i: number) {
  localExcludes.value = localExcludes.value.filter((_, idx) => idx !== i);
  lsp.excludesDirty.value = true;
}
async function saveExcludes() {
  await lsp.saveExcludes(localExcludes.value);
}
const excludeDialogVisible = ref(false);
function onExcludesPicked(paths: string[]) {
  // 合并去重
  const merged = [...localExcludes.value];
  for (const p of paths) if (!merged.includes(p)) merged.push(p);
  localExcludes.value = merged;
  lsp.excludesDirty.value = true;
}

async function setEnabled(v: boolean) {
  await lsp.setEnabled(v);
  if (v) void status.probe();
}

// ── 安装向导（随包分发的 lsp-install-guide.html，系统浏览器打开）──
async function openGuide() {
  await api.openLspInstallGuide().catch(() => {});
}

// ── 服务器覆盖（lsp.servers[lang]：program + args，优先级高于 PATH 发现）──
interface OverrideDraft { program: string; args: string }
const overrides = ref<Record<string, OverrideDraft>>({});
const savedOverrides = ref<Record<string, { program: string; args: string[] }>>({});

async function loadOverrides() {
  try {
    const s = await api.getSettings();
    savedOverrides.value = s.lsp?.servers ?? {};
    overrides.value = {};
    for (const [lang, o] of Object.entries(savedOverrides.value)) {
      overrides.value[lang] = { program: o.program, args: o.args.join(" ") };
    }
  } catch { /* 读失败静默（后端异常不阻断面板） */ }
}

function draftFor(lang: string): OverrideDraft {
  if (!overrides.value[lang]) overrides.value[lang] = { program: "", args: "" };
  return overrides.value[lang];
}
function isOverrideDirty(lang: string): boolean {
  const d = draftFor(lang);
  const o = savedOverrides.value[lang];
  return !o || o.program !== d.program || o.args.join(" ") !== d.args;
}
function hasOverride(lang: string): boolean {
  return !!savedOverrides.value[lang]?.program;
}
async function saveOverride(lang: string) {
  const d = draftFor(lang);
  const servers = { ...savedOverrides.value };
  if (d.program.trim()) {
    servers[lang] = {
      program: d.program.trim(),
      args: d.args.trim() ? d.args.trim().split(/\s+/) : [],
    };
  } else {
    delete servers[lang];
  }
  try {
    await api.setSettings({ lsp: { servers } });
    savedOverrides.value = servers;
    // 覆盖改了 server 启动方式 → 重拉该工作区 server（disable→enable）
    if (lsp.enabled.value) {
      await lsp.setEnabled(false);
      await lsp.setEnabled(true);
    }
    stopEdit(lang);
  } catch { /* 静默 */ }
}
async function clearOverride(lang: string) {
  overrides.value[lang] = { program: "", args: "" };
  await saveOverride(lang);
}

// ── 文件浏览弹窗（server 二进制选择）──
const filePickerVisible = ref(false);
const filePickerLang = ref<string>("");
function openFilePicker(lang: string) {
  filePickerLang.value = lang;
  filePickerVisible.value = true;
}
function onFilePicked(path: string) {
  const lang = filePickerLang.value;
  if (lang) draftFor(lang).program = path;
  filePickerLang.value = "";
}

// ── ok 态「更改」展开编辑 ──
const editingLang = ref<Set<string>>(new Set());
function startEdit(lang: string) { editingLang.value = new Set([...editingLang.value, lang]); }
function stopEdit(lang: string) { const s = new Set(editingLang.value); s.delete(lang); editingLang.value = s; }
function isEditing(lang: string): boolean { return editingLang.value.has(lang); }
</script>

<template>
  <div ref="rootEl" class="lsp-wrap">
    <!-- 常驻徽章：语言状态概要 -->
    <button
      class="lsp-badge"
      :class="badgeTone"
      v-tooltip="'语言服务器（LSP）'"
      :aria-label="'语言服务器'"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="lsp-badge-text">{{ badgeText }}</span>
      <svg
        class="lsp-badge-chevron" :class="{ open }"
        width="7" height="5" viewBox="0 0 8 5" fill="none"
        stroke="currentColor" stroke-width="1.5"
      ><path d="M0.5 0.5L4 4L7.5 0.5"/></svg>
    </button>

    <!-- 点击面板 -->
    <Transition name="lsp-drop">
      <div v-if="open" class="lsp-panel" role="dialog" aria-label="语言服务器">
        <div class="lsp-header">
          <span class="lsp-title">语言服务器</span>
          <label class="lsp-toggle" :class="{ on: lsp.enabled.value }">
            <input
              type="checkbox"
              :checked="lsp.enabled.value"
              @change="setEnabled(($event.target as HTMLInputElement).checked)"
            />
            <span class="lsp-toggle-track"></span>
          </label>
        </div>

        <!-- 语言状态行 + 内联 override（取代旧 install-box note + 底部服务器覆盖区） -->
        <div class="lsp-body">
          <div v-if="langRows.length === 0" class="lsp-empty">
            {{
              !lsp.enabled.value
                ? "LSP 已关闭 — 打开开关开始探测"
                : status.probing
                  ? "正在探测项目语言…"
                  : root
                    ? "未检测到项目语言"
                    : "打开目录后可用"
            }}
          </div>

          <div v-for="row in langRows" :key="row.lang" class="lang-block">
            <div class="lang-row">
              <span class="st-dot" :class="STATUS_CLASS[row.status]" />
              <span class="lang-name">{{ row.name }}</span>
              <span class="lang-server">{{ row.server }}</span>
              <span class="lang-status" :class="row.status">{{ STATUS_TEXT[row.status] }}</span>
            </div>

            <!-- failed：可编辑 + 红色错误提示（后端回传的 stderr/握手详情） -->
            <div v-if="row.status === 'failed'" class="override-inline failed">
              <div class="path-row">
                <input
                  v-model="draftFor(row.lang).program"
                  class="path-input"
                  :class="{ 'has-value': draftFor(row.lang).program }"
                  placeholder="server 完整路径（留空 = PATH 发现）"
                  @keydown.enter="saveOverride(row.lang)"
                />
                <button class="browse-btn" @click="openFilePicker(row.lang)">浏览…</button>
              </div>
              <input
                v-model="draftFor(row.lang).args"
                class="args-input"
                placeholder="参数（空格分隔，可选）"
                @keydown.enter="saveOverride(row.lang)"
              />
              <div v-if="row.error" class="err-hint">{{ row.error }}</div>
              <div class="override-actions">
                <button v-if="hasOverride(row.lang)" class="clear-btn" @click="clearOverride(row.lang)">清除</button>
                <button v-if="isOverrideDirty(row.lang)" class="save-btn" @click="saveOverride(row.lang)">保存</button>
              </div>
            </div>

            <!-- ok 且未编辑：紧凑只读 + 更改 -->
            <div v-else-if="row.status === 'ok' && !isEditing(row.lang)" class="ok-compact">
              <span class="path-static">
                {{ savedOverrides[row.lang]?.program ? savedOverrides[row.lang].program : `PATH 发现：${row.server}` }}
              </span>
              <button class="change-btn" @click="startEdit(row.lang)">更改…</button>
            </div>

            <!-- missing 或 ok 编辑态：可编辑 -->
            <div v-else-if="row.status === 'missing' || (row.status === 'ok' && isEditing(row.lang))" class="override-inline">
              <div class="path-row">
                <input
                  v-model="draftFor(row.lang).program"
                  class="path-input"
                  :class="{ 'has-value': draftFor(row.lang).program }"
                  placeholder="server 完整路径（留空 = PATH 发现）"
                  @keydown.enter="saveOverride(row.lang)"
                />
                <button class="browse-btn" @click="openFilePicker(row.lang)">浏览…</button>
              </div>
              <input
                v-model="draftFor(row.lang).args"
                class="args-input"
                placeholder="参数（空格分隔，可选）"
                @keydown.enter="saveOverride(row.lang)"
              />
              <div class="override-actions">
                <button v-if="hasOverride(row.lang)" class="clear-btn" @click="clearOverride(row.lang)">清除</button>
                <button v-if="isOverrideDirty(row.lang)" class="save-btn" @click="saveOverride(row.lang)">保存</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 排除目录：浏览工作空间目录（多选，限工作空间内） -->
        <div class="exclude-section">
          <div class="exclude-title">排除目录（不发给 LSP）</div>
          <div class="exclude-body">
            <div v-if="localExcludes.length > 0" class="exclude-list">
              <span v-for="(dir, i) in localExcludes" :key="i" class="chip">
                {{ dir }}
                <button class="chip-x" v-tooltip="'移除'" @click="removeExclude(i)">✕</button>
              </span>
            </div>
            <button class="browse-btn exclude-browse-btn" @click="excludeDialogVisible = true">浏览工作空间目录…</button>
            <div v-if="lsp.excludesDirty.value" class="exclude-save-row">
              <button class="exclude-save-btn" @click="saveExcludes">保存排除配置</button>
            </div>
          </div>
        </div>

        <!-- 安装向导入口（随包 HTML，系统浏览器打开） -->
        <div class="guide-row">
          <button class="guide-btn" @click="openGuide">打开安装向导 ↗</button>
        </div>
      </div>
    </Transition>

    <!-- 文件浏览 + 排除目录弹窗（Teleport to body） -->
    <FilePickerDialog v-model:visible="filePickerVisible" @confirm="onFilePicked" />
    <ExcludeDirsDialog v-model:visible="excludeDialogVisible" :workspace-root="root" @confirm="onExcludesPicked" />
  </div>
</template>

<style scoped>
.lsp-wrap { position: relative; display: flex; align-items: center; height: 100%; }

/* ── 徽章 ── */
.lsp-badge {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 8px 0 10px; margin: 0 4px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 99px;
  color: var(--aide-text-secondary);
  font-size: 10.5px; font-family: inherit; cursor: pointer;
  transition: background var(--aide-ease-t), border-color var(--aide-ease-t);
  box-shadow: var(--aide-highlight-inset);
}
.lsp-badge:hover { background: var(--aide-surface-hover); }
.lsp-badge.on { color: var(--aide-success); }
.lsp-badge.warn { color: var(--aide-warning); }
.lsp-badge.off { color: var(--aide-text-muted); }
.lsp-badge-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lsp-badge-chevron { flex-shrink: 0; opacity: 0.5; transition: transform 0.14s ease; }
.lsp-badge-chevron.open { transform: rotate(180deg); }

/* ── 面板 ── */
.lsp-panel {
  position: absolute; top: calc(100% + 6px); right: 0;
  width: 380px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  z-index: 900; overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
}
.lsp-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aide-border);
  background: linear-gradient(180deg, var(--aide-border-subtle) 0%, transparent 100%), var(--aide-bg-raised);
}
.lsp-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;
  color: var(--aide-text-muted);
}

/* 开关（原生 checkbox 隐藏，track 自绘） */
.lsp-toggle { display: inline-flex; align-items: center; cursor: pointer; }
.lsp-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.lsp-toggle-track {
  width: 30px; height: 16px; border-radius: 9px; position: relative;
  background: var(--aide-surface-active); transition: background var(--aide-ease-t);
}
.lsp-toggle-track::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%; background: var(--aide-text-muted);
  transition: all var(--aide-ease-t);
}
.lsp-toggle.on .lsp-toggle-track { background: var(--aide-accent); }
.lsp-toggle.on .lsp-toggle-track::after { left: 16px; background: var(--aide-bg-deep); }

/* ── 语言行 ── */
.lsp-body { max-height: 360px; overflow-y: auto; padding: 4px 0; scrollbar-width: thin; scrollbar-color: var(--aide-surface-active) transparent; }
.lsp-empty { padding: 26px 14px; text-align: center; color: var(--aide-text-muted); font-size: 12px; }

.lang-block { padding: 0 0 2px; }
.lang-row {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 14px;
}
.lang-row:hover { background: var(--aide-surface-default); }
.st-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.st-ok { background: var(--aide-success); box-shadow: 0 0 4px color-mix(in srgb, var(--aide-success) 40%, transparent); }
.st-miss { background: var(--aide-warning); box-shadow: 0 0 4px color-mix(in srgb, var(--aide-warning) 40%, transparent); }
.st-err { background: var(--aide-danger); box-shadow: 0 0 4px color-mix(in srgb, var(--aide-danger) 40%, transparent); }
.st-idle { background: var(--aide-text-muted); opacity: 0.5; }
.lang-name { font-size: 12.5px; color: var(--aide-text-primary); font-weight: 500; }
.lang-server { font-size: 10px; color: var(--aide-text-muted); font-family: var(--aide-font-mono); }
.lang-status { font-size: 10.5px; color: var(--aide-text-muted); flex-shrink: 0; margin-left: auto; }
.lang-status.ok { color: var(--aide-success); }
.lang-status.miss { color: var(--aide-warning); }
.lang-status.err { color: var(--aide-danger); }

/* ── 内联 override 行（取代 install-box note + 底部服务器覆盖区） ── */
.override-inline { padding: 2px 14px 10px 29px; display: flex; flex-direction: column; gap: 5px; }
.override-inline.failed { background: color-mix(in srgb, var(--aide-danger) 6%, transparent); }
.path-row { display: flex; gap: 5px; }
.path-input {
  flex: 1; min-width: 0; background: var(--aide-bg-base); border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm); color: var(--aide-text-primary); font-size: 11px;
  padding: 4px 8px; outline: none; font-family: inherit;
}
.path-input:focus { border-color: var(--aide-accent); }
.path-input.has-value { color: var(--aide-text-secondary); }
.browse-btn {
  background: var(--aide-accent-subtle); color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  border-radius: var(--aide-radius-sm); font-size: 11px; padding: 4px 10px; cursor: pointer;
  font-family: inherit; white-space: nowrap; transition: all 0.12s;
}
.browse-btn:hover { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); }
.args-input {
  width: 100%; background: var(--aide-bg-base); border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm); color: var(--aide-text-primary); font-size: 11px;
  padding: 4px 8px; outline: none; font-family: inherit;
}
.args-input:focus { border-color: var(--aide-accent); }
.err-hint { font-size: 10.5px; color: var(--aide-danger); line-height: 1.5; word-break: break-word; }
.override-actions { display: flex; gap: 6px; justify-content: flex-end; }
.save-btn {
  background: var(--aide-accent-subtle); color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  border-radius: var(--aide-radius-sm); font-size: 11px; padding: 3px 12px; cursor: pointer; font-family: inherit;
}
.save-btn:hover { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); }
.clear-btn {
  background: none; color: var(--aide-text-muted); border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm); font-size: 11px; padding: 3px 12px; cursor: pointer; font-family: inherit;
}
.clear-btn:hover { color: var(--aide-danger); border-color: var(--aide-danger); }

/* ok 紧凑行 */
.ok-compact { padding: 2px 14px 8px 29px; display: flex; align-items: center; gap: 6px; }
.path-static { flex: 1; min-width: 0; font-size: 10.5px; color: var(--aide-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--aide-font-mono); }
.change-btn { background: none; border: none; color: var(--aide-accent); font-size: 10.5px; cursor: pointer; font-family: inherit; padding: 0; flex-shrink: 0; }
.change-btn:hover { text-decoration: underline; }

/* ── 排除目录 ── */
.exclude-section { border-top: 1px solid var(--aide-border); padding: 9px 12px 11px; }
.exclude-title {
  font-size: 10.5px; font-weight: 600; color: var(--aide-text-muted);
  text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 7px;
}
.exclude-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--aide-text-secondary);
  background: var(--aide-surface-default); border: 1px solid var(--aide-border);
  padding: 2px 4px 2px 9px; border-radius: 12px; font-family: var(--aide-font-mono);
}
.chip-x {
  width: 14px; height: 14px; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; background: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 9px; transition: background 0.12s;
}
.chip-x:hover { background: var(--aide-danger); color: var(--aide-text-primary); }
.exclude-browse-btn { margin-bottom: 0; }
.exclude-save-row { display: flex; justify-content: flex-end; margin-top: 8px; }
.exclude-save-btn {
  background: var(--aide-accent-subtle); color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  border-radius: var(--aide-radius-sm); font-size: 11px; padding: 4px 12px;
  cursor: pointer; font-family: inherit; transition: all 0.12s;
}
.exclude-save-btn:hover {
  background: color-mix(in srgb, var(--aide-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
}

/* ── 安装向导入口 ── */
.guide-row {
  border-top: 1px solid var(--aide-border);
  padding: 8px 12px;
  text-align: right;
  background: linear-gradient(180deg, transparent 0%, var(--aide-border-subtle) 100%);
}
.guide-btn {
  background: none; border: none; cursor: pointer;
  font-size: 11px; color: var(--aide-accent); font-family: inherit;
  padding: 2px 4px; transition: opacity 0.12s;
}
.guide-btn:hover { opacity: 0.8; text-decoration: underline; }

/* ── 过渡 ── */
.lsp-drop-enter-active, .lsp-drop-leave-active { transition: opacity var(--aide-ease-t), transform var(--aide-ease-t); }
.lsp-drop-enter-from, .lsp-drop-leave-to { opacity: 0; transform: translateY(-4px); }
</style>