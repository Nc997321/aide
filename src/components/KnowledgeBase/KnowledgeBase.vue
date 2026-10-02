<script setup lang="ts">
/**
 * 知识库主区视图（第一版：可读可搜）。
 * 与 MemoryObservatory 同范式——填满主区的一级视图，不是模态。
 * 数据闭包见 useKnowledgeBase，通道见 kbClient（直连 knowledge-server REST）。
 *
 * 第一版不做：编辑保存、版本回滚、编辑锁、文件上传导入。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import Icon from "@/components/Icon.vue";
import { useKnowledgeBase } from "@/composables/useKnowledgeBase";
import { useModal } from "@/composables/useModal";
import KbLogin from "./KbLogin.vue";
import KbDocumentView from "./KbDocumentView.vue";
import { getBaseUrl, kb } from "./kbClient";
import { GUIDE_MD } from "./guideText";
import { MIN_SERVER_VERSION, UPGRADE_COMMAND } from "./serverVersion";
import KbSearchView from "./KbSearchView.vue";
import KbMembers from "./KbMembers.vue";
import KbSpaceList from "./KbSpaceList.vue";
import KbTree from "./KbTree.vue";
import { ancestorIds, subtreeSize } from "./docTree";

const emit = defineEmits<{ close: [] }>();

const k = useKnowledgeBase();
/** 应用统一的对话框（ModalDialog）。**不用 window.confirm**：那个在 WebView 里
 *  是浏览器原生样式，与整个应用的主题无关，且会阻塞渲染进程。 */
const modal = useModal();
const activeDocId = ref<string | null>(null);
/** 两段的「+」都在父层模板里（分组标题旁），只能这样够到组件的 startCreate */
const spaceRef = ref<InstanceType<typeof KbSpaceList> | null>(null);
const treeRef = ref<InstanceType<typeof KbTree> | null>(null);

// 视图分流只有一条轴：登录与否。未登录直接是 KbLogin 表单（模式由服务端
// initialized 决定：空库 → 创建管理员，否则 → 口令登录/邀请链接），
// 登录成功 k.user 非空即落主界面。没有营销首屏，没有「先看看长什么样」。

// 「文档 / 成员」二态——与 view 分流是两套轴，互不干扰。
const innerView = ref<"doc" | "members">("doc");

const isAdmin = computed(() => k.user.value?.isAdmin === true);

// ── 两个全屏态 ──
// 索引态＝屏幕没被任何一样东西占着（目录整屏）；阅读态＝有东西开着（整屏给它）。
// 这个判断只有一处，模板里所有分流都挂在它上面。
const reading = computed(
  () =>
    innerView.value === "members" ||
    !!k.searchResult.value ||
    k.searching.value ||
    !!k.activeDoc.value,
);

// ── 阅读态的左侧目录栏 ──
// 阅读时看得见自己在库里的位置、能直接跳到相邻文档，不必每次退回整屏目录。
// 开合是个人偏好，记在 localStorage（不可用时就每次默认展开，不影响功能）。
const RAIL_KEY = "aide.kb.railOpen";
function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== "0";
  } catch {
    return true;
  }
}
const railOpen = ref(readRail());
function toggleRail(): void {
  railOpen.value = !railOpen.value;
  try {
    localStorage.setItem(RAIL_KEY, railOpen.value ? "1" : "0");
  } catch {
    /* 偏好存不下就算了 */
  }
}

const railTitle = computed(
  () =>
    (k.spaces.value.length > 1 && k.spaces.value.find((s) => s.id === k.activeSpaceId.value)?.name) ||
    "目录",
);

/** 当前文档的祖先链（从根到父）。给文章页的面包屑用。 */
const crumbs = computed(() => {
  const id = activeDocId.value;
  if (!id) return [];
  const byId = new Map(k.documents.value.map((d) => [d.id, d.title]));
  return ancestorIds(k.documents.value, id)
    .reverse()
    .map((aid) => ({ id: aid, title: byId.get(aid) ?? "" }))
    .filter((c) => c.title !== "");
});

/** 搜索结果的所在路径：命中很多时，靠路径区分同名文档。 */
const hitPaths = computed(() => {
  const res = k.searchResult.value;
  if (!res) return {};
  const byId = new Map(k.documents.value.map((d) => [d.id, d.title]));
  const out: Record<string, string> = {};
  for (const h of res.hits) {
    out[h.documentId] = ancestorIds(k.documents.value, h.documentId)
      .reverse()
      .map((id) => byId.get(id) ?? "")
      .filter(Boolean)
      .join(" / ");
  }
  return out;
});

