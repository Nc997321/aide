import { Marked } from "marked";
import { hljs } from "./highlight";
import { parseFileLink } from "./fileLink";

/** 未标语言的围栏走 highlightAuto 会把文本用全部注册语言(12 种)各跑一遍再挑
 *  最优——大块时是首次挂载卡顿的放大器,超阈值直接转义纯文本。标了语言的
 *  单语言高亮便宜得多,给一个宽松上限兜底极端体积。 */
const AUTO_HIGHLIGHT_MAX_CHARS = 10_000;
const LABELED_HIGHLIGHT_MAX_CHARS = 100_000;

type CodeToken = { text: string; lang?: string };

/** 定稿块的 code 渲染器：按语言/体积决定高亮策略（见上）。 */
function highlightedCode({ text, lang }: CodeToken): string {
  if (lang && hljs.getLanguage(lang)) {
    if (text.length > LABELED_HIGHLIGHT_MAX_CHARS) {
      return `<pre><code class="hljs language-${lang}">${escapeHtml(text)}</code></pre>`;
    }
    const result = hljs.highlight(text, { language: lang });
    return `<pre><code class="hljs language-${lang}">${result.value}</code></pre>`;
  }
  if (text.length > AUTO_HIGHLIGHT_MAX_CHARS) {
    return `<pre><code class="hljs">${escapeHtml(text)}</code></pre>`;
  }
  const result = hljs.highlightAuto(text);
  return `<pre><code class="hljs">${result.value}</code></pre>`;
}

/** 流式尾块的 code 渲染器：一律转义纯文本，绝不跑 hljs。
 *
 *  流式尾块每个增量都对整块全文重跑 marked.parse，而 hljs 对「成长中的大代码
 *  围栏」反复整体高亮是 O(n²) 卡死放大器：实测 30KB 围栏 300 增量累积 6.5s、
 *  60KB 12.4s、90KB 17.2s，而同体积纯文本仅 0.7s——差距全在 hljs。语法高亮
 *  没有理由在每个增量都重算，延到消息定稿：定稿块走 renderMarkdown 一次性
 *  高亮并缓存（highlightedCode）。类名与定稿态保持一致，定稿时只是补上颜色
 *  span，不重排版。 */
function plainCode({ text, lang }: CodeToken): string {
  const cls = lang ? `hljs language-${lang}` : "hljs";
  return `<pre><code class="${cls}">${escapeHtml(text)}</code></pre>`;
}

/** 文件路径判定在渲染期完成：命中白名单的 inline code 打上 aide-file-link，
 *  点击/样式层只认这个标记，纯代码片段不再被渲染成可点的"文件"。两个实例共用。 */
function codespan({ text }: { text: string }): string {
  const cls = parseFileLink(text) ? ' class="aide-file-link"' : "";
  return `<code${cls}>${escapeHtml(text)}</code>`;
}

function makeMarked(code: (token: CodeToken) => string): Marked {
  const instance = new Marked({ gfm: true, breaks: false });
  instance.use({ renderer: { code, codespan } });
  return instance;
}

/** 高亮实例：定稿正文（renderMarkdown）、文件 .md 预览、plan 预览都用它。 */
export const marked = makeMarked(highlightedCode);
/** 非高亮实例：只服务流式尾块，剥掉 hljs 放大器。 */
const markedStreaming = makeMarked(plainCode);

/** 已定稿文本块的渲染缓存：消息块一旦完成内容就不再变化，而 Vue 组件每次
 *  重渲染都会重新执行渲染函数——没有缓存的话，流式期间每个增量都会把整条
 *  消息里所有历史块的 Markdown 解析 + 代码高亮全部重跑一遍（O(n²) 卡死的
 *  根源之一）。命中缓存还让 v-html 拿到同一个字符串引用，Vue 直接跳过
 *  innerHTML 写入，旧块的 DOM 完全不动。 */
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 300;
/** 单条缓存上限（P2-2）：文本超此字符数不入缓存。cap 300 条只挡了条数，单条无上限时
 *  一条 MB 级文本的 HTML 能常驻数十 MB（文本 512KB UTF-16 + HTML 数倍）；超阈直接
 *  parse 不缓存——大块本就少见，每次重渲染多付一次解析换内存有界（数据层另有 P0-3
 *  降级在 store 超阈值后收敛大 block，这里是渲染缓存层的独立有界性）。 */
const RENDER_CACHE_MAX_TEXT_CHARS = 256 * 1024;
/** 缓存总字节上限（2026-08-28）：条数+单条双上限仍留有 300×256K≈75MB 的最坏驻留
 *  （freeze-1787901573714 渲染进程 1.08GB GC 螺旋的放大器之一）。键值都是 UTF-16
 *  字符串，按 (text.length+html.length)×2 记账，超限按插入序淘汰到限内。 */
const RENDER_CACHE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
let renderCacheBytes = 0;

/** 测试钩子：当前缓存条目数（P2-2 验证「超限不入缓存」用）。
 *  注意不能用「重复渲染引用相同」断言——marked.parse 本身对相同输入返回同引用。 */
export function __renderCacheSizeForTest(): number {
  return renderCache.size;
}
/** 测试钩子：当前缓存记账字节（总字节 LRU 验证用）。 */
export function __renderCacheBytesForTest(): number {
  return renderCacheBytes;
}

export function renderMarkdown(text: string): string {
  // 超阈大文本不入缓存（见 RENDER_CACHE_MAX_TEXT_CHARS 注释）
  if (text.length > RENDER_CACHE_MAX_TEXT_CHARS) {
    return marked.parse(text) as string;
  }
  const hit = renderCache.get(text);
  if (hit !== undefined) return hit;
  const html = marked.parse(text) as string;
  // Map 按插入序迭代，删最老的即最简 LRU——够用，无需引依赖。
  // 淘汰条件：条数上限 或 总字节上限（哪个先到算哪个）。
  const entryBytes = (text.length + html.length) * 2;
  while (
    renderCache.size >= RENDER_CACHE_MAX ||
    renderCacheBytes + entryBytes > RENDER_CACHE_MAX_TOTAL_BYTES
  ) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break; // 空缓存仍超（单条本身就超总上限）→ 放行本条，下条再淘
    const oldestHtml = renderCache.get(oldest)!; // 键来自 keys() 迭代，必存在
    renderCacheBytes -= (oldest.length + oldestHtml.length) * 2;
    renderCache.delete(oldest);
  }
  renderCache.set(text, html);
  renderCacheBytes += entryBytes;
  return html;
}

/** 流式尾块专用：结构（标题/列表/加粗/段落）照常实时渲染，唯独代码围栏
 *  不高亮——避免每个增量重跑 hljs 的 O(n²) 放大。块定稿后 ChatMessage 切回
 *  renderMarkdown，此时才补上语法高亮（一次，并缓存）。不进 renderCache：
 *  每个增量文本都不同，塞进去只会污染缓存键。 */
export function renderStreaming(text: string): string {
  return markedStreaming.parse(text) as string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
