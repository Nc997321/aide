import { computed, reactive, ref } from "vue";
import type { KbRef } from "@aide/sdk/types/chat";
import { onKbSelectionEvent, type KbSelectionEvent } from "@aide/sdk/composables/useKbSelectionEvents";

/**
 * 知识库「圈选 → 交给 AI 改」的前端状态（模块级单例）。
 *
 * 一条圈选的一生：
 *   draft    刚圈出来，浮窗里写意见（同一时刻只留一个 draft）
 *   pending  已确认、等着发送（文档里编号标记，聊天输入框上方同步出芯片）
 *   sent     已发给 agent，还没看到它动手
 *   working  agent 正在改（收到 edit_selection 的开始事件）
 *   done     改好了（带新版本号；文档据此刷新并把新范围亮一下）
 *   refused  改不成（文档在圈选后被改过 / 没写权限 …），带人话原因
 *   noop     这一轮结束了，agent 没有改这一段
 *
 * 状态只由两类来源推进：用户操作，以及聊天事件流里的 edit_selection 事件（多端一致的真相）。
 * 本地绝不「乐观地」宣布 done——不是 AI 真改成了，就不能说改成了。
 *
 * 草稿归属是**当前选中的会话**（发送时才决定发给谁），不是某个输入框：知识库打开时聊天输入框
 * 不在眼前，所以圈选也得能在文档这一侧直接发出去（requestSend）。
 */
export type KbSelectionStatus = "draft" | "pending" | "sent" | "working" | "done" | "refused" | "noop";

export interface KbSelectionRecord {
  ref: KbRef;
  status: KbSelectionStatus;
  /** 圈选那一刻的整篇正文：AI 改完后据此推算「新范围」（前后缀不变，只有这一段变了）。 */
  baseContent: string;
  seq: number;
  sid?: string;
  /** done：写入后的文档版本。 */
  versionNo?: number;
  /** done：读回核对发现选区之外有出入。 */
  warning?: boolean;
  /** refused：给用户看的原因。 */
  message?: string;
  /** done 且文档已刷新：改出来的那段在新正文里的位置（用于高亮）。 */
  newRange?: { start: number; end: number };
}

export interface BeginInput {
  documentId: string;
  title: string;
  baseVersion: number;
  baseContent: string;
  scope: { start: number; end: number; text: string; lineStart: number; lineEnd: number; precise: boolean };
}

const records = reactive<Record<string, KbSelectionRecord>>({});
let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** 结果态（done / refused / noop）在界面上停留多久后自动收起。 */
const RESULT_LINGER_MS = 20_000;
/** sent 之后多久没动静就当「这一轮没改」。 */
const SENT_GIVE_UP_MS = 180_000;

function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function schedule(id: string, ms: number, fn: () => void): void {
  clearTimer(id);
  timers.set(id, setTimeout(fn, ms));
}

function remove(id: string): void {
  clearTimer(id);
  delete records[id];
}

function finishWith(id: string, patch: Partial<KbSelectionRecord> & { status: KbSelectionStatus }): void {
  const rec = records[id];
  if (!rec) return;
  Object.assign(rec, patch);
  schedule(id, RESULT_LINGER_MS, () => remove(id));
}

/** 工具回的英文拒绝文本 → 给用户看的话。认不出的原样截短给出，不吞。 */
function friendly(message: string | undefined): string {
  const m = message ?? "";
  if (/no longer where the user selected/.test(m)) return "文档在你圈选之后被改过，这一处没有改动——请重新圈选";
  if (/has not selected anything|no selection/.test(m)) return "没有找到这处圈选，请重新圈选";
  if (/403|forbidden|permission|not allowed/i.test(m)) return "你对这篇文档没有编辑权限";
  if (/locked|编辑中/.test(m)) return "文档正被别人编辑，稍后再试";
  return m.trim().slice(0, 160) || "没有改成";
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  onKbSelectionEvent((e: KbSelectionEvent) => {
    if (e.kind === "working") {
      const rec = records[e.selectionId];
      if (rec && (rec.status === "sent" || rec.status === "working")) {
        rec.status = "working";
        rec.sid = e.sid;
        clearTimer(e.selectionId);
      }
    } else if (e.kind === "result") {
      const rec = records[e.selectionId];
      if (!rec) return;
      if (e.ok) finishWith(e.selectionId, { status: "done", versionNo: e.versionNo, warning: e.warning });
      else finishWith(e.selectionId, { status: "refused", message: friendly(e.message) });
    } else if (e.kind === "turn_end") {
      for (const [id, rec] of Object.entries(records)) {
        if ((rec.status === "sent" || rec.status === "working") && (!rec.sid || rec.sid === e.sid)) {
          finishWith(id, { status: "noop" });
        }
      }
    }
  });
}

