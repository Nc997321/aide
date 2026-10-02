<script setup lang="ts">
// 知识库文档里的「圈选 → 交给 AI 改」交互层。
//
// 它不在文章流里，而是**绝对定位在文章的滚动容器里**的一层：滚动时跟着内容走，只有布局变化
// （改宽度 / 图片撑开 / 字体换上）才重算。所有高亮都由「源文偏移」推出来（rangeForSource），不攥着
// DOM Range 不放——正文重新渲染之后 Range 会塌缩，偏移永远有效。
//
// 一条圈选的视觉语言（颜色全走主题变量，人 = accent，AI = agentAccent，与应用里既有语义一致）：
//   圈出来 → 小入口「✦ 让 AI 改」（不抢复制：只是选中文字时挂在末尾的一枚小药丸）
//   写意见 → 浮窗（范围说明 + 一句话 + 常用意图 + 发送）
//   待发送 → 编号角标 ①②，底部托盘「已圈 N 处 · 一起交给 AI」
//   处理中 → 高亮上有一道流光扫过
//   改好了 → 新文字亮一下再静下来，角标「✦ 已改 · v8  撤销」
// 范围说明永远写在浮窗里：「第 12 行 · 这一句」或「第 12–14 行 · 整段（选区含格式，已扩大到整块）」——
// 用户必须在发送前就知道 AI **只会动**哪里。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { kb, KbError } from "../kbClient";
import { useKbSelections, type KbSelectionRecord } from "@/composables/useKbSelections";
import { scopeFromRange, type ResolvedScope } from "./scopeFromRange";
import { rangeForSource } from "./rangeForSource";
import { rectsInScroller, type LayoutRect } from "./layoutRects";

const props = defineProps<{
  /** 渲染出来的正文容器（markdown 看态才有）。 */
  bodyEl: HTMLElement | null;
  /** 文章的滚动容器：本层的绝对定位参照与坐标原点。 */
  scrollEl: HTMLElement | null;
  doc: { id: string; title: string; versionNo: number; content?: string | null };
}>();

const emit = defineEmits<{
  /** AI 改完了：请父层把这篇文档刷新到新版本。 */
  refresh: [docId: string];
  /** 撤销成功（回滚到圈选之前的版本）：父层刷新。 */
  reverted: [docId: string];
}>();

const kbSel = useKbSelections();
const source = computed(() => props.doc.content ?? "");

// ── 阶段：idle → cta（选中后的小入口）→ compose（写意见的浮窗）─────────────────
type Stage = "idle" | "cta" | "compose";
const stage = ref<Stage>("idle");
/** cta 阶段暂存的范围（还没成为记录：只是选中文字不该留下任何状态）。 */
const pendingScope = ref<ResolvedScope | null>(null);
const ctaAnchor = ref<LayoutRect | null>(null);
const composeId = ref<string | null>(null);
const note = ref("");
const noteEl = ref<HTMLTextAreaElement | null>(null);
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(msg: string): void {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 2600);
}

// ── 布局：每条记录 → 一组矩形 ───────────────────────────────────────────────
interface Overlay {
  rec: KbSelectionRecord;
  rects: LayoutRect[];
  /** 该条在待发送里的序号（1 起）；非待发送为 0。 */
  pin: number;
  /** 圈选的原文已不在原位（文档被改过）：不画，但要有交代。 */
  stale: boolean;
}
const overlays = ref<Overlay[]>([]);
const tick = ref(0);
let rafId = 0;

function scheduleLayout(): void {
  if (typeof requestAnimationFrame === "undefined") {
    tick.value += 1;
    return;
  }
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => (tick.value += 1));
}

/** 该记录此刻应当高亮的源文范围：done 且新位置已算出 → 新范围；否则圈选时的范围。 */
function effectiveRange(rec: KbSelectionRecord): { s: number; e: number } | null {
  if (rec.status === "done") return rec.newRange ? { s: rec.newRange.start, e: rec.newRange.end } : null;
  return { s: rec.ref.start, e: rec.ref.end };
}

