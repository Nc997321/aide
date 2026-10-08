import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { useChatSession, isPendingSession } from "@aide/sdk/composables/useChatSession";
import { api } from "@aide/sdk/api";
import { useSessionNames } from "@aide/sdk/composables/useSessionNames";
import { isEditSelectionTool } from "@aide/sdk/composables/useKbSelectionEvents";
import { dailyWorkspaceBind, ensureDailyWorkspace } from "@aide/sdk/utils/dailyWorkspace";
import type { ChatMessage, KbRef, PermissionRequest } from "@aide/sdk/types/chat";

/**
 * 知识库卡片对话：**一篇文档一个会话**。
 *
 * 圈选卡片里的对话不再回到主聊天里发：卡片自己持有这篇文档的会话，发送、流式回复、
 * 权限确认都在卡片内完成。会话本身是日常工作区里一条普通会话（侧栏「日常」栏可见、
 * 可点开继续聊），不另造一套存储——卡片里看到的只是同一份消息 store 的一个视图。
 *
 * 为什么是日常：知识库文档不属于任何代码项目；日常目录有自己的记忆（个人写作偏好），
 * 而不是把当前活动工作区的项目记忆带进团队可见的文档。归属走会话自持的 wsPath，
 * 不经「活动工作区」那条回落链（回落到活动工作区 = 跑错项目）。
 *
 * 状态只由事件推进：用户气泡、AI 回复、权限请求都来自 sidecar 广播进消息 store，这里
 * 只读它；**不做本地乐观渲染**。
 */

// ── 文档 → 会话 的映射（本机，不同步）─────────────────────────────────────────
const STORAGE_KEY = "aide.kbCardSessions.v1";
const sids = ref<Record<string, string>>(readMap());

