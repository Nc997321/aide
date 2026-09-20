<script setup lang="ts">
// 内嵌浏览器主区面板：主区一级视图（跟「插件」「知识库」同级，不占会话 tab、不碰 pane 布局），
// 自带标签条。
//
// 物理约束（plan §2）：原生 WebView2 子视图浮在主 webview 的 HTML **之上**，不能与 Vue 元素
// z 序交错。所以 `.bp-surface` 是布局里的「占位洞」——原生视图被钉在它的屏幕坐标上；标签条与
// 工具栏排在洞**外**（不重叠），否则会被原生视图吃掉。面板关闭 / 切标签都必须 `setVisible(false)`，
// 否则原生视图脱离 DOM 生命周期、继续浮在全部内容之上。
// 同理，**任何 HTML 浮层盖上来时它都得让位**（`v-overlay-layer` 登记驱动，见「可见性总闸」）——
// 浮层的 z-index 再高也压不住原生子视图，只有让位一条路。
//
// 坐标：窗口 `decorations(false)` + 主 webview 铺满客户区 → `getBoundingClientRect()`(CSS px)
// 直接等于 Tauri logical px（devicePixelRatio == scale_factor），无需换算；rect 视口相对，天然
// 吸收滚动偏移。
//
// 多标签：**每个标签一个原生视图**（Rust 注册表 `id → 视图`，引擎天然支持 N 个），切换 = 旧视图
// `setVisible(false)` + 新视图 `setVisible(true)` + 同步坐标；视图常驻注册表，切回页面状态还在。
// 空标签（还没导航过）不建视图——首次导航才 create，免得每个新标签都空跑一次加载。
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import {
  useEmbeddedBrowser,
  onBrowserNav,
  type BrowserViewDto,
  type BoundsDto,
  type NavStateDto,
} from "../../composables/useEmbeddedBrowser";
import { useRightPanel } from "../../composables/useRightPanel";
import { useBrowserBookmarks } from "../../composables/useBrowserBookmarks";
import { overlayLayerOpen } from "../../directives/overlayLayer";
import FilePickerDialog from "../FilePickerDialog.vue";
import Icon from "../Icon.vue";
import BookmarkFolderMenu from "./BookmarkFolderMenu.vue";
import {
  buildBookmarkBar,
  formatImportReport,
  navOfEvent,
  normalizeBrowserUrl,
  tabLabelOf,
  urlOfNav,
  type BookmarkEntry,
  type BookmarkFolder,
} from "../../utils/browser";

const { browserActive, select } = useRightPanel();
const browser = useEmbeddedBrowser();

/** 一个浏览器标签页。`viewId=null` = 还没开原生视图的空标签（首次导航才 create）。 */
interface Tab {
  id: string;
  viewId: string | null;
  /** 标签当前 URL（地址栏回显 + ⟳ 的目标；编辑中的输入不写回这里）。 */
  url: string;
  nav: NavStateDto | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

function blankTab(): Tab {
  return {
    id: `tab-${crypto.randomUUID()}`,
    viewId: null,
    url: "",
    nav: null,
    canGoBack: false,
    canGoForward: false,
  };
}

const tabs = ref<Tab[]>([blankTab()]);
const activeId = ref(tabs.value[0].id);
const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? tabs.value[0]);

const surfaceEl = ref<HTMLElement | null>(null);
const addressEl = ref<HTMLInputElement | null>(null);
const address = ref("");

// 单一消息条：导航错误与书签反馈共用一行（两处各设一个就互相清掉，不会叠两条）。
const message = ref("");
const messageTone = ref<"info" | "error">("info");

let ro: ResizeObserver | null = null;
let rafId = 0;
let unlistenNav: (() => void) | null = null;

function errText(e: unknown): string {
  return typeof e === "string" ? e : String(e);
}

function setError(e: unknown) {
  messageTone.value = "error";
  message.value = errText(e);
}

function setInfo(text: string) {
  messageTone.value = "info";
  message.value = text;
}

function clearMessage() {
  message.value = "";
}

// ── 坐标同步：洞 → 活动标签的原生视图 ──

