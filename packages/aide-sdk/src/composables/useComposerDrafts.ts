import { reactive } from "vue";
import type { ImageAttachment } from "./useChatSession";
import type { MediaRef } from "../types/chat";

/**
 * 输入框草稿——**按会话自持**（2026-10-19）。
 *
 * 以前草稿挂在输入框组件实例上，而一个分屏组只有一个输入框、组里所有标签共用它：
 * 切会话时文字跟着串到别的会话，图片 / 引用芯片则被清掉。现在草稿是会话的属性，
 * 与 provider 绑定 / 工作区归属 / 附加目录同一套纪律：
 * - key = 会话 id；还没有会话的空白标签用调用方给的空白键（`blank:` 前缀，见 blankDraftKey）。
 * - 定名（tempId → realId）随 finalizeSession 搬迁；空白标签发出首条消息拿到 tempId 时由输入框搬过去。
 * - 关 tab / 删会话随 disposeSession 收口。
 *
 * 只在内存里：重启不保留（落盘要另议——图片 base64 可能很大）。
 */
export interface ComposerMention {
  path: string;
  isDir: boolean;
  range?: { start: number; end: number };
}

export interface ComposerMediaRef {
  ref: MediaRef;
  frame?: ImageAttachment & { previewUrl: string };
}

export interface ComposerDraft {
  text: string;
  images: Array<ImageAttachment & { previewUrl: string }>;
  mentions: ComposerMention[];
  /** Media ref and its optional frame are one removable / sendable draft unit. */
  mediaRefs: ComposerMediaRef[];
}

const drafts = reactive<Record<string, ComposerDraft>>({});
const draftAliases = new Map<string, string>();

function resolveDraftKey(key: string): string {
  const seen = new Set<string>();
  let current = key;
  while (!seen.has(current)) {
    const next = draftAliases.get(current);
    if (next === undefined) break;
    seen.add(current);
    current = next;
  }
  return current;
}

const emptyDraft = (): ComposerDraft => ({ text: "", images: [], mentions: [], mediaRefs: [] });

function isEmpty(d: ComposerDraft | undefined): boolean {
  return !d || (!d.text && d.images.length === 0 && d.mentions.length === 0 && d.mediaRefs.length === 0);
}

/** 空白标签（还没有会话）的草稿键。 */
export function blankDraftKey(id: string): string {
  return `blank:${id}`;
}

/** 取（必要时建）某个 key 的草稿。返回的是响应式对象本身：直接改字段即可。 */
function draftOf(key: string): ComposerDraft {
  const resolved = resolveDraftKey(key);
  // 从 reactive 容器读回代理对象，不返回刚创建的原始对象。
  if (!drafts[resolved]) drafts[resolved] = emptyDraft();
  return drafts[resolved];
}

/** Read an existing draft without creating one; useful for asynchronous event ingress. */
function existingDraftOf(key: string): ComposerDraft | undefined {
  return drafts[resolveDraftKey(key)];
}

/** 搬迁：from 的草稿归 to。to 已有内容时不覆盖（谁也不丢——只在 to 为空时搬）。 */
function migrateDraft(from: string, to: string): void {
  const source = resolveDraftKey(from);
  const target = resolveDraftKey(to);
  if (source === target) return;
  const src = drafts[source];
  if (!src) return;
  const destination = drafts[target];
  if (isEmpty(destination)) drafts[target] = src;
  else if (destination) mergeDrafts({ from: src, into: destination });
  delete drafts[source];
  draftAliases.set(source, target);
  draftAliases.set(from, target);
}

function mergeDrafts(pair: { from: ComposerDraft; into: ComposerDraft }): void {
  const { from, into } = pair;
  if (from.text && from.text !== into.text) into.text = [from.text, into.text].filter(Boolean).join("\n\n");
  into.images.push(...from.images.filter((item) => !into.images.includes(item)));
  into.mentions.push(...from.mentions.filter((item) => !into.mentions.includes(item)));
  into.mediaRefs.push(...from.mediaRefs.filter((item) => !into.mediaRefs.includes(item)));
}

function clearDraft(key: string): void {
  const target = resolveDraftKey(key);
  const aliases = [...draftAliases.keys()].filter((alias) => resolveDraftKey(alias) === target);
  delete drafts[target];
  for (const alias of aliases) draftAliases.delete(alias);
}

export function useComposerDrafts() {
  return { draftOf, existingDraftOf, resolveDraftKey, migrateDraft, clearDraft };
}

/** 测试钩子 */
export function __resetComposerDraftsForTest(): void {
  for (const k of Object.keys(drafts)) delete drafts[k];
  draftAliases.clear();
}