// ── 文档互链 [[标题]] ──
const norm = (t: string): string => t.trim().toLowerCase();
const knownTitles = computed<ReadonlySet<string>>(
  () => new Set(k.documents.value.filter((d) => d.kind !== "folder").map((d) => norm(d.title))),
);

/** 点互链：按标题找文档。重名取最近更新的那篇；找不到就如实说，不静默。 */
async function onWiki(title: string): Promise<void> {
  const hits = k.documents.value
    .filter((d) => d.kind !== "folder" && norm(d.title) === norm(title))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (!hits.length) {
    k.notice.value = `库里没有叫「${title.trim()}」的文档`;
    return;
  }
  await openFromSearch(hits[0].id);
}

/** 点面包屑里的文件夹：文件夹没有正文，只能把它在目录里亮出来。 */
async function onReveal(id: string): Promise<void> {
  if (!railOpen.value) toggleRail();
  k.revealNode(id);
  await nextTick();
  treeRef.value?.scrollToNode(id);
}

// ── 索引首页：最近更新 + 概况 ──
// 首页不能只是一列目录：先回答「最近谁动了什么」，再给全量目录；页脚亮出连接状态，
// 让人一眼知道这个库是连着的、是新的。

/** 相对时间：近的说「今天 / 昨天 / N 天前」，远的给日期。 */
function relTime(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() === new Date().getFullYear() ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

const docCount = computed(() => k.documents.value.filter((d) => d.kind !== "folder").length);

/** 最近更新的 4 篇文档（不含文件夹）。不足 3 篇时不出这一块——几篇的库一眼就看完了，不需要「最近」。 */
const recent = computed(() => {
  if (docCount.value < 3) return [];
  const byId = new Map(k.documents.value.map((d) => [d.id, d.title]));
  return k.documents.value
    .filter((d) => d.kind !== "folder" && d.updatedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 4)
    .map((d) => ({
      id: d.id,
      title: d.title,
      path: ancestorIds(k.documents.value, d.id)
        .reverse()
        .map((id) => byId.get(id) ?? "")
        .filter(Boolean)
        .join(" / "),
      time: relTime(d.updatedAt),
    }));
});

/** 页脚的连接主机：只给 host（端口去掉），完整地址在设置里看。 */
const serverHost = computed(() => {
  try {
    return new URL(getBaseUrl()).hostname;
  } catch {
    return getBaseUrl();
  }
});

/** 回索引：把"开着的东西"全部关掉。 */
function backToIndex(): void {
  k.clearSearch();
  innerView.value = "doc";
  activeDocId.value = null;
  // 直接清 composable 里的 activeDoc：它只被读，但这里是唯一的"关闭"语义所在，
  // 没有对应的 composable 方法可调（不为此新增 API）。
  k.activeDoc.value = null;
}

// ── 使用指南 ──
// 它**不是**特殊页面：是库里一份普通文档。没有它时索引页给一个一次性入口装进来
// （见模板的 kb-index-foot），装过之后入口永久消失，之后你改它、删它都随你。
const hasGuide = computed(() => k.documents.value.some((d) => d.title === "使用指南"));

async function installGuide(): Promise<void> {
  const spaceId = k.activeSpaceId.value;
  if (!spaceId) return;
  const r = await kb.createDocument({
    spaceId,
    parentId: null,
    title: "使用指南",
    content: GUIDE_MD,
  });
  await k.loadDocuments(spaceId);
  await openDoc(r.documentId);
}

// 进入成员页时拉一次名单；非管理员不会看到入口，这里再兜一层防止直接切。
watch(innerView, (v) => {
  if (v === "members" && isAdmin.value) void k.loadUsers();
});

/** 折叠集由父层持有：只有它知道 localStorage 与当前空间（KbTree 是受控组件）。 */
const collapsed = computed<ReadonlySet<string>>(() => k.collapsedFor(k.activeSpaceId.value));

// 正在编辑的文档 id。openDoc 切换前检查它，避免编辑中的草稿被侧栏一次点击冲掉
// （编辑内容本身在 KbDocumentView 里，组件卸载即丢——所以要在卸载前问一句）。
const editingDocId = ref<string | null>(null);

async function openDoc(id: string): Promise<void> {
  if (editingDocId.value && editingDocId.value !== id) {
    const name =
      k.documents.value.find((d) => d.id === editingDocId.value)?.title ?? "那份文档";
    const ok = await modal.confirm(
      "切换会丢掉没保存的内容",
      `「${name}」还在编辑中。切过去之后，没保存的修改就没了。`,
      "丢弃并切换",
      true,
    );
    if (!ok) return;
    // 用户确认放弃：KbDocumentView 卸载时 onScopeDispose 会释放编辑锁
    editingDocId.value = null;
  }
  activeDocId.value = id;
  k.clearSearch();
  await k.openDocument(id);
}

/**
 * 搜索命中跳转：打开文档之后要**把它的祖先链展开并滚到那一行**。
 * 少了这一步，用户在树里找不到自己刚打开的那篇——文档一多就是常态。
 */
async function openFromSearch(id: string): Promise<void> {
  await openDoc(id);
  k.revealNode(id);
  await nextTick();
  treeRef.value?.scrollToNode(id);
}

function onTreeToggle(id: string): void {
  k.toggleCollapsed(k.activeSpaceId.value, id);
}
async function onTreePatch(id: string, input: { title?: string; parentId?: string | null }): Promise<void> {
  const ok = await k.patchNode(id, input);
  // 移进了折叠着的文件夹：展开它，否则刚移过去的节点从屏幕上「消失」了
  if (ok && input.parentId) k.revealNode(input.parentId);
}

/** 新建节点：标题在树组件的内联输入里收集，随 emit 一起交出来。 */
async function onCreateNode(
  parentId: string | null,
  kind: "doc" | "folder",
  title: string,
): Promise<void> {
  const id = await k.createNode(title, parentId, kind);
  if (!id) return;
  // 新建文档 → 直接打开它（建完就是要写）；新建文件夹 → 什么都不做
  if (kind === "doc") await openDoc(id);
  // 在折叠着的文件夹里新建 → 把它展开，否则新节点看不见
  if (parentId) k.revealNode(parentId);
}

/**
 * 人上传一个文件进来（入口在「新建」菜单与索引页空态里）。
 *
 * 格式判定、上传、错误提示都在闭包里（`k.uploadFile`）；这里只做上传**之后**的事：
 * 展开它落进去的文件夹（不然新节点看不见）、然后打开它——「能放进去」的下一步
 * 就是「能打开看」。
 */
async function onUpload(parentId: string | null, file: File): Promise<void> {
  const id = await k.uploadFile(parentId, file);
  if (!id) return;
  if (parentId) k.revealNode(parentId);
  await openDoc(id);
}

/** 复制升级命令。剪贴板不可用（权限/安全上下文）时不假装成功——命令就在旁边，能自己选。 */
const copiedUpgrade = ref(false);
async function copyUpgrade(): Promise<void> {
  try {
    await navigator.clipboard.writeText(UPGRADE_COMMAND);
    copiedUpgrade.value = true;
    setTimeout(() => (copiedUpgrade.value = false), 1500);
  } catch {
    copiedUpgrade.value = false;
  }
}

/** 保存/回滚后刷新正文与侧栏（侧栏要反映新的 versionNo 与 updatedAt）。
 *  保存请求进行期间用户可能已切走文档——那时只刷列表，不把用户拉回来。 */
async function refreshDoc(id: string): Promise<void> {
  const spaceId = k.activeSpaceId.value;
  if (activeDocId.value === id) await k.openDocument(id);
  if (spaceId) await k.loadDocuments(spaceId);
}

function onEditing(on: boolean): void {
  editingDocId.value = on ? activeDocId.value : null;
}

/**
 * 删除（软删；服务端把整棵子树一并删掉）。
 *
 * 确认弹窗放在**父层**而不是按钮旁边：只有这里手里有整份文档列表，「会连带删掉几个」
 * 才算得出来（与侧栏渲染共用 ./docTree）。数量点明是必要的——用户点的是一个节点，
 * 实际消失的可能是一棵树。
 *
 * 量词是「个项目」不是「篇子文档」：`subtreeSize` 把文件夹也数进去了，说「篇」
 * 会让用户以为文件夹不在其中。
 *
 * 不做「已删除」的成功提示：那一行从侧栏消失、正文区回落空态，本身就是回执。
 */
async function onDeleteDoc(id: string): Promise<void> {
  const title = k.documents.value.find((d) => d.id === id)?.title ?? id;
  const total = subtreeSize(k.documents.value, id);
  const scope = total > 1 ? `它连同下面的 ${total - 1} 个项目会一起被删掉。` : "它会被删掉。";
  const ok = await modal.confirm(
    `删除「${title}」？`,
    `${scope}删除之后不再出现在任何列表、检索与正文里，也没有恢复入口。`,
    "删除",
    true,
  );
  if (!ok) return;

  // 只有真删掉了才把视图切走：403 / 断网时留在原地，否则用户既丢了阅读位置、
  // 文档又还在（错误提示由 k.error 显示在正文区）。
  // 两个都清：只清 activeDocId 的话 composable 里的 activeDoc 还挂着，
  // 阅读态判据仍然成立，屏幕会停在一份已经不存在的文档上。
  if (await k.deleteDocument(id)) {
    activeDocId.value = null;
    k.activeDoc.value = null;
  }
}

// 搜索防抖：中文输入每敲一个字都发请求既浪费又会让结果闪烁
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onQueryInput(v: string): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void k.search(v), 250);
}

