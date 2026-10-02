<script setup lang="ts">
// 文档正文：查看 / 编辑 / 版本历史 三态。
//
// 编辑的锁走 useKbDocLock（30s 心跳续租，失锁禁存）；保存成功后不退出编辑——
// 服务端有 5 分钟合并窗口（revision_merge_window_seconds），连续小保存会合并进
// 同一版本，「完成」才是编辑会话的终点，那时才释放锁。
//
// draft 的脏检查基线（baseTitle/baseContent）是本地变量而不是 props.doc：
// props.doc 由父层异步刷新，保存成功到刷新落地之间若跟 props.doc 比会误报 dirty，
// 导致「完成」弹出莫名的保存确认。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { getBaseUrl, kb, KbError } from "./kbClient";
import type { KbDocument } from "./kbClient";
import { renderKbMarkdown } from "./markdown";
import { createAssetLoader, type AssetLoader } from "./assetLoader";
import { previewKindFor } from "./previewKind";
import { useKbDocLock } from "@/composables/useKbDocLock";
import { useModal } from "@/composables/useModal";
import { useRightPanel } from "@/composables/useRightPanel";
import KbHistory from "./KbHistory.vue";
import KbMarkdownEditor from "./KbMarkdownEditor.vue";
import KbOutline from "./KbOutline.vue";

/** 应用统一的对话框（ModalDialog）。**不用 window.confirm**：原生样式与主题无关。 */
const modal = useModal();

const props = withDefaults(
  defineProps<{
    doc: KbDocument;
    editable?: boolean;
    /** 祖先链（从根到父，不含自己）。给了才显示面包屑 */
    crumbs?: { id: string; title: string }[];
  }>(),
  { editable: false, crumbs: () => [] },
);

const emit = defineEmits<{
  /** 保存成功（父层刷新 activeDoc 与侧栏列表）。带 docId：保存期间用户可能已切走 */
  saved: [docId: string];
  /** 回滚完成（父层刷新 activeDoc；历史面板由本组件关闭） */
  reverted: [docId: string];
  /** 编辑会话开关（父层据此在切换文档前拦截未保存修改） */
  editing: [on: boolean];
  /** 点了面包屑里的文件夹：文件夹没有正文可开，只能在目录里定位到它 */
  reveal: [id: string];
  /** 用户点了删除。**只报意图**：确认弹窗与接口调用都在父层——只有它手里有整份
   *  文档列表，「会连带删掉几篇子文档」才算得出来。 */
  delete: [docId: string];
}>();

// 锁 API 注入：状态机因此可以脱离网络单测（见 useKbDocLock.test.ts）
const lock = useKbDocLock({
  acquire: (id) => kb.acquireLock(id),
  heartbeat: (id) => kb.lockHeartbeat(id),
  release: (id) => kb.releaseLock(id),
});

const editing = ref(false);
const draftTitle = ref("");
const draftContent = ref("");
const changeNote = ref("");
const saving = ref(false);
/** 最近一次保存的结果提示（「已保存为 v3」/「已合并进 v3」），下次保存前清除 */
const saveMsg = ref<string | null>(null);
const saveErr = ref<string | null>(null);
/** 取锁本身的失败（网络 / 403），与保存失败分开显示 */
const lockErr = ref<string | null>(null);
const showHistory = ref(false);

// ── 正文按 mime 分派（唯一产地 ./previewKind）─────────────────────────────
// markdown → 就地渲染；html → 网页产物，**在右栏浏览器里跑**（取件地址，见 spec §4.6）；
// 其余 → 转义后的原文（防御性分支，按收录范围到不了）。
const kind = computed(() => previewKindFor(props.doc.mime ?? "text/markdown"));

const opening = ref(false);
const openErr = ref<string | null>(null);

