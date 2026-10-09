/**
 * 文件类型图标（SVG path + 语义色），从 TreeNodeItem 抽出的共享定义——
 * 文件树、变更列表、输入框「文件引用芯片」与知识库目录树（KbNodeIcon）共用，
 * 改图标只需动这一处。颜色全部走 --aide-* 语义 token。
 *
 * 两种画法：
 * - 徽标（`badge`）：16 格画布上的实心圆角色块 + bg-deep 反色描边字形，
 *   代码 / 文档类文件用它。字母不用字体排（各平台字体不一、细节糊），
 *   而是下面 LETTERS 里的描边字形，与知识库的 Markdown「M」同一笔法。
 * - 图形（`path`）：24 格画布的实心剪影，配置 / 资源类文件用它。
 */

export interface BadgeStroke {
  d: string;
  /** 在 16 格画布上的平移 */
  dx: number;
  dy: number;
}

export interface FileIconDef {
  color: string;
  /** 图形图标的 path（24 格）；有 badge 时不用。 */
  path: string;
  /** 徽标字形，渲染见 FileTypeIcon.vue。 */
  badge?: { strokes: BadgeStroke[]; width: number };
}

/** 徽标色块（16 格）：与 KbNodeIcon 原样一致。 */
export const BADGE_TILE = { x: 1.5, y: 1.5, size: 13, rx: 3.5 } as const;

/** 描边字母，字格 4×6（x 0..4，y 0..6）。 */
const LETTERS: Record<string, string> = {
  A: "M0 6 2 0l2 6M.7 4h2.6",
  B: "M0 3h2.5a1.5 1.5 0 0 1 0 3H0V0h2.2a1.5 1.5 0 0 1 0 3",
  C: "M4 1.2A2 2 0 0 0 2.2 0h-.4A1.8 1.8 0 0 0 0 1.8v2.4A1.8 1.8 0 0 0 1.8 6h.4A2 2 0 0 0 4 4.8",
  D: "M0 0v6h1.8A2.2 2.2 0 0 0 4 3.8V2.2A2.2 2.2 0 0 0 1.8 0z",
  G: "M4 1.2A2 2 0 0 0 2.2 0h-.4A1.8 1.8 0 0 0 0 1.8v2.4A1.8 1.8 0 0 0 1.8 6h.4A1.8 1.8 0 0 0 4 4.2V3.2H2.4",
  H: "M0 0v6M4 0v6M0 3h4",
  J: "M1 0h3v4.2A1.8 1.8 0 0 1 2.2 6h-.4A1.8 1.8 0 0 1 0 4.2",
  K: "M0 0v6M4 0 0 4M1.4 2.6 4 6",
  L: "M0 0v6h4",
  M: "M0 6V0l2 3 2-3v6",
  O: "M1.8 0h.4A1.8 1.8 0 0 1 4 1.8v2.4A1.8 1.8 0 0 1 2.2 6h-.4A1.8 1.8 0 0 1 0 4.2V1.8A1.8 1.8 0 0 1 1.8 0z",
  P: "M0 6V0h2.4a1.6 1.6 0 0 1 0 3.2H0",
  Q: "M1.8 0h.4A1.8 1.8 0 0 1 4 1.8v2.4A1.8 1.8 0 0 1 2.2 6h-.4A1.8 1.8 0 0 1 0 4.2V1.8A1.8 1.8 0 0 1 1.8 0zM2.6 4.4 4 6",
  R: "M0 6V0h2.4a1.6 1.6 0 0 1 0 3.2H0M2.2 3.2 4 6",
  S: "M4 1A1.7 1.7 0 0 0 2.4 0h-.8A1.6 1.6 0 0 0 0 1.6C0 2.5.7 3 1.6 3h.8C3.3 3 4 3.5 4 4.4A1.6 1.6 0 0 1 2.4 6h-.8A1.7 1.7 0 0 1 0 5",
  T: "M0 0h4M2 0v6",
  U: "M0 0v4.2A1.8 1.8 0 0 0 1.8 6h.4A1.8 1.8 0 0 0 4 4.2V0",
  V: "M0 0l2 6 2-6",
  W: "M0 0l1 6 1-4 1 4 1-6",
  Y: "M0 0l2 3 2-3M2 3v3",
  "+": "M2 1.2v3.6M.2 3h3.6",
  "#": "M1.4.4 1 5.6M3 .4 2.6 5.6M0 2h4M0 4h4",
};
const LETTER_W = 4;
const LETTER_H = 6;
const LETTER_GAP = 1.6;

