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

/** 应用统一的对话框（ModalDialog）。**不用 window.confirm**：原生样式与主题无关。 */
const modal = useModal();

const props = withDefaults(defineProps<{ doc: KbDocument; editable?: boolean }>(), {
  editable: false,
});

const emit = defineEmits<{
  /** 保存成功（父层刷新 activeDoc 与侧栏列表）。带 docId：保存期间用户可能已切走 */
  saved: [docId: string];
  /** 回滚完成（父层刷新 activeDoc；历史面板由本组件关闭） */
  reverted: [docId: string];
  /** 编辑会话开关（父层据此在切换文档前拦截未保存修改） */
  editing: [on: boolean];
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

const previewHtml = computed(() => renderKbMarkdown(draftContent.value));

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
  <article class="kb-doc" :class="{ editing, history: showHistory }">
    <!-- 历史 / 查看 / 编辑 互斥切换：覆盖层方案在 overflow:auto 容器里
         会有「随内容滚走」的定位坑，直接换视图最稳 -->
    <KbHistory v-if="showHistory" :doc="doc" @reverted="onReverted" />

    <header v-else-if="!editing" class="kb-doc-head">
      <h1>{{ doc.title }}</h1>
      <div class="kb-meta">
        <span class="kb-ver">v{{ doc.versionNo }}</span>
        <span v-if="updated">{{ updated }}</span>
        <!-- slug 是内部标识（同父下唯一），个人库里对人没有信息量，不上台面 -->
        <span class="kb-spacer" />
        <span v-if="editable" class="kb-head-actions">
          <button class="kb-link" @click="showHistory = true">历史</button>
          <button class="kb-link" :disabled="lock.state.value.phase === 'acquiring'" @click="startEdit()">
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
        <button class="kb-btn" :disabled="!canSave" @click="save()">
          {{ saving ? "保存中…" : "保存" }}
        </button>
        <button class="kb-btn primary" @click="finish()">完成</button>
        <button class="kb-btn" @click="cancel()">取消</button>
      </div>

      <div class="kb-edit-body">
        <textarea
          v-model="draftContent"
          class="kb-editor"
          spellcheck="false"
          placeholder="正文（Markdown）"
        />
        <!-- v-html 的内容来自 renderKbMarkdown，已做默认拒绝处理，见 ./markdown.ts -->
        <div class="kb-preview msg-text" v-html="previewHtml" />
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
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────
   资料库 · 正文页
   它是"一页纸"：所有内容（标题、元信息、动作、正文）落在同一条
   720px 的竖轴上，居中。**正文区里没有任何方框**——没有卡片、没有
   圆角底块、没有 chip；标题下面也不再画横线（留白代替）。
   ───────────────────────────────────────────────────────────────── */

.kb-doc {
  height: 100%;
  overflow: auto;
  padding: 40px 24px 88px;
}
/* 一页纸的那条竖轴：直接子元素一律 720px 居中 */
.kb-doc > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
/* 编辑态：容器不滚（textarea / 预览各自滚），双栏占满剩余高度 */
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
}

.kb-doc-head {
  margin-bottom: 32px;
}
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
.kb-title-input {
  width: 100%;
  margin: 0 0 10px;
  padding: 6px 10px;
  font: inherit;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--aide-text-primary);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  outline: none;
}
.kb-title-input:focus { box-shadow: var(--aide-accent-ring); }

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
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  outline: none;
}
.kb-note-input:focus { box-shadow: var(--aide-accent-ring); }
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
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.kb-editor {
  flex: 1;
  min-width: 0;
  padding: 12px 14px;
  font-family: var(--aide-font-mono);
  font-size: 13px;
  line-height: 1.75;
  color: var(--aide-text-primary);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  outline: none;
  resize: none;
}
.kb-editor:focus { box-shadow: var(--aide-accent-ring); }
.kb-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.8;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
}

/* ── .msg-text 未覆盖的 Markdown 元素 ──
   :deep() 是必需的：v-html 产出的节点不带 scoped 的 data 属性。 */
.kb-body :deep(h1),
.kb-body :deep(h2),
.kb-body :deep(h3),
.kb-body :deep(h4),
.kb-preview :deep(h1),
.kb-preview :deep(h2),
.kb-preview :deep(h3),
.kb-preview :deep(h4) {
  margin: 32px 0 12px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.005em;
  color: var(--aide-text-primary);
}
.kb-body :deep(h3),
.kb-body :deep(h4),
.kb-preview :deep(h3),
.kb-preview :deep(h4) { margin: 24px 0 8px; }

.kb-body :deep(h1),
.kb-preview :deep(h1) { font-size: 22px; }
.kb-body :deep(h2),
.kb-preview :deep(h2) { font-size: 17px; }
.kb-body :deep(h3),
.kb-preview :deep(h3) { font-size: 15px; }
.kb-body :deep(h4),
.kb-preview :deep(h4) { font-size: 14px; }
.kb-body :deep(> *:first-child),
.kb-preview :deep(> *:first-child) { margin-top: 0; }

/* 段落节奏由这里定：.msg-text p 的 8px 是聊天里的密度，阅读面要更松 */
.kb-body :deep(p),
.kb-preview :deep(p) { margin: 0 0 16px; }

.kb-body :deep(ul),
.kb-body :deep(ol),
.kb-preview :deep(ul),
.kb-preview :deep(ol) {
  margin: 12px 0 16px;
  padding-left: 22px;
}
.kb-body :deep(li),
.kb-preview :deep(li) { margin: 5px 0; }

.kb-body :deep(blockquote),
.kb-preview :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--aide-accent);
  color: var(--aide-text-muted);
}

.kb-body :deep(table),
.kb-preview :deep(table) {
  margin: 10px 0;
  border-collapse: collapse;
  font-size: 12px;
}
.kb-body :deep(th),
.kb-body :deep(td),
.kb-preview :deep(th),
.kb-preview :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--aide-border);
  /* 列宽下限：不设则 auto 布局把富余宽度全给长文本列，窄列被压到一个汉字宽，
     两字单元格逐字竖排（实测 800px 容器复现）。5em = 60px，扣掉单元格
     padding+border 22px 后内容盒 38px，够两字（Maple Mono NF CN 1.2em = 28.8px）。
     桌面聊天同一问题见 src/styles/global.css。 */
  min-width: 5em;
}
.kb-body :deep(th),
.kb-preview :deep(th) {
  background: var(--aide-bg-deep);
  font-weight: 600;
}

.kb-body :deep(a),
.kb-preview :deep(a) {
  color: var(--aide-accent);
  text-decoration: none;
}
.kb-body :deep(a:hover),
.kb-preview :deep(a:hover) { text-decoration: underline; }

.kb-body :deep(img),
.kb-preview :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}
.kb-body :deep(hr),
.kb-preview :deep(hr) {
  margin: 14px 0;
  border: none;
  border-top: 1px solid var(--aide-border);
}
</style>
