<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useWorkspaceLsp } from "../../composables/useWorkspaceLsp";
import { useLspStatus, type LspServerStatus } from "../../composables/useLspStatus";
import { useWorkspaceJdk } from "../../composables/useWorkspaceJdk";
import { useSettings } from "../../composables/useSettings";
import { installGuideFor } from "../../lspInstallGuide";
import { useLanguagePacks } from "../../composables/useLanguagePacks";
import { useMarketplace } from "../../composables/useMarketplace";
import { api } from "../../api";
import type { JdkEntry } from "../../types";
import ThemedSelect from "../ThemedSelect.vue";
import FilePickerDialog from "../FilePickerDialog.vue";
import ExcludeDirsDialog from "../ExcludeDirsDialog.vue";

/**
 * 标题栏「语言环境」入口（变体 B：常驻徽章 + 点击面板）。
 * 徽章显示各语言 server 状态；面板内每语言一行：状态点 + 语言名 + server 名 + 状态，
 * 行内联「路径 + 浏览文件 + 参数 + 保存/清除」（取代旧 install-box note 与底部服务器覆盖区）。
 * 排除目录走「浏览工作空间目录」多选弹窗。底部是整体开关 + 安装向导。
 *
 * JDK 区块（2026-08-08 从设置面板迁入）：Java 工作区才显示——探测与 LSP 总开关
 * 解耦（lsp_detect_languages 是纯文件探测，无信任门/开关门）。一个工作区 = 一个
 * JDK（Maven/Gradle 反应堆只有一个启动 JDK，per-module 是错误粒度）：顶部「本
 * 工作区 JDK」选择器写 state.json workspace_jdks，run 进程启动时合入 env；
 * 下面是机器级注册表管理（扫描/手动添加/移除）。
 */
const props = defineProps<{ workspaceRoot?: string }>();

const root = computed(() => props.workspaceRoot ?? "");
const lsp = useWorkspaceLsp(() => root.value);
const status = useLspStatus(() => root.value, lsp.enabled);
// 语言包（插件市场同一份状态）：未安装 / 启动失败的行直接给「一键安装」，装好后重探
const packs = useLanguagePacks();
watch(packs.revision, () => {
  if (lsp.enabled.value) void status.probe();
});

// ── 面板开关（NotificationBell 同款：点击外关闭 / Esc）──
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

function toggle() {
  open.value = !open.value;
  if (open.value) {
    void status.probe(); // 打开时刷新一次（ensure 幂等）
    void packs.refresh(); // 窗口可能换绑过 Host，语言包状态每次打开重读
    void loadOverrides(); // 覆盖配置可能有外部改动，每次打开重读
    void detectJava(); // JDK 区块显示条件（与 LSP 开关解耦）
  }
}
function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  // 只在面板真开着时才消费（preventDefault 标记：PermissionDialog 的 window 级
  // Esc 见 defaultPrevented 让路）；没开着就不是本组件的按键，不拦截。
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    open.value = false;
  }
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
  ok: "✓", missing: "✗", failed: "!", idle: "", indexing: "⟳",
};
const STATUS_TEXT: Record<LspServerStatus, string> = {
  ok: "就绪", missing: "未安装", failed: "启动失败", idle: "待探测", indexing: "索引中…",
};
const STATUS_CLASS: Record<LspServerStatus, string> = {
  ok: "st-ok", missing: "st-miss", failed: "st-err", idle: "st-idle", indexing: "st-index",
};

const MAX_BADGE_SEGS = 4;