onMounted(() => {
  void k.init();
  // 支持的格式（服务端是唯一权威）先拉一次：文件选择器的 accept 用它，
  // 也让第一次上传不用等这一趟。失败无声——真正要报错的时机是上传那一刻。
  void k.loadFormats();
});
</script>

<template>
  <div class="kb-panel" :class="{ 'is-reading': reading }">
    <header class="kb-head">
      <!-- 「资料库」既是标题也是回索引的入口；阅读态它就是返回 -->
      <button class="kb-home" :class="{ back: reading }" @click="backToIndex()">
        <Icon
          v-if="reading"
          name="caret"
          :size="12"
          :stroke-width="1.6"
          class="kb-home-caret"
        />
        <span>资料库</span>
      </button>

      <button
        v-if="k.user.value && reading"
        class="kb-iconbtn"
        v-tooltip="railOpen ? '收起目录' : '展开目录'"
        @click="toggleRail()"
      >
        <Icon name="sidebar" :size="14" :stroke-width="1.4" />
      </button>

      <div v-if="k.user.value" class="kb-searchbox">
        <Icon name="search" :size="13" :stroke-width="1.4" />
        <input
          :value="k.query.value"
          placeholder="搜索资料…"
          @input="onQueryInput(($event.target as HTMLInputElement).value)"
        />
        <button v-if="k.query.value" class="kb-clearq" @click="k.clearSearch()">
          <Icon name="close" :size="11" :stroke-width="1.4" />
        </button>
      </div>

      <span class="kb-spacer" />

      <!-- 新建在索引态是**有字有底色**的按钮：它是这个面板最主要的动作，
           不该缩成一个藏在角落里的小图标 -->
      <button
        v-if="k.user.value && !reading"
        class="kb-newbtn"
        :disabled="!k.activeSpaceId.value"
        @click="treeRef?.openCreateMenu($event, null)"
      >
        <Icon name="plus" :size="12" :stroke-width="1.6" />
        <span>新建</span>
      </button>
      <button
        v-if="k.user.value"
        class="kb-iconbtn"
        v-tooltip="'刷新'"
        :disabled="k.loading.value"
        @click="k.loadSpaces()"
      >
        <Icon name="refresh" :size="13" :stroke-width="1.4" />
      </button>
      <button class="kb-iconbtn" v-tooltip="'关闭'" @click="emit('close')">
        <Icon name="close" :size="13" :stroke-width="1.4" />
      </button>
    </header>

    <!-- 服务端太旧：**说清怎么办，不挡用**。位置在分流之前——登录页也要看得到。
         命令是一辈子的那一条（compose 跟的是移动标签 :stable，见 serverVersion.ts）。 -->
    <div v-if="k.needsUpgrade.value" class="kb-upgrade">
      <span class="kb-upgrade-text">
        知识库服务是 <b>{{ k.serverVersion.value ?? "旧版本" }}</b>，这个客户端需要
        {{ MIN_SERVER_VERSION }} 以上（网页产物、免登录都是新版本才有的）。
        在你放 docker-compose.yml 的目录里跑：
      </span>
      <code class="kb-upgrade-cmd">{{ UPGRADE_COMMAND }}</code>
      <button class="kb-link" @click="copyUpgrade()">{{ copiedUpgrade ? "已复制" : "复制命令" }}</button>
    </div>

    <!-- 探测中：先不出登录框，否则每次开面板都会闪一下表单再切换 -->
    <div v-if="!k.ready.value" class="kb-empty">
      <p>正在连接资料库…</p>
      <small>服务跑在你自己机器上，第一次连会慢一点</small>
    </div>

    <!-- 未登录：直接是表单。改服务地址失焦后重新探测，空库/已初始化随之切换。 -->
    <KbLogin
      v-else-if="!k.user.value"
      :busy="k.loading.value"
      :error="k.error.value"
      :initialized="k.initialized.value"
      @setup="
        (u, n, p, e) => {
          void k.setup(u, n, p, e);
        }
      "
      @login="
        (a, p) => {
          void k.login(a, p);
        }
      "
      @join="
        (t) => {
          void k.join(t);
        }
      "
      @retry="k.init()"
    />

    <template v-else>
      <!-- 两个态之间换的是**整个平面**，所以给一次有方向的过渡：索引向上退、内容向上浮。
           `mode="out-in"` 避免两个全屏块同时占位把布局顶跳。全产品只此一处动效。 -->
      <Transition name="kb-swap" mode="out-in">
      <!-- ══ 索引态：整屏目录 ══════════════════════════════════════════
           没有常驻侧栏。一个人用的库，条目本身才是主角——目录占满整屏，
           打开一份东西时它整个让位（见下面的阅读态），而不是"右边换个内容"。 -->
      <div v-if="!reading" class="kb-index">
        <p v-if="k.error.value" class="kb-err">{{ k.error.value }}</p>
        <p v-if="k.notice.value" class="kb-notice">{{ k.notice.value }}</p>

        <div class="kb-index-inner">
          <!-- 上传进度：字节传完（99%）之后服务端还要解析 + 落库（大 docx 要几秒），
               那时改口叫「正在处理」——不假装还在传，也不让界面看起来卡住了 -->
          <div v-if="k.uploading.value" class="kb-progress">
            <span class="kb-progress-text">正在上传「{{ k.uploading.value.name }}」</span>
            <span class="kb-progress-state">
              {{ k.uploading.value.pct >= 99 ? "服务端正在处理…" : `${k.uploading.value.pct}%` }}
            </span>
            <span class="kb-progress-track">
              <i :style="{ width: `${k.uploading.value.pct}%` }" />
            </span>
          </div>

          <!-- 只有一个空间时不出现：个人库里「空间」是权限边界的残留，不是组织手段。
               组织靠文件夹。 -->
          <KbSpaceList
            v-if="k.spaces.value.length > 1"
            ref="spaceRef"
            :spaces="k.spaces.value"
            :active-id="k.activeSpaceId.value"
            :busy="k.loading.value"
            @select="(id) => void k.selectSpace(id)"
            @create="
              (key, name, vis) => {
                void k.createSpace({ key, name, visibility: vis });
              }
            "
            @rename="(id, name) => void k.renameSpace(id, name)"
          />

          <section v-if="recent.length" class="kb-recent">
            <div class="kb-sec-label">最近更新</div>
            <div class="kb-recent-grid">
              <button
                v-for="r in recent"
                :key="r.id"
                type="button"
                class="kb-card"
                @click="openFromSearch(r.id)"
              >
                <span class="kb-card-title">{{ r.title }}</span>
                <span class="kb-card-meta">
                  <span class="kb-card-path">{{ r.path || "根目录" }}</span>
                  <span class="kb-card-time">{{ r.time }}</span>
                </span>
              </button>
            </div>
          </section>

          <div v-if="k.documents.value.length" class="kb-sec-label kb-sec-all">
            全部文档<span class="kb-sec-count">{{ docCount }}</span>
          </div>

          <KbTree
            ref="treeRef"
            :documents="k.documents.value"
            :active-id="activeDocId"
            :collapsed="collapsed"
            :busy="k.loading.value"
            :accept="k.formats.value"
            @open="(id) => void openDoc(id)"
            @toggle="onTreeToggle"
            @create="onCreateNode"
            @patch="onTreePatch"
            @remove="onDeleteDoc"
            @upload="onUpload"
          />

          <!-- 空态是**邀请**：两条路都直接给出来（建一份 / 传一个），
               而不是只说「这里是空的」再让人自己找 -->
          <div v-if="!k.documents.value.length && k.ready.value" class="kb-index-empty">
            <p>这里还是空的</p>
            <small>用上面的「新建」建一份，或者把现有的文件传进来</small>
            <div class="kb-empty-acts">
              <button class="kb-link" @click="treeRef?.pickFile(null)">上传一个文件…</button>
            </div>
          </div>
        </div>

        <footer class="kb-index-foot">
          <!-- 连接状态：绿点 + 主机 + 服务版本。「它连着、它是新的」要写在脸上，用户才信它。 -->
          <span class="kb-conn" :title="`已连接 ${serverHost}`">
            <i class="kb-conn-dot" />已连接 · {{ serverHost }}<template v-if="k.serverVersion.value"> · v{{ k.serverVersion.value }}</template>
          </span>
          <span class="kb-foot-name">{{ k.user.value.displayName }}</span>
          <button v-if="isAdmin" class="kb-link" @click="innerView = 'members'">成员</button>
          <!-- 指南不再是特殊页面：它就是库里一份普通文档，没有就让用户一键装进来。
               装过之后这个入口永远消失——不写死、不做特例。 -->
          <button v-if="!hasGuide" class="kb-link" @click="installGuide()">
            把使用指南存进资料库
          </button>
          <!-- 「退出登录」不是「关闭面板」：点了会吊销服务端会话并清本地 token，
               下次进来必须重新登录。关面板用标题栏的 ×。 -->
          <button class="kb-link" @click="k.logout()">退出登录</button>
        </footer>
      </div>

      <!-- ══ 阅读态：整屏给这一样东西 ══════════════════════════════════ -->
      <div v-else class="kb-reading">
        <aside v-if="railOpen" class="kb-rail" aria-label="目录">
          <div class="kb-rail-head">
            <span class="kb-rail-title">{{ railTitle }}</span>
            <button
              class="kb-iconbtn kb-rail-add"
              v-tooltip="'新建'"
              :disabled="!k.activeSpaceId.value"
              @click="treeRef?.openCreateMenu($event, null)"
            >
              <Icon name="plus" :size="12" :stroke-width="1.5" />
            </button>
          </div>
          <div class="kb-rail-scroll">
            <KbTree
              ref="treeRef"
              compact
              :documents="k.documents.value"
              :active-id="activeDocId"
              :collapsed="collapsed"
              :busy="k.loading.value"
              :accept="k.formats.value"
              @open="(id) => void openDoc(id)"
              @toggle="onTreeToggle"
              @create="onCreateNode"
              @patch="onTreePatch"
              @remove="onDeleteDoc"
              @upload="onUpload"
            />
          </div>
        </aside>
      <main class="kb-main">
        <p v-if="k.error.value" class="kb-err">{{ k.error.value }}</p>
        <p v-if="k.notice.value" class="kb-notice">{{ k.notice.value }}</p>

        <KbMembers
          v-if="innerView === 'members' && isAdmin"
          :users="k.users.value"
          :spaces="k.spaces.value"
          :busy="k.loading.value"
          :error="null"
          :current-user-id="k.user.value.id"
          :last-invite="k.lastInvite.value"
          @invite="
            (u, n, a, sid, role) => {
              void k.invite({ username: u, displayName: n, isAdmin: a, spaceId: sid, spaceRole: role });
            }
          "
          @revoke="
            (id) => {
              void k.revokeUser(id);
            }
          "
          @refresh="k.loadUsers()"
        />
        <KbSearchView
          v-else-if="k.searchResult.value || k.searching.value"
          :result="k.searchResult.value"
          :busy="k.searching.value"
          :paths="hitPaths"
          @open="(id) => void openFromSearch(id)"
        />
        <KbDocumentView
          v-else-if="k.activeDoc.value"
          :doc="k.activeDoc.value"
          :crumbs="crumbs"
          :known-titles="knownTitles"
          :editable="true"
          @wiki="(t) => void onWiki(t)"
          @reveal="(id) => void onReveal(id)"
          @saved="(id) => refreshDoc(id)"
          @reverted="(id) => refreshDoc(id)"
          @editing="onEditing"
          @delete="(id) => void onDeleteDoc(id)"
        />
      </main>
      </div>
      </Transition>
    </template>
  </div>
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────
   资料库 · 外壳
   主张：一张纸，一条线。导航侧退进环境光里（透明），正文是一块
   打亮的平面（bgBase），两者之间只有一条 hairline。整个面板里
   **唯一有底色的元素是"当前选中的那一样东西"**。

   字号只有五档，全部在此列明（组件内不再出现别的尺寸）：
     面板标题 14/600 · 文章标题由 KbDocumentView 负责(26/600)
     分组标题 11.5/500 · 目录行 13 · 元信息 11.5
   间距只用 4 的倍数：4 / 8 / 12 / 16 / 24。
   ───────────────────────────────────────────────────────────────── */

