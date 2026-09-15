// 内嵌浏览器书签（收藏夹）：IPC 封装 + 模块级列表状态（与 useKnowledgeBase/useMarketplace 同范式）。
//
// 桌面壳专属能力（书签落 `~/.aide/browser/bookmarks.json`，remote-pwa/ohos 无对应语义），与
// useEmbeddedBrowser 同类——已在 scripts/check-tauri-imports.mjs 登记门面例外。
//
// 真相在 Rust：去重键、`url_guard` 守门、归一化都在 `browser/bookmarks`。这里只持有"面板要显示的那份
// 列表"，不复制任何规则。
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  added_at: number;
}

/** 导入结果（Rust `ImportReportDto`）——如实展示，不笼统说"导入完成"。 */
export interface ImportReport {
  added: number;
  skipped: number;
  invalid: number;
}

/** 模块级单例状态：收藏条与（将来的）其它入口共用一份。 */
const bookmarks = ref<Bookmark[]>([]);
const error = ref("");

/**
 * 比较用的宽松归一：只削掉末尾斜杠。
 *
 * **不复制 URL 规则**——真正的去重/归一在 Rust（`url_guard` + url crate）。这里仅用于把 ★ 的
 * 选中态和收藏条对上号：用户手打 `https://a.com` 与存储里的 `https://a.com/` 是同一条。
 */
function looseKey(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function useBrowserBookmarks() {
  async function refresh(): Promise<void> {
    try {
      bookmarks.value = await invoke<Bookmark[]>("browser_bookmarks_list");
      error.value = "";
    } catch (e) {
      error.value = typeof e === "string" ? e : String(e);
    }
  }

  /** 加一条（幂等：同 URL 返回既有那条）。返回落库后的条目（url 是归一化形态）。 */
  async function add(title: string, url: string): Promise<Bookmark> {
    const saved = await invoke<Bookmark>("browser_bookmarks_add", { title, url });
    await refresh();
    return saved;
  }

  async function remove(id: string): Promise<void> {
    await invoke<boolean>("browser_bookmarks_remove", { id });
    await refresh();
  }

  /** 从文件导入（路径由应用内文件选择器给出）。返回如实报告。 */
  async function importFromFile(path: string): Promise<ImportReport> {
    const report = await invoke<ImportReport>("browser_bookmarks_import", { path });
    await refresh();
    return report;
  }

  /** 当前 URL 是否已收藏（宽松比较，见 `looseKey`）。 */
  function has(url: string): boolean {
    if (!url) return false;
    const key = looseKey(url);
    return bookmarks.value.some((b) => looseKey(b.url) === key);
  }

  /** 取已收藏那条的 id（取消收藏用）。 */
  function idOf(url: string): string | null {
    const key = looseKey(url);
    return bookmarks.value.find((b) => looseKey(b.url) === key)?.id ?? null;
  }

  return { bookmarks, error, refresh, add, remove, importFromFile, has, idOf };
}
