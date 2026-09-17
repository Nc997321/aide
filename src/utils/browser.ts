// 内嵌浏览器面板的纯逻辑（无 DOM、无 IPC）：URL 归一、标签标题、事件载荷还原、收藏条分组。
//
// 抽出来的理由与其它 utils 一致：组件只留接线，判定规则可单测（`browser.test.ts`）。
import type { NavEventDto, NavStateDto } from "../composables/useEmbeddedBrowser";
import type { Bookmark, ImportReport } from "../composables/useBrowserBookmarks";

/**
 * 地址栏输入归一：裸域名补 `https://`（UX 便利）；带 scheme 的原样交给后端 `url_guard` 守门
 * —— scheme 白名单在 Rust 侧是唯一真相，前端不复制一份（否则两处规则会漂移）。
 */
export function normalizeBrowserUrl(raw: string): string {
  const t = raw.trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`;
}

/** 从导航状态里取当前 URL（`idle` 没有 URL）。 */
export function urlOfNav(nav: NavStateDto | null): string {
  return nav && "url" in nav ? nav.url : "";
}

/**
 * 标签页标题。
 *
 * v1 用**主机名**：真标题要 WebView2 `DocumentTitleChanged`（下一批 webview2-com），当前
 * tauri/wry 都没有暴露取标题的接口（已核实）——所以这里不编造标题，只展示 URL 里真实存在的部分。
 */
export function tabLabelOf(url: string): string {
  if (!url) return "新标签页";
  try {
    return new URL(url).host || url;
  } catch {
    return url; // 未归一/畸形输入：原样显示，不猜
  }
}

/**
 * 事件载荷 → 纯导航状态。事件是 `{id, can_go_*, ...NavStateDto}` 的**拍平**形态（Rust
 * `#[serde(flatten)]`），这里按 `state` 判别式还原成判别联合——显式分支，不用 rest 解构，
 * 免掉类型断言（形状契约由 Rust 侧 `nav_event_serializes_flat_for_frontend` 钉住）。
 */
export function navOfEvent(e: NavEventDto): NavStateDto {
  switch (e.state) {
    case "idle":
      return { state: "idle" };
    case "loading":
      return { state: "loading", url: e.url };
    case "ready":
      return { state: "ready", url: e.url, title: e.title };
    case "failed":
      return { state: "failed", url: e.url, reason: e.reason };
  }
}

// ── 收藏条分组 ────────────────────────────────────────────────────────────
//
// Rust 侧只存「一条 URL + 标题 + 目录路径」，**没有目录树实体**（`bookmarks/mod.rs`：不搞带 id 的
// 目录——重命名/拖拽都还没需求，目录树只会带来孤儿节点和级联删除）。分组是纯展示问题，所以在这一层
// 把路径还原成树；好处是它没有 DOM、没有 IPC，可以直接单测。

/** 收藏条上的一项：文件夹（点开下拉）或书签（点了导航）。 */
export type BookmarkEntry =
  | { kind: "folder"; folder: BookmarkFolder }
  | { kind: "link"; id: string; title: string; url: string };

/** 一层目录。`entries` 按导出时的原序**混排**文件夹与书签。 */
export interface BookmarkFolder {
  /** 路径分段，从外到内（顶层 = `[name]`）。既区分不同父下的重名目录，也当查找用的键。 */
  path: string[];
  name: string;
  entries: BookmarkEntry[];
}

/**
 * 扁平收藏列表 → 收藏条（根层条目，按原序混排文件夹与根级散条）。
 *
 * 目录的挂载位置 = **它第一条书签在列表里的位置**，不是"统一排到后面"——浏览器导出时目录与书签是
 * 交错的，全排末尾会让栏上的顺序跟用户的印象对不上。
 */
export function buildBookmarkBar(bookmarks: Bookmark[]): BookmarkEntry[] {
  const bar: BookmarkEntry[] = [];
  const byPath = new Map<string, BookmarkFolder>();

  /** 取（或建）某层目录。建的同时挂进父层——挂载点即此刻的父层末尾，也就是第一条书签的位置。 */
  function ensureFolder(path: string[]): BookmarkFolder {
    const key = path.join("/");
    const existing = byPath.get(key);
    if (existing) return existing;

    const folder: BookmarkFolder = { path, name: path[path.length - 1], entries: [] };
    byPath.set(key, folder);
    // 父层可能还没建（中间层自己没有书签）→ 递归先建出来，层次不能断。
    const siblings = path.length === 1 ? bar : ensureFolder(path.slice(0, -1)).entries;
    siblings.push({ kind: "folder", folder });
    return folder;
  }

  for (const b of bookmarks) {
    const link: BookmarkEntry = { kind: "link", id: b.id, title: b.title, url: b.url };
    if (b.folders.length === 0) bar.push(link);
    else ensureFolder(b.folders).entries.push(link);
  }
  return bar;
}

/** 下拉菜单的一行。`depth` 用于缩进——子目录的内容比它的标题行深一层。 */
export type FolderMenuRow =
  | { kind: "folder"; depth: number; label: string }
  | { kind: "link"; depth: number; label: string; url: string };

/**
 * 导入结果 → 一句真话。
 *
 * **只报真实发生的**：没补目录 / 没进图标就不提那一项（每行都挂个「补目录 0 条」是噪声）。
 * 顺序固定为 导入 → 补目录 → 图标 → 跳过 → 丢弃，方便按位置读。
 *
 * 「图标 N 条」是**排障用的那一句**：没有它，UI 上分不清"文件没带图标"和"带了但没存进去"
 * （2026-09-17 那次"导入后全是地球图标"就卡在这儿）。
 */
export function formatImportReport(r: ImportReport): string {
  const parts = [`导入 ${r.added} 条`];
  if (r.adopted > 0) parts.push(`补目录 ${r.adopted} 条`);
  if (r.icons > 0) parts.push(`图标 ${r.icons} 条`);
  parts.push(`跳过 ${r.skipped} 条重复`, `丢弃 ${r.invalid} 条非法`);
  return parts.join("，");
}

/** 一层目录 → 菜单行（深度优先、保持原序）。子目录自身出一行标题，其内容缩进后继续展开。 */
export function flattenFolderMenu(folder: BookmarkFolder): FolderMenuRow[] {
  const rows: FolderMenuRow[] = [];

  function walk(entries: BookmarkEntry[], depth: number) {
    for (const entry of entries) {
      if (entry.kind === "folder") {
        rows.push({ kind: "folder", depth, label: entry.folder.name });
        walk(entry.folder.entries, depth + 1);
      } else {
        rows.push({ kind: "link", depth, label: entry.title, url: entry.url });
      }
    }
  }

  walk(folder.entries, 0);
  return rows;
}
