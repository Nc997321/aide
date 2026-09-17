import { describe, it, expect } from "vitest";
import {
  buildBookmarkBar,
  flattenFolderMenu,
  formatImportReport,
  normalizeBrowserUrl,
  tabLabelOf,
  urlOfNav,
  navOfEvent,
  type BookmarkEntry,
} from "./browser";
import type { NavEventDto } from "../composables/useEmbeddedBrowser";
import type { Bookmark } from "../composables/useBrowserBookmarks";

describe("normalizeBrowserUrl", () => {
  it("裸域名补 https", () => {
    expect(normalizeBrowserUrl("bing.com")).toBe("https://bing.com");
    expect(normalizeBrowserUrl("  example.com/a?b=1  ")).toBe("https://example.com/a?b=1");
  });

  it("带 scheme 的原样（scheme 白名单在 Rust url_guard，前端不复制规则）", () => {
    expect(normalizeBrowserUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeBrowserUrl("file:///C:/x.html")).toBe("file:///C:/x.html");
  });
});

describe("urlOfNav", () => {
  it("idle 没有 URL", () => {
    expect(urlOfNav({ state: "idle" })).toBe("");
    expect(urlOfNav(null)).toBe("");
  });

  it("loading/ready 取 url 字段", () => {
    expect(urlOfNav({ state: "loading", url: "https://a.com/" })).toBe("https://a.com/");
    expect(urlOfNav({ state: "ready", url: "https://a.com/", title: "A" })).toBe("https://a.com/");
  });
});

describe("tabLabelOf", () => {
  it("空标签显示「新标签页」", () => {
    expect(tabLabelOf("")).toBe("新标签页");
  });

  it("v1 用主机名（真标题要 webview2-com 的 DocumentTitleChanged）", () => {
    expect(tabLabelOf("https://www.bing.com/search?q=x")).toBe("www.bing.com");
    expect(tabLabelOf("http://localhost:5173/")).toBe("localhost:5173");
  });

  it("畸形输入原样显示，不猜也不编", () => {
    expect(tabLabelOf("not a url")).toBe("not a url");
  });
});

// ── 收藏条分组（把 Rust 给的 folders 路径还原成树） ──

/** 一条收藏（只填分组关心的字段）。 */
function bm(id: string, folders: string[] = []): Bookmark {
  return { id, title: id.toUpperCase(), url: `https://${id}.com/`, folders, added_at: 1 };
}

/**
 * 收藏条压成紧凑文本，如 `根级 工具/[a b 漳蒲/[z]]`——一眼看层级**与顺序**。
 * 顺序也断言的理由：目录挂在「它第一条书签」的位置，才能跟浏览器导出时的先后对上；
 * 全量 `toEqual` 一棵树写起来噪声太大，看不出这一点。
 */
function shape(entries: BookmarkEntry[]): string {
  return entries
    .map((e) => (e.kind === "folder" ? `${e.folder.name}/[${shape(e.folder.entries)}]` : e.id))
    .join(" ");
}

/** 从收藏条里取出某个目录（测试用；找不到就是测试自己写错了，直接抛）。 */
function folderAt(entries: BookmarkEntry[], name: string) {
  const hit = entries.find((e) => e.kind === "folder" && e.folder.name === name);
  if (!hit || hit.kind !== "folder") throw new Error(`测试数据里没有目录 ${name}`);
  return hit.folder;
}

describe("buildBookmarkBar", () => {
  it("空库给空条（不凭空造目录）", () => {
    expect(buildBookmarkBar([])).toEqual([]);
  });

  it("根级条目平铺、目录条目归到各自的文件夹", () => {
    const bar = buildBookmarkBar([bm("root"), bm("a", ["工具"]), bm("b", ["工具"])]);
    expect(shape(bar)).toBe("root 工具/[a b]");
  });

  it("目录挂在其**第一条书签**的位置——不是全排到末尾（要跟导出时的先后一致）", () => {
    const bar = buildBookmarkBar([bm("a"), bm("x", ["组"]), bm("b")]);
    expect(shape(bar)).toBe("a 组/[x] b");
  });

  it("多层目录逐段还原，且子目录夹在父层条目中间也保序", () => {
    // 真机形状：工作 → [中科台达, 农业数字化, 漳蒲 → [福建省…]]。
    const bar = buildBookmarkBar([
      bm("w1", ["工作"]),
      bm("w2", ["工作"]),
      bm("z1", ["工作", "漳蒲"]),
    ]);
    expect(shape(bar)).toBe("工作/[w1 w2 漳蒲/[z1]]");
  });

  it("父层没有直接书签也能建出来（中间层不丢）", () => {
    expect(shape(buildBookmarkBar([bm("z", ["工作", "漳蒲"])]))).toBe("工作/[漳蒲/[z]]");
  });

  it("同名目录在不同父下**不合并**（按完整路径分层）", () => {
    const bar = buildBookmarkBar([bm("x", ["A", "共同"]), bm("y", ["B", "共同"])]);
    expect(shape(bar)).toBe("A/[共同/[x]] B/[共同/[y]]");
  });

  it("根级书签没有 folders 字段时按根级处理（不炸）", () => {
    // v1 老数据 / 未来某个调用点漏给字段时的容错：只要求不抛，按根级显示。
    const bar = buildBookmarkBar([{ ...bm("a"), folders: [] }]);
    expect(shape(bar)).toBe("a");
  });
});