/** 量占位洞的视口矩形；display:none / 未布局（宽高 ≤0）时返回 null。 */
function rectOf(): BoundsDto | null {
  const el = surfaceEl.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function syncBounds() {
  const viewId = active.value?.viewId;
  if (!viewId) return;
  const b = rectOf();
  if (!b) return;
  void browser.setBounds(viewId, b).catch(() => {});
}

/** rAF 节流：resize 期间每帧至多一次 IPC，不淹没命令通道。 */
function scheduleSync() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    syncBounds();
  });
}

/** 显示活动标签的原生视图（空标签没有视图可显示）。 */
async function showActive() {
  await nextTick(); // 等 v-show 摘掉 display:none、完成布局
  const viewId = active.value?.viewId;
  if (!viewId) return;
  await browser.setVisible(viewId, true).catch(() => {});
  await nextTick();
  syncBounds();
}

/** 隐藏某个标签的原生视图（保活：只隐不销毁，页面状态留在注册表里）。 */
function hideTab(t: Tab | undefined) {
  if (!t?.viewId) return;
  void browser.setVisible(t.viewId, false).catch(() => {});
}

// ── 可见性总闸：原生视图给 HTML 浮层让位 ──

/** 活动视图此刻该不该露头：面板开着 **且** 没有任何浮层盖着——面板内的（导入书签的文件选择器）
 *  与面板外的（设置、Ctrl+P 命令面板、全局 modal、右键菜单）一视同仁。
 *
 *  原生视图浮在所有 HTML 之上、**不受 z-index 约束**（见文件头「物理约束」），浮层一开它就必须
 *  让位，否则浮层只在「洞」以上那一条可见、取消/确认按钮全被网页吃掉。
 *  **浮层清单不在这里维护**：谁有遮罩谁在根元素挂 `v-overlay-layer` 自己登记
 *  （见 `directives/overlayLayer.ts`），这里只读结论——所以新增浮层不必回来改这个文件。 */
const viewAllowed = computed(() => browserActive.value && !overlayLayerOpen.value);

/** 地址栏回显：用户正在输入时不抢（否则事件一到就把输入冲掉）。 */
function syncAddressFromTab() {
  if (document.activeElement === addressEl.value) return;
  address.value = active.value?.url ?? "";
}

/** 从命令应答（`BrowserViewDto`）刷新标签状态。 */
function applyView(t: Tab, view: BrowserViewDto) {
  t.viewId = view.id;
  t.nav = view.nav;
  t.canGoBack = view.can_go_back;
  t.canGoForward = view.can_go_forward;
  t.url = urlOfNav(view.nav) || t.url;
}

// ── 导航动作 ──

/** 首次导航时为标签建原生视图（此时洞已布局好）。 */
async function ensureView(t: Tab, url: string): Promise<boolean> {
  if (t.viewId) return true;
  await nextTick();
  const b = rectOf();
  if (!b) {
    setError("占位区未就绪（宽高为 0）");
    return false;
  }
  try {
    applyView(t, await browser.create(url, b));
    clearMessage();
    return true;
  } catch (e) {
    setError(e);
    return false;
  }
}

async function go() {
  const t = active.value;
  if (!t) return;
  const target = normalizeBrowserUrl(address.value);
  if (!target) return;
  clearMessage();
  try {
    if (!t.viewId) {
      if (!(await ensureView(t, target))) return;
      t.url = target;
    } else {
      applyView(t, await browser.navigate(t.viewId, target));
    }
  } catch (e) {
    setError(e);
  }
}

/** ⟳ = 重载当前 URL（后端把「同 URL 导航」按重载处理：不压历史）。空标签则等同「打开」。 */
async function reload() {
  const t = active.value;
  if (!t) return;
  if (!t.viewId) {
    await go();
    return;
  }
  clearMessage();
  try {
    applyView(t, await browser.navigate(t.viewId, t.url));
  } catch (e) {
    setError(e);
  }
}

async function back() {
  const t = active.value;
  if (!t?.viewId) return;
  try {
    applyView(t, await browser.goBack(t.viewId));
  } catch (e) {
    setError(e);
  }
}

