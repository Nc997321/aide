import { Marked } from "marked";
import { hljs } from "./highlight";
import { parseFileLink } from "./fileLink";

export const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      if (lang && hljs.getLanguage(lang)) {
        const result = hljs.highlight(text, { language: lang });
        return `<pre><code class="hljs language-${lang}">${result.value}</code></pre>`;
      }
      const result = hljs.highlightAuto(text);
      return `<pre><code class="hljs">${result.value}</code></pre>`;
    },
    // 文件路径判定在渲染期完成：命中白名单的 inline code 打上 aide-file-link，
    // 点击/样式层只认这个标记，纯代码片段不再被渲染成可点的"文件"。
    codespan({ text }: { text: string }) {
      const cls = parseFileLink(text) ? ' class="aide-file-link"' : "";
      return `<code${cls}>${escapeHtml(text)}</code>`;
    },
  },
});

/** 已定稿文本块的渲染缓存：消息块一旦完成内容就不再变化，而 Vue 组件每次
 *  重渲染都会重新执行渲染函数——没有缓存的话，流式期间每个增量都会把整条
 *  消息里所有历史块的 Markdown 解析 + 代码高亮全部重跑一遍（O(n²) 卡死的
 *  根源之一）。命中缓存还让 v-html 拿到同一个字符串引用，Vue 直接跳过
 *  innerHTML 写入，旧块的 DOM 完全不动。 */
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 300;

export function renderMarkdown(text: string): string {
  const hit = renderCache.get(text);
  if (hit !== undefined) return hit;
  const html = marked.parse(text) as string;
  if (renderCache.size >= RENDER_CACHE_MAX) {
    // Map 按插入序迭代，删最老的一条即最简 LRU——够用，无需引依赖
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  renderCache.set(text, html);
  return html;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