/** 字母徽标：≤2 个字母，水平居中排进色块。单字母沿用知识库 1.7 笔宽，双字母收细。 */
function badge(label: string, color: string): FileIconDef {
  const chars = [...label];
  const total = chars.length * LETTER_W + (chars.length - 1) * LETTER_GAP;
  const x0 = 8 - total / 2;
  const dy = 8 - LETTER_H / 2;
  const strokes = chars.map((ch, i) => {
    const d = LETTERS[ch];
    if (!d) throw new Error(`fileIcons: 徽标字形缺字母 ${ch}`);
    return { d, dx: x0 + i * (LETTER_W + LETTER_GAP), dy };
  });
  return { color, path: "", badge: { strokes, width: chars.length > 1 ? 1.4 : 1.7 } };
}

/** 整幅字形徽标（字形已按 16 格画好）。 */
function glyphBadge(d: string, color: string): FileIconDef {
  return { color, path: "", badge: { strokes: [{ d, dx: 0, dy: 0 }], width: 1.7 } };
}

/** 知识库原有的两枚：Markdown「M」、网页「< >」。 */
export const MARKDOWN_ICON = glyphBadge("M4.9 11V5.2l3.1 3.6 3.1-3.6V11", "var(--aide-success)");
export const HTML_ICON = glyphBadge(
  "M6.6 5.6 4.2 8l2.4 2.4M9.4 5.6 11.8 8 9.4 10.4",
  "var(--aide-syntax-keyword, var(--aide-accent))",
);
const XML_ICON = { ...HTML_ICON, color: "var(--aide-warning)" };

