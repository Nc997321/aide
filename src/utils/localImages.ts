// 回复里的本地图片：把 markdown 渲染器打了标记的 <img data-aide-src>（见
// @aide/sdk/utils/markdown 的 localImagePath）经 Host 读出字节、填上 blob URL。
//
// 走 read_file_binary 而不是 asset 协议：图在 Host 上（可能是 WSL / SSH），GUI 本机
// 不一定有这个文件；文件查看器看图也是这条路。

import { api } from "@aide/sdk/api";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";
import { imageMimeFromPath } from "./imageMime";

/** 同一路径短时间内只读一次：流式期间尾块每个增量都会重建 DOM、重新挂图。
 *  过期后重读——agent 常对同一个文件反复出图，新消息要看到新内容。 */
const FRESH_MS = 3000;
const MAX_ENTRIES = 64;

interface Entry {
  at: number;
  url: Promise<string>;
}
const cache = new Map<string, Entry>();

function revoke(entry: Entry): void {
  // 已经显示出来的 <img> 不受 revoke 影响（解码结果留在元素上）。
  entry.url.then((u) => URL.revokeObjectURL(u), () => {});
}

function load(path: string): Promise<string> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < FRESH_MS) return hit.url;
  if (hit) {
    cache.delete(path);
    revoke(hit);
  }
  const mime = imageMimeFromPath(path) ?? "application/octet-stream";
  const url = api
    .readFileBinary(path)
    .then((buf) => URL.createObjectURL(new Blob([buf], { type: mime })));
  const entry: Entry = { at: now, url };
  cache.set(path, entry);
  // 读失败不缓存：文件可能稍后才写出来
  url.catch(() => {
    if (cache.get(path) === entry) cache.delete(path);
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    revoke(cache.get(oldest)!);
    cache.delete(oldest);
  }
  return url;
}

/** 填 root 下尚未处理的本地图片。可重复调用（已处理的跳过），v-html 每次重建 DOM 后调一次。 */
export function hydrateLocalImages(root: HTMLElement | null, workspacePath?: string): void {
  if (!root) return;
  const imgs = root.querySelectorAll<HTMLImageElement>("img.aide-local-img:not([data-aide-state])");
  for (const img of imgs) {
    const raw = img.dataset.aideSrc;
    if (!raw) continue;
    img.dataset.aideState = "loading";
    const path = resolveFileLinkPath(raw, workspacePath);
    load(path).then(
      (url) => {
        img.src = url;
        img.dataset.aideState = "ok";
      },
      (e) => {
        img.dataset.aideState = "error";
        img.title = `图片读取失败：${path}\n${String(e)}`;
      },
    );
  }
}

/** 测试钩子 */
export function __resetLocalImageCacheForTest(): void {
  cache.clear();
}
