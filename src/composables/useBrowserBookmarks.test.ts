// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { useBrowserBookmarks, type Bookmark } from "./useBrowserBookmarks";

const bm = (id: string, title: string, url: string): Bookmark => ({
  id,
  title,
  url,
  added_at: 1,
});

describe("useBrowserBookmarks", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    // 模块级单例：清空列表，避免用例间串味。
    tauri.invoke.mockResolvedValue([]);
  });

  async function loaded(rows: Bookmark[]) {
    const b = useBrowserBookmarks();
    tauri.invoke.mockResolvedValueOnce(rows);
    await b.refresh();
    return b;
  }

  it("refresh 把 Rust 返回的列表装进单例状态", async () => {
    const b = await loaded([bm("1", "A", "https://a.com/")]);
    expect(b.bookmarks.value).toHaveLength(1);
    expect(tauri.invoke).toHaveBeenCalledWith("browser_bookmarks_list");
  });

  it("has/idOf 按「削末尾斜杠」对号：手打 https://a.com 与存储的 https://a.com/ 是同一条", async () => {
    const b = await loaded([bm("1", "A", "https://a.com/")]);
    expect(b.has("https://a.com")).toBe(true);
    expect(b.has("https://a.com/")).toBe(true);
    expect(b.idOf("https://a.com")).toBe("1");
    // 不同 URL 不得误判为已收藏（否则 ★ 会显示成实心但点了没反应）。
    expect(b.has("https://b.com/")).toBe(false);
    expect(b.has("")).toBe(false);
    expect(b.idOf("https://b.com/")).toBeNull();
  });

  it("add 转发 title/url 并刷新列表", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke
      .mockResolvedValueOnce(bm("9", "A", "https://a.com/")) // add
      .mockResolvedValueOnce([bm("9", "A", "https://a.com/")]); // refresh
    const saved = await b.add("A", "https://a.com");
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "browser_bookmarks_add", {
      title: "A",
      url: "https://a.com",
    });
    expect(saved.id).toBe("9");
    expect(b.has("https://a.com/")).toBe(true);
  });

  it("remove 转发 id 并刷新", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce([]);
    await b.remove("9");
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "browser_bookmarks_remove", { id: "9" });
    expect(b.bookmarks.value).toEqual([]);
  });

  it("importFromFile 回传如实报告（新增/跳过/丢弃分开）", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke
      .mockResolvedValueOnce({ added: 2, skipped: 1, invalid: 1 }) // import
      .mockResolvedValueOnce([]); // refresh
    const report = await b.importFromFile("C:/x/bookmarks.html");
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "browser_bookmarks_import", {
      path: "C:/x/bookmarks.html",
    });
    expect(report).toEqual({ added: 2, skipped: 1, invalid: 1 });
  });

  it("失败时把错误写进 error（面板据此显示真话，不静默）", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke.mockRejectedValueOnce("读取文件失败：C:/x（not found）");
    await b.refresh();
    expect(b.error.value).toContain("读取文件失败");
  });
});