/** 在右栏打开这份网页产物：签票 → 拼取件地址 → 交给右栏（它自己决定怎么开）。 */
async function openPreview(): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  openErr.value = null;
  try {
    const { token } = await kb.previewToken(props.doc.id);
    useRightPanel().openInBrowser(`${getBaseUrl()}/p/${token}`);
  } catch (e) {
    openErr.value = e instanceof KbError ? e.message : `打开失败：${String(e)}`;
  } finally {
    opening.value = false;
  }
}

// ── 正文内嵌资源（asset://）────────────────────────────────────────────────
// markdown 里存的是稳定的 `asset://<uuid>`，真实字节要带 Bearer 去取再转
// objectURL（`<img src>` 发不出 Authorization 头，见 design spec §8.2）。
// 所以渲染完还需要这一趟「装载」，它依赖 DOM 已挂载。
const viewBody = ref<HTMLElement | null>(null);
/** 文章容器：真正滚动的那一层，目录的滚动联动要挂在它上面 */
const docEl = ref<HTMLElement | null>(null);
let assetLoader: AssetLoader | null = null;

/** 换文档或切回看态时重新装载。旧的一批先回收，否则 objectURL 会泄漏。 */
async function loadAssets() {
  await nextTick();
  assetLoader?.dispose();
  assetLoader = null;

  if (!viewBody.value) return;
  assetLoader = createAssetLoader((id) => kb.getAsset(id));
  await assetLoader.load(viewBody.value);
}

watch(
  () => [props.doc.id, props.doc.content, editing.value, showHistory.value],
  loadAssets,
  { immediate: true },
);
onBeforeUnmount(() => assetLoader?.dispose());

let baseTitle = "";
let baseContent = "";

const dirty = computed(
  () =>
    editing.value &&
    (draftTitle.value !== baseTitle || draftContent.value !== baseContent),
);

const canSave = computed(
  () => lock.held.value && !saving.value && draftTitle.value.trim() !== "",
);

/** 本页目录只在「看 markdown 正文」时出现；编辑 / 历史态没有渲染出来的标题可读。 */
const outlineOn = computed(() => !editing.value && !showHistory.value && kind.value === "markdown");
const outlineRev = computed(() => `${props.doc.id}:${props.doc.versionNo}:${props.doc.content?.length ?? 0}`);

/** 阅读时长：中文按 500 字/分钟粗估。只是个量级感，所以不精确到秒、最少 1 分钟。 */
const readMinutes = computed(() => Math.max(1, Math.round((props.doc.content?.length ?? 0) / 500)));

/** 代码块的「复制」：按钮在 v-html 里，事件委托在正文容器上。 */
async function onBodyClick(e: MouseEvent): Promise<void> {
  const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-kb-copy]");
  if (!btn) return;
  const code = btn.closest(".kb-code")?.querySelector("pre")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = "已复制";
  } catch {
    // 剪贴板不可用（权限 / 非安全上下文）不假装成功：代码就在旁边，能自己选
    btn.textContent = "复制失败";
  }
  window.setTimeout(() => (btn.textContent = "复制"), 1500);
}

const updated = computed(() => {
  const d = new Date(props.doc.updatedAt);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
});

const conflictName = computed(() =>
  lock.state.value.phase === "conflict" ? lock.state.value.holderName : null,
);

async function startEdit(): Promise<void> {
  if (editing.value || !props.editable) return;
  lockErr.value = null;
  try {
    const ok = await lock.enter(props.doc.id);
    if (!ok) return; // conflict：模板渲染「正被 X 编辑中」
    baseTitle = props.doc.title;
    baseContent = props.doc.content ?? "";
    draftTitle.value = baseTitle;
    draftContent.value = baseContent;
    changeNote.value = "";
    saveMsg.value = null;
    saveErr.value = null;
    editing.value = true;
    emit("editing", true);
  } catch (e) {
    lockErr.value = e instanceof KbError ? e.message : `获取编辑锁失败：${String(e)}`;
  }
}