async function forward() {
  const t = active.value;
  if (!t?.viewId) return;
  try {
    applyView(t, await browser.goForward(t.viewId));
  } catch (e) {
    setError(e);
  }
}

// ── 标签动作 ──

function addTab() {
  const t = blankTab();
  tabs.value.push(t);
  activeId.value = t.id; // 激活 watcher 负责显隐与地址栏
  nextTick(() => addressEl.value?.focus());
}

function closeTab(id: string) {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [removed] = tabs.value.splice(i, 1);
  // 关标签 = 销毁该视图（与面板关闭不同：那是保活，只隐藏）。
  if (removed.viewId) void browser.close(removed.viewId).catch(() => {});

  if (tabs.value.length === 0) {
    // 浏览器惯例：永远留一个标签页。
    const t = blankTab();
    tabs.value.push(t);
    activeId.value = t.id;
    return;
  }
  if (activeId.value === id) {
    activeId.value = tabs.value[Math.min(i, tabs.value.length - 1)].id;
  }
}

function activateTab(id: string) {
  if (activeId.value !== id) activeId.value = id;
}

// ── 书签（收藏夹） ──

const {
  bookmarks,
  favicons,
  refresh: refreshBookmarks,
  add: addBookmark,
  remove: removeBookmark,
  importFromFile,
  idOf: bookmarkIdOf,
} = useBrowserBookmarks();

/** 导入用的文件选择器开没开（它自己会挂 `v-overlay-layer` 让原生视图让位，这里只管开关）。 */
const pickerVisible = ref(false);

/** 收藏条：扁平列表 → 按目录路径分组的条目（纯函数在 `utils/browser.ts`，这里只接线）。 */
const bookmarkBar = computed(() => buildBookmarkBar(bookmarks.value));

/** 展开的文件夹菜单（null = 没开）。开着时它登记浮层 → 原生视图让位（见「可见性总闸」）。 */
const openFolder = ref<BookmarkFolder | null>(null);
const folderMenuAnchor = ref({ left: 0, top: 0 });

/** 收藏条的 key：文件夹按路径（同名不同父不撞），书签按 id。 */
function entryKey(e: BookmarkEntry): string {
  return e.kind === "folder" ? `f:${e.folder.path.join("/")}` : `b:${e.id}`;
}

/** 点栏上的文件夹按钮：菜单贴按钮下沿展开（坐标直接取按钮的 rect，不用另测一遍布局）。 */
function openFolderMenu(folder: BookmarkFolder, ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  folderMenuAnchor.value = { left: r.left, top: r.bottom + 2 };
  openFolder.value = folder;
}

/** 菜单里点了书签：**先撤菜单再导航**。菜单在册期间原生视图是隐藏的，直接导航会让新视图建出来
 *  盖在菜单上（`create` 之后才轮到 watch 把它藏回去——中间那帧抢不回来）。 */
async function onFolderPick(url: string) {
  openFolder.value = null;
  await nextTick();
  await openBookmark(url);
}

/** ★ 的目标 URL：活动标签的当前 URL；空标签时用地址栏里已输入的内容。 */
const starTarget = computed(() => active.value?.url || normalizeBrowserUrl(address.value));
const starred = computed(() => !!starTarget.value && bookmarkIdOf(starTarget.value) !== null);

/** ★：已收藏 = 取消收藏；未收藏 = 收藏（标题先用标签标题=主机名，真标题待 webview2-com）。 */
async function toggleBookmark() {
  const url = starTarget.value;
  if (!url) return;
  try {
    const existing = bookmarkIdOf(url);
    if (existing) {
      await removeBookmark(existing);
      setInfo("已取消收藏");
    } else {
      const saved = await addBookmark(tabLabelOf(url), url);
      setInfo(`已收藏：${saved.title}`);
    }
  } catch (e) {
    setError(e);
  }
}

/** 收藏条上删除：不弹确认——误删再点 ★ 就回来了，收藏不是不可逆数据。 */
async function removeFromBar(id: string) {
  try {
    await removeBookmark(id);
  } catch (e) {
    setError(e);
  }
}

