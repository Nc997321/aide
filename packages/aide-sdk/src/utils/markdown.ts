import { Marked, Renderer } from "marked";
import type { TokenizerAndRendererExtension, Tokens } from "marked";
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

/** 裸 HTML（块级 <div>/<script> 与行内 <b> 两类 token 都走这一个 renderer）：
 *  一律转义成可见原文，绝不交给浏览器解析。
 *
 *  marked 自 v5 起移除 sanitize，裸 HTML 是原样透传的——模型输出里一个
 *  `<img src=x onerror=...>` 会在 v-html 汇点上真的执行。本文件导出的
 *  marked / renderMarkdown / renderStreaming 是全仓 marked 派生 v-html 的唯一
 *  来源（ChatMessage / StreamingText / BtwDrawer / PermissionDialog / FileWindow /
 *  AutomationDetail / LSP hover / remote-pwa 两处），在渲染器层拦一道即全覆盖。
 *  选这里而不是 DOMPurify：解析期就决定，零额外 DOM 解析轮次——而 DOMPurify
 *  每次渲染都要重跑一遍 DOM 解析，正压在本文件刚从流式热路径上摘掉的 O(n²) 上。
 *
 *  代价（已知并接受）：模型偶尔吐的 `<details>`/`<br>` 这类合法 HTML 会显示成原文。
 *  知识库不走这里——它有自己的更严格实例（components/KnowledgeBase/markdown.ts）。 */
function escapedHtml({ text }: { text: string }): string {
  return escapeHtml(text);
}

/** 链接/图片 URL 白名单：只放行"明确安全"的前缀，其余一律降级成纯文本。
 *
 *  为什么是前缀白名单、不是协议黑名单：href 里的 `:` 能被实体编码（`&#58;`/
 *  `&colon;`）或插控制字符（`java\tscript:`）——浏览器解析属性时会先解码/剥离，
 *  于是 `[x](&#106;avascript:alert(1))` 在 DOM 里就是 `javascript:alert(1)`。
 *  任何"先取出协议再比对"的黑名单都有这条缝；前缀白名单 fail-closed，没有缝。
 *
 *  代价（已知并接受）：不带 `./` 的裸相对路径（`[x](docs/a.md)`）也会降级成纯文本。 */
const SAFE_URL_PREFIXES = ["#", "/", "./", "../", "https://", "http://", "mailto:"];

/** URL 命中白名单则原样返回，否则 null（调用方据此降级）。 */
function safeUrl(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  const lower = v.toLowerCase();
  return SAFE_URL_PREFIXES.some((prefix) => lower.startsWith(prefix)) ? v : null;
}

/** 默认渲染器实例：放行的 URL 一律委托给它——属性转义、alt 的预转义处理、
 *  xhtml 自闭合这些细节都在它的实现里，自造 markup 迟早与 marked 漂移。 */
const defaultRenderer = new Renderer();

/** 链接：URL 不在白名单 → 只留标签文本（内联格式照常渲染），不产生活链接。 */
function safeLink(this: Renderer, token: Tokens.Link): string {
  if (safeUrl(token.href) !== null) return defaultRenderer.link.call(this, token);
  return this.parser.parseInline(token.tokens);
}

/** 图片：URL 不在白名单 → 退化成 alt 文本。token.text 是未转义的原始文本，
 *  且这里落在文本位而非属性位，故转义 &<> 即可。 */
function safeImage(this: Renderer, token: Tokens.Image): string {
  if (safeUrl(token.href) !== null) return defaultRenderer.image.call(this, token);
  return escapeHtml(token.text);
}