.kb-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ── 顶栏 ──────────────────────────────────────────────── */
.kb-head {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 12px 0 20px;
  flex: none;
}
/* 标题兼返回：位置固定在最左，索引态是"我在哪"，阅读态是"回哪去" */
.kb-home {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 5px 8px 5px 0;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--aide-text-primary);
  border-radius: var(--aide-radius-sm);
  cursor: default;
}
.kb-home.back { cursor: pointer; transition: color var(--aide-ease-t); }
.kb-home.back:hover { color: var(--aide-accent); }
.kb-home:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-home-caret { transform: rotate(180deg); }

/* 新建：面板里最主要的动作，给它实心和字 */
.kb-newbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-highlight-inset);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--aide-ease-t);
}
.kb-newbtn:hover:not(:disabled) { background: var(--aide-accent-hover); }
.kb-newbtn:disabled { opacity: 0.4; cursor: default; }
.kb-newbtn:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-spacer { flex: 1; }

/* 检索框：唯一有"面"的元素，内凹而不是描边（描边是模板感的来源） */
.kb-searchbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 4px;
  padding: 0 8px;
  height: 30px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  box-shadow: var(--aide-shadow-inset);
  color: var(--aide-text-muted);
  transition: box-shadow var(--aide-ease-t);
}
.kb-searchbox:focus-within { box-shadow: var(--aide-accent-ring); }
.kb-searchbox input {
  width: 240px;
  border: none;
  background: none;
  outline: none;
  font: inherit;
  font-size: 13px;
  color: var(--aide-text-primary);
}
.kb-searchbox input::placeholder { color: var(--aide-text-muted); }