describe("flattenFolderMenu", () => {
  it("目录自己的书签 depth 0", () => {
    const bar = buildBookmarkBar([bm("a", ["工具"]), bm("b", ["工具"])]);
    expect(flattenFolderMenu(folderAt(bar, "工具"))).toEqual([
      { kind: "link", depth: 0, label: "A", url: "https://a.com/" },
      { kind: "link", depth: 0, label: "B", url: "https://b.com/" },
    ]);
  });

  it("子目录出标题行、其内容缩进一层，且保持原序", () => {
    const bar = buildBookmarkBar([
      bm("w1", ["工作"]),
      bm("z1", ["工作", "漳蒲"]),
      bm("w2", ["工作"]),
    ]);
    expect(flattenFolderMenu(folderAt(bar, "工作"))).toEqual([
      { kind: "link", depth: 0, label: "W1", url: "https://w1.com/" },
      { kind: "folder", depth: 0, label: "漳蒲" },
      { kind: "link", depth: 1, label: "Z1", url: "https://z1.com/" },
      { kind: "link", depth: 0, label: "W2", url: "https://w2.com/" },
    ]);
  });

  it("空目录给空菜单（不产出幽灵行）", () => {
    expect(flattenFolderMenu({ path: ["空"], name: "空", entries: [] })).toEqual([]);
  });
});

describe("formatImportReport", () => {
  it("五类如实报出（顺序：导入 → 补目录 → 图标 → 跳过 → 丢弃）", () => {
    expect(
      formatImportReport({ added: 12, adopted: 30, icons: 73, skipped: 3, invalid: 1 }),
    ).toBe("导入 12 条，补目录 30 条，图标 73 条，跳过 3 条重复，丢弃 1 条非法");
  });

  it("没补目录 / 没进图标就不提那两项（每行挂个 0 条是噪声）", () => {
    expect(
      formatImportReport({ added: 12, adopted: 0, icons: 0, skipped: 3, invalid: 1 }),
    ).toBe("导入 12 条，跳过 3 条重复，丢弃 1 条非法");
  });

  it("图标条数单独可见——它是「图标进来没有」的唯一信号", () => {
    // 复现现场：书签全跳过了、目录也早补过，只剩这一项能说明问题。
    expect(
      formatImportReport({ added: 0, adopted: 0, icons: 73, skipped: 78, invalid: 0 }),
    ).toBe("导入 0 条，图标 73 条，跳过 78 条重复，丢弃 0 条非法");
  });

  it("全 0 也给一句真话（不是「导入完成」）", () => {
    expect(
      formatImportReport({ added: 0, adopted: 0, icons: 0, skipped: 0, invalid: 0 }),
    ).toBe("导入 0 条，跳过 0 条重复，丢弃 0 条非法");
  });
});

describe("navOfEvent", () => {
  // 事件是 Rust `#[serde(flatten)]` 的拍平形态：state 与 id/can_go_* 同级。
  // 形状契约由 Rust 侧 dto_test 钉住，这里验前端按判别式还原。
  it("loading 事件还原为 loading 状态", () => {
    const e = {
      id: "browser-1",
      state: "loading",
      url: "https://a.com/",
      can_go_back: false,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "loading", url: "https://a.com/" });
  });

  it("ready 事件带标题字段", () => {
    const e = {
      id: "browser-1",
      state: "ready",
      url: "https://a.com/",
      title: "",
      can_go_back: true,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "ready", url: "https://a.com/", title: "" });
  });

  it("failed 事件带原因", () => {
    const e = {
      id: "browser-1",
      state: "failed",
      url: "https://a.com/",
      reason: "net::ERR",
      can_go_back: false,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "failed", url: "https://a.com/", reason: "net::ERR" });
  });

  it("idle 事件无负载", () => {
    const e = {
      id: "browser-1",
      state: "idle",
      can_go_back: false,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "idle" });
  });
});
