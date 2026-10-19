import { reactive } from "vue";
import type { ImageAttachment } from "./useChatSession";

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

export interface ComposerDraft {
  text: string;
  images: Array<ImageAttachment & { previewUrl: string }>;
  mentions: ComposerMention[];
}

const drafts = reactive<Record<string, ComposerDraft>>({});

const emptyDraft = (): ComposerDraft => ({ text: "", images: [], mentions: [] });

function isEmpty(d: ComposerDraft | undefined): boolean {
  return !d || (!d.text && d.images.length === 0 && d.mentions.length === 0);
}

/** 空白标签（还没有会话）的草稿键。 */
export function blankDraftKey(id: string): string {
  return `blank:${id}`;
}

/** 取（必要时建）某个 key 的草稿。返回的是响应式对象本身：直接改字段即可。 */
function draftOf(key: string): ComposerDraft {
  // 注意别写成 `return (drafts[key] ??= emptyDraft())`：那返回的是**原始**对象，改它不触发更新
  if (!drafts[key]) drafts[key] = emptyDraft();
  return drafts[key];
}

/** 搬迁：from 的草稿归 to。to 已有内容时不覆盖（谁也不丢——只在 to 为空时搬）。 */
function migrateDraft(from: string, to: string): void {
  if (from === to) return;
  const src = drafts[from];
  if (!src) return;
  if (isEmpty(drafts[to])) drafts[to] = src;
  delete drafts[from];
}

function clearDraft(key: string): void {
  delete drafts[key];
}

export function useComposerDrafts() {
  return { draftOf, migrateDraft, clearDraft };
}

/** 测试钩子 */
export function __resetComposerDraftsForTest(): void {
  for (const k of Object.keys(drafts)) delete drafts[k];
}