.kb-clearq,
.kb-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  width: 28px;
  height: 28px;
  border-radius: var(--aide-radius-sm);
  padding: 0;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-clearq { width: 20px; height: 20px; }
.kb-iconbtn:hover { color: var(--aide-text-primary); background: var(--aide-surface-hover); }
.kb-iconbtn:disabled { opacity: 0.4; cursor: default; background: none; }
.kb-clearq:focus-visible,
.kb-iconbtn:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }

/* ── 索引态：整屏目录 ─────────────────────────────────── */
.kb-index {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  padding: 36px 24px 0;
}
.kb-index-inner {
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  flex: 1;
}

/* 上传进度：一条 2px 的线 + 一行字。没有方框、不抢戏——它是过程，不是内容。
   进度条**不做过渡动画**：全产品只留两个态之间那一处动效。 */
.kb-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 10px 2px 14px;
  font-size: 12px;
  color: var(--aide-text-secondary);
}
.kb-progress-state {
  font-variant-numeric: tabular-nums;
  color: var(--aide-text-muted);
}
.kb-progress-track {
  flex: 1 1 100%;
  height: 2px;
  border-radius: 1px;
  background: var(--aide-surface-default);
  overflow: hidden;
}
.kb-progress-track i {
  display: block;
  height: 100%;
  background: var(--aide-accent);
}