async function save(): Promise<boolean> {
  if (!canSave.value) return false;
  saving.value = true;
  saveErr.value = null;
  try {
    const r = await kb.updateDocument(props.doc.id, {
      title: draftTitle.value.trim(),
      content: draftContent.value,
      changeNote: changeNote.value.trim() || null,
    });
    baseTitle = draftTitle.value.trim();
    baseContent = draftContent.value;
    saveMsg.value = r.merged
      ? `已合并进 v${r.versionNo}（5 分钟内的连续保存不另开版本）`
      : `已保存为 v${r.versionNo}`;
    // 修改说明只随一次保存生效，保存完清空，避免下次误用
    changeNote.value = "";
    emit("saved", props.doc.id);
    return true;
  } catch (e) {
    // 409（别人持锁）最常由「心跳间隙锁被取走」引起，错误消息已带持有人昵称；
    // 下一轮心跳会自动把锁状态打到 lost，这里不用抢状态机的活
    saveErr.value = e instanceof KbError ? e.message : `保存失败：${String(e)}`;
    return false;
  } finally {
    saving.value = false;
  }
}

/** 结束编辑。有修改时必须走一次三选：保存 / 放弃 / 继续编辑——二值化会把
 *  「我想接着改」这一档挤掉（那时用户只能按取消再取消，两层确认）。 */
async function finish(): Promise<void> {
  if (dirty.value) {
    const pick = await modal.choice("有没保存的修改", "结束编辑之前，先把它存成一个版本？", {
      confirmLabel: "保存并结束",
      altLabel: "放弃修改",
    });
    if (pick === "cancel") return; // 继续编辑
    if (pick === "confirm" && !(await save())) return; // 保存失败留在编辑态，把错误留在屏幕上
  }
  await leave();
}

async function cancel(): Promise<void> {
  if (dirty.value) {
    const ok = await modal.confirm(
      "放弃没保存的修改？",
      "这段修改不会进版本历史，离开之后就找不回来了。",
      "放弃修改",
      true,
    );
    if (!ok) return;
  }
  await leave();
}

async function leave(): Promise<void> {
  editing.value = false;
  emit("editing", false);
  saveMsg.value = null;
  saveErr.value = null;
  await lock.exit();
}

/** 失锁后重新取回（编辑内容保留，锁状态由状态机恢复为 held） */
async function relock(): Promise<void> {
  lockErr.value = null;
  try {
    await lock.enter(props.doc.id);
  } catch (e) {
    lockErr.value = e instanceof KbError ? e.message : `获取编辑锁失败：${String(e)}`;
  }
}

function onReverted(): void {
  showHistory.value = false;
  emit("reverted", props.doc.id);
}
</script>