function layout(): void {
  const body = props.bodyEl;
  const scroller = props.scrollEl;
  if (!body || !scroller) {
    overlays.value = [];
    return;
  }
  const src = source.value;
  let pinNo = 0;
  const out: Overlay[] = [];
  for (const rec of kbSel.forDoc(props.doc.id)) {
    const pin = rec.status === "pending" ? ++pinNo : 0;
    const range = effectiveRange(rec);
    if (!range) {
      out.push({ rec, rects: [], pin, stale: false });
      continue;
    }
    // 还没改成之前，圈选的原文必须仍在原位才画——否则高亮会框住别的字，比不画更糟。
    const stale = rec.status !== "done" && src.slice(range.s, range.e) !== rec.ref.text;
    if (stale) {
      out.push({ rec, rects: [], pin, stale: true });
      continue;
    }
    const dom = rangeForSource(body, src, range.s, range.e);
    out.push({ rec, rects: dom ? rectsInScroller(dom, scroller) : [], pin, stale: false });
  }
  overlays.value = out;
}

watch(
  [tick, () => props.bodyEl, () => props.doc.content, () => props.doc.versionNo, () => kbSel.all.value.map((r) => `${r.ref.selectionId}:${r.status}:${r.newRange?.start ?? ""}`).join("|")],
  () => void nextTick(layout),
  { immediate: true },
);

// 布局变化 → 重算。ResizeObserver 管宽度/内容高度；图片 load 与字体就绪管「异步撑开」。
let ro: ResizeObserver | null = null;
function observe(): void {
  ro?.disconnect();
  ro = null;
  if (!props.bodyEl) return;
  // 没有 ResizeObserver 的环境（测试 / 极老内核）只是少了「宽度变化自动重排」，圈选照常可用
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(scheduleLayout);
    ro.observe(props.bodyEl);
  }
  props.bodyEl.addEventListener("load", scheduleLayout, true);
}
watch(
  () => props.bodyEl,
  (now, prev) => {
    prev?.removeEventListener("load", scheduleLayout, true);
    prev?.removeEventListener("mouseup", onPointerUp);
    prev?.removeEventListener("keyup", onKeyUp);
    observe();
    now?.addEventListener("mouseup", onPointerUp);
    now?.addEventListener("keyup", onKeyUp);
    dismiss();
  },
  { immediate: true },
);
onMounted(() => {
  window.addEventListener("resize", scheduleLayout);
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("keydown", onDocKeyDown, true);
  void document.fonts?.ready.then(scheduleLayout);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(rafId);
  clearTimeout(toastTimer);
  ro?.disconnect();
  props.bodyEl?.removeEventListener("load", scheduleLayout, true);
  props.bodyEl?.removeEventListener("mouseup", onPointerUp);
  props.bodyEl?.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("resize", scheduleLayout);
  document.removeEventListener("mousedown", onDocMouseDown, true);
  document.removeEventListener("keydown", onDocKeyDown, true);
  // 离开文档时丢掉草稿；待发送的保留（用户可能去聊天里发）。
  if (composeId.value) kbSel.discard(composeId.value);
});

// ── 选中 → 小入口 ──────────────────────────────────────────────────────────
function onPointerUp(): void {
  // 等浏览器把选区结算完（双击选词、拖选收尾）
  setTimeout(readSelection, 0);
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.shiftKey) setTimeout(readSelection, 0);
}

function readSelection(): void {
  const body = props.bodyEl;
  const scroller = props.scrollEl;
  if (!body || !scroller || stage.value === "compose") return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    if (stage.value === "cta") dismiss();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return;
  const res = scopeFromRange(range, body, source.value);
  if (!res.ok) {
    if (res.reason === "unlocatable") showToast("这里是提示块或组件，暂时不能圈选");
    return;
  }
  const rects = rectsInScroller(range, scroller);
  const last = rects[rects.length - 1];
  if (!last) return;
  pendingScope.value = res.scope;
  ctaAnchor.value = last;
  stage.value = "cta";
}

function dismiss(): void {
  stage.value = "idle";
  pendingScope.value = null;
  ctaAnchor.value = null;
  if (composeId.value) kbSel.discard(composeId.value);
  composeId.value = null;
  note.value = "";
}

