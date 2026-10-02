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
import { hljs } from "@aide/sdk/utils/highlight";

/**
 * **属性位置**的转义。SDK 的 `escapeHtml` 只转 `& < >`，写进文本节点够用，写进
 * `href="…"` / `alt="…"` 就不够了：值里一个 `"` 就能收掉属性、后面接 `onerror=`——
 * 文档正文团队可写，那是对所有读者客户端的存储型 XSS（2026-10-02 实测复现）。
 * 凡是要进属性的值，一律走这个；文本位置继续用 escapeHtml。
 */
function escapeAttr(v: string): string {
  return escapeHtml(v).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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

/**
 * 原始 HTML 的**标签白名单**：只放行"排版语义"标签，且一律**丢弃全部属性**。
 *
 * 为什么要放行：导入的文档（Mintlify 一类文档站导出的 md）里到处是
 * `<h2 id="x"> 标题 </h2>`，全转义的话就把标签源码原样摆在正文里。
 * 为什么安全：只出标签名、不带任何属性 → 没有事件属性、style、href、src 可注入；
 * 白名单之外（script/iframe/img/a/style/不认识的标签……）与标签之间的文字仍然整段转义。
 * `id` 也一并丢掉：它会和应用自身 DOM 的 id 撞车（DOM clobbering），而文档内锚点
 * 本来就因为链接 target=_blank 用不上。
 */
const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "b", "strong", "i", "em", "u", "s", "del", "sub", "sup", "kbd", "mark",
  "ul", "ol", "li", "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
]);
const VOID_TAGS = new Set(["br", "hr"]);

/**
 * 文档站组件标签（Mintlify 等）。**只认这张具体的名单，不按"首字母大写"猜**：
 * `Vec<T>` 里的 `<T>` 同样是大写开头，猜规则会把泛型吞掉。名单外一律照旧转义显示。
 *  - callout：渲染成提示块（kind 只决定配色，类名全是本文件写死的，不取自文档）；
 *  - container：标签本身对读者没有意义，丢掉、保留里面的内容；有 title 的把标题留成一行粗体
 *    （否则「安装」「配置」这些小标题会凭空消失）。title 转义后只作纯文本。
 */
const CALLOUT_KINDS: Record<string, "note" | "tip" | "warn"> = {
  note: "note", info: "note",
  tip: "tip", check: "tip",
  warning: "warn", caution: "warn", danger: "warn",
};
const CONTAINER_TAGS = new Set([
  "steps", "step", "tabs", "tab", "card", "cardgroup", "accordion", "accordiongroup",
  "frame", "columns", "column", "div", "span",
]);
const isComponentTag = (name: string) => name in CALLOUT_KINDS || CONTAINER_TAGS.has(name);

// 标签 `<name ...>` / `</name>` / `<name/>`；属性段不含 `<` `>`，所以 `<a title=">">` 这类
// 取巧写法落不进来，而是被当成普通文字转义。
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?(\/?)>/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TITLE_RE = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** 当前这次 parse 里还没闭合的提示块（记元素名 div/span，闭合要对得上）。parse 同步，模块级即可。 */
let openCallouts: string[] = [];