/** AI 改完后，改出来的那段在新正文里的位置。只有「前后缀与圈选时逐字相同」才算数——
 *  否则说明同时有别人改了别处，位置不可信，返回 null（界面不画新高亮，只给版本号）。 */
export function newRangeAfterEdit(baseContent: string, ref: Pick<KbRef, "start" | "end">, newContent: string): { start: number; end: number } | null {
  const prefix = baseContent.slice(0, ref.start);
  const suffix = baseContent.slice(ref.end);
  if (newContent.length < prefix.length + suffix.length) return null;
  if (!newContent.startsWith(prefix) || !newContent.endsWith(suffix)) return null;
  return { start: ref.start, end: newContent.length - suffix.length };
}

const sendRequest = ref<{ nonce: number; text: string } | null>(null);
let sendNonce = 0;
/** 「请把聊天亮出来」：文档侧发起的发送被聊天里的**发送前确认**（模型 / 供应商变了）拦下时，确认框画在
 *  聊天面板里——而知识库打开时聊天面板是隐藏的，用户永远看不到它，发送就一直挂着（圈选停在「待发送」）。
 *  知识库面板据此收起自己，让确认框露出来。 */
const chatRequest = ref<{ nonce: number } | null>(null);
let chatNonce = 0;

export function useKbSelections() {
  wire();

  /** 开始一条新圈选（草稿）。同一时刻只留一个草稿：新的来了，旧草稿直接作废。 */
  function begin(input: BeginInput): KbSelectionRecord {
    for (const [id, rec] of Object.entries(records)) if (rec.status === "draft") remove(id);
    const id = `s${++counter}`;
    records[id] = {
      ref: {
        selectionId: id,
        documentId: input.documentId,
        title: input.title,
        baseVersion: input.baseVersion,
        start: input.scope.start,
        end: input.scope.end,
        text: input.scope.text,
        comment: "",
        lineStart: input.scope.lineStart,
        lineEnd: input.scope.lineEnd,
        precise: input.scope.precise,
      },
      status: "draft",
      baseContent: input.baseContent,
      seq: counter,
    };
    return records[id]!;
  }

  function setComment(id: string, comment: string): void {
    const rec = records[id];
    if (rec && (rec.status === "draft" || rec.status === "pending")) rec.ref.comment = comment.trim();
  }

  /** 草稿 → 待发送。 */
  function confirm(id: string, comment: string): void {
    const rec = records[id];
    if (!rec || rec.status !== "draft") return;
    rec.ref.comment = comment.trim();
    rec.status = "pending";
  }

  /** 丢掉草稿 / 待发送项 / 已收尾的结果。在途（sent / working）的不许丢——它已经发出去了。 */
  function discard(id: string): void {
    const rec = records[id];
    if (!rec) return;
    if (rec.status === "sent" || rec.status === "working") return;
    remove(id);
  }

  function discardPending(): void {
    for (const [id, rec] of Object.entries(records)) if (rec.status === "pending") remove(id);
  }

  /** 发送出去了：待发送 → sent。 */
  function markSent(ids: string[], sid?: string): void {
    for (const id of ids) {
      const rec = records[id];
      if (!rec || rec.status !== "pending") continue;
      rec.status = "sent";
      if (sid) rec.sid = sid;
      schedule(id, SENT_GIVE_UP_MS, () => finishWith(id, { status: "noop" }));
    }
  }

  /** 文档刷新到新版本后，算出 done 记录的新范围（供高亮）。 */
  function resolveDone(id: string, newContent: string): void {
    const rec = records[id];
    if (!rec || rec.status !== "done" || rec.newRange) return;
    const r = newRangeAfterEdit(rec.baseContent, rec.ref, newContent);
    if (r) rec.newRange = r;
  }

  /** 文档侧要求「现在就发」：聚焦的聊天输入框收到后带上全部待发送圈选发出去。 */
  function requestSend(text = ""): void {
    sendRequest.value = { nonce: ++sendNonce, text };
  }

  function revealChat(): void {
    chatRequest.value = { nonce: ++chatNonce };
  }

  const all = computed(() => Object.values(records).sort((a, b) => a.seq - b.seq));
  const pendingRefs = computed<KbRef[]>(() => all.value.filter((r) => r.status === "pending").map((r) => ({ ...r.ref })));
  const forDoc = (documentId: string) => all.value.filter((r) => r.ref.documentId === documentId);

  return {
    records,
    all,
    pendingRefs,
    forDoc,
    sendRequest,
    chatRequest,
    revealChat,
    begin,
    setComment,
    confirm,
    discard,
    discardPending,
    markSent,
    resolveDone,
    requestSend,
  };
}

/** 仅测试：清空全部状态与定时器。 */
export function __resetKbSelectionsForTest(): void {
  for (const id of Object.keys(records)) remove(id);
  counter = 0;
  sendNonce = 0;
  sendRequest.value = null;
  chatNonce = 0;
  chatRequest.value = null;
}