/** 徽章文本：语言短名 + 状态符号，最多 4 段 + "+N"。 */
const badgeText = computed(() => {
  if (!root.value) return "语言环境";
  if (!lsp.enabled.value) return "语言环境";
  const list = status.langs.value;
  if (list.length === 0) return "语言环境";
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
const langRows = computed(() => status.langs.value.map((x) => {
  const pack = packs.packForLang(x.lang);
  return {
    ...x,
    name: installGuideFor(x.lang)?.displayName ?? x.lang,
    server: installGuideFor(x.lang)?.serverBinary ?? "—",
    pack,
    /** 未装 / 起不来，且有对应语言包没装上：给一键安装 */
    offerPack: !!pack && !pack.installed && (x.status === "missing" || x.status === "failed"),
  };
}));

/** ok 行的来源说明：手动配置 > 语言包 > PATH 发现（与后端查找链同序）。 */
function okSourceText(row: { lang: string; server: string; pack?: { server: string; installed: { version: string } | null } }): string {
  const manual = savedOverrides.value[row.lang]?.program;
  if (manual) return manual;
  if (row.pack?.installed) return `语言包：${row.pack.server} ${row.pack.installed.version}`;
  return `PATH 发现：${row.server}`;
}

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
/** 主入口：插件市场「语言服务器」分类（一键安装）。 */
const marketplace = useMarketplace();
function openLanguagePacks() {
  open.value = false;
  marketplace.openPanel({ category: "langpacks" });
}

/** 次入口：手动安装说明（还没有语言包的语言，如 Go / Java / Kotlin）。 */
async function openGuide() {
  try {
    await api.openLspInstallGuide();
  } catch (e) {
    // 打开系统浏览器失败不阻断面板（次要路径），但落日志便于排查
    console.warn("[LspIndicator] 打开安装向导失败:", e);
  }
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
  } catch (e) {
    // 保存失败：保留编辑态让用户能重试/修改（stopEdit 不执行），并落日志——
    // 本组件无 toast 通道（标题栏徽章区），console.warn 是唯一反馈出口
    console.warn(`[LspIndicator] 保存 ${lang} 服务器覆盖失败，编辑态已保留:`, e);
  }
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

// ── JDK 区块（Java 工作区才显示；探测与 LSP 开关解耦）──
// 一个工作区 = 一个 JDK：选择器写 state.json workspace_jdks（useWorkspaceJdk
// 单例，App.vue 在工作区切换时 loadFor），注册表是机器级（AppSettings.jdkRegistry，
// 所有工作区共享）。扫描/添加结果按 path 去重合并，整块写回。

const { jdkHome, setJdk } = useWorkspaceJdk();
const { settings, setJdkRegistry } = useSettings();

const hasJava = ref(false);
async function detectJava() {
  const r = root.value;
  if (!r) { hasJava.value = false; return; }
  const langs = await api.lspDetectLanguages(r).catch(() => [] as string[]);
  if (root.value !== r) return; // 工作区切换竞态：丢弃陈旧结果
  hasJava.value = langs.includes("java");
}
watch(root, () => { void detectJava(); });

/** 工作区 JDK 选择器选项：(系统默认) + 注册表条目 + 存量临时项（选中项已被
 *  移出注册表时显示「不在注册表」，防选择凭空消失——JDK 仍在磁盘上，注入仍有效）。 */
const jdkOptions = computed(() => {
  const opts = [{ value: "", label: "(系统默认)" }];
  const registry = settings.jdkRegistry ?? [];
  for (const e of registry) opts.push({ value: e.path, label: `${e.name} · Java ${e.version}` });
  if (jdkHome.value && !registry.some((e) => e.path === jdkHome.value)) {
    opts.push({ value: jdkHome.value, label: `${jdkHome.value}（不在注册表）` });
  }
  return opts;
});
function onPickWorkspaceJdk(path: string) {
  void setJdk(path);
}

const jdkEntries = computed<JdkEntry[]>(() => settings.jdkRegistry ?? []);

const jdkScanning = ref(false);
const jdkScanMsg = ref("");
const jdkScanMsgKind = ref<"ok" | "err">("ok");
const manualOpen = ref(false);
const manualPath = ref("");
const manualName = ref("");
const jdkResolving = ref(false);

async function scanJdks() {
  jdkScanning.value = true;
  jdkScanMsg.value = "";
  try {
    const found = await api.scanJdks();
    // 按 path 去重合并：扫描结果覆盖同 path 条目（版本可能更新），保留扫描未覆盖的手动条目
    const byPath = new Map<string, JdkEntry>();
    for (const e of jdkEntries.value) byPath.set(e.path, e);
    for (const e of found) byPath.set(e.path, e);
    const merged = Array.from(byPath.values());
    await setJdkRegistry(merged);
    jdkScanMsgKind.value = "ok";
    jdkScanMsg.value = `扫描完成，发现 ${found.length} 个 JDK（共 ${merged.length} 个已登记）`;
  } catch (e) {
    jdkScanMsgKind.value = "err";
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
      jdkScanMsgKind.value = "err";
      jdkScanMsg.value = `未在 ${p} 找到有效的 JDK（缺少 release 文件）`;
      return;
    }
    // 用户给名优先，否则用解析出的目录名
    const name = manualName.value.trim() || resolved.name;
    const entry: JdkEntry = { name, version: resolved.version, path: resolved.path };
    // 同 path 替换，避免重复
    const filtered = jdkEntries.value.filter((e) => e.path !== entry.path);
    await setJdkRegistry([...filtered, entry]);
    manualPath.value = "";
    manualName.value = "";
    manualOpen.value = false;
    jdkScanMsgKind.value = "ok";
    jdkScanMsg.value = `已添加 ${name}（Java ${resolved.version}）`;
  } catch (e) {
    jdkScanMsgKind.value = "err";
    jdkScanMsg.value = `添加失败：${e}`;
  } finally {
    jdkResolving.value = false;
  }
}

async function removeJdk(path: string) {
  await setJdkRegistry(jdkEntries.value.filter((e) => e.path !== path));
}

// ── 程序化展开（App.vue 预防式 JDK 提示「去配置 JDK」→ 直接领到这里）──
function openPanel() {
  if (!open.value) toggle();
}
defineExpose({ openPanel });
</script>

<template>
  <div ref="rootEl" class="lsp-wrap">
    <!-- 常驻徽章：语言状态概要 -->
    <button
      class="lsp-badge"
      :class="badgeTone"
      v-tooltip="'语言环境'"
      :aria-label="'语言环境'"
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
              <svg v-if="row.status === 'indexing'" class="st-dot-spin" width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 1.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <span v-else class="st-dot" :class="STATUS_CLASS[row.status]" />
              <span class="lang-name">{{ row.name }}</span>
              <span class="lang-server">{{ row.server }}</span>
              <span class="lang-status" :class="row.status">{{ STATUS_TEXT[row.status] }}</span>
            </div>

            <!-- 有对应语言包且没装：一键安装（与插件市场「语言服务器」同一份状态） -->
            <div v-if="row.offerPack && row.pack" class="pack-cta">
              <button
                class="pack-btn"
                :disabled="!!packs.busy.value[row.pack.id] || row.pack.installing"
                @click="packs.install(row.pack.id)"
              >
                {{ packs.busy.value[row.pack.id] || row.pack.installing ? "安装中…" : `一键安装 ${row.pack.name} 语言包` }}
              </button>
              <span class="pack-hint">装到当前窗口连着的机器，或在下方手动指定路径</span>
              <div v-if="packs.errors.value[row.pack.id]" class="err-hint">{{ packs.errors.value[row.pack.id] }}</div>
            </div>

            <!-- indexing 诚实兜底文案：超 90s 仍无就绪信号时单列一行（仍索引中，不切假就绪） -->
            <div v-if="row.note" class="lang-note-row">{{ row.note }}</div>

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
              <span class="path-static">{{ okSourceText(row) }}</span>
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

        <!-- JDK 区块：Java 工作区才显示（探测与 LSP 开关解耦）。
             一个工作区 = 一个 JDK，所有运行配置共享；注册表机器级。 -->
        <div v-if="hasJava" class="jdk-section">
          <div class="jdk-ws-label">本工作区 JDK</div>
          <ThemedSelect
            :model-value="jdkHome"
            :options="jdkOptions"
            block
            @update:model-value="onPickWorkspaceJdk"
          />
          <div class="jdk-ws-hint">
            {{ jdkEntries.length > 0
              ? "该工作区所有运行配置共享，启动时注入 JAVA_HOME（系统全局不变）"
              : "未登记 JDK 时只能选择系统默认——先扫描或手动添加：" }}
          </div>

          <template v-if="jdkEntries.length > 0">
            <div class="jdk-registry-head">
              <span class="jdk-registry-title">注册表（机器级）</span>
              <span class="jdk-count">{{ jdkEntries.length }}</span>
              <button class="jdk-rescan" :disabled="jdkScanning" @click="scanJdks">
                <svg v-if="jdkScanning" class="jdk-spin" width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 1.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <svg v-else width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.13"/>
                </svg>
                {{ jdkScanning ? "扫描中…" : "重新扫描" }}
              </button>
            </div>
            <div class="jdk-list">
              <div
                v-for="jdk in jdkEntries" :key="jdk.path"
                class="jdk-item" :class="{ 'active-ws': jdk.path === jdkHome }"
              >
                <div class="jdk-item-line1">
                  <span class="jdk-item-name">{{ jdk.name }}</span>
                  <span class="jdk-item-version">Java {{ jdk.version }}</span>
                  <span v-if="jdk.path === jdkHome" class="jdk-item-inuse">● 本工作区</span>
                  <button class="jdk-remove" v-tooltip="'移除'" @click="removeJdk(jdk.path)">✕</button>
                </div>
                <span class="jdk-item-path" v-tooltip="jdk.path">{{ jdk.path }}</span>
              </div>
            </div>
          </template>
          <div v-else class="jdk-empty">
            <button class="jdk-scan-btn" :disabled="jdkScanning" @click="scanJdks">
              <svg v-if="jdkScanning" class="jdk-spin" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M6 1.5a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
              </svg>
              <span>{{ jdkScanning ? "扫描中…" : "扫描本机 JDK" }}</span>
            </button>
          </div>

          <div v-if="jdkScanMsg" class="jdk-scan-msg" :class="jdkScanMsgKind">{{ jdkScanMsg }}</div>

          <button v-if="!manualOpen" class="jdk-manual-toggle" @click="manualOpen = true">＋ 手动添加 JDK…</button>
          <div v-else class="jdk-manual-form">
            <div class="jdk-manual-row">
              <input
                v-model="manualPath"
                class="jdk-input"
                placeholder="JDK home 路径，如 C:\Program Files\Java\jdk-21"
                @keydown.enter="addManualJdk"
              />
            </div>
            <div class="jdk-manual-row">
              <input
                v-model="manualName"
                class="jdk-input"
                placeholder="名称（可空，默认取目录名）"
                @keydown.enter="addManualJdk"
              />
              <button
                class="jdk-add-btn"
                :disabled="jdkResolving || !manualPath.trim()"
                @click="addManualJdk"
              >{{ jdkResolving ? "校验中…" : "添加" }}</button>
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

        <!-- 安装入口：主 = 插件市场「语言服务器」一键安装；次 = 手动安装说明（随包 HTML，系统浏览器打开） -->
        <div class="guide-row">
          <button class="market-btn" @click="openLanguagePacks">在插件市场安装语言服务器</button>
          <button class="guide-btn" @click="openGuide">手动安装说明 ↗</button>
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
/* indexing：旋转 spinner 替代静态圆点（accent 色 = 进行中，区别于绿色就绪） */
.st-dot-spin { color: var(--aide-accent); flex-shrink: 0; animation: jdk-spin 0.8s linear infinite; }
.lang-name { font-size: 12.5px; color: var(--aide-text-primary); font-weight: 500; }
.lang-server { font-size: 10px; color: var(--aide-text-muted); font-family: var(--aide-font-mono); }
.lang-status { font-size: 10.5px; color: var(--aide-text-muted); flex-shrink: 0; margin-left: auto; }
.lang-status.ok { color: var(--aide-success); }
.lang-status.miss { color: var(--aide-warning); }
.lang-status.err { color: var(--aide-danger); }
.lang-status.indexing { color: var(--aide-accent); }
/* indexing 诚实兜底文案：对齐到 lang-name 下方（29px = 14px 行内边距 + 6px 点 + 9px 间距） */
.lang-note-row { padding: 0 14px 6px 29px; font-size: 10px; color: var(--aide-text-muted); line-height: 1.4; }

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
/* ── 语言包一键安装（未安装 / 启动失败行） ── */
.pack-cta { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 6px 17px; }
.pack-btn {
  align-self: flex-start;
  background: var(--aide-accent); color: var(--aide-text-on-accent);
  border: 1px solid var(--aide-accent); border-radius: var(--aide-radius-sm);
  font-size: 11.5px; font-weight: 500; padding: 4px 12px; cursor: pointer; font-family: inherit;
}
.pack-btn:hover:not(:disabled) { background: var(--aide-accent-hover); }
.pack-btn:disabled { opacity: 0.6; cursor: progress; }
.pack-hint { font-size: 10.5px; color: var(--aide-text-muted); line-height: 1.5; }
.change-btn { background: none; border: none; color: var(--aide-accent); font-size: 10.5px; cursor: pointer; font-family: inherit; padding: 0; flex-shrink: 0; }
.change-btn:hover { text-decoration: underline; }

/* ── JDK 区块（Java 工作区；工作区选择器 + 机器级注册表） ── */
.jdk-section { border-top: 1px solid var(--aide-border); padding: 9px 12px 11px; }
.jdk-ws-label {
  font-size: 10.5px; font-weight: 600; color: var(--aide-text-muted);
  text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px;
}
.jdk-ws-hint { font-size: 10px; color: var(--aide-text-muted); line-height: 1.55; margin-top: 5px; }

.jdk-registry-head {
  display: flex; align-items: center; gap: 8px;
  margin: 10px 0 6px; padding-top: 9px;
  border-top: 1px dashed var(--aide-border);
}
.jdk-registry-title {
  font-size: 10px; font-weight: 600; color: var(--aide-text-muted);
  text-transform: uppercase; letter-spacing: 0.6px;
}
.jdk-count {
  font-size: 10px; color: var(--aide-text-muted);
  background: var(--aide-surface-default); border: 1px solid var(--aide-border);
  padding: 0 6px; border-radius: 8px; line-height: 15px;
}
.jdk-rescan {
  margin-left: auto;
  background: none; border: none; cursor: pointer; font-family: inherit;
  font-size: 10.5px; color: var(--aide-accent); padding: 0 2px;
  display: inline-flex; align-items: center; gap: 4px;
}
.jdk-rescan:hover:not(:disabled) { text-decoration: underline; }
.jdk-rescan:disabled { opacity: 0.5; cursor: default; }

.jdk-list {
  display: flex; flex-direction: column; gap: 5px;
  max-height: 128px; overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: var(--aide-surface-active) transparent;
}
.jdk-item {
  display: flex; flex-direction: column; gap: 1px;
  padding: 6px 8px 6px 10px;
  border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-base);
}
.jdk-item.active-ws { border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent); }
.jdk-item-line1 { display: flex; align-items: center; gap: 7px; }
.jdk-item-name {
  font-size: 12px; color: var(--aide-text-primary); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.jdk-item-version {
  font-size: 9.5px; color: var(--aide-accent);
  padding: 0 5px; border-radius: var(--aide-radius-sm); line-height: 15px;
  background: var(--aide-accent-subtle); flex-shrink: 0;
}
.jdk-item-inuse {
  font-size: 9px; color: var(--aide-success); flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 3px;
}
.jdk-remove {
  margin-left: auto; width: 16px; height: 16px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; background: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 9px; transition: background 0.12s;
}
.jdk-remove:hover { background: var(--aide-danger); color: var(--aide-text-primary); }
.jdk-item-path {
  font-size: 10px; color: var(--aide-text-muted); font-family: var(--aide-font-mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.jdk-scan-msg { font-size: 10.5px; line-height: 1.5; margin-top: 7px; }
.jdk-scan-msg.ok { color: var(--aide-success); }
.jdk-scan-msg.err { color: var(--aide-danger); }

.jdk-empty { display: flex; padding: 4px 2px 2px; }
.jdk-scan-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-accent); color: var(--aide-bg-deep);
  border: none; font-size: 11.5px; font-weight: 500; font-family: inherit;
  cursor: pointer; transition: opacity 0.12s;
}
.jdk-scan-btn:hover:not(:disabled) { opacity: 0.9; }
.jdk-scan-btn:disabled { opacity: 0.45; cursor: default; }
.jdk-spin { animation: jdk-spin 0.8s linear infinite; }
@keyframes jdk-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .jdk-spin, .st-dot-spin { animation: none; }
}

