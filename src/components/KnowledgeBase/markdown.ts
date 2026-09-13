// 知识库的 Markdown 渲染：**默认拒绝**，不是"渲染完再消毒"。
//
// 背景：aide 现有的 v-html 渲染（ChatMessage / FileViewer / PermissionDialog）喂的是
// 模型输出与本盘文件，信任边界在这台机器之内；marked 的 code/codespan 渲染器已经
// 做了 escapeHtml（见 packages/aide-sdk/src/utils/markdown.ts:41,51），够用。
//
// 知识库不同：正文是**团队里任何人可写**的，还可能来自导入的 docx / pdf。
// marked 自 v5 起不再自带 sanitize，原始 HTML 块是透传的——
// 一个账号失守就能往全团队的页面里种脚本。
//
// 为什么不用 DOMPurify：
//   它是"默认允许、逐个剔除"的白名单模型，对知识库这种只需要标准 Markdown 的
//   场景是过度配置，还要为此多一个 20KB 依赖。这里改用**默认拒绝**——
//   覆盖 html renderer 把原始 HTML 转成纯文本，再给 URL 加协议白名单。
//   少一个依赖，且语义上更难出错：漏掉的是"少渲染一个标签"，不是"放进一个脚本"。
//
// ⚠️ 将来若要给 aide 全局收紧渲染，改这里一处即可，不要在各 v-html 点重复写。
import { Marked } from "marked";
import { escapeHtml } from "@aide/sdk/utils/markdown";

/** 允许的 URL 协议。其余（javascript: / data: / vbscript:）一律拒绝。 */
function safeUrl(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  // 相对路径、根路径、锚点
  if (/^[#/]/.test(v)) return v;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  return null;
}

/** 文档资源引用的协议前缀。由 kbClient.getAsset + objectURL 装载（spec §8.2）。 */
export const ASSET_SCHEME = "asset://";

/**
 * **图片专用**的 URL 判定。
 *
 * ⚠️ 刻意与 `safeUrl` 分开，不是重复代码：`safeUrl` 同时服务 `<a href>`，
 * 为了放行图片而改它就顺带改变了**链接**的协议策略 —— 那是另一个面，
 * 不该被这次改动牵连。（`data:` 就在这个区分上：作为 `<img src>` 危害有限，
 * 作为 `<a href>` 则是可点击的 `data:text/html`，是实实在在的 XSS 面。）
 */
function safeImageUrl(raw: string): string | null {
  const v = raw.trim();
  if (v.startsWith(ASSET_SCHEME)) {
    // 空 id 的 `asset://` 没有意义，当非法处理
    return v.length > ASSET_SCHEME.length ? v : null;
  }
  return safeUrl(v);
}

const kbMarked = new Marked({ gfm: true, breaks: false });

kbMarked.use({
  renderer: {
    /** 原始 HTML 块：转义成文本显示，绝不交给浏览器解析。 */
    html({ text }: { text: string }): string {
      return escapeHtml(text);
    },

    link({
      href,
      title,
      tokens,
    }: {
      href: string;
      title?: string | null;
      tokens: unknown[];
    }): string {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (this as any).parser.parseInline(tokens) as string;
      const url = safeUrl(href);
      // 协议不允许 → 退化成纯文本，而不是渲染一个危险的 <a>
      if (!url) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },

    image({
      href,
      title,
      text,
    }: {
      href: string;
      title?: string | null;
      text: string;
    }): string {
      const url = safeImageUrl(href);
      if (!url) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      // loading=lazy：一篇长文档里几十张图不该在打开瞬间全部拉。
      // ⚠️ 对 asset:// 它不生效（src 稍后会被 JS 换成 objectURL），见 spec §12 已知代价
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${t} loading="lazy" />`;
    },
  },
});

export function renderKbMarkdown(text: string): string {
  // 先走 SDK 的实例拿到缓存与 hljs 高亮，再用本文件的严格实例重渲染。
  // 两者不一致会造成"预览和正文长得不一样"，所以**只用**严格实例，
  // 缓存靠下面的 Map 自己维护（与 SDK 同款 LRU 思路，规模按文档数封顶）。
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = kbMarked.parse(text) as string;
  if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
  cache.set(text, html);
  return html;
}

// 文档正文一旦加载就不变，缓存按"文档正文"粒度命中率很高，
// 上限 200 篇足够（切换文档来回点不会重复解析）。
const cache = new Map<string, string>();

/** 供测试观察缓存规模。 */
export function __kbRenderCacheSize(): number {
  return cache.size;
}

// 这里**故意不**再导出 SDK 的 renderMarkdown：本模块只提供"默认拒绝"的渲染，
// 从"默认拒绝"的模块里顺手拿到未收紧的版本，是最容易被踩的坑（当前调用方只用
// renderKbMarkdown）。要通用渲染就走 @aide/sdk/utils/markdown，别从这里拿。