/** 收藏条上点一条：在当前标签打开（空标签则先建视图）。 */
async function openBookmark(url: string) {
  address.value = url;
  await go();
}

/** 导入：应用内文件选择器给路径 → Rust 解析合并 → 如实报告（新增/补目录/跳过/丢弃）。 */
async function onImportFile(path: string) {
  try {
    setInfo(formatImportReport(await importFromFile(path)));
  } catch (e) {
    setError(e);
  }
}

// ── 生命周期与事件 ──

// 切标签：旧视图隐藏、新视图显示（都在注册表里常驻，不销毁）。
watch(activeId, async (_id, oldId) => {
  hideTab(tabs.value.find((t) => t.id === oldId));
  clearMessage();
  address.value = active.value?.url ?? "";
  if (viewAllowed.value) await showActive();
});

// 可见性总闸：面板开关 **与** 浮层开关都收敛到 viewAllowed——开 → 露头，关 → 让位（保活，不销毁）。
watch(viewAllowed, (ok) => {
  if (ok) void showActive();
  else hideTab(active.value);
});

onMounted(() => {
  ro = new ResizeObserver(scheduleSync);
  if (surfaceEl.value) ro.observe(surfaceEl.value);
  window.addEventListener("resize", scheduleSync);

  // 首次挂载时面板可能已经是开的（`browserEverActive` 与 `browserActive` 同一次点击里置位，
  // 组件的 watch 捕不到那次变化）——补一次显示，别让首个视图隐着。
  if (viewAllowed.value) void showActive();

  // 收藏条数据（模块级单例状态，挂载时拉一次；之后每次写操作各自刷新）。
  void refreshBookmarks();

  // 导航事件：**多驱动者共用的真相通道**——页面是被用户点出来的、还是将来 agent 工具驱动的，
  // 状态都从这里到 UI（CLAUDE.md 红线：UI 状态只认事件，不做乐观更新）。
  void onBrowserNav((e) => {
    const t = tabs.value.find((x) => x.viewId === e.id);
    // 认不出的视图 id → 忽略（本面板只认自己建的）。将来 agent 自建视图的标签页在这里长出来
    // ——那需要视图生命周期事件，见续作路线。
    if (!t) return;
    t.nav = navOfEvent(e);
    t.canGoBack = e.can_go_back;
    t.canGoForward = e.can_go_forward;
    const url = urlOfNav(t.nav);
    if (url) {
      t.url = url;
      if (t.id === activeId.value) syncAddressFromTab();
    }
  }).then((fn) => {
    unlistenNav = fn;
  });
});

onBeforeUnmount(() => {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
  window.removeEventListener("resize", scheduleSync);
  if (rafId) cancelAnimationFrame(rafId);
  unlistenNav?.();
  unlistenNav = null;
  // 组件销毁 = 销毁全部原生视图（否则它们脱离 DOM 生命周期、继续浮在最上层）。
  for (const t of tabs.value) {
    if (t.viewId) void browser.close(t.viewId).catch(() => {});
  }
});
</script>

