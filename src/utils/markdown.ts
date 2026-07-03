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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