/** ── 输出样式的 Insight 旁注块 ──
 *
 *  Claude Code 的 Explanatory / Learning 输出样式会让模型自绘一段旁注：
 *      ★ Insight ─────────────────────────
 *      …讲解（正文 + 列表）…
 *      ────────────────────────────────────
 *  它是**模型自由输出的文本，不是协议字段**：定界行可能裸写、可能被反引号包住、
 *  可能整体带 `>` 引用前缀，长短也不固定。所以识别必须宽容、落空必须能降级——
 *  宁可退回普通 markdown，也不能吃掉一个字（同 display 通道的降级约定）。
 *
 *  ⚠️ 连标签前的星号**都不固定**（2026-09-14 实锤：上一轮把截图文字手抄成 ★ 去
 *  探针，真身其实是 ✶ U+2736，于是"探针全绿、用户看到的仍是旧样子"）——按星形
 *  符号家族识别，见 INSIGHT_LABEL_RE。
 *
 *  为什么必须在这一层做：闭合的那行 `───` 紧跟最后一个列表项、中间没有空行，
 *  marked 会把它当成该 <li> 的续行吞掉——用户看到的是「最后一条 bullet 里挂着
 *  一条莫名其妙的横线」。块级扩展在 list tokenizer 之前整段吃掉，顺带把这个渲染
 *  bug 一并修掉。
 *
 *  ⚠️ 刻意**不定义 `start`**：marked 对 startBlock 的处理是每个块迭代都把剩余
 *  全文重新扫一遍（`e.slice(1)` + 逐个 start 取 min），定义它等于给全应用所有
 *  markdown 解析加一趟 O(n²) 扫描——本文件被这类扫描坑过不止一次。代价：开口行
 *  前必须有空行才成为块起点（实测的模型输出都满足）；没有空行时它早已被段落
 *  吞掉，结果是退化成普通 markdown，内容不丢。
 *  ⚠️ 同一条账也压在 tokenizer 自己身上：它同样每个块位置被调用一次，所以**存否
 *  判定只许碰首行**（`indexOf("\n")`，见 tokenizer 内注释）——否则省下的那趟
 *  O(n²) 会被自己原样补回来（实测过，152KB 文档差 10 倍）。
 *
 *  产出的 <aside> **不含任何视觉变体**（三套外观全交给 CSS，见 styles/global.css）：
 *  renderMarkdown 按原文缓存，变体一旦进 HTML 就会命中旧缓存、切换时穿帮。 */

/** 一行剥掉模型自绘的脚手架：行首空白、`>` 引用前缀、包裹的反引号。 */
function stripScaffold(line: string): string {
  return line
    .replace(/^[ \t]*>[ \t]?/, "")
    .trim()
    .replace(/^`+/, "")
    .replace(/`+$/, "")
    .trim();
}

/** 标签行：**星形符号家族**（1-3 枚连写）+ 字面量 `Insight`。
 *
 *  为什么不钉死一个码位：星号由模型自绘，实测同一会话里 ★(U+2605) 与 ✶(U+2736)
 *  混用且后者更多——钉死一个就是把另一形态静默降级（2026-09-14 的真实事故）。
 *  值域一律写成码位转义：这次事故的本质就是"两个星号肉眼几乎一样、码位不同"，
 *  字符类里摆裸字符等于把同一个坑再埋一次（谁也没法确认那个字到底是不是 273D）。
 *  收录：黑/白星 U+2605-2606 · 星号星 U+22C6 · 六/八芒星与星形装饰 U+2726-273D ·
 *  大星 U+2B50。
 *  刻意**不收 ASCII `*`**：那是 markdown 列表符，收进来会把 `* Insight 是什么`
 *  这类正文行误判成块起点，而误判会把后续行一路吃进 aside（见下方循环）。
 *  边界不放宽（引号/括号包住的 Insight 不算）由「行首即符号」这条兜着，
 *  负例见 markdown.test.ts。 */
const INSIGHT_LABEL_RE = /^[\u2605\u2606\u22c6\u2726-\u273d\u2b50]{1,3}[ \t]*Insight\b/i;

/** 开口行 → 同一行上剩下的正文字（可为空串 = 标签独占一行）；不是开口行返回 null。
 *  **必须把剩下的正文留下来**：模型有时把开头一整句直接跟在标签后面
 *  （`★ Insight ───── 这仓库的 CLAUDE.md…`），整行丢掉就是吞内容。 */
