import { computed, ref } from "vue";
import { api } from "../api";
import { useFileViewer } from "./useFileViewer";
import { isHtmlFilePath, isHttpUrl, resolveFileLinkPath } from "../utils/fileLink";
import { useRightPanel } from "./useRightPanel";
import { openHtmlInBuiltinBrowser } from "./useOpenHtml";
import { isMediaFilePath } from "@aide/sdk/utils/mediaArtifacts";
import { useMediaPreview } from "./useMediaPreview";
import { useNotifications } from "./useNotifications";

interface FileOpenContext { draftKey: () => string }
interface FileTarget { path: string; line?: number; flashCount?: number }
interface FileLookup { rawPath: string; workspacePath?: string }

const resolving = ref(false);
const resolvingName = ref("");
const candidates = ref<string[]>([]);
const pendingTarget = ref<FileTarget | null>(null);

function basenameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

async function locate(path: string, lookup: FileLookup): Promise<string[]> {
  try {
    if (await api.fileExists(path)) return [path];
  } catch (error) {
    console.warn("文件路径探测失败，继续工作区搜索", error);
  }
  if (!lookup.workspacePath) return [];
  resolving.value = true;
  resolvingName.value = basenameOf(lookup.rawPath);
  try {
    return await api.findFilesByName(lookup.rawPath, lookup.workspacePath, 50);
  } catch (error) {
    console.warn("工作区文件搜索失败，将由查看器报告原路径", error);
    return [];
  } finally {
    resolving.value = false;
  }
}

function reportOpenError(error: unknown): void {
  useNotifications().push({
    severity: "error", source: "fileviewer", title: "文件打开失败", body: String(error),
    timestamp: Date.now(), dedupKey: "fileviewer:open-error",
  });
}

export function useFileResolver(context?: FileOpenContext) {
  const viewer = useFileViewer();
  const { openInBrowser } = useRightPanel();
  const mediaPreview = useMediaPreview();

  async function openTarget(target: FileTarget): Promise<void> {
    try {
      if (isHttpUrl(target.path)) { openInBrowser(target.path); return; }
      if (isHtmlFilePath(target.path)) { await openHtmlInBuiltinBrowser(target.path); return; }
      if (isMediaFilePath(target.path)) { await openMedia(target.path); return; }
      if (target.line !== undefined) await viewer.openAndScrollTo(target.path, target.line, target.flashCount);
      else await viewer.open(target.path);
    } catch (error) {
      reportOpenError(error);
    }
  }

  async function openMedia(path: string): Promise<void> {
    const draftKey = context?.draftKey();
    if (!draftKey) throw new Error("媒体预览缺少原会话，请先打开一个会话再试");
    await mediaPreview.open({ files: [{ path, title: basenameOf(path) }], selected: 0, draftKey });
  }

  function openMatches(matches: string[], target: FileTarget): Promise<void> {
    if (matches.length <= 1) return openTarget({ ...target, path: matches[0] ?? target.path });
    pendingTarget.value = target;
    candidates.value = matches;
    return Promise.resolve();
  }

  async function openResolved(rawPath: string, workspacePath: string | undefined, line?: number, flashCount?: number): Promise<void> {
    const target = { path: resolveFileLinkPath(rawPath, workspacePath), line, flashCount };
    if (isHttpUrl(target.path) || isMediaFilePath(target.path)) return openTarget(target);
    const matches = await locate(target.path, { rawPath, workspacePath });
    return openMatches(matches, target);
  }

  function pickCandidate(path: string): void {
    const target = pendingTarget.value;
    candidates.value = [];
    pendingTarget.value = null;
    void openTarget({ path, line: target?.line, flashCount: target?.flashCount });
  }

  function cancelPicker(): void {
    candidates.value = [];
    pendingTarget.value = null;
  }

  return {
    resolving: computed(() => resolving.value), resolvingName: computed(() => resolvingName.value),
    candidates: computed(() => candidates.value), pickerVisible: computed(() => candidates.value.length > 0),
    openResolved, pickCandidate, cancelPicker,
  };
}
