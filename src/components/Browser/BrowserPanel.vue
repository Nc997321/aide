<script setup lang="ts">
// 内嵌浏览器主区面板：主区一级视图（跟「插件」「知识库」同级，不占会话 tab、不碰 pane 布局），
// 自带标签条。
//
// 物理约束（plan §2）：原生 WebView2 子视图浮在主 webview 的 HTML **之上**，不能与 Vue 元素
// z 序交错。所以 `.bp-surface` 是布局里的「占位洞」——原生视图被钉在它的屏幕坐标上；标签条与
// 工具栏排在洞**外**（不重叠），否则会被原生视图吃掉。面板关闭 / 切标签都必须 `setDisplayed(false)`，
// 否则原生视图脱离 DOM 生命周期、继续浮在全部内容之上。
// 同理，**任何 HTML 浮层盖上来时它都得让位**（`v-overlay-layer` 登记驱动，见「可见性总闸」）——
// 浮层的 z-index 再高也压不住原生子视图，只有让位一条路。
//
// 坐标：窗口 `decorations(false)` + 主 webview 铺满客户区 → `getBoundingClientRect()`(CSS px)
// 直接等于 Tauri logical px（devicePixelRatio == scale_factor），无需换算；rect 视口相对，天然
// 吸收滚动偏移。
//
// 多标签：**每个标签一个原生视图**（Rust 注册表 `id → 视图`，引擎天然支持 N 个），切换 = 旧视图
// `setDisplayed(false)` + 新视图 `setDisplayed(true)` + 同步坐标；视图常驻注册表，切回页面状态还在。
// 空标签（还没导航过）不建视图——首次导航才 create，免得每个新标签都空跑一次加载。
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { api } from "@aide/sdk";
import {
  useEmbeddedBrowser,
  onBrowserNav,
  type BrowserViewDto,
  type BoundsDto,
  type NavEventDto,
  type NavStateDto,
  type ViewEventDto,
} from "../../composables/browser/useEmbeddedBrowser";
import { useRightPanel } from "../../composables/useRightPanel";
import { useBrowserBookmarks } from "../../composables/browser/useBrowserBookmarks";
import { useBrowserViews } from "../../composables/browser/useBrowserViews";
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

const { browserActive, select, pendingBrowserUrl, consumePendingBrowserUrl } = useRightPanel();
const browser = useEmbeddedBrowser();
// 常驻层（App 已安装）：挂载前收到的生命周期事件与 focus 请求都在它那儿缓冲着。
const { pendingFocusViewId, buffered, takeViewEvents, consumePendingFocus } = useBrowserViews();

/** 一个浏览器标签页。`viewId=null` = 还没开原生视图的空标签（首次导航才 create）。 */
interface Tab {
  id: string;
  viewId: string | null;
  /** 标签当前 URL（地址栏回显 + ⟳ 的目标；编辑中的输入不写回这里）。 */
  url: string;
  nav: NavStateDto | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 创建时给的名字（agent 靠它给 tab 起名），页面没标题时标签条用它。 */
  label: string | null;
  /** 谁开的：agent 的 tab 在标签条上带归属标记。 */
  origin: "user" | "agent";
}