export function parseSidMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string" && val) out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function readMap(): Record<string, string> {
  try {
    return parseSidMap(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

function setMapping(docId: string, sid: string | null): void {
  const next = { ...sids.value };
  if (sid) next[docId] = sid;
  else delete next[docId];
  sids.value = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 存不了就只在本次运行内有效：下次圈选会新开一条会话，不影响功能 */
  }
}

/** 测试用：从 localStorage 重新读映射（模拟「重启后」）。 */
export function __reloadMapForTest(): void {
  sids.value = readMap();
}

/** 测试用：清空映射。 */
export function __resetKbCardSessionsForTest(): void {
  sids.value = {};
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── 线程：消息 store 的卡片视图 ──────────────────────────────────────────────
export interface CardTurn {
  id: string;
  role: "user" | "ai";
  text: string;
  /** 用户这一条圈了几处（用来在气泡上标「圈了 N 处」，没写意见时也有东西可显示）。 */
  refs: number;
  streaming: boolean;
}

/** 消息 → 卡片线程。只取人话：用户写的意见、AI 的文字回复；工具调用、思考块都不进卡片。
 *  卡片浮窗里写的意见不走正文，而是作为圈选的 `comment` 随 kbref 块发出——正文为空时取它；
 *  两样都没有（只让 AI 看这一段）才显示占位，不让气泡凭空消失。 */
export function buildCardThread(messages: ChatMessage[]): CardTurn[] {
  const out: CardTurn[] = [];
  for (const m of messages) {
    if (m.markerFor) continue;
    const text = m.blocks
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (m.role === "user") {
      const kbrefs = m.blocks.filter((b): b is Extract<typeof b, { type: "kbref" }> => b.type === "kbref");
      if (!text && kbrefs.length === 0) continue;
      const comments = kbrefs.map((b) => b.comment.trim()).filter(Boolean).join("；");
      out.push({
        id: m.id,
        role: "user",
        text: text || comments || "（没有补充意见，只让 AI 看这一段）",
        refs: kbrefs.length,
        streaming: false,
      });
    } else if (m.role === "assistant" && text) {
      out.push({ id: m.id, role: "ai", text, refs: 0, streaming: !!m.streaming });
    }
  }
  return out;
}

/** 权限请求是不是「AI 要改圈选的那一段」；是就取出选区 id 与新文本（卡片里画成原文 ↔ 新文本对照）。 */
export function editSelectionRequest(p: PermissionRequest | null): { selectionId: string; newText: string } | null {
  if (!p || !isEditSelectionTool(p.name)) return null;
  const input = p.input as { selectionId?: unknown; newText?: unknown } | null;
  if (!input || typeof input.selectionId !== "string" || typeof input.newText !== "string") return null;
  return { selectionId: input.selectionId, newText: input.newText };
}

/** 新会话的名字：侧栏「日常」里一眼认出它是哪篇文档的圈选对话。 */
export function cardSessionTitle(docTitle: string): string {
  return `知识库 · ${docTitle.trim() || "未命名文档"}`;
}

/** 这条会话还在吗：映射可能指向已被删除的会话（侧栏删了、别的端删了、磁盘被清）。
 *  依据是会话档案里的归属——卡片会话落盘时一定写了 wsPath（见 send 的 workspace）。
 *  还没定名（临时 id）说明刚发出、正在途中，当作还在。读不到（传输出错）也当作还在：
 *  宁可多续一次，也不因为一次读失败就把用户的对话映射丢了。 */
export async function cardSessionAlive(sid: string): Promise<boolean> {
  if (isPendingSession(sid)) return true;
  try {
    const ws = await api.sessionWorkspace(sid);
    return !!(ws?.wsPath || ws?.wsKey);
  } catch (e) {
    console.warn("[kb-card] 读不到会话档案，按「还在」处理", sid, e);
    return true;
  }
}

/** 已有会话的模型与档位：会话记下的优先，其次 sidecar 坐实的当前档位；读不到就不传。
 *  不传 = 不动——绝不能退成「默认值」，那会把用户在聊天里调高的档位悄悄压回去。 */
export async function pinnedSettings(
  sid: string,
  live: { model: string; effort: string },
): Promise<{ model?: string; effort?: string }> {
  const [model, effort] = await Promise.all([
    api.sessionModel(sid).catch(() => null),
    api.sessionEffort(sid).catch(() => null),
  ]);
  const m = model || live.model;
  const e = effort || live.effort;
  return { ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) };
}

export interface KbCardDoc {
  id: string;
  title: string;
}

export function useKbCardSession(doc: () => KbCardDoc) {
  const sid = computed<string | null>(() => sids.value[doc().id] ?? null);
  const chat = useChatSession(sid as Ref<string | null>);

  // 首发会话先拿到临时 id，SDK 用 session_init 确认真实 id 后换名：映射跟着换，
  // 否则下次打开这篇文档会去续一个不存在的临时会话。
  const off = chat.onSessionCreated((tempId, realId) => {
    for (const [docId, s] of Object.entries(sids.value)) {
      if (s === tempId) setMapping(docId, realId);
    }
  });
  onScopeDispose(off);

  const thread = computed(() => buildCardThread(chat.messages.value));
  const permission = computed(() => chat.pendingPermission.value);
  const editRequest = computed(() => editSelectionRequest(permission.value));
  const busy = computed(() => chat.isBusy.value);

  const sendError = ref<string | null>(null);

  /** 把这一批圈选 + 一句意见发给这篇文档的会话；没有会话就在日常里开一条。 */
  async function send(kbrefs: KbRef[], note: string): Promise<string | undefined> {
    sendError.value = null;
    const d = doc();
    let existing = sid.value;
    // 映射指向的会话已经没了：忘掉它，这一条按新会话开（归属落日常），别拿一个不存在的 id 去续。
    if (existing && !(await cardSessionAlive(existing))) {
      setMapping(d.id, null);
      existing = null;
    }
    let workspace: { wsKey: string; wsPath: string } | undefined;
    if (!existing) {
      // 新会话必须有归属：拿不到日常目录就不发——绝不静默落到「活动工作区」（跑错项目的来源）。
      if (!(await ensureDailyWorkspace())) {
        sendError.value = "这台 Host 上没有可用的日常目录，没法开启卡片对话";
        return undefined;
      }
      workspace = dailyWorkspaceBind() ?? undefined;
      if (!workspace) {
        sendError.value = "没有读到日常目录，没法开启卡片对话";
        return undefined;
      }
    }
    // 模型 / 档位：卡片没有选择器，所以**永远沿用会话自己的**——聊天里的「发送前确认」只在「用户
    // 选的与会话上次的不一样」时才有意义，这里没有「用户选的」，也就不该有悄悄的变更：已有会话
    // 取它记下的值（没记就取 sidecar 坐实的当前值，都没有就不传、由 sidecar 保持原样）；
    // 新会话取「日常」的快速档、模型走供应商默认。想换模型 / 档位，去聊天里打开这条会话换。
    const pinned = existing ? await pinnedSettings(existing, { model: chat.currentModel.value, effort: chat.currentEffort.value }) : { effort: "low" };
    return chat.sendMessage(note, {
      kbrefs,
      ...(pinned.model ? { initialModel: pinned.model } : {}),
      ...(pinned.effort ? { initialEffort: pinned.effort } : {}),
      ...(workspace ? { workspace } : {}),
      // 首发：临时 id 一分配就登记到文档名下并暂存标题——sidecar 的 session_title / session_init
      // 在 sendMessage 返回之前就可能到达，晚一步登记会让映射停在临时号上、标题被首条消息
      // 的展开文本（一大段圈选）抢占。
      onTempSession: (temp) => {
        setMapping(d.id, temp);
        useSessionNames().setPendingTitle(temp, cardSessionTitle(d.title));
      },
    });
  }

  async function respond(approved: boolean, reason?: string): Promise<void> {
    const p = permission.value;
    if (!p) return;
    await chat.respondPermission(p.id, approved, reason ? { reason } : {});
  }

  /** 忘掉这篇文档的会话映射（会话本身留在日常里）：下次圈选从头开一条。 */
  function forget(): void {
    setMapping(doc().id, null);
  }

  watch(
    () => doc().id,
    () => {
      sendError.value = null;
    },
  );

  return { sid, thread, permission, editRequest, busy, sendError, send, respond, forget };
}