/* 分组小标题：与阅读态的目录栏 / 本页内容同一档（11 / 500 / 字距） */
.kb-sec-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px 10px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--aide-text-muted);
}
.kb-sec-count { font-variant-numeric: tabular-nums; letter-spacing: 0; opacity: 0.7; }
.kb-sec-all { padding-top: 28px; }

/* 最近更新：整个首页里唯一成"卡"的东西——它们是**入口**，不是列表行 */
.kb-recent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.kb-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 18px;
  min-height: 92px;
  padding: 14px 16px;
  text-align: left;
  font: inherit;
  color: inherit;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md, var(--aide-radius-sm));
  cursor: pointer;
  transition: background var(--aide-ease-t), border-color var(--aide-ease-t), transform var(--aide-ease-t);
}
.kb-card:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border);
  transform: translateY(-1px);
}
.kb-card:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-card-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--aide-text-primary);
}
.kb-card-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}
.kb-card-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-card-time { flex: none; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .kb-card:hover { transform: none; } }

/* 空空间是**邀请**，不是一句灰字 */
.kb-index-empty {
  padding: 72px 8px;
  text-align: center;
  color: var(--aide-text-muted);
}
.kb-index-empty p {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--aide-text-secondary);
}
.kb-index-empty small { font-size: 12.5px; }
.kb-empty-acts {
  margin-top: 14px;
  display: flex;
  justify-content: center;
}