/** 点小入口：把暂存的范围变成草稿记录，打开浮窗。 */
function openCompose(): void {
  const scope = pendingScope.value;
  if (!scope) return;
  const rec = kbSel.begin({
    documentId: props.doc.id,
    title: props.doc.title,
    baseVersion: props.doc.versionNo,
    baseContent: source.value,
    scope,
  });
  composeId.value = rec.ref.selectionId;
  note.value = "";
  stage.value = "compose";
  // 原生选区交给我们自己的高亮接管：不然两层高亮叠着，点输入框时原生选区还会塌掉。
  window.getSelection()?.removeAllRanges();
  void nextTick(() => noteEl.value?.focus());
}

function onDocMouseDown(e: MouseEvent): void {
  if (stage.value === "idle") return;
  const t = e.target as HTMLElement | null;
  if (t?.closest(".ksl-pop, .ksl-cta")) return;
  // compose 时点正文空白处才收起；点在别处的角标/托盘上不算
  if (t?.closest(".ksl-badge, .ksl-tray")) return;
  if (stage.value === "compose" && note.value.trim() !== "") return; // 写了字不因误点丢失
  dismiss();
}

function onDocKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && stage.value !== "idle") {
    e.stopPropagation();
    dismiss();
  }
}

// ── 浮窗 ───────────────────────────────────────────────────────────────────
const composeRec = computed(() => (composeId.value ? kbSel.records[composeId.value] : undefined));
const composeOverlay = computed(() => overlays.value.find((o) => o.rec.ref.selectionId === composeId.value));

/** 范围说明：用户在发送前就要知道 AI 只会动哪里。 */
const scopeLabel = computed(() => {
  const r = composeRec.value?.ref;
  if (!r) return "";
  const lines = r.lineStart === r.lineEnd ? `第 ${r.lineStart} 行` : `第 ${r.lineStart}–${r.lineEnd} 行`;
  if (r.precise) return `${lines} · ${r.text.length <= 24 ? "这几个字" : "这一段话"}`;
  return `${lines} · 整块`;
});
const scopeHint = computed(() =>
  composeRec.value?.ref.precise
    ? "AI 只会改高亮的这部分，其余内容一个字都不会动"
    : "选区含格式或跨段，已扩大到整块——AI 只会改这一块，其余内容不会动",
);

/** 常用意图：点一下就填进意见，省掉最常见的那几句话。 */
const INTENTS = ["更简洁", "更具体", "改得更正式", "修正错别字", "翻译成英文", "补充例子"];
function pickIntent(label: string): void {
  note.value = note.value.trim() ? `${note.value.trim()}；${label}` : label;
  void nextTick(() => noteEl.value?.focus());
}

const pendingCount = computed(() => overlays.value.filter((o) => o.rec.status === "pending").length);
const sendLabel = computed(() => (pendingCount.value > 0 ? `一起交给 AI（共 ${pendingCount.value + 1} 处）` : "交给 AI"));

function submit(sendNow: boolean): void {
  const id = composeId.value;
  if (!id) return;
  kbSel.confirm(id, note.value);
  composeId.value = null;
  stage.value = "idle";
  pendingScope.value = null;
  note.value = "";
  if (sendNow) kbSel.requestSend("");
}

function onNoteKey(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit(true);
  }
}

// 浮窗的位置：贴在圈选末行下方，放不下就翻到首行上方；横向夹在文章可视宽度内。
const POP_W = 392;
const popStyle = computed(() => {
  const o = composeOverlay.value;
  const scroller = props.scrollEl;
  if (!o || !scroller || o.rects.length === 0) return { display: "none" };
  const first = o.rects[0]!;
  const last = o.rects[o.rects.length - 1]!;
  const viewBottom = scroller.scrollTop + scroller.clientHeight;
  const below = last.y + last.h + 10;
  const flip = below + 210 > viewBottom && first.y - 10 - 210 > scroller.scrollTop;
  const left = Math.max(12, Math.min(first.x, scroller.clientWidth - POP_W - 12));
  return {
    left: `${left}px`,
    top: flip ? undefined : `${below}px`,
    bottom: flip ? `${scroller.scrollHeight - first.y + 10}px` : undefined,
    width: `${POP_W}px`,
    "--ksl-notch-x": `${Math.max(16, Math.min(first.x + 14 - left, POP_W - 28))}px`,
  } as Record<string, string | undefined>;
});
const popFlipped = computed(() => {
  const o = composeOverlay.value;
  const scroller = props.scrollEl;
  if (!o || !scroller || o.rects.length === 0) return false;
  const first = o.rects[0]!;
  const last = o.rects[o.rects.length - 1]!;
  const below = last.y + last.h + 10;
  return below + 210 > scroller.scrollTop + scroller.clientHeight && first.y - 10 - 210 > scroller.scrollTop;
});

