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
import { computed, ref } from "vue";
import { kb, KbError } from "./kbClient";
import type { KbDocument } from "./kbClient";
import { renderKbMarkdown } from "./markdown";
import { useKbDocLock } from "@/composables/useKbDocLock";
import KbHistory from "./KbHistory.vue";

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

async function finish(): Promise<void> {
  if (dirty.value) {
    if (!window.confirm("有未保存的修改，保存后结束编辑？\n（取消 = 继续编辑）")) return;
    if (!(await save())) return; // 保存失败留在编辑态，把错误留在屏幕上
  }
  await leave();
}

async function cancel(): Promise<void> {
  if (dirty.value && !window.confirm("放弃未保存的修改？")) return;
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
        <span class="kb-slug">{{ doc.slug }}</span>
        <span class="kb-spacer" />
        <span v-if="editable" class="kb-head-actions">
          <button class="kb-link" @click="showHistory = true">历史</button>
          <button class="kb-link" :disabled="lock.state.value.phase === 'acquiring'" @click="startEdit()">
            {{ lock.state.value.phase === "acquiring" ? "取锁中…" : "编辑" }}
          </button>
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

    <!-- v-html 同上；正文只在查看态渲染（历史/编辑态各有自己的内容区） -->
    <div
      v-if="!editing && !showHistory"
      class="kb-body msg-text"
      v-html="renderKbMarkdown(doc.content ?? '')"
    />
    <p v-if="!editing && !showHistory && !doc.content" class="kb-empty">
      这篇文档还没有正文。
    </p>
  </article>
</template>

<style scoped>
.kb-doc {
  height: 100%;
  overflow: auto;
  padding: 20px 26px 40px;
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
.kb-doc.editing .kb-doc-head,
.kb-doc.editing .kb-edit-bar {
  flex-shrink: 0;
}
.kb-doc-head {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--aide-border);
}
.kb-doc-head h1 {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
  color: var(--aide-text-primary);
  line-height: 1.4;
}
.kb-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.kb-ver {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--aide-bg-deep);
  color: var(--aide-accent);
}
.kb-ver.stale {
  color: var(--aide-text-muted);
}
.kb-slug {
  font-family: var(--aide-font-mono);
  opacity: 0.7;
}
.kb-spacer { flex: 1; }
.kb-head-actions {
  display: inline-flex;
  gap: 12px;
}
.kb-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
}
.kb-link:disabled { opacity: 0.5; cursor: default; }
.kb-lock-note {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--aide-text-muted);
  background: color-mix(in srgb, var(--aide-accent) 8%, transparent);
  border-radius: 6px;
  padding: 5px 10px;
}
.kb-err {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--aide-error, #d0453b);
}
.kb-body {
  font-size: 13px;
  line-height: 1.75;
  color: var(--aide-text-primary);
}
.kb-empty {
  font-size: 12px;
  color: var(--aide-text-muted);
}

/* ── 编辑态 ── */
.kb-title-input {
  width: 100%;
  margin: 0 0 6px;
  padding: 4px 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
.kb-title-input:focus {
  border-color: var(--aide-accent);
}
.kb-lock-lost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--aide-error, #d0453b);
}
.kb-edit-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.kb-note-input {
  width: 240px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
.kb-savemsg {
  font-size: 11px;
  color: var(--aide-accent);
}
.kb-err-inline {
  font-size: 11px;
  color: var(--aide-error, #d0453b);
}
.kb-btn {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  cursor: pointer;
}
.kb-btn:hover { border-color: var(--aide-accent); }
.kb-btn:disabled { opacity: 0.5; cursor: default; }
.kb-btn.primary {
  color: #fff;
  background: var(--aide-accent);
  border-color: var(--aide-accent);
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
  padding: 10px 12px;
  font-family: var(--aide-font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 8px;
  outline: none;
  resize: none;
}
.kb-editor:focus {
  border-color: var(--aide-accent);
}
.kb-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.75;
  border: 1px solid var(--aide-border);
  border-radius: 8px;
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
  margin: 18px 0 8px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--aide-text-primary);
}
.kb-body :deep(h1),
.kb-preview :deep(h1) { font-size: 16px; }
.kb-body :deep(h2),
.kb-preview :deep(h2) { font-size: 15px; }
.kb-body :deep(h3),
.kb-preview :deep(h3) { font-size: 14px; }
.kb-body :deep(h4),
.kb-preview :deep(h4) { font-size: 13px; }
.kb-body :deep(> *:first-child),
.kb-preview :deep(> *:first-child) { margin-top: 0; }

.kb-body :deep(ul),
.kb-body :deep(ol),
.kb-preview :deep(ul),
.kb-preview :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.kb-body :deep(li),
.kb-preview :deep(li) { margin: 3px 0; }

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