/* 脚注：账号与那几个低频动作。只在索引态出现——阅读态整屏给内容 */
.kb-index-foot {
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 20px 0 24px;
  display: flex;
  align-items: center;
  gap: 18px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  flex: none;
}
.kb-conn { display: inline-flex; align-items: center; gap: 8px; margin-right: auto; }
.kb-conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-success) 18%, transparent);
}

.kb-link {
  border: none;
  background: none;
  padding: 2px 0;
  font: inherit;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color var(--aide-ease-t);
}
.kb-link:hover { color: var(--aide-text-primary); }
.kb-link:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); border-radius: 3px; }

/* ── 阅读态：左目录栏 + 正文 ───────────────────────────── */
.kb-reading {
  flex: 1;
  min-height: 0;
  display: flex;
  /* 容器查询看的是面板自己的宽度（不是窗口宽度）：左侧栏 / 右栏会吃掉一大块 */
  container-type: inline-size;
}
.kb-rail {
  flex: 0 0 264px;
  width: 264px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--aide-border-subtle);
}
@container (max-width: 760px) {
  .kb-rail { display: none; }
}
.kb-rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 8px 0 20px;
  flex: none;
}
.kb-rail-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--aide-text-muted);
}
.kb-rail-add { width: 24px; height: 24px; }
.kb-rail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 16px;
}