// ── 小入口、角标的位置 ──────────────────────────────────────────────────────
const ctaStyle = computed(() => {
  const a = ctaAnchor.value;
  const scroller = props.scrollEl;
  if (!a || !scroller) return { display: "none" };
  const left = Math.max(8, Math.min(a.x + a.w - 8, scroller.clientWidth - 150));
  return { left: `${left}px`, top: `${a.y + a.h + 6}px` };
});

function badgeStyle(o: Overlay): Record<string, string> {
  const r = o.rects[0];
  if (!r) return { display: "none" };
  return { left: `${r.x}px`, top: `${r.y}px` };
}

// ── 状态推进里需要本层配合的两件事 ──────────────────────────────────────────
// 1) done：文档要刷新到新版本（一次）；刷新到了就算出新范围、亮一下。
const asked = new Set<string>();
const told = new Set<string>();
watch(
  () => [kbSel.all.value.map((r) => `${r.ref.selectionId}:${r.status}`).join("|"), props.doc.versionNo, props.doc.content] as const,
  () => {
    for (const rec of kbSel.forDoc(props.doc.id)) {
      if (rec.status !== "done") continue;
      const id = rec.ref.selectionId;
      if ((rec.versionNo ?? 0) > props.doc.versionNo) {
        if (!asked.has(id)) {
          asked.add(id);
          emit("refresh", props.doc.id);
        }
      } else if (!rec.newRange && props.doc.content != null) {
        kbSel.resolveDone(id, props.doc.content);
        // 刷新到了、位置却算不出（同时有别人改了别处）：不画错位的高亮，但要交代结果。
        if (!kbSel.records[id]?.newRange && !told.has(id)) {
          told.add(id);
          showToast(`AI 已改好（v${rec.versionNo}）。文档里同时有别的改动，没法标出具体位置`);
        }
      }
    }
  },
  { immediate: true },
);

// 2) 撤销：回滚到圈选那一刻的版本。只有「之后没有别的改动」才允许——否则会把别人的改动一起回掉。
const undoing = ref<string | null>(null);
function canUndo(rec: KbSelectionRecord): boolean {
  return rec.status === "done" && rec.versionNo === props.doc.versionNo;
}
async function undo(rec: KbSelectionRecord): Promise<void> {
  if (!canUndo(rec) || undoing.value) return;
  undoing.value = rec.ref.selectionId;
  try {
    await kb.revert(props.doc.id, rec.ref.baseVersion);
    kbSel.discard(rec.ref.selectionId);
    emit("reverted", props.doc.id);
  } catch (e) {
    showToast(e instanceof KbError ? e.message : `撤销失败：${String(e)}`);
  } finally {
    undoing.value = null;
  }
}

// ── 底部托盘 ───────────────────────────────────────────────────────────────
const trayNote = ref("");
const inFlight = computed(() => overlays.value.filter((o) => o.rec.status === "sent" || o.rec.status === "working").length);
const trayMode = computed<"pending" | "busy" | "hidden">(() => {
  if (pendingCount.value > 0) return "pending";
  if (inFlight.value > 0) return "busy";
  return "hidden";
});
function sendAll(): void {
  kbSel.requestSend(trayNote.value);
  trayNote.value = "";
}
function onTrayKey(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendAll();
  }
}

function badgeText(o: Overlay): string {
  const r = o.rec;
  switch (r.status) {
    case "pending":
      return "待发送";
    case "sent":
      return "已交给 AI";
    case "working":
      return "AI 处理中";
    case "done":
      return `已改 · v${r.versionNo ?? ""}`;
    case "refused":
      return r.message ?? "没有改成";
    case "noop":
      return "AI 这次没有改这一段";
    default:
      return "";
  }
}
</script>

