/**
 * 把文档正文里 `asset://<uuid>` 的图片装上真实字节。
 *
 * 为什么要绕 objectURL 这一圈：资源端点要 Bearer 鉴权，而 `<img src>` **发不出**
 * `Authorization` 头（浏览器发起的图片请求不经过我们的 fetch）。所以要 JS 去取。
 *
 * 为什么不在渲染器里直接把 src 换成签名 URL：渲染器是纯函数且有 LRU 缓存，
 * 签名会过期 → 缓存命中时显示破图；而且带凭据的 URL 会进访问日志。
 * 两条理由都写在 design spec §8.2。
 */
import { ASSET_SCHEME } from "./markdown";

/** `asset://<id>` → `<id>`；不是资源引用则 null。 */
export function assetIdFromSrc(src: string): string | null {
  if (!src.startsWith(ASSET_SCHEME)) return null;
  const id = src.slice(ASSET_SCHEME.length);
  return id === "" ? null : id;
}

export interface AssetLoader {
  /** 装载容器内所有 `asset://` 图片。**失败的不抛错** —— 退化成 alt 文本。 */
  load(container: ParentNode): Promise<void>;
  /** 回收本次装载创建的所有 objectURL。可重复调用。 */
  dispose(): void;
}

export function createAssetLoader(fetchAsset: (id: string) => Promise<Blob>): AssetLoader {
  let urls: string[] = [];

  return {
    async load(container) {
      const targets = Array.from(container.querySelectorAll("img"))
        .map((img) => ({ img, id: assetIdFromSrc(img.getAttribute("src") ?? "") }))
        .filter((t): t is { img: HTMLImageElement; id: string } => t.id !== null);

      await Promise.all(
        targets.map(async ({ img, id }) => {
          try {
            const blob = await fetchAsset(id);
            const url = URL.createObjectURL(blob);
            urls.push(url);
            img.setAttribute("src", url);
          } catch {
            // 取不到就保持原样：img 显示它自己的 alt 文本，整篇文档照常渲染。
            // 「整条消息不能消失」是仓库既有的降级约定（CLAUDE.md）。
          }
        }),
      );
    },

    dispose() {
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [];
    },
  };
}
