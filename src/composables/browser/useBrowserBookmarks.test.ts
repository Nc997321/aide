// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { useBrowserBookmarks, type Bookmark } from "./useBrowserBookmarks";

const bm = (id: string, title: string, url: string, folders: string[] = []): Bookmark => ({
  id,
  title,
  url,
  folders,
  added_at: 1,
});

describe("useBrowserBookmarks", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    // 模块级单例：清空列表，避免用例间串味。
    // 默认**按命令分派**：列表回空数组、图标回空表——图标回成数组的话下标访问照样是 undefined，
    // 一路静默成"所有图标都没有"，测试还全绿。
    tauri.invoke.mockImplementation(async (cmd: string) =>
      cmd === "browser_favicons" ? {} : [],
    );
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

  it("refresh 保留 Rust 给的目录路径（分组要用它，不能在传输层削掉）", async () => {
    const b = await loaded([bm("1", "A", "https://a.com/", ["工作", "漳蒲"])]);
    expect(b.bookmarks.value[0].folders).toEqual(["工作", "漳蒲"]);
  });

  it("refresh 顺带批量取图标，只问去重后的 URL 一次", async () => {
    // 图标按 URL 存在独立缓存里（`browser::favicons`）。同一条 URL 挂在两个目录下只该问一次。
    const b = useBrowserBookmarks();
    tauri.invoke
      .mockResolvedValueOnce([
        bm("1", "A", "https://a.com/", ["工具"]),
        bm("2", "A", "https://a.com/", ["娱乐"]),
        bm("3", "B", "https://b.com/"),
      ])
      .mockResolvedValueOnce({ "https://a.com/": "data:image/png;base64,AAA" });
    await b.refresh();

    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "browser_favicons", {
      urls: ["https://a.com/", "https://b.com/"],
    });
    expect(b.favicons.value["https://a.com/"]).toBe("data:image/png;base64,AAA");
  });

  it("查不到的图标是 undefined（调用点据此渲染默认地球图标）", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke
      .mockResolvedValueOnce([bm("1", "A", "https://a.com/")])
      .mockResolvedValueOnce({});
    await b.refresh();

    expect(b.favicons.value["https://a.com/"]).toBeUndefined();
    expect(b.favicons.value["https://never-asked.com/"]).toBeUndefined();
  });

  it("空收藏不发图标请求（别拿空数组去敲 IPC）", async () => {
    await loaded([]);
    const cmds = tauri.invoke.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain("browser_favicons");
  });

  it("importFromFile 回传如实报告（新增/补目录/图标/跳过/丢弃分开）", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke
      .mockResolvedValueOnce({ added: 2, adopted: 3, icons: 9, skipped: 1, invalid: 1 }) // import
      .mockResolvedValueOnce([]) // refresh: 列表
      .mockResolvedValueOnce({}); // refresh: 图标
    const report = await b.importFromFile("C:/x/bookmarks.html");
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "browser_bookmarks_import", {
      path: "C:/x/bookmarks.html",
    });
    expect(report).toEqual({ added: 2, adopted: 3, icons: 9, skipped: 1, invalid: 1 });
  });

  it("失败时把错误写进 error（面板据此显示真话，不静默）", async () => {
    const b = useBrowserBookmarks();
    tauri.invoke.mockRejectedValueOnce("读取文件失败：C:/x（not found）");
    await b.refresh();
    expect(b.error.value).toContain("读取文件失败");
  });
});