/* ── 阅读态：整屏给它 ─────────────────────────────────── */
/* 索引态是"环境光里的目录"，阅读态是"一块打亮的纸"——两个态之间换的是整个平面，
   不是右边一小块。所以这里没有分隔线：旁边已经没有别的东西了。 */
.kb-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-base);
  overflow: hidden;
}

.kb-err {
  margin: 0;
  padding: 10px 20px;
  font-size: 12px;
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  flex: none;
}

/* 服务端该升级了：一条说明 + 一条命令 + 复制。不挡用（它是提示，不是错误），
   但要说清"为什么现在能用不了新东西"——不然用户只会看到按钮点了没反应。 */
.kb-upgrade {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 10px 20px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
  background: var(--aide-accent-subtle);
  flex: none;
}
/* 说明独占一行，命令 + 复制在下一行——挤在一行时命令会被面板边缘切掉 */
.kb-upgrade-text { flex: 1 1 100%; min-width: 0; }
.kb-upgrade-text b { font-weight: 600; color: var(--aide-text-primary); }
.kb-upgrade-cmd {
  flex: 0 1 auto;
  min-width: 0;
  padding: 2px 8px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
  color: var(--aide-text-primary);
  overflow-wrap: anywhere; /* 窄面板下折行，不溢出 */
  user-select: all; /* 复制按钮失效时，点一下能全选带走 */
}

/* 非失败提示（解析器的降级信息）：不是错误，所以不是红的 */
.kb-notice {
  margin: 0;
  padding: 10px 20px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-accent-subtle);
  flex: none;
}

.kb-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--aide-text-muted);
  padding: 24px;
  text-align: center;
}
.kb-empty p { margin: 0; font-size: 13px; color: var(--aide-text-secondary); }
.kb-empty small { font-size: 11.5px; }

/* ── 两态转场：唯一一处动效 ─────────────────────────────── */
.kb-swap-enter-active,
.kb-swap-leave-active {
  transition: opacity 140ms var(--aide-ease), transform 140ms var(--aide-ease);
}
/* 索引向上退（像被翻过去），内容向上浮（像被放到台面上） */
.kb-swap-leave-to { opacity: 0; transform: translateY(-10px); }
.kb-swap-enter-from { opacity: 0; transform: translateY(10px); }

@media (prefers-reduced-motion: reduce) {
  .kb-swap-enter-active,
  .kb-swap-leave-active { transition: none; }
  .kb-swap-leave-to,
  .kb-swap-enter-from { transform: none; }
}
</style>