<template>
  <div v-show="browserActive" class="browser-panel">
    <!-- 顶行：标签条（可横向滚动）+ 关面板 ✕ 钉在右上角（与「知识库/插件」头部同规格同语义：
         面板关掉回聊天，网页保活） -->
    <div class="bp-top">
      <div class="bp-tabs">
        <div
          v-for="t in tabs"
          :key="t.id"
          class="bp-tab"
          :class="{ on: t.id === activeId }"
          :title="t.url || '新标签页'"
          @click="activateTab(t.id)"
        >
          <span v-if="t.nav?.state === 'loading'" class="bp-spin" aria-hidden="true" />
          <span class="bp-tab-label">{{ tabLabelOf(t.url) }}</span>
          <button class="bp-tab-x" title="关闭标签页" @click.stop="closeTab(t.id)">✕</button>
        </div>
        <button class="bp-add" title="新建标签页" @click="addTab">＋</button>
      </div>
      <button
        class="bp-iconbtn"
        v-tooltip="'关闭面板（网页保活：Ctrl+8 / Ctrl+Shift+B 或右栏 rail 图标可再开）'"
        @click="select('browser')"
      >
        ✕
      </button>
    </div>

    <!-- 工具栏（在洞外：原生视图会盖住洞内的任何 HTML） -->
    <div class="bp-toolbar">
      <button class="bp-btn" :disabled="!active?.canGoBack" title="后退" @click="back">‹</button>
      <button
        class="bp-btn"
        :disabled="!active?.canGoForward"
        title="前进"
        @click="forward"
      >›</button>
      <button class="bp-btn" title="刷新当前页面" @click="reload">⟳</button>
      <input
        ref="addressEl"
        v-model="address"
        class="bp-address"
        placeholder="输入网址，回车打开（裸域名自动补 https://）"
        spellcheck="false"
        @keydown.enter="go"
      />
      <button
        class="bp-btn bp-star"
        :class="{ on: starred }"
        :disabled="!starTarget"
        :title="starred ? '取消收藏' : '收藏当前页面'"
        @click="toggleBookmark"
      >
        {{ starred ? "★" : "☆" }}
      </button>
      <button class="bp-btn bp-go" @click="go">打开</button>
    </div>

    <!-- 收藏条：顶层文件夹点开下拉、根级散条点标题直达、✕ 删除；右端是导入入口 -->
    <div class="bp-bookmarks">
      <div class="bp-bm-list">
        <template v-for="e in bookmarkBar" :key="entryKey(e)">
          <button
            v-if="e.kind === 'folder'"
            class="bp-bm bp-bm-folder"
            :title="`文件夹：${e.folder.name}`"
            @click="openFolderMenu(e.folder, $event)"
          >
            <Icon name="folder" :size="13" class="bp-bm-glyph" />
            <span class="bp-bm-label">{{ e.folder.name }}</span>
          </button>
          <div v-else class="bp-bm" :title="e.url">
            <img v-if="favicons[e.url]" class="bp-bm-icon" :src="favicons[e.url]" alt="" />
            <Icon v-else name="globe" :size="13" class="bp-bm-glyph" />
            <span class="bp-bm-label" @click="openBookmark(e.url)">{{ e.title }}</span>
            <button class="bp-bm-x" title="删除收藏" @click="removeFromBar(e.id)">✕</button>
          </div>
        </template>
      </div>
      <button
        class="bp-bm-import"
        title="从书签文件导入（浏览器导出的 HTML 或 Chromium 的 JSON）"
        @click="pickerVisible = true"
      >
        导入…
      </button>
    </div>

    <!-- 文件夹下拉（自己 Teleport 到 body；在册期间原生视图让位——见「可见性总闸」） -->
    <BookmarkFolderMenu
      v-if="openFolder"
      :folder="openFolder"
      :anchor="folderMenuAnchor"
      :favicons="favicons"
      @open="onFolderPick"
      @close="openFolder = null"
    />

    <div v-if="message" class="bp-notice" :class="{ err: messageTone === 'error' }">
      {{ message }}
    </div>

    <!-- 占位洞：原生 WebView2 子视图浮在这块的屏幕坐标之上 -->
    <div ref="surfaceEl" class="bp-surface">
      <div v-if="!active?.viewId" class="bp-hint">
        <span class="bp-hint-title">新标签页</span>
        <span class="bp-hint-sub">在地址栏输入网址回车打开</span>
      </div>
    </div>

    <!-- 导入用的文件选择器：复用应用内单文件选择弹窗（有盘符入口 + 可编辑地址栏，
         能选到任意路径——书签文件通常在 Downloads，不在工作区内）。
         它的根元素挂了 `v-overlay-layer`：一开就登记，原生视图自动让位（见「可见性总闸」）。 -->
    <FilePickerDialog
      v-model:visible="pickerVisible"
      title="导入书签文件"
      empty-error="请选择书签文件（HTML 或 JSON）"
      @confirm="onImportFile"
    />
  </div>
</template>

<style scoped>
.browser-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--aide-bg-base);
}

/* ── 顶行：标签条 + 关面板 ── */

.bp-top {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
}

.bp-tabs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 0;
  overflow-x: auto;
}

