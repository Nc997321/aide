import { computed, ref } from "vue";
import { api } from "../api";
import { useFileViewer } from "./useFileViewer";
import { isHtmlFilePath, isHttpUrl, resolveFileLinkPath } from "../utils/fileLink";
import { useRightPanel } from "./useRightPanel";
import { openHtmlInBuiltinBrowser } from "./useOpenHtml";

/**
 * 聊天文件链接的「智能打开」状态层。
 *
 * 聊天里的路径经常不全（相对某个子目录、或只给文件名），直接拼到工作区根下会
 * 打不开。这里在打开前先探测：命中就直接开；不存在则在工作区内按名搜索
 * （带加载态），0 命中退回原路径让 FileViewer 报"不存在"，1 命中直接开，
 * 多命中交给选择浮层由用户挑。状态做成模块级单例——搜索/选择浮层全局只有一个。
 */

const resolving = ref(false);
const resolvingName = ref("");
const candidates = ref<string[]>([]);
const pendingLine = ref<number | undefined>(undefined);

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

export function useFileResolver() {
  const viewer = useFileViewer();
  const { openInBrowser } = useRightPanel();

  function doOpen(path: string, line?: number, flashCount?: number) {
    // 网页链接与本地 HTML 都在内置浏览器里开（不再交给系统默认浏览器）。
    if (isHttpUrl(path)) {
      openInBrowser(path);
      return;
    }
    if (isHtmlFilePath(path)) {
      void openHtmlInBuiltinBrowser(path);
      return;
    }
    if (line !== undefined) void viewer.openAndScrollTo(path, line, flashCount);
    else void viewer.open(path);
  }

  async function openResolved(rawPath: string, workspacePath: string | undefined, line?: number, flashCount?: number) {
    const full = resolveFileLinkPath(rawPath, workspacePath);

    // 纯网页 URL 不需要 fs 探测/工作区搜索，直接在内置浏览器打开。
    if (isHttpUrl(full)) {
      doOpen(full, line, flashCount);
      return;
    }

    // 1. 直接命中 → 原有行为
    try {
      if (await api.fileExists(full)) {
        doOpen(full, line, flashCount);
        return;
      }
    } catch {
      /* 探测失败也走搜索兜底 */
    }

    // 2. 不存在 → 工作区内按名搜索（无工作区根可搜时退回原路径）
    if (!workspacePath) {
      doOpen(full, line, flashCount);
      return;
    }
    resolving.value = true;
    resolvingName.value = basenameOf(rawPath);
    let matches: string[] = [];
    try {
      matches = await api.findFilesByName(rawPath, workspacePath, 50);
    } catch {
      matches = [];
    }
    resolving.value = false;

    if (matches.length === 0) {
      doOpen(full, line, flashCount); // 交给 FileViewer 显示"文件不存在"
    } else if (matches.length === 1) {
      doOpen(matches[0], line, flashCount);
    } else {
      pendingLine.value = line;
      candidates.value = matches;
    }
  }

  function pickCandidate(path: string) {
    const line = pendingLine.value;
    candidates.value = [];
    pendingLine.value = undefined;
    doOpen(path, line);
  }

  function cancelPicker() {
    candidates.value = [];
    pendingLine.value = undefined;
  }

  return {
    resolving: computed(() => resolving.value),
    resolvingName: computed(() => resolvingName.value),
    candidates: computed(() => candidates.value),
    pickerVisible: computed(() => candidates.value.length > 0),
    openResolved,
    pickCandidate,
    cancelPicker,
  };
}
