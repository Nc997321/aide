import { mediaApi, type MediaOpenRequest } from "@aide/sdk/api/media";
import { useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";
import type { MediaRef } from "@aide/sdk/types/chat";
import type { MediaArtifact } from "@aide/sdk/utils/mediaArtifacts";
import { useBrowserHistory } from "./browser/useBrowserHistory";
import { browserRecordTarget } from "./browser/useBrowserHistory/target";

export interface OpenMediaOptions {
  files: MediaArtifact[];
  selected: number;
  draftKey: string;
  expectedRevision?: string;
}

const THEME_TOKENS = [
  "--aide-bg-deep", "--aide-bg-base", "--aide-bg-raised", "--aide-surface-default",
  "--aide-surface-hover", "--aide-surface-active", "--aide-text-primary",
  "--aide-text-secondary", "--aide-text-muted", "--aide-border", "--aide-border-strong",
  "--aide-accent", "--aide-accent-subtle", "--aide-danger", "--aide-warning", "--aide-success",
] as const;

function currentTheme(): Record<string, string> {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return {};
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()])
    .filter(([, value]) => Boolean(value)));
}

async function openRequest(request: MediaOpenRequest): Promise<void> {
  const drafts = useComposerDrafts();
  request.target.draftKey = drafts.resolveDraftKey(request.target.draftKey);
  drafts.draftOf(request.target.draftKey);
  await mediaApi.open(request);
  const file = request.files[request.selected];
  if (file) useBrowserHistory().record({
    kind: "media", path: file.path, title: file.title || file.path,
    target: browserRecordTarget(request.target.draftKey),
  });
}

async function open(options: OpenMediaOptions): Promise<void> {
  if (!options.files.length || !Number.isInteger(options.selected)
    || options.selected < 0 || options.selected >= options.files.length) return;
  await openRequest({
    files: options.files,
    selected: options.selected,
    target: { draftKey: options.draftKey, ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}) },
    theme: currentTheme(),
  });
}

async function openReference(request: { ref: MediaRef; draftKey: string }): Promise<void> {
  await openRequest({
    files: [{ path: request.ref.source.path, title: request.ref.source.title }], selected: 0,
    target: { draftKey: request.draftKey, expectedRevision: request.ref.source.revision, selection: request.ref.selection },
    theme: currentTheme(),
  });
}

export function useMediaPreview() {
  return { open, openReference };
}
