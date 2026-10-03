// 「圈中什么改什么」的权威来源：用户在知识库文档里圈选的范围。
//
// 为什么放在 sidecar 而不是信任 agent 的工具参数：范围必须是**用户**定的，agent 只能决定
// 「替换成什么」。所以范围经由用户消息的 `display`（kbref 块，发送方构造、sidecar 原样回灌的
// 那条通道）进来，登记在这里；edit_selection 只收选区 id + 新文本，起止位置从这里取。
// agent 在参数里写什么范围都不作数——它连「范围」这个参数都没有。
//
// 生命周期：**按最新一条用户消息**。每来一条用户消息整表替换——不带圈选的消息把表清空，
// 于是「本轮没圈选」与「本轮圈了这些」永远只有一种真相，不会残留上一轮的授权。
import type { UserMessageBlock } from "../../engine/types.js";

export interface KbScope {
  /** 客户端在一条消息内铸的短 id（如 "s1"），agent 在 edit_selection 里引用它。 */
  id: string;
  documentId: string;
  title: string;
  /** 选中那一刻的文档版本；仅用于提示文案，校验靠 `text` 与偏移（版本变了但这段没变是允许的）。 */
  baseVersion: number;
  /** 正文里的 UTF-16 偏移，[start, end)。与客户端同为 JS 字符串偏移。 */
  start: number;
  end: number;
  /** 选中的原文，恒等于 content.slice(start, end)——写入前据此校验「这段还在原位」。 */
  text: string;
  /** 用户写的意见（可空），仅用于默认的变更说明。 */
  comment: string;
}

/** 单条消息最多登记的选区数、单个选区的原文上限（字符）。越界的块整个丢弃，不截断——
 *  截断会让 text 与偏移对不上，等于伪造范围。 */
export const MAX_KB_SCOPES = 8;
/** 单条消息最多登记的关联工作区数（与 engine 附加根的 8 个上限同量级）。 */
export const MAX_LINKED_ROOTS = 8;
export const MAX_KB_SCOPE_TEXT = 20_000;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** display 里的 kbref 块 → 合法选区；形状不对的返回 null（display 来自客户端，不可信）。 */
export function parseScope(raw: unknown): KbScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (b.type !== "kbref") return null;
  const { selectionId, documentId, title, baseVersion, start, end, text, comment } = b;
  if (typeof selectionId !== "string" || !selectionId) return null;
  if (typeof documentId !== "string" || !documentId) return null;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_KB_SCOPE_TEXT) return null;
  if (!isInt(start) || !isInt(end) || end <= start) return null;
  // 偏移与原文必须自洽，否则这条「范围」自相矛盾——宁可不登记。
  if (text.length !== end - start) return null;
  return {
    id: selectionId,
    documentId,
    title: typeof title === "string" ? title : "",
    baseVersion: isInt(baseVersion) ? baseVersion : 0,
    start,
    end,
    text,
    comment: typeof comment === "string" ? comment : "",
  };
}

/** kbref 块里的 `linked`（关联工作区根目录）→ 干净的字符串数组；形状不对的丢弃。
 *  display 来自客户端，不可信：这里只做形状清洗，是否真是已注册工作区由 read_memory 读不读得到记忆目录兜底。 */
export function parseLinked(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const linked = (raw as Record<string, unknown>).linked;
  if (!Array.isArray(linked)) return [];
  return linked.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

export class KbScopeStore {
  private scopes = new Map<string, KbScope>();
  private linked: string[] = [];

  /** 一条用户消息到达：整表替换。没有 kbref 就是清空（圈选范围与关联项目都随最新一条消息走，
   *  不残留上一轮的授权）。 */
  replaceFromDisplay(display: readonly UserMessageBlock[] | undefined): void {
    this.scopes.clear();
    const linked = new Set<string>();
    for (const block of display ?? []) {
      if (this.scopes.size >= MAX_KB_SCOPES) break;
      const scope = parseScope(block);
      if (scope && !this.scopes.has(scope.id)) {
        this.scopes.set(scope.id, scope);
        for (const dir of parseLinked(block)) linked.add(dir);
      }
    }
    this.linked = [...linked].slice(0, MAX_LINKED_ROOTS);
  }

  /** 本轮可参考记忆的关联工作区（read_memory 的授权根之一）。 */
  linkedRoots(): string[] {
    return [...this.linked];
  }

  get(id: string): KbScope | undefined {
    return this.scopes.get(id);
  }

  list(): KbScope[] {
    return [...this.scopes.values()];
  }

  /** 本轮是否被圈选范围约束（有 = 除 edit_selection 外一律不许写知识库）。 */
  get active(): boolean {
    return this.scopes.size > 0;
  }

  /** 改成功后把范围移到新位置：同一轮里对同一选区再改一次（用户追问「再短点」）仍然合法，
   *  且范围始终只覆盖这次改出来的那段。 */
  moveTo(id: string, scope: Pick<KbScope, "start" | "end" | "text" | "baseVersion">): void {
    const cur = this.scopes.get(id);
    if (cur) this.scopes.set(id, { ...cur, ...scope });
  }
}

export type SelectionEdit =
  | { ok: true; body: string; start: number; end: number }
  | { ok: false; reason: "stale" };

/**
 * 范围替换（纯函数）：只动 [start, end)，前后两段原样拼回。
 *
 * 「不会改到其它内容」在这里是**构造性**成立的：新正文 = 原文前缀 + 新文本 + 原文后缀，
 * 前缀与后缀是同一份字符串的切片，没有任何一个字符经过 agent 之手。唯一的风险是
 * 「范围已经不指向用户圈的那段」（文档在圈选之后被改过），所以先校验原位再拼。
 */
export function applySelectionEdit(
  content: string,
  scope: Pick<KbScope, "start" | "end" | "text">,
  newText: string,
): SelectionEdit {
  if (content.slice(scope.start, scope.end) !== scope.text) return { ok: false, reason: "stale" };
  return {
    ok: true,
    body: content.slice(0, scope.start) + newText + content.slice(scope.end),
    start: scope.start,
    end: scope.start + newText.length,
  };
}
