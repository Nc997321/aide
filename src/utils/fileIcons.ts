/**
 * 文件类型图标（SVG path + 语义色），从 TreeNodeItem 抽出的共享定义——
 * 文件树节点与输入框的「文件引用芯片」（ChatPanel mention chip）共用，
 * 改图标只需动这一处。颜色全部走 --aide-* 语义 token。
 */

export interface FileIconDef {
  color: string;
  path: string;
}

export const FILE_ICONS: Record<string, FileIconDef> = {
  vue:  { color: "var(--aide-success)",  path: "M2 3h6l4 7 4-7h6L12 21 2 3z" },
  ts:   { color: "var(--aide-info)",     path: "M3 5h18v14H3V5zm6 3v2h2v7h2V10h2V8H9zm8 0v9h2V8h-2z" },
  js:   { color: "var(--aide-warning)",  path: "M3 3h18v18H3V3zm9 14c0 1.1-.9 2-2 2s-2-.5-2-1.5h1.5c0 .3.2.5.5.5s.5-.2.5-.5V10h2v7zm4 2c-1.1 0-2-.5-2-1.5h1.5c0 .3.2.5.5.5s.5-.2.5-.5c0-.4-.3-.5-.8-.7l-.5-.2C14.3 15.6 14 15 14 14.3c0-1 .8-1.8 1.8-1.8 1 0 1.7.5 1.7 1.5h-1.4c0-.3-.1-.5-.4-.5-.2 0-.4.2-.4.4 0 .3.2.4.6.6l.6.2c.9.4 1.3 1 1.3 1.8 0 1-1 1.8-2.1 1.8z" },
  json: { color: "var(--aide-text-muted)", path: "M5 3h2v2H5v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5h2v2H5c-1.1 0-2-.9-2-2v-4a2 2 0 0 0-2-2v-2a2 2 0 0 0 2-2V5c0-1.1.9-2 2-2zm14 0c1.1 0 2 .9 2 2v4a2 2 0 0 0 2 2v2a2 2 0 0 0-2 2v4c0 1.1-.9 2-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3h2z" },
  md:   { color: "var(--aide-text-secondary)", path: "M2 4h20v16H2V4zm3 12V8l3 4 3-4v8h2V8h2v8h2V8h1.5" },
  html: { color: "var(--aide-danger)",   path: "M4 2l1.5 17L12 22l6.5-3L20 2H4zm13.1 5H8.4l.3 3h8.1l-.8 8-4 1.4-4-1.4-.4-4h2.8l.2 2.1 1.4.4 1.5-.4.2-2.1H7.6L7 5.5h10.3l-.2 1.5z" },
  css:  { color: "var(--aide-info)",     path: "M4 2l1.5 17L12 22l6.5-3L20 2H4zm12 12.5c0 1.9-1.6 3.5-4 3.5s-4-1.6-4-3.5h2.5c0 .8.7 1.3 1.5 1.3s1.5-.4 1.5-1.3c0-.8-.5-1.2-1.5-1.5-2-.5-3.5-1.2-3.5-3.2C9 7.5 10.5 6 12 6s3 1.5 3 3h-2.5c0-.5-.3-1-.5-1-.4 0-.5.3-.5.8 0 .8.5 1 1.5 1.4 2 .6 3 1.5 3 3.3z" },
  rs:   { color: "var(--aide-accent)",   path: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 3c1.1 0 2 .6 2 1.3 0 .5-.3 1-.8 1.2.7.3 1.3 1.1 1.3 2 0 1.2-1.1 2.2-2.5 2.2S9.5 10.7 9.5 9.5c0-.9.5-1.7 1.3-2C10.3 7.3 10 6.8 10 6.3 10 5.6 10.9 5 12 5zm-3 8h6v2l-3 4-3-4v-2z" },
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

export function getFileIcon(name: string): FileIconDef {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (name === ".gitignore") return FILE_ICONS.gitignore;
  if (name.endsWith(".lock")) return FILE_ICONS.lock;
  return FILE_ICONS[ext] || DEFAULT_ICON;
}

/** 从完整路径取文件名（跨平台分隔符）。 */
export function pathBasename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}