export const FILE_ICONS: Record<string, FileIconDef> = {
  // ── 文档 ──
  md:    MARKDOWN_ICON,
  mdx:   MARKDOWN_ICON,
  html:  HTML_ICON,
  htm:   HTML_ICON,
  xml:   XML_ICON,
  // ── 语言 ──
  java:  badge("J",  "var(--aide-danger)"),
  kt:    badge("K",  "var(--aide-accent)"),
  kts:   badge("K",  "var(--aide-accent)"),
  scala: badge("SC", "var(--aide-danger)"),
  groovy: badge("G", "var(--aide-info)"),
  gradle: badge("G", "var(--aide-success)"),
  rs:    badge("RS", "var(--aide-warning)"),
  ts:    badge("TS", "var(--aide-info)"),
  tsx:   badge("TS", "var(--aide-info)"),
  mts:   badge("TS", "var(--aide-info)"),
  cts:   badge("TS", "var(--aide-info)"),
  js:    badge("JS", "var(--aide-warning)"),
  jsx:   badge("JS", "var(--aide-warning)"),
  mjs:   badge("JS", "var(--aide-warning)"),
  cjs:   badge("JS", "var(--aide-warning)"),
  vue:   badge("V",  "var(--aide-success)"),
  css:   badge("CS", "var(--aide-info)"),
  scss:  badge("S",  "var(--aide-danger)"),
  less:  badge("L",  "var(--aide-info)"),
  py:    badge("PY", "var(--aide-info)"),
  go:    badge("GO", "var(--aide-info)"),
  c:     badge("C",  "var(--aide-info)"),
  h:     badge("H",  "var(--aide-text-secondary)"),
  cpp:   badge("C+", "var(--aide-info)"),
  cc:    badge("C+", "var(--aide-info)"),
  cxx:   badge("C+", "var(--aide-info)"),
  hpp:   badge("H+", "var(--aide-text-secondary)"),
  cs:    badge("C#", "var(--aide-success)"),
  swift: badge("SW", "var(--aide-danger)"),
  rb:    badge("RB", "var(--aide-danger)"),
  php:   badge("P",  "var(--aide-accent)"),
  lua:   badge("LU", "var(--aide-info)"),
  dart:  badge("DA", "var(--aide-info)"),
  sql:   badge("SQ", "var(--aide-warning)"),
  // ── 图形图标 ──
  json: { color: "var(--aide-text-muted)", path: "M5 3h2v2H5v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5h2v2H5c-1.1 0-2-.9-2-2v-4a2 2 0 0 0-2-2v-2a2 2 0 0 0 2-2V5c0-1.1.9-2 2-2zm14 0c1.1 0 2 .9 2 2v4a2 2 0 0 0 2 2v2a2 2 0 0 0-2 2v4c0 1.1-.9 2-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3h2z" },
  toml: { color: "var(--aide-text-muted)", path: "M3 3h18v18H3V3zm3 3v3h3V6H6zm4.5 0v3h3V6h-3zM15 6v3h3V6h-3zM6 10.5v3h12v-3H6zM6 15v3h12v-3H6z" },
  yaml: { color: "var(--aide-text-muted)", path: "M3 3h18v18H3V3zm3 3v3h3V6H6zm4.5 0v3h3V6h-3zM15 6v3h3V6h-3zM6 10.5v3h12v-3H6zM6 15v3h12v-3H6z" },
  yml:  { color: "var(--aide-text-muted)", path: "M3 3h18v18H3V3zm3 3v3h3V6H6zm4.5 0v3h3V6h-3zM15 6v3h3V6h-3zM6 10.5v3h12v-3H6zM6 15v3h12v-3H6z" },
  sh:   { color: "var(--aide-success)",  path: "M4 17l6-5-6-5v10zm8 0h8v-2h-8v2z" },
  ps1:  { color: "var(--aide-info)",     path: "M4 17l6-5-6-5v10zm8 0h8v-2h-8v2z" },
  png:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  jpg:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  svg:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  ico:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  lock: { color: "var(--aide-text-muted)", path: "M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-6V9A6 6 0 0 0 6 9v2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2zM8 9a4 4 0 1 1 8 0v2H8V9z" },
  gitignore: { color: "var(--aide-text-muted)", path: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm3.5-12.5L12 11l-3.5-3.5L7 9l3.5 3.5L7 16l1.5 1.5L12 14l3.5 3.5L17 16l-3.5-3.5L17 9l-1.5-1.5z" },
};

export const DEFAULT_ICON: FileIconDef = {
  color: "var(--aide-text-muted)",
  path: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 8V3.5L18.5 8H14zM6 20V4h6v6h6v10H6z",
};

/** 文件夹图标（TreeNodeItem 未展开态），芯片/列表复用同一个 path。 */
export const FOLDER_ICON_PATH =
  "M3 7c0-1.1.9-2 2-2h4.6L12 7h7c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7z";

/** 按完整文件名识别（优先于扩展名）。 */
const NAME_ICONS: Record<string, FileIconDef> = {
  dockerfile: badge("D",  "var(--aide-info)"),
  makefile:   badge("MK", "var(--aide-text-secondary)"),
  "pom.xml":  badge("MV", "var(--aide-danger)"),
};

export function getFileIcon(name: string): FileIconDef {
  const base = pathBasename(name);
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const byName = NAME_ICONS[base.toLowerCase()];
  if (byName) return byName;
  if (base === ".gitignore") return FILE_ICONS.gitignore;
  if (base.endsWith(".lock")) return FILE_ICONS.lock;
  return FILE_ICONS[ext] || DEFAULT_ICON;
}

/** 从完整路径取文件名（跨平台分隔符）。 */
export function pathBasename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}