<template>
  <div class="kb-doc-shell">
  <article ref="docEl" class="kb-doc" :class="{ editing, history: showHistory }">
    <!-- 历史 / 查看 / 编辑 互斥切换：覆盖层方案在 overflow:auto 容器里
         会有「随内容滚走」的定位坑，直接换视图最稳 -->
    <KbHistory v-if="showHistory" :doc="doc" @reverted="onReverted" />

    <header v-else-if="!editing" class="kb-doc-head">
      <nav v-if="crumbs.length" class="kb-crumbs" aria-label="所在位置">
        <template v-for="(c, i) in crumbs" :key="c.id">
          <span v-if="i" class="kb-crumb-sep">›</span>
          <button type="button" class="kb-crumb" @click="emit('reveal', c.id)">{{ c.title }}</button>
        </template>
      </nav>
      <h1>{{ doc.title }}</h1>
      <div class="kb-meta">
        <span class="kb-ver">v{{ doc.versionNo }}</span>
        <span v-if="updated">{{ updated }}</span>
        <span v-if="kind === 'markdown' && doc.content">约 {{ readMinutes }} 分钟读完</span>
        <!-- slug 是内部标识（同父下唯一），个人库里对人没有信息量，不上台面 -->
        <span class="kb-spacer" />
        <span v-if="editable" class="kb-head-actions">
          <button class="kb-link" @click="showHistory = true">历史</button>
          <button class="kb-link kb-edit-btn" :disabled="lock.state.value.phase === 'acquiring'" @click="startEdit()">
            {{ lock.state.value.phase === "acquiring" ? "取锁中…" : "编辑" }}
          </button>
          <!-- 只在看态出现（编辑态下没有这个按钮）：编辑中的草稿与「删掉这篇」同时可点，
               是两条状态机的交叉，没有必要 -->
          <button class="kb-link danger" @click="emit('delete', doc.id)">删除</button>
        </span>
      </div>
      <p v-if="conflictName" class="kb-lock-note">
        正被 {{ conflictName }} 编辑中，稍后再试
      </p>
      <p v-if="lockErr" class="kb-err">{{ lockErr }}</p>
    </header>

    <template v-else>
      <header class="kb-doc-head">
        <input v-model="draftTitle" class="kb-title-input" placeholder="标题" spellcheck="false" />
        <div class="kb-meta">
          <span class="kb-ver" :class="{ stale: !lock.held.value }">v{{ doc.versionNo }}</span>
          <span v-if="lock.lost.value" class="kb-lock-lost">
            编辑锁已失效（可能被他人取走），保存已禁用
            <button class="kb-link" @click="relock()">重新取锁</button>
          </span>
        </div>
      </header>

      <div class="kb-edit-bar">
        <input
          v-model="changeNote"
          class="kb-note-input"
          placeholder="修改说明（可选，只随下一次保存生效）"
          spellcheck="false"
        />
        <span v-if="saveMsg" class="kb-savemsg">{{ saveMsg }}</span>
        <span v-if="saveErr" class="kb-err-inline">{{ saveErr }}</span>
        <span class="kb-spacer" />
        <button class="kb-link" :disabled="!canSave" @click="save()">
          {{ saving ? "保存中…" : "保存" }}
        </button>
        <button class="kb-link" @click="cancel()">取消</button>
        <button class="kb-btn primary" @click="finish()">完成</button>
      </div>

      <!-- 单栏：与阅读页同一条竖轴、同一套排版，不再并排放源码与预览（对照是两份内容在抢注意力）。
           滚动在这一层，上面的标题与动作条不动。 -->
      <div class="kb-edit-body">
        <KbMarkdownEditor v-model="draftContent" class="kb-edit-page" @save="save()" />
      </div>
    </template>

    <!-- 查看态按 mime 分派；正文只在查看态渲染（历史/编辑态各有自己的内容区） -->
    <template v-if="!editing && !showHistory">
      <!-- markdown：现有渲染，一行不变的路径。
           ref=viewBody：assetLoader 要在这一层查 img[src^="asset://"] 换成 objectURL -->
      <div
        v-if="kind === 'markdown'"
        ref="viewBody"
        class="kb-body msg-text"
        @click="onBodyClick"
        v-html="renderKbMarkdown(doc.content ?? '')"
      />

      <!-- 网页产物：正文不在这里渲染，它该在浏览器里**跑起来**。
           取件地址是短时票据（10 分钟），过期重新点一次——这句必须写在脸上。 -->
      <div v-else-if="kind === 'html'" class="kb-web">
        <p class="kb-web-lead">这是一份网页产物，在右栏浏览器里打开。</p>
        <button class="kb-btn primary" :disabled="opening" @click="openPreview()">
          {{ opening ? "正在打开…" : "在右栏打开" }}
        </button>
        <p class="kb-web-hint">预览链接 10 分钟后失效，过期重新点一次。</p>
        <p v-if="openErr" class="kb-err">{{ openErr }}</p>
      </div>

      <!-- 兜底：不认识的内容类型按原文显示，绝不白屏。
           插值而非 v-html——它渲染的是**原文**，不是标记。 -->
      <pre v-else class="kb-body kb-plain">{{ doc.content }}</pre>
    </template>
    <p v-if="!editing && !showHistory && !doc.content" class="kb-empty">
      这篇文档还没有正文。
    </p>
  </article>
  <!-- 目录是文章的**邻居**而不是子元素：文章容器自己滚动，目录要钉在原地 -->
  <KbOutline v-if="outlineOn" :body-el="viewBody" :scroll-el="docEl" :rev="outlineRev" />
  </div>
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────
   资料库 · 正文页
   它是"一页纸"：所有内容（标题、元信息、动作、正文）落在同一条
   720px 的竖轴上，居中。**正文区里没有任何方框**——没有卡片、没有
   圆角底块、没有 chip；标题下面也不再画横线（留白代替）。
   ───────────────────────────────────────────────────────────────── */