function insightOpenRest(line: string): string | null {
  const stripped = stripScaffold(line);
  const m = INSIGHT_LABEL_RE.exec(stripped);
  if (!m) return null;
  return stripped.slice(m[0].length).replace(/^[ \t]*─+[ \t]*/, "").trim();
}

/** 行尾的闭口横线：命中返回去掉它的文本，未命中返回 null。
 *  只认制表符 U+2500（模型自绘的就是它）——把 ASCII 连字符也算进来会误伤正文。 */
function stripClosingRule(text: string): string | null {
  const m = /[ \t]*─{3,}[ \t]*$/.exec(text);
  return m ? text.slice(0, m.index).trimEnd() : null;
}

/** 独占一行的闭口横线。 */
function isClosingRuleLine(line: string): boolean {
  return /^─{3,}$/.test(stripScaffold(line));
}

const insightExtension: TokenizerAndRendererExtension = {
  name: "aideInsight",
  level: "block",
  tokenizer(src: string): Tokens.Generic | undefined {
    // 存否判定**只看首行**：本函数被 marked 在**每一个块位置**用「剩余全文」调用一次
    // （块级扩展无 `start` 时就是这语义），在这里 `split` 全文 = 把本文件最忌讳的
    // O(n²) 请回来——2026-09-14 实测：152KB 文档 10.7ms → 107.2ms，纯段落文档
    // 段数每翻倍耗时 ×3-4。命中是极少数（一条消息通常 0-1 次），全文切分留到命中之后。
    const nl = src.indexOf("\n");
    const firstLine = nl === -1 ? src : src.slice(0, nl);
    const rest = insightOpenRest(firstLine);
    if (rest === null) return undefined;
    const lines = src.split("\n");

    // 整块写成引用（`> ★ Insight`）时，body 也剥掉一层 `>`，免得 <aside> 里再套一个
    // blockquote——引用层级由开口行决定，body 跟随。
    const quoted = /^[ \t]*>/.test(firstLine);
    const strip = (l: string) => (quoted ? l.replace(/^[ \t]*>[ \t]?/, "") : l);

    const body: string[] = [];
    let consumed = 1;

    // ① 开口行自带正文、且以横线收在同一行（整块压成一行）
    const inline = stripClosingRule(rest);
    if (inline !== null) {
      body.push(inline);
    } else {
      body.push(rest);
      // ② 逐行吃到收口为止。收口有两种写法：**独占一行**的横线，以及**行尾收在一句话
      //    后面**（`第二句。 ────`）——后者不能只认「整行是横线」，否则整块被判成未闭
      //    合、把后面的正文也吞进 aside。两种都没有（流式中途 / 模型漏画）→ 吃到末尾。
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        consumed = i + 1;
        // 判定用剥壳后的文本（容忍 `> ` 前缀与反引号包裹）；进 body 的用只剥引用前缀
        // 的那份，免得把行内的反引号当脚手架削掉。
        if (isClosingRuleLine(line)) break;
        const content = strip(line);
        const withoutRule = stripClosingRule(content);
        if (withoutRule !== null) {
          body.push(withoutRule);
          break;
        }
        body.push(content);
      }
    }

    return {
      type: "aideInsight",
      // marked 靠 raw.length 前进：拼回被消费的原始行（含闭口行，不含其后的换行）。
      raw: lines.slice(0, consumed).join("\n"),
      tokens: this.lexer.blockTokens(body.join("\n"), []),
    };
  },
  // 标签是固定字面量，body 走既有渲染管线（转义纪律不变），无新增 XSS 面。
  renderer(token: Tokens.Generic): string {
    return (
      '<aside class="aide-insight">' +
      '<span class="aide-insight-label">★ Insight</span>' +
      `<div class="aide-insight-body">${this.parser.parse(token.tokens ?? [])}</div>` +
      "</aside>"
    );
  },
};

function makeMarked(code: (token: CodeToken) => string): Marked {
  const instance = new Marked({ gfm: true, breaks: false });
  instance.use({
    renderer: { code, codespan, html: escapedHtml, link: safeLink, image: safeImage },
    extensions: [insightExtension],
  });
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
