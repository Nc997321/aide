import { api } from "../api";
import { normalizeBrowserUrl } from "../utils/browser";
import { errorText } from "../utils/errors";
import { useNotifications } from "./useNotifications";
import { useRightPanel } from "./useRightPanel";

/**
 * 本地 HTML 文件 → 在**内置浏览器**（右栏浏览器 tab）里新开一页打开，而不是交给系统默认浏览器。
 *
 * 跨界显式：内置浏览器跑在本机，Host 窗口里的路径先经 `file_gui_path` 翻译（WSL → `\\wsl.localhost\…`，
 * SSH 如实拒绝，同「用本机程序打开」）。失败出声（通知），不能是「点了没反应」。
 * 路径转 `file://` 由 `normalizeBrowserUrl` 统一做（盘符 / UNC / POSIX 都认）。
 */
export async function openHtmlInBuiltinBrowser(path: string): Promise<void> {
  try {
    const local = await api.fileGuiPath(path);
    useRightPanel().openInBrowser(normalizeBrowserUrl(local));
  } catch (e) {
    useNotifications().push({
      severity: "error",
      source: "fileviewer",
      title: "内置浏览器打开失败",
      body: `${path}: ${errorText(e)}`,
      timestamp: Date.now(),
      dedupKey: `fileviewer:open-html:${path}`,
    });
  }
}