/* 外壳：文章 + 右侧目录并排。目录在窄面板下整列收起（容器查询：看的是面板宽度，
   不是窗口宽度——左侧栏与右栏会吃掉一大块） */
.kb-doc-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  container-type: inline-size;
}
@container (max-width: 980px) {
  .kb-doc-shell :deep(.kb-outline) { display: none; }
}

.kb-doc {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 40px 24px 88px;
  /* App.vue 的 .app-layout 全局设了 user-select: none（防拖拽分栏时误选界面文字），
   * 该属性可继承，会一路传导到正文，整篇文档都选不中、复制不了（与 ChatMessage.vue /
   * FileWindow.vue 同一类问题）。在文档容器局部恢复；按钮 / 链接式动作仍保持不可选。 */
  user-select: text;
  -webkit-user-select: text;
}
.kb-doc button {
  user-select: none;
  -webkit-user-select: none;
}
/* 一页纸的那条竖轴：直接子元素一律 720px 居中 */
.kb-doc > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
/* 编辑态：标题与动作条钉在上面，正文区（.kb-edit-body）自己滚 */
.kb-doc.editing {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 历史态：滚动交给 KbHistory 自己，宿主退成透明壳（去掉 padding 避免双圈） */
.kb-doc.history {
  padding: 0;
  overflow: hidden;
}
/* 历史视图自带竖轴与留白，别再套上面那层 720 宽——套了之后它自己的左右
   padding 会把内容再缩进 24px，与文档页的竖轴对不齐（对齐是这次重做的重点） */
.kb-doc.history > * {
  max-width: none;
  margin-left: 0;
  margin-right: 0;
}
.kb-doc.editing .kb-doc-head,
.kb-doc.editing .kb-edit-bar {
  flex-shrink: 0;
  /* flex 列里 margin:auto 的子项不再拉伸、会缩成内容宽度并居中——
     标题 / 操作条与满宽的正文编辑器就对不齐了。显式占满那条 720 竖轴。 */
  width: 100%;
}

.kb-doc-head {
  margin-bottom: 32px;
}
/* 面包屑：文章标题上方一行静音的位置说明，不是导航条 */
.kb-crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.kb-crumb {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: color var(--aide-ease-t);
}
.kb-crumb:hover { color: var(--aide-text-primary); }
.kb-crumb:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); border-radius: 3px; }
.kb-crumb-sep { opacity: 0.5; }

.kb-doc-head h1 {
  margin: 0 0 10px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--aide-text-primary);
}
.kb-meta {
  display: flex;
  align-items: baseline;
  gap: 14px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}
/* 版本号是静默的一行字，不是胶囊 */
.kb-ver {
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}
.kb-ver.stale { opacity: 0.6; }
.kb-spacer { flex: 1; }
.kb-head-actions {
  display: inline-flex;
  gap: 14px;
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
.kb-link:disabled { opacity: 0.4; cursor: default; }
.kb-link:disabled:hover { color: var(--aide-text-muted); }
.kb-link.danger:hover { color: var(--aide-danger); }
/* 「编辑」是这页最主要的动作：给它一个轮廓，其余（历史 / 删除）保持静音文字 */
.kb-link.kb-edit-btn {
  padding: 3px 12px;
  color: var(--aide-text-secondary);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
}
.kb-link.kb-edit-btn:hover:not(:disabled) {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
  border-color: var(--aide-border);
}

.kb-link:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); border-radius: 3px; }