function blankTab(): Tab {
  return {
    id: `tab-${crypto.randomUUID()}`,
    viewId: null,
    url: "",
    nav: null,
    canGoBack: false,
    canGoForward: false,
    label: null,
    origin: "user",
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

/**
 * 面板对**已存在视图**的后台调用（同步坐标 / 显示 / 隐藏 / 对账）失败时不打扰用户，但**必须留痕**：
 * 这些调用一旦被后端拒绝（视图不属于本窗口 / 已不存在），原生视图就会脱离面板——悬在错的位置、盖住
 * 别的内容、标签页对不上——而静默吞掉错误就让这类故障无从诊断。落到 Rust 日志（`FRONTEND_ERROR`），
 * 同一条 5 秒内只记一次（resize 期间每帧一次的同步不能淹没日志）。
 */
const faultLoggedAt = new Map<string, number>();
function fault(op: string, e: unknown) {
  const line = `[browser] ${op} failed: ${typeof e === "string" ? e : String(e)}`;
  const now = Date.now();
  if (now - (faultLoggedAt.get(line) ?? 0) < 5000) return;
  faultLoggedAt.set(line, now);
  void api.logFrontendError(line).catch(() => {});
}

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
  void browser.setBounds(viewId, b).catch((e) => fault(`set_bounds ${viewId}`, e));
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
  await browser.setDisplayed(viewId, true).catch((e) => fault(`set_displayed(true) ${viewId}`, e));
  await nextTick();
  syncBounds();
}

/** 隐藏某个标签的原生视图（保活：只隐不销毁，页面状态留在注册表里）。 */
function hideTab(t: Tab | undefined) {
  if (!t?.viewId) return;
  const viewId = t.viewId;
  void browser.setDisplayed(viewId, false).catch((e) => fault(`set_displayed(false) ${viewId}`, e));
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
  t.label = view.label;
  t.origin = view.origin;
}

// ── 视图生命周期：与 agent 共处一张标签条 ──

/** 标签显示名：agent 起的名 > 页面标题 > 主机名。 */
function tabTitle(t: Tab): string {
  const titled = t.nav?.state === "ready" ? t.nav.title : "";
  return t.label || titled || tabLabelOf(t.url);
}

/** 用一份视图快照建标签（对账与 created 事件共用）。 */
function adoptView(v: BrowserViewDto): Tab {
  const t = blankTab();
  applyView(t, v);
  return t;
}

/** 摘掉一个标签，**不动视图**（视图已被销毁，或由别的驱动者负责）。空表时补一个空标签。 */
function dropTab(id: string) {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.value.splice(i, 1);
  if (tabs.value.length === 0) {
    const t = blankTab();
    tabs.value.push(t);
    activeId.value = t.id;
    return;
  }
  if (activeId.value === id) {
    activeId.value = tabs.value[Math.min(i, tabs.value.length - 1)].id;
  }
}

/** 库里有的视图而标签条上没有 → 补标签（agent 开 tab 时面板还没挂载就是这条路径）。 */
function adoptMissing(views: BrowserViewDto[]) {
  for (const v of views) {
    if (!tabs.value.some((t) => t.viewId === v.id)) tabs.value.push(adoptView(v));
  }
}

/** 标签条上有视图而库里没有 → 摘掉（视图已被别人关掉，**不能再调 close**）。 */
function dropGone(views: BrowserViewDto[]) {
  const live = new Set(views.map((v) => v.id));
  for (const t of tabs.value.filter((x) => x.viewId && !live.has(x.viewId))) {
    dropTab(t.id);
  }
}

// ── 自己 create 的回声：押后到应答落地 ──
//
// 面板自己开的网页也走"认不出的视图 id"这条路。`browser_create` 是 async 命令，而 Rust 在
// **create 内部**就广播了 `browser-view created`（facade.rs：`broadcast_view` 在回快照之前），
// 应答要绕 tokio worker 回来——**回声恒先于应答**（真机每次必犯，不是偶发竞态）。那一刻新标签
// 还没有 viewId（id 在应答里），两条采纳路径都会把它当成"别人开的 tab"再长一个：同一个视图两个
// 标签，后长的那个再也收不到后续事件（`find` 只认第一个），于是永远空白。
//
// 所以：**自己有 create 在飞时，认不出的视图事件先押后**。不猜归属——这个特性的应用场景恰恰是
// 多个 agent 并发开 tab，猜错就是把 agent 的页面绑到你的标签上；押后不需要猜：等应答把 id 绑上
// 再回放，命中的是自己的视图（幂等），仍然认不出的才是别人开的。

/** 正在等 `browser_create` 应答的标签（id 还没回来）。 */
const creatingTabs = new Set<Tab>();

/** 押后的回声（带 id：视图没了就别回放）。 */
let heldEchoes: Array<{ id: string; replay: () => void }> = [];

/** 有 create 在飞就把这件事押后（回 true = 已押后，调用方别再采纳）。 */
function deferWhileCreating(viewId: string, replay: () => void): boolean {
  if (creatingTabs.size === 0) return false;
  heldEchoes.push({ id: viewId, replay });
  return true;
}

/** create 落定后回放押后的事件（那时自己的 id 已经绑上，回放都落在"已知"这条路上）。 */
function flushHeldEchoes() {
  if (creatingTabs.size > 0) return;
  const pending = heldEchoes;
  heldEchoes = [];
  for (const { replay } of pending) replay();
  // 回放可能才把某个标签长出来（agent 的 tab）——focus 请求正等着它，补一次机会。
  applyPendingFocus();
}

/** 视图已经没了：押着的回声别再回放，否则补出一个再也摘不掉的幽灵标签。 */
function forgetHeldEchoes(viewId: string) {
  heldEchoes = heldEchoes.filter((h) => h.id !== viewId);
}

/** 应用一条生命周期增量：created 补标签、closed 摘标签。重复投递是安全的（幂等）。 */
function applyViewEvent(e: ViewEventDto) {
  const existing = tabs.value.find((t) => t.viewId === e.id);
  if (e.kind === "created") {
    if (existing) {
      existing.label = e.label;
      existing.origin = e.origin;
      return;
    }
    // 认不出的视图：可能正是自己在建的那个（应答还没回来）——押后，别急着自己建标签。
    if (deferWhileCreating(e.id, () => applyViewEvent(e))) return;
    tabs.value.push({ ...blankTab(), viewId: e.id, label: e.label, origin: e.origin });
    return;
  }
  forgetHeldEchoes(e.id);
  if (existing) dropTab(existing.id);
}

/** 应用一批增量（常驻层缓冲来的），随后处理可能已就位的 focus 请求。 */
function applyViewEvents(events: ViewEventDto[]) {
  for (const e of events) applyViewEvent(e);
  applyPendingFocus();
}

/** 应用一条导航事件——**多驱动者共用的真相通道**：页面是被用户点出来的、还是 agent 工具驱动的，
 *  状态都从这里到 UI（CLAUDE.md 红线：UI 状态只认事件，不做乐观更新）。 */
function applyNav(e: NavEventDto) {
  let t = tabs.value.find((x) => x.viewId === e.id);
  if (!t) {
    // 视图生命周期事件还没到（或面板错过了）→ 就地长一个标签，免得"页面在跑但标签条上没有它"。
    // 自己 create 的回声也走这条路（应答未回、id 未绑）——押后，等绑上了再回放。
    if (deferWhileCreating(e.id, () => applyNav(e))) return;
    t = { ...blankTab(), viewId: e.id };
    tabs.value.push(t);
  }
  t.nav = navOfEvent(e);
  t.canGoBack = e.can_go_back;
  t.canGoForward = e.can_go_forward;
  const url = urlOfNav(t.nav);
  if (url) {
    t.url = url;
    if (t.id === activeId.value) syncAddressFromTab();
  }
}

/** 待切视图到了就切过去（focus 请求可能先于标签出现，也可能先于面板挂载）。 */
function applyPendingFocus() {
  const want = pendingFocusViewId.value;
  if (!want) return;
  const t = tabs.value.find((x) => x.viewId === want);
  if (!t) return; // 视图还没在标签条上出现：留着 pending，等下一次
  activeId.value = t.id;
  consumePendingFocus(want);
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
  // 回声已经在路上（见「自己 create 的回声」）：先登记，押后的事件要等这次应答落地才回放。
  creatingTabs.add(t);
  try {
    applyView(t, await browser.create(url, b));
    clearMessage();
    return true;
  } catch (e) {
    setError(e);
    return false;
  } finally {
    creatingTabs.delete(t);
    flushHeldEchoes();
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

/**
 * 「给我在右栏打开这个地址」——来自别的模块的请求（资料库的网页产物预览）。
 *
 * 开**新标签**而不是改写当前页：预览是「顺手看一眼」，不该把用户正在读的那页顶掉。
 * 走面板自己的建视图路径（`ensureView`），地址栏 / 标签 / 收藏状态与手动打开一致——
 * 不直接调 `browser.create` 绕过面板状态。
 */
async function openExternally(url: string) {
  const target = normalizeBrowserUrl(url);
  if (!target) return;

  const t = blankTab();
  tabs.value.push(t);
  activeId.value = t.id; // 激活 watcher 负责显隐；这里等布局落到占位洞上
  clearMessage();

  if (!(await waitForSurface())) return;
  if (!(await ensureView(t, target))) return;
  t.url = target;
  if (t.id === activeId.value) syncAddressFromTab();
}

/**
 * 等占位洞拿到真实尺寸（最多 ~10 帧）。
 *
 * 面板可能是**这一拍刚被展开**的（资料库点「在右栏打开」就是），此时 v-show 的
 * 布局还没落，`rectOf()` 拿到 0×0 —— 直接建视图会失败成一个看不懂的错误。
 */
async function waitForSurface(): Promise<boolean> {
  for (let i = 0; i < 10; i += 1) {
    await nextTick();
    if (rectOf()) return true;
    await new Promise((r) => requestAnimationFrame(r));
  }
  setError("占位区未就绪（宽高为 0）");
  return false;
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

/** 关标签 = 销毁该视图（与面板关闭不同：那是保活，只 parking）。 */
function closeTab(id: string) {
  const t = tabs.value.find((x) => x.id === id);
  if (t?.viewId) void browser.close(t.viewId).catch(() => {});
  // 空表补一页、活动标签接替：都在 dropTab 里（与"视图被别人关掉"共用同一条路径）。
  dropTab(id);
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
  if (ok) {
    void showActive();
    // 有浮层盖着时收到的「打开这个地址」不执行（建视图要占位洞的真实尺寸），
    // 留在这儿等浮层关掉再消费
    void consumePendingOpen();
  } else {
    hideTab(active.value);
  }
});

/**
 * 消费别的模块留下的待打开地址（`useRightPanel.openInBrowser`）。
 *
 * **不消费就留着的两种情况**：面板被折叠（`viewAllowed` 为假）、有浮层盖着。
 * 那时建视图拿不到尺寸，硬开会失败成一个看不懂的错误——等开关变化时再来。
 */
async function consumePendingOpen() {
  const url = pendingBrowserUrl.value;
  if (!url || !viewAllowed.value) return;
  consumePendingBrowserUrl();
  await openExternally(url);
}

onMounted(() => {
  ro = new ResizeObserver(scheduleSync);
  if (surfaceEl.value) ro.observe(surfaceEl.value);
  window.addEventListener("resize", scheduleSync);

  // 首次挂载时面板可能已经是开的（`browserEverActive` 与 `browserActive` 同一次点击里置位，
  // 组件的 watch 捕不到那次变化）——补一次显示，别让首个视图隐着。
  if (viewAllowed.value) void showActive();

  // 收藏条数据（模块级单例状态，挂载时拉一次；之后每次写操作各自刷新）。
  void refreshBookmarks();

  // **对账**：视图可能先于面板被创建（agent 先开 tab、用户还没点开面板），那条 `browser-view`
  // 事件就没人接。所以挂载时先拉一次快照补齐，再吃增量——快照是权威、事件是增量。
  void browser
    .listViews()
    .then((views) => {
      adoptMissing(views);
      dropGone(views);
      applyPendingFocus();
    })
    .catch((e) => {
      // 对账失败不该挡住面板本身（增量通道仍然有效），但要留痕：失败意味着面板挂载前就存在的视图
      // （窗口重载后残留的原生视图）认不回来，会悬在面板之外。
      fault("views_list", e);
    });

  // 常驻层缓冲的增量（挂载前收到的都在它那儿）。
  watch(buffered, () => applyViewEvents(takeViewEvents()));
  watch(pendingFocusViewId, applyPendingFocus);

  // 待打开的地址：面板可能是**挂载之后**才收到请求的（懒挂载——首次点浏览器 tab 才挂），
  // 也可能是挂载前就压着一条（下面补一次消费）。
  watch(pendingBrowserUrl, () => void consumePendingOpen());
  void consumePendingOpen();

  // 导航事件订阅（应用逻辑见 `applyNav`）。
  void onBrowserNav(applyNav).then((fn) => {
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
          <span
            v-if="t.origin === 'agent'"
            class="bp-tab-agent"
            title="agent 开的标签页（后台在跑，不抢你的前台）"
            >◆</span
          >
          <span class="bp-tab-label">{{ tabTitle(t) }}</span>
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

/* agent 开的 tab：一枚小菱形（与"自己开的"一眼分开）。颜色走语义 token，不硬编码。 */
.bp-tab-agent {
  flex: 0 0 auto;
  font-size: 9px;
  line-height: 1;
  color: var(--aide-accent);
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
