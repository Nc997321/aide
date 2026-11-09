import { useComposerDrafts, blankDraftKey } from "@aide/sdk/composables/useComposerDrafts";
import { isMediaFilePath } from "@aide/sdk/utils/mediaArtifacts";
import { usePaneLayout } from "../usePaneLayout";
import { findGroup, listGroups, viewSessionOf } from "../paneLayout/tree";
import { useMediaPreview } from "../useMediaPreview";
import { useRightPanel } from "../useRightPanel";
import { useBrowserHistory, type BrowserRecent, type BrowserRecordTarget, type CreationMode } from "./useBrowserHistory";
import { browserRecordTarget } from "./useBrowserHistory/target";

function focusedDraftKey(): string {
  const { layout } = usePaneLayout();
  const group = findGroup(layout.root, layout.focusedGroupId);
  if (!group) throw new Error("当前会话面板不可用，请先打开一个会话");
  const tab = group.tabs.find((item) => item.id === group.activeTabId);
  return viewSessionOf(tab ?? null) ?? blankDraftKey(tab?.id ?? `group:${group.id}`);
}

function revealConversation(): void {
  useRightPanel().setMaximized(false);
}

function activateTarget(target: BrowserRecordTarget): string {
  const panes = usePaneLayout();
  const key = useComposerDrafts().resolveDraftKey(target.key);
  if (target.kind === "session") {
    panes.openSession(key);
    return key;
  }
  for (const group of listGroups(panes.layout.root)) {
    for (const tab of group.tabs) {
      const draft = viewSessionOf(tab) ?? blankDraftKey(tab.id);
      if (useComposerDrafts().resolveDraftKey(draft) !== key) continue;
      panes.setActiveTab(group.id, tab.id);
      return key;
    }
    if (!group.tabs.length && blankDraftKey(`group:${group.id}`) === key) {
      panes.focusGroup(group.id);
      return key;
    }
  }
  throw new Error("原草稿已关闭，请从「打开媒体」重新选择文件，或打开原创作会话");
}

interface CreationContext { mode: CreationMode; brief: string; key: string }

function prepareCreation(input: { mode: CreationMode; brief: string }): void {
  const context = creationContext(input);
  appendCreationDraft(context);
  rememberCreation(context);
  revealConversation();
}

function creationContext(input: { mode: CreationMode; brief: string }): CreationContext {
  const brief = input.brief.trim();
  if (!brief) throw new Error("请先填写视频想法或剪辑要求");
  return { mode: input.mode, brief, key: focusedDraftKey() };
}

function appendCreationDraft(context: CreationContext): void {
  const draft = useComposerDrafts().draftOf(context.key);
  const instruction = context.mode === "create"
    ? "请帮我制作短视频，先与我确认分镜、画幅、时长和素材，再开始制作。"
    : "请帮我剪辑已有视频，先确认素材、剪辑范围、字幕和节奏，再开始修改。";
  draft.text = [draft.text, `${instruction}\n\n${context.brief}`].filter(Boolean).join("\n\n");
}

function rememberCreation(context: CreationContext): void {
  const title = context.brief.split("\n")[0]?.slice(0, 80) || "视频创作";
  useBrowserHistory().record({ kind: "creation", mode: context.mode, title, target: browserRecordTarget(context.key) });
}

async function openMedia(path: string): Promise<void> {
  if (!isMediaFilePath(path)) throw new Error("请选择支持的视频或音频文件");
  await previewMedia({ path, draftKey: focusedDraftKey() });
}

async function previewMedia(source: { path: string; draftKey: string }): Promise<void> {
  const title = source.path.split(/[\\/]/).pop() || source.path;
  await useMediaPreview().open({ files: [{ path: source.path, title }], selected: 0, draftKey: source.draftKey });
}

async function resume(entry: Exclude<BrowserRecent, { kind: "web" }>): Promise<void> {
  const draftKey = activateTarget(entry.target);
  if (entry.kind === "media") await previewMedia({ path: entry.path, draftKey });
  else {
    useBrowserHistory().restore({ ...entry, visitedAt: Date.now() });
    revealConversation();
  }
}

export function useBrowserStartActions() {
  return { prepareCreation, openMedia, resume };
}