.kb-lock-note {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-accent-subtle);
  border-radius: var(--aide-radius-sm);
  padding: 8px 12px;
}
.kb-err {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--aide-danger);
}

/* 正文：14 / 1.8。行长由上面那条 720px 的轴封顶（约 66 字符） */
.kb-body {
  font-size: 14px;
  line-height: 1.8;
  color: var(--aide-text-primary);
}
.kb-empty {
  font-size: 13px;
  color: var(--aide-text-muted);
}

/* 网页产物：一段话 + 一个动作 + 一句代价说明。没有方框（面板里唯一有底色的
   东西是"选中的那一样"与主按钮）。 */
.kb-web {
  padding: 48px 0 0;
}
.kb-web-lead {
  margin: 0 0 20px;
  font-size: 14px;
  color: var(--aide-text-secondary);
}
.kb-web-hint {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}

/* 兜底档的原文：保留换行、可横向滚，不折行毁掉缩进 */
.kb-plain {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--aide-font-mono);
  font-size: 12.5px;
}

/* ── 编辑态 ── */
/* 标题输入就是阅读页的 h1 本身：同字号同字重，没有底块和边框 */
.kb-title-input {
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 0;
  font: inherit;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--aide-text-primary);
  background: none;
  border: none;
  outline: none;
}
.kb-title-input::placeholder { color: var(--aide-text-muted); }

.kb-lock-lost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--aide-danger);
}
.kb-edit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.kb-note-input {
  width: 260px;
  padding: 4px 0;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: none;
  border: none;
  border-bottom: 1px solid var(--aide-border-subtle);
  outline: none;
  transition: border-color var(--aide-ease-t);
}
.kb-note-input:focus { border-bottom-color: var(--aide-accent); }
.kb-note-input::placeholder { color: var(--aide-text-muted); }
.kb-savemsg { font-size: 11.5px; color: var(--aide-success); }
.kb-err-inline { font-size: 11.5px; color: var(--aide-danger); }

.kb-btn {
  padding: 6px 14px;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t), border-color var(--aide-ease-t);
}
.kb-btn:hover:not(:disabled) {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
  border-color: var(--aide-border);
}
.kb-btn:disabled { opacity: 0.4; cursor: default; }
.kb-btn:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-btn.primary {
  color: var(--aide-text-on-accent);
  background: var(--aide-accent);
  border-color: transparent;
  box-shadow: var(--aide-highlight-inset);
}
.kb-btn.primary:hover:not(:disabled) {
  background: var(--aide-accent-hover);
  color: var(--aide-text-on-accent);
}
.kb-edit-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  /* 滚动条贴在面板边，正文仍在那条 720 的竖轴上（见 .kb-edit-page） */
  max-width: none;
  margin: 0 -24px;
  padding: 0 24px;
}
.kb-edit-page {
  max-width: 720px;
  margin: 0 auto;
}

/* ── .msg-text 未覆盖的 Markdown 元素 ──
   :deep() 是必需的：v-html 产出的节点不带 scoped 的 data 属性。 */
.kb-body :deep(h1),
.kb-body :deep(h2),
.kb-body :deep(h3),
.kb-body :deep(h4) {
  margin: 32px 0 12px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.005em;
  color: var(--aide-text-primary);
}
.kb-body :deep(h3),
.kb-body :deep(h4) { margin: 24px 0 8px; }

.kb-body :deep(h1) { font-size: 22px; }
.kb-body :deep(h2) { font-size: 17px; }
.kb-body :deep(h3) { font-size: 15px; }
.kb-body :deep(h4) { font-size: 14px; }
.kb-body :deep(> *:first-child) { margin-top: 0; }
/* 目录跳转落点：标题不要贴着容器顶边 */
.kb-body :deep(h1),
.kb-body :deep(h2),
.kb-body :deep(h3),
.kb-body :deep(h4) { scroll-margin-top: 20px; }