/* 关面板：钉在右上角不随标签条滚动（与「知识库/插件」头部 ✕ 同语义） */
.bp-iconbtn {
  flex: 0 0 auto;
  align-self: flex-start;
  margin: 6px 8px 0 4px;
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--aide-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.bp-iconbtn:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.bp-tab {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  height: 28px;
  padding: 0 6px 0 10px;
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-bottom: none;
  border-radius: var(--aide-radius-sm) var(--aide-radius-sm) 0 0;
  cursor: pointer;
  user-select: none;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.bp-tab:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
/* 活动标签 = 当前所在页面（与侧栏导航行同语言：accent 轻量标记） */
.bp-tab.on {
  color: var(--aide-text-primary);
  background: var(--aide-bg-base);
  border-color: var(--aide-accent);
}

.bp-tab-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bp-tab-x {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 10px;
  line-height: 1;
  color: var(--aide-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
}
.bp-tab-x:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.bp-add {
  flex: 0 0 auto;
  width: 26px;
  height: 28px;
  margin-bottom: 1px;
  font-size: 14px;
  line-height: 1;
  color: var(--aide-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
}
.bp-add:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

/* 加载指示：只动 transform（合成器动画，不触发布局/重绘） */
.bp-spin {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--aide-text-muted);
  border-top-color: var(--aide-accent);
  border-radius: 50%;
  animation: bp-spin 0.8s linear infinite;
}
@keyframes bp-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 工具栏 ── */

.bp-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
}

.bp-btn {
  flex: 0 0 auto;
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
  font-size: 15px;
  line-height: 1;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.bp-btn:hover:not(:disabled) {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.bp-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.bp-go {
  color: var(--aide-text-on-accent);
  background: var(--aide-accent);
  border-color: var(--aide-accent);
  font-size: 13px;
}
.bp-go:hover:not(:disabled) {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.bp-address {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  font-size: 13px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  outline: none;
}
.bp-address:focus {
  border-color: var(--aide-accent);
}

/* ★ 已收藏 = accent（与侧栏导航行的选中语言一致） */
.bp-star {
  font-size: 14px;
}
.bp-star.on:not(:disabled) {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}

/* ── 收藏条 ── */

.bp-bookmarks {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
}

.bp-bm-list {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
}

.bp-bm {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 180px;
  height: 24px;
  padding: 0 2px 0 8px;
  border-radius: var(--aide-radius-sm);
  transition: background var(--aide-ease-t);
}

/* 文件夹按钮：与书签同一行同高，靠 ▾ 区分（不塞文件夹图标——收藏条本来就密）。 */
.bp-bm-folder {
  padding: 0 8px;
  border: none;
  background: none;
  cursor: pointer;
}

/* 图标位：站点真图标 / 缺图标时的地球字形 / 目录的文件夹字形，都是 14px 见方且不参与收缩。 */
.bp-bm-icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border-radius: 2px;
  object-fit: contain;
}

.bp-bm-glyph {
  flex: 0 0 auto;
  color: var(--aide-text-muted);
}
.bp-bm:hover {
  background: var(--aide-surface-hover);
}

.bp-bm-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--aide-text-secondary);
  cursor: pointer;
}
.bp-bm:hover .bp-bm-label {
  color: var(--aide-text-primary);
}

.bp-bm-x {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: 9px;
  line-height: 1;
  color: var(--aide-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
}
.bp-bm-x:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.bp-bm-import {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.bp-bm-import:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

/* 消息条：导航错误与书签反馈共用一行（info 中性色，err 才用 danger） */
.bp-notice {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border-bottom: 1px solid var(--aide-border);
}
.bp-notice.err {
  color: var(--aide-danger);
}

/* ── 占位洞 ── */

.bp-surface {
  flex: 1 1 auto;
  position: relative;
  min-height: 0;
  background: var(--aide-surface-default);
}

.bp-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
}
.bp-hint-title {
  font-size: 14px;
  color: var(--aide-text-secondary);
}
.bp-hint-sub {
  font-size: 12px;
  color: var(--aide-text-muted);
}
</style>