<template>
  <div class="ksl" aria-hidden="false">
    <!-- 高亮：每条记录的每一行一个圆角色块 -->
    <template v-for="o in overlays" :key="o.rec.ref.selectionId">
      <div
        v-for="(r, i) in o.rects"
        :key="i"
        class="ksl-hl"
        :class="[`ksl-hl--${o.rec.status}`, { 'ksl-hl--first': i === 0, 'ksl-hl--last': i === o.rects.length - 1 }]"
        :style="{ left: `${r.x - 2}px`, top: `${r.y - 1}px`, width: `${r.w + 4}px`, height: `${r.h + 2}px` }"
      />

      <!-- 角标：编号 + 状态 + 动作。待发送可摘掉，改好的可撤销，被拒/没改的可收起 -->
      <div
        v-if="o.rec.status !== 'draft' && (o.rects.length || o.stale || o.rec.status === 'done')"
        class="ksl-badge"
        :class="[`ksl-badge--${o.rec.status}`, { 'ksl-badge--stale': o.stale }]"
        :style="badgeStyle(o)"
        role="status"
      >
        <span v-if="o.pin" class="ksl-pin">{{ o.pin }}</span>
        <span v-else-if="o.rec.status === 'working' || o.rec.status === 'sent'" class="ksl-dots" aria-hidden="true"><i /><i /><i /></span>
        <span v-else-if="o.rec.status === 'done'" class="ksl-spark">✦</span>
        <span v-else-if="o.rec.status === 'refused'" class="ksl-mark">!</span>
        <span class="ksl-badge-text">{{ o.stale ? "原文已变，请重新圈选" : badgeText(o) }}</span>
        <button
          v-if="o.rec.status === 'done'"
          type="button"
          class="ksl-badge-act"
          :disabled="!canUndo(o.rec) || undoing === o.rec.ref.selectionId"
          :title="canUndo(o.rec) ? '回到圈选之前的版本' : '之后又有别的改动，请到「历史」里回退'"
          @click="undo(o.rec)"
        >{{ undoing === o.rec.ref.selectionId ? "撤销中…" : "撤销" }}</button>
        <button
          v-if="o.rec.status === 'pending' || o.rec.status === 'refused' || o.rec.status === 'noop' || o.rec.status === 'done'"
          type="button"
          class="ksl-badge-x"
          :aria-label="o.rec.status === 'pending' ? '不要这处圈选' : '收起'"
          @click="kbSel.discard(o.rec.ref.selectionId)"
        >×</button>
      </div>
    </template>

    <!-- 小入口：选中文字后挂在末尾，不抢复制 -->
    <button v-if="stage === 'cta'" type="button" class="ksl-cta" :style="ctaStyle" @mousedown.prevent @click="openCompose">
      <span class="ksl-spark">✦</span>让 AI 改这段
    </button>

    <!-- 浮窗：范围说明 + 一句话 + 常用意图 + 发送 -->
    <div v-if="stage === 'compose' && composeRec" class="ksl-pop" :class="{ 'ksl-pop--up': popFlipped }" :style="popStyle" role="dialog" aria-label="让 AI 修改圈选的内容">
      <span class="ksl-notch" aria-hidden="true" />
      <header class="ksl-pop-head">
        <span class="ksl-spark ksl-spark--lg">✦</span>
        <span class="ksl-pop-title">让 AI 改这一段</span>
        <span class="ksl-scope" :class="{ 'ksl-scope--wide': !composeRec.ref.precise }" :title="scopeHint">{{ scopeLabel }}</span>
      </header>
      <textarea
        ref="noteEl"
        v-model="note"
        class="ksl-input"
        rows="2"
        placeholder="想怎么改？（可以留空，只让 AI 看这一段）"
        spellcheck="false"
        @keydown="onNoteKey"
      />
      <div class="ksl-intents" role="group" aria-label="常用意图">
        <button v-for="t in INTENTS" :key="t" type="button" class="ksl-intent" @click="pickIntent(t)">{{ t }}</button>
      </div>
      <footer class="ksl-pop-foot">
        <span class="ksl-hint">{{ scopeHint }}</span>
        <span class="ksl-spacer" />
        <button type="button" class="ksl-btn" @click="submit(false)" title="先记下这一处，继续圈别处，最后一起发">再圈一处</button>
        <button type="button" class="ksl-btn ksl-btn--primary" @click="submit(true)">
          {{ sendLabel }}<kbd>↵</kbd>
        </button>
      </footer>
    </div>

    <!-- 底部托盘：粘在文章可视区底部 -->
    <div v-if="trayMode !== 'hidden'" class="ksl-dock">
      <div class="ksl-tray" :class="`ksl-tray--${trayMode}`" role="region" aria-label="圈选">
        <template v-if="trayMode === 'pending'">
          <span class="ksl-tray-count"><b>{{ pendingCount }}</b> 处已圈</span>
          <input
            v-model="trayNote"
            class="ksl-tray-input"
            placeholder="补一句话（可选）"
            spellcheck="false"
            @keydown="onTrayKey"
          />
          <button type="button" class="ksl-btn" @click="kbSel.discardPending()">清空</button>
          <button type="button" class="ksl-btn ksl-btn--primary" @click="sendAll">一起交给 AI<kbd>↵</kbd></button>
        </template>
        <template v-else>
          <span class="ksl-dots" aria-hidden="true"><i /><i /><i /></span>
          <span class="ksl-tray-busy">AI 正在处理 {{ inFlight }} 处…</span>
        </template>
      </div>
    </div>

    <div v-if="toast" class="ksl-toast" role="alert">{{ toast }}</div>
  </div>
