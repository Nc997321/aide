// @vitest-environment jsdom
// ↑ 必须：下面要 createElement / querySelectorAll。仓库既有的 per-file 覆盖约定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetIdFromSrc, createAssetLoader } from "./assetLoader";

describe("assetIdFromSrc", () => {
  it("剥出 asset:// 的 id", () => {
    expect(assetIdFromSrc("asset://abc")).toBe("abc");
    expect(assetIdFromSrc("asset://550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("非 asset:// 一律 null", () => {
    expect(assetIdFromSrc("https://e.com/a.png")).toBeNull();
    expect(assetIdFromSrc("blob:fake/0")).toBeNull();
    expect(assetIdFromSrc("")).toBeNull();
  });

  it("空 id 返回 null（`asset://` 本身没有意义）", () => {
    expect(assetIdFromSrc("asset://")).toBeNull();
  });
});

describe("createAssetLoader", () => {
  let created: string[];
  let revoked: string[];
  let seq: number;

  beforeEach(() => {
    created = [];
    revoked = [];
    seq = 0;
    // jsdom 不实现 createObjectURL/revokeObjectURL，必须打桩
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const u = `blob:fake/${seq++}`;
        created.push(u);
        return u;
      }),
      revokeObjectURL: vi.fn((u: string) => {
        revoked.push(u);
      }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function mount(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  function okBlob() {
    return vi.fn().mockResolvedValue(new Blob([new Uint8Array([1])]));
  }

  it("把 asset:// 换成 objectURL，alt 保留", async () => {
    const el = mount(
      '<img src="asset://a1" alt="图一"><img src="https://e.com/x.png" alt="外链">',
    );
    const loader = createAssetLoader(okBlob());

    await loader.load(el);

    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("blob:fake/0");
    expect(imgs[0].getAttribute("alt")).toBe("图一");
    // 外链不能被碰
    expect(imgs[1].getAttribute("src")).toBe("https://e.com/x.png");
  });

  it("取不到时保持原样 —— img 退化成 alt 文本，文档照常", async () => {
    const el = mount('<img src="asset://bad" alt="坏图">');
    const loader = createAssetLoader(vi.fn().mockRejectedValue(new Error("403")));

    await expect(loader.load(el)).resolves.toBeUndefined();

    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("asset://bad");
    expect(img.getAttribute("alt")).toBe("坏图");
    expect(created).toHaveLength(0);
  });

  it("一张失败不影响另一张", async () => {
    const el = mount('<img src="asset://a1"><img src="asset://a2">');
    const fetchAsset = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new Blob([new Uint8Array([2])]));
    const loader = createAssetLoader(fetchAsset);

    await loader.load(el);

    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("asset://a1");
    expect(imgs[1].getAttribute("src")).toBe("blob:fake/0");
  });

  it("dispose 回收所有已创建的 objectURL", async () => {
    const el = mount('<img src="asset://a1"><img src="asset://a2">');
    const loader = createAssetLoader(okBlob());

    await loader.load(el);
    expect(created).toHaveLength(2);

    loader.dispose();
    expect(revoked.sort()).toEqual([...created].sort());
  });

  it("dispose 可重复调用，不会重复 revoke", async () => {
    const el = mount('<img src="asset://a1">');
    const loader = createAssetLoader(okBlob());

    await loader.load(el);
    loader.dispose();
    loader.dispose();

    expect(revoked).toHaveLength(1);
  });

  it("容器里没有 asset:// 图片时什么都不做", async () => {
    const el = mount("<p>纯文本</p>");
    const fetchAsset = okBlob();
    const loader = createAssetLoader(fetchAsset);

    await loader.load(el);

    expect(fetchAsset).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});