/* 段落节奏由这里定：.msg-text p 的 8px 是聊天里的密度，阅读面要更松 */
.kb-body :deep(p) { margin: 0 0 16px; }

.kb-body :deep(ul),
.kb-body :deep(ol) {
  margin: 12px 0 16px;
  padding-left: 22px;
}
.kb-body :deep(li) { margin: 5px 0; }

.kb-body :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--aide-accent);
  color: var(--aide-text-muted);
}

.kb-body :deep(table) {
  margin: 10px 0;
  border-collapse: collapse;
  font-size: 12px;
}
.kb-body :deep(th),
.kb-body :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--aide-border);
  /* 列宽下限：不设则 auto 布局把富余宽度全给长文本列，窄列被压到一个汉字宽，
     两字单元格逐字竖排（实测 800px 容器复现）。5em = 60px，扣掉单元格
     padding+border 22px 后内容盒 38px，够两字（Maple Mono NF CN 1.2em = 28.8px）。
     桌面聊天同一问题见 src/styles/global.css。 */
  min-width: 5em;
}
.kb-body :deep(th) {
  background: var(--aide-bg-deep);
  font-weight: 600;
}

/* 代码块（markdown.ts 的 renderCode 产出）：外层 .kb-code 持有底色与边框，
   里面的 pre 退成纯滚动区——否则 .msg-text pre 自带的那层框会叠成双框。
   顶栏只放两样：语言名（左）与复制（右），都是静音小字。 */
.kb-body :deep(.kb-code) {
  margin: 18px 0;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  overflow: hidden;
}
.kb-body :deep(.kb-code-bar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 30px;
  padding: 0 8px 0 14px;
  font-size: 11px;
  color: var(--aide-text-muted);
  border-bottom: 1px solid var(--aide-border-subtle);
  user-select: none;
}
.kb-body :deep(.kb-code-lang) { font-family: var(--aide-font-mono); letter-spacing: 0.02em; }
.kb-body :deep(.kb-copy) {
  border: none;
  background: none;
  padding: 3px 8px;
  font: inherit;
  color: inherit;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  opacity: 0.75;
  transition: opacity var(--aide-ease-t), background var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-body :deep(.kb-code:hover .kb-copy),
.kb-body :deep(.kb-copy:focus-visible) { opacity: 1; }
.kb-body :deep(.kb-copy:hover) { color: var(--aide-text-primary); background: var(--aide-surface-hover); }
.kb-body :deep(.kb-copy:focus-visible) { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-body :deep(.kb-code pre) {
  margin: 0;
  padding: 12px 14px;
  border: none;
  border-radius: 0;
  background: none;
  font-size: 12.5px;
  line-height: 1.65;
}

/* 提示块（<Note> / <Tip> / <Warning> 渲染而来，类名由 markdown.ts 写死）：
   与引用块同一语言——左侧强调线 + 淡底，不画整圈边框 */
.kb-body :deep(.kb-callout) {
  display: block;
  margin: 16px 0;
  padding: 10px 14px;
  border-left: 3px solid var(--aide-accent);
  background: var(--aide-accent-subtle);
  border-radius: 0 var(--aide-radius-sm) var(--aide-radius-sm) 0;
}
.kb-body :deep(.kb-callout-tip) {
  border-left-color: var(--aide-success);
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
}
.kb-body :deep(.kb-callout-warn) {
  border-left-color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
}
.kb-body :deep(.kb-callout > :first-child) { margin-top: 0; }
.kb-body :deep(.kb-callout > :last-child) { margin-bottom: 0; }

.kb-body :deep(a) {
  color: var(--aide-accent);
  text-decoration: none;
}
.kb-body :deep(a:hover) { text-decoration: underline; }

.kb-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}
.kb-body :deep(hr) {
  margin: 14px 0;
  border: none;
  border-top: 1px solid var(--aide-border);
}
</style>