</template>

<style scoped>
/* 本层绝对定位在文章滚动容器里（父层给 .kb-doc 加了 position: relative）：
   自己不占流、不拦鼠标，只有可交互的零件（小入口 / 浮窗 / 角标 / 托盘）开 pointer-events。 */
.ksl {
  position: absolute;
  inset: 0 0 auto 0;
  height: 0;
  pointer-events: none;
  z-index: 3;
}
.ksl > *,
.ksl-pop,
.ksl-badge,
.ksl-cta {
  pointer-events: auto;
}
.ksl-hl {
  pointer-events: none;
}

/* ── 高亮：圆角色块，多行时首尾圆、中间连成一片 ── */
.ksl-hl {
  position: absolute;
  border-radius: 5px;
  background: color-mix(in srgb, var(--aide-accent) 16%, transparent);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--aide-accent) 70%, transparent);
  animation: ksl-in 180ms var(--aide-ease, ease-out);
  transition: background 220ms var(--aide-ease, ease), box-shadow 220ms var(--aide-ease, ease);
}
.ksl-hl:not(.ksl-hl--first) {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.ksl-hl:not(.ksl-hl--last) {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.ksl-hl--draft {
  background: color-mix(in srgb, var(--aide-accent) 22%, transparent);
  box-shadow: inset 0 -2px 0 var(--aide-accent), 0 0 0 3px color-mix(in srgb, var(--aide-accent) 14%, transparent);
}
/* 已发出 / 处理中：换成 AI 的色，并有一道流光扫过——「它正在动这一段」 */
.ksl-hl--sent,
.ksl-hl--working {
  background:
    linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--aide-agent-accent) 42%, transparent) 50%, transparent 80%) 0 0 / 220% 100% no-repeat,
    color-mix(in srgb, var(--aide-agent-accent) 13%, transparent);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--aide-agent-accent) 75%, transparent);
  animation: ksl-sweep 1.5s linear infinite;
}
/* 改好了：新文字先亮一下（成功色），再静成淡淡的一层 */
.ksl-hl--done {
  background: color-mix(in srgb, var(--aide-success) 14%, transparent);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--aide-success) 65%, transparent);
  animation: ksl-flash 1.4s var(--aide-ease, ease-out);
}
.ksl-hl--refused {
  background: color-mix(in srgb, var(--aide-danger) 10%, transparent);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--aide-danger) 60%, transparent);
}
.ksl-hl--noop {
  background: color-mix(in srgb, var(--aide-text-muted) 10%, transparent);
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--aide-text-muted) 45%, transparent);
}