function sanitizeHtml(raw: string, block: boolean): string {
  // HTML 注释对读者没有意义，静默丢弃（以前会把 `<!-- ... -->` 当文字摆出来）
  const text = raw.replace(COMMENT_RE, "");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase();
    const closing = m[1] === "/";
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (name in CALLOUT_KINDS) {
      if (closing) {
        // 没有对应开标签的孤立闭标签：丢掉，别输出一个会误伤外层的 </div>
        const el = openCallouts.pop();
        if (el) out += `</${el}>`;
      } else if (m[4] === "/" || /\/\s*$/.test(m[3] ?? "")) {
        continue; // 自闭合 <Note />：没有内容，不开外框
      } else {
        // 行内（<Note>x</Note> 写在一行里）用 span：块级元素塞进 <p> 会被浏览器截断出空段落
        const el = block ? "div" : "span";
        openCallouts.push(el);
        out += `<${el} class="kb-callout kb-callout-${CALLOUT_KINDS[name]}">`;
      }
    } else if (CONTAINER_TAGS.has(name)) {
      if (closing) continue;
      const t = TITLE_RE.exec(m[3] ?? "");
      const title = (t?.[1] ?? t?.[2] ?? "").trim();
      if (title) out += block ? `<p><strong>${escapeHtml(title)}</strong></p>` : `<strong>${escapeHtml(title)}</strong> `;
    } else if (!ALLOWED_TAGS.has(name)) {
      out += escapeHtml(m[0]);
    } else if (VOID_TAGS.has(name)) {
      out += `<${name}>`;
    } else {
      out += closing ? `</${name}>` : `<${name}>`;
    }
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * 解析前处理：给**独占一行**的组件标签前后补空行。
 *
 * CommonMark 的 HTML 块会一直吃到下一个空行——`<Note>\n  带 `代码` 的正文\n</Note>` 整段
 * 都落进同一个 html 块，正文就成了不渲染的原文。补了空行，标签自成一块，里面的正文走正常
 * Markdown 解析。围栏代码块里的不动（那是文档在**讲**这些标签，不是在用）。
 */
const COMPONENT_LINE_RE = /^\s*<\/?([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?\/?>\s*$/;
function separateComponentTags(text: string): string {
  if (!/<\/?[a-zA-Z]/.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const m = fence === null && !f ? COMPONENT_LINE_RE.exec(line) : null;
    if (m && isComponentTag(m[1].toLowerCase())) {
      if (out.length && out[out.length - 1].trim() !== "") out.push("");
      out.push(line.trim()); // 去缩进：缩进 ≥4 格会被当成代码块
      out.push("");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** 标了语言的围栏才高亮，且超过这个体积直接转义纯文本（hljs 对超大块是卡顿放大器）。
 *  **没标语言的不跑 highlightAuto**：它会把文本拿 12 种语言各试一遍再挑最像的，
 *  既慢，猜错时还给普通文字染上莫名其妙的颜色——文档里的无标注围栏多半就是日志 / 目录树 / 命令输出。 */
const HIGHLIGHT_MAX_CHARS = 100_000;

/**
 * 代码块：语言标签 + 复制按钮 + 高亮。
 * 按钮只带 `data-kb-copy`，没有任何文档内容进属性；点击由 KbDocumentView 在容器上
 * 事件委托处理（v-html 里的节点绑不了 Vue 事件）。语言名只在 hljs 认识时才进 class，
 * 标签文字一律转义——围栏信息串来自文档，是不可信输入。
 */
function renderCode({ text, lang }: { text: string; lang?: string }): string {
  const name = (lang ?? "").trim().split(/\s+/)[0] ?? "";
  const known = name !== "" && !!hljs.getLanguage(name);
  const body =
    known && text.length <= HIGHLIGHT_MAX_CHARS
      ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value
      : escapeHtml(text);
  const cls = known ? `hljs language-${escapeAttr(name)}` : "hljs";
  return (
    `<div class="kb-code"><div class="kb-code-bar"><span class="kb-code-lang">${escapeHtml(name)}</span>` +
    `<button type="button" class="kb-copy" data-kb-copy>复制</button></div>` +
    `<pre><code class="${cls}">${body}</code></pre></div>`
  );
}

const kbMarked = new Marked({ gfm: true, breaks: false });

kbMarked.use({
  renderer: {
    code: renderCode,

    /** 原始 HTML（块与行内同走这里）：只放行白名单标签（无属性），其余转义成文本，
     *  绝不把原样 HTML 交给浏览器解析。 */
    html({ text, block }: { text: string; block?: boolean }): string {
      return sanitizeHtml(text, block ?? false);
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
      const t = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(url)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
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
      const t = title ? ` title="${escapeAttr(title)}"` : "";
      // loading=lazy：一篇长文档里几十张图不该在打开瞬间全部拉。
      // ⚠️ 对 asset:// 它不生效（src 稍后会被 JS 换成 objectURL），见 spec §12 已知代价
      return `<img src="${escapeAttr(url)}" alt="${escapeAttr(text)}"${t} loading="lazy" />`;
    },
  },
});

export function renderKbMarkdown(text: string): string {
  // 先走 SDK 的实例拿到缓存与 hljs 高亮，再用本文件的严格实例重渲染。
  // 两者不一致会造成"预览和正文长得不一样"，所以**只用**严格实例，
  // 缓存靠下面的 Map 自己维护（与 SDK 同款 LRU 思路，规模按文档数封顶）。
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  openCallouts = [];
  let html = kbMarked.parse(separateComponentTags(text)) as string;
  // 漏写闭标签的提示块：在文末补上，别让它的外框连带后面的内容一起开着
  while (openCallouts.length) html += `</${openCallouts.pop()}>`;
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
