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
  /** 目录路径，从外到内；空数组 = 根级散条（Rust `Bookmark::folders`）。分组见 `utils/browser.ts`。 */
  folders: string[];
  added_at: number;
}

/** 导入结果（Rust `ImportReportDto`）——如实展示，不笼统说"导入完成"。 */
export interface ImportReport {
  added: number;
  /** 同 URL 已在库里但没目录 → 原位补上目录的条数（"再导一次就自愈"的那批）。 */
  adopted: number;
  skipped: number;
  invalid: number;
  /** 真的写进图标缓存的条数（"图标进来没有"的可见信号）。 */
  icons: number;
}

/** 模块级单例状态：收藏条与（将来的）其它入口共用一份。 */
const bookmarks = ref<Bookmark[]>([]);

/**
 * `url → data URI` 的图标表（Rust `browser_favicons`）。
 *
 * **`| undefined` 是签名级的诚实**：查不到的 url 就是没有键——不是"空字符串"也不是"忘了取"。
 * 调用点（收藏条 / 下拉）据此渲染默认图标。
 */
const favicons = ref<Record<string, string | undefined>>({});

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
      await refreshFavicons();
      error.value = "";
    } catch (e) {
      error.value = typeof e === "string" ? e : String(e);
    }
  }

  /**
   * 拉一次图标表。**去重后批量问**：同一条 URL 可能挂在多个目录下（图标按 URL 存，只该问一次），
   * 空收藏干脆不发请求。
   *
   * 图标**不进书签列表**是刻意的：那是几十 KB 的 base64，塞进每次列表返回里都要跟着走一遍 IPC
   * （见 Rust `browser::favicons` 模块头）。
   */
  async function refreshFavicons(): Promise<void> {
    const urls = [...new Set(bookmarks.value.map((b) => b.url))];
    favicons.value = urls.length
      ? await invoke<Record<string, string>>("browser_favicons", { urls })
      : {};
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

  // `favicons` 直接出表而不是包成 `faviconOf(url)`：两个消费方（收藏条、文件夹下拉）都要按 url 查，
  // 下拉那边要的是**表本身**（当 prop 传下去）；包一层只会多一个消费方还得再拆开。
  return { bookmarks, favicons, error, refresh, add, remove, importFromFile, has, idOf };
}