/* ── 角标：贴在首行左上角、压在文字上方一点 ── */
.ksl-badge {
  position: absolute;
  transform: translateY(calc(-100% - 5px));
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: min(360px, 92%);
  height: 22px;
  padding: 0 4px 0 6px;
  border-radius: 11px;
  border: 1px solid color-mix(in srgb, var(--aide-accent) 38%, var(--aide-border));
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  font-size: 11px;
  line-height: 1;
  color: var(--aide-text-secondary);
  white-space: nowrap;
  animation: ksl-rise 200ms var(--aide-ease, ease-out);
}
.ksl-badge--sent,
.ksl-badge--working {
  border-color: color-mix(in srgb, var(--aide-agent-accent) 45%, var(--aide-border));
  color: var(--aide-text-primary);
}
.ksl-badge--done {
  border-color: color-mix(in srgb, var(--aide-success) 50%, var(--aide-border));
}
.ksl-badge--refused,
.ksl-badge--stale {
  border-color: color-mix(in srgb, var(--aide-danger) 50%, var(--aide-border));
}
.ksl-badge-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.ksl-pin {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--aide-accent-gradient, var(--aide-accent));
  color: var(--aide-text-on-accent);
  font-size: 10px;
  font-weight: 700;
}
.ksl-mark {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--aide-danger);
  color: var(--aide-text-on-accent);
  font-size: 10px;
  font-weight: 700;
}
.ksl-spark {
  color: var(--aide-agent-accent);
  font-size: 12px;
}
.ksl-spark--lg {
  font-size: 14px;
}
.ksl-badge--done .ksl-spark {
  color: var(--aide-success);
}
.ksl-badge-act,
.ksl-badge-x {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  font: inherit;
  height: 18px;
  border-radius: 9px;
  transition: background var(--aide-ease-t, 120ms), color var(--aide-ease-t, 120ms);
}
.ksl-badge-act {
  padding: 0 7px;
  color: var(--aide-accent);
  font-weight: 600;
}
.ksl-badge-act:hover:not(:disabled) {
  background: var(--aide-accent-subtle);
}
.ksl-badge-act:disabled {
  color: var(--aide-text-muted);
  cursor: not-allowed;
}
.ksl-badge-x {
  width: 18px;
  font-size: 14px;
}
.ksl-badge-x:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.ksl-badge-act:focus-visible,
.ksl-badge-x:focus-visible,
.ksl-cta:focus-visible,
.ksl-btn:focus-visible,
.ksl-intent:focus-visible {
  outline: 2px solid var(--aide-accent);
  outline-offset: 1px;
}

/* 三点呼吸：处理中 */
.ksl-dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}
.ksl-dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--aide-agent-accent);
  animation: ksl-dot 1s ease-in-out infinite;
}
.ksl-dots i:nth-child(2) {
  animation-delay: 0.15s;
}
.ksl-dots i:nth-child(3) {
  animation-delay: 0.3s;
}

/* ── 小入口 ── */
.ksl-cta {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px 0 9px;
  border-radius: 13px;
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 45%, var(--aide-border));
  background: var(--aide-bg-raised);
  color: var(--aide-text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--aide-shadow-md), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  animation: ksl-rise 160ms var(--aide-ease, ease-out);
  transition: background var(--aide-ease-t, 120ms), border-color var(--aide-ease-t, 120ms);
}
.ksl-cta:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-agent-accent);
}

