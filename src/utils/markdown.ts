import { Marked } from "marked";
import { hljs } from "./highlight";

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
  },
});

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
