// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileBinary = vi.fn();
vi.mock("@aide/sdk/api", () => ({ api: { readFileBinary: (p: string) => readFileBinary(p) } }));

import { hydrateLocalImages, __resetLocalImageCacheForTest } from "./localImages";
import { renderMarkdown } from "@aide/sdk/utils/markdown";

const flush = () => new Promise((r) => setTimeout(r, 0));

function mount(md: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = renderMarkdown(md);
  return el;
}

describe("hydrateLocalImages", () => {
  beforeEach(() => {
    __resetLocalImageCacheForTest();
    readFileBinary.mockReset();
    let n = 0;
    globalThis.URL.createObjectURL = vi.fn(() => `blob:test-${++n}`);
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it("相对路径按工作区根解析，经 Host 读字节后填 blob URL", async () => {
    readFileBinary.mockResolvedValue(new ArrayBuffer(4));
    const el = mount("![图](out/chart.png)");
    hydrateLocalImages(el, "/home/u/proj");
    await flush();
    const img = el.querySelector("img")!;
    expect(readFileBinary).toHaveBeenCalledWith("/home/u/proj/out/chart.png");
    expect(img.getAttribute("src")).toBe("blob:test-1");
    expect(img.dataset.aideState).toBe("ok");
  });

  it("重复调用不重复读；短时间内同一路径只读一次", async () => {
    readFileBinary.mockResolvedValue(new ArrayBuffer(4));
    const a = mount("![a](/x/a.png)");
    hydrateLocalImages(a);
    hydrateLocalImages(a);
    const b = mount("![a](/x/a.png)"); // 流式重建 DOM
    hydrateLocalImages(b);
    await flush();
    expect(readFileBinary).toHaveBeenCalledTimes(1);
    expect(b.querySelector("img")!.getAttribute("src")).toBe("blob:test-1");
  });

  it("读失败：标 error、title 写明原因，不缓存失败", async () => {
    readFileBinary.mockRejectedValueOnce("Failed to read file: not found");
    const el = mount("![a](/x/missing.png)");
    hydrateLocalImages(el);
    await flush();
    const img = el.querySelector("img")!;
    expect(img.dataset.aideState).toBe("error");
    expect(img.title).toContain("/x/missing.png");
    readFileBinary.mockResolvedValue(new ArrayBuffer(1));
    hydrateLocalImages(mount("![a](/x/missing.png)"));
    expect(readFileBinary).toHaveBeenCalledTimes(2);
  });
});