/* ── 浮窗 ── */
.ksl-pop {
  position: absolute;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 12px;
  border-radius: var(--aide-radius-lg);
  border: 1px solid var(--aide-border-strong);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  animation: ksl-pop-in 170ms var(--aide-ease, ease-out);
  transform-origin: var(--ksl-notch-x, 24px) top;
}
.ksl-pop--up {
  transform-origin: var(--ksl-notch-x, 24px) bottom;
}
.ksl-notch {
  position: absolute;
  top: -6px;
  left: var(--ksl-notch-x, 24px);
  width: 10px;
  height: 10px;
  transform: rotate(45deg);
  background: var(--aide-bg-raised);
  border-left: 1px solid var(--aide-border-strong);
  border-top: 1px solid var(--aide-border-strong);
}
.ksl-pop--up .ksl-notch {
  top: auto;
  bottom: -6px;
  border-left: none;
  border-top: none;
  border-right: 1px solid var(--aide-border-strong);
  border-bottom: 1px solid var(--aide-border-strong);
}
.ksl-pop-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.ksl-pop-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.ksl-scope {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 28%, transparent);
  white-space: nowrap;
}
/* 扩大到整块：换成警示色，让「范围比你选的大」这件事不会被忽略 */
.ksl-scope--wide {
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-warning) 35%, transparent);
}
.ksl-input {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  padding: 9px 11px;
  border-radius: var(--aide-radius-md);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
  outline: none;
  transition: border-color var(--aide-ease-t, 120ms), box-shadow var(--aide-ease-t, 120ms);
}
.ksl-input::placeholder {
  color: var(--aide-text-muted);
}
.ksl-input:focus {
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring);
}
.ksl-intents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ksl-intent {
  appearance: none;
  height: 24px;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background var(--aide-ease-t, 120ms), color var(--aide-ease-t, 120ms), border-color var(--aide-ease-t, 120ms);
}
.ksl-intent:hover {
  background: var(--aide-accent-subtle);
  border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent);
  color: var(--aide-accent);
}
.ksl-pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ksl-hint {
  font-size: 11px;
  line-height: 1.4;
  color: var(--aide-text-muted);
  max-width: 150px;
}
.ksl-spacer {
  flex: 1;
}
.ksl-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--aide-radius-md);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--aide-ease-t, 120ms), border-color var(--aide-ease-t, 120ms), color var(--aide-ease-t, 120ms);
}
.ksl-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.ksl-btn--primary {
  border-color: transparent;
  background: var(--aide-accent-gradient, var(--aide-accent));
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow);
}
.ksl-btn--primary:hover {
  background: var(--aide-accent-gradient, var(--aide-accent-hover));
  color: var(--aide-text-on-accent);
  filter: brightness(1.06);
}
.ksl-btn kbd {
  font: inherit;
  font-size: 10.5px;
  opacity: 0.8;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

/* ── 底部托盘：粘在文章可视区底部，不随内容滚走 ── */
.ksl-dock {
  position: sticky;
  bottom: 18px;
  height: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.ksl-tray {
  position: absolute;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 32px);
  padding: 7px 8px 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--aide-border-strong);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  pointer-events: auto;
  animation: ksl-rise 220ms var(--aide-ease, ease-out);
}
.ksl-tray--busy {
  padding-right: 16px;
  border-color: color-mix(in srgb, var(--aide-agent-accent) 45%, var(--aide-border));
}
.ksl-tray-count {
  font-size: 12px;
  color: var(--aide-text-secondary);
  white-space: nowrap;
}
.ksl-tray-count b {
  color: var(--aide-accent);
  font-size: 13px;
}
.ksl-tray-busy {
  font-size: 12px;
  color: var(--aide-text-primary);
}
.ksl-tray-input {
  width: 180px;
  min-width: 80px;
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.ksl-tray-input:focus {
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring);
}
.ksl-tray .ksl-btn {
  border-radius: 14px;
  height: 26px;
}

.ksl-toast {
  position: sticky;
  top: 12px;
  margin: 0 auto;
  width: fit-content;
  max-width: 80%;
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  box-shadow: var(--aide-shadow-md);
  font-size: 12px;
  color: var(--aide-text-secondary);
  animation: ksl-rise 180ms var(--aide-ease, ease-out);
}

@keyframes ksl-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ksl-rise {
  from { opacity: 0; transform: translateY(calc(-100% - 1px)); }
  to { opacity: 1; transform: translateY(calc(-100% - 5px)); }
}
/* 小入口 / 托盘 / 提示不带 translateY(-100%) 的定位，用各自的入场 */
.ksl-cta,
.ksl-tray,
.ksl-toast {
  animation-name: ksl-fade-up;
}
@keyframes ksl-fade-up {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes ksl-pop-in {
  from { opacity: 0; transform: scale(0.96) translateY(-4px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes ksl-sweep {
  from { background-position: 130% 0, 0 0; }
  to { background-position: -130% 0, 0 0; }
}
@keyframes ksl-flash {
  0% { background: color-mix(in srgb, var(--aide-success) 42%, transparent); }
  100% { background: color-mix(in srgb, var(--aide-success) 14%, transparent); }
}
@keyframes ksl-dot {
  0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.15); }
}
@media (prefers-reduced-motion: reduce) {
  .ksl-hl,
  .ksl-badge,
  .ksl-cta,
  .ksl-pop,
  .ksl-tray,
  .ksl-toast,
  .ksl-dots i {
    animation: none !important;
  }
}
</style>
