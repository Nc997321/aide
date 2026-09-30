// 预览分派：按条目 mime 决定正文怎么呈现。**唯一产地**。
//
// 只有两档 + 一个兜底，刻意与 Aide 自己的文件类型词汇一致（spec §5.1）：
// `useFileViewer` 的 `isMarkdown`（能渲染预览）与 `FileWindow` 的
// `isHtmlFilePath`（丢进浏览器打开）——**markdown 与 html，就这两个**。
//
// 不要"顺手补齐"：产品里没有 csv / json（Aide 全仓没有 csv 处理，也没有表格预览），
// 真收进来也只该按纯文本显示。加一档预览 = 加一套产品里不存在的界面。

export type PreviewKind = "markdown" | "html" | "text";

/** 未知 / 空 mime 一律退化成纯文本，**绝不留白**（防御性分支：按收录范围库里到不了）。 */
export function previewKindFor(mime: string): PreviewKind {
  // 先剥 `;` 参数（`text/html; charset=utf-8` 也该认得）再 trim 小写
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "text/markdown") return "markdown";
  if (base === "text/html") return "html";
  return "text";
}