.jdk-manual-toggle {
  background: none; border: none; cursor: pointer; font-family: inherit;
  font-size: 10.5px; color: var(--aide-text-muted); padding: 0; margin-top: 8px;
  display: inline-flex; align-items: center; gap: 4px;
}
.jdk-manual-toggle:hover { color: var(--aide-accent); }
.jdk-manual-form { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
.jdk-manual-row { display: flex; gap: 5px; }
.jdk-input {
  flex: 1; min-width: 0; background: var(--aide-bg-base); border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm); color: var(--aide-text-primary); font-size: 11px;
  padding: 4px 8px; outline: none; font-family: inherit;
}
.jdk-input:focus { border-color: var(--aide-accent); }
.jdk-input::placeholder { color: var(--aide-text-muted); }
.jdk-add-btn {
  background: var(--aide-accent-subtle); color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  border-radius: var(--aide-radius-sm); font-size: 11px; padding: 4px 12px;
  cursor: pointer; font-family: inherit; white-space: nowrap;
}
.jdk-add-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); }
.jdk-add-btn:disabled { opacity: 0.45; cursor: default; }

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

/* ── 安装入口（插件市场 + 手动安装说明） ── */
.guide-row {
  border-top: 1px solid var(--aide-border);
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: linear-gradient(180deg, transparent 0%, var(--aide-border-subtle) 100%);
}
.market-btn {
  background: var(--aide-accent-subtle); color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  border-radius: var(--aide-radius-sm); font-size: 11px; font-weight: 500;
  padding: 4px 12px; cursor: pointer; font-family: inherit;
}
.market-btn:hover { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); }
.guide-btn {
  background: none; border: none; cursor: pointer;
  font-size: 11px; color: var(--aide-text-muted); font-family: inherit;
  padding: 2px 4px; transition: opacity 0.12s;
}
.guide-btn:hover { color: var(--aide-accent); text-decoration: underline; }

/* ── 过渡 ── */
.lsp-drop-enter-active, .lsp-drop-leave-active { transition: opacity var(--aide-ease-t), transform var(--aide-ease-t); }
.lsp-drop-enter-from, .lsp-drop-leave-to { opacity: 0; transform: translateY(-4px); }
</style>