import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import java from "highlight.js/lib/languages/java";
import ini from "highlight.js/lib/languages/ini";
import properties from "highlight.js/lib/languages/properties";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("java", java);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("plaintext", plaintext);

export { hljs };

export const extToLang: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust",
  json: "json", jsonc: "json", jsonl: "json",
  xml: "xml", html: "html", htm: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", less: "css",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "bash",
  py: "python", pyw: "python",
  md: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  java: "java", jar: "java",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  properties: "properties",
  gitignore: "plaintext", env: "plaintext",
};

export function highlightCode(code: string, ext: string): string {
  const lang = extToLang[ext] || "plaintext";
  try {
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return hljs.highlightAuto(code).value;
  }
}

/**
 * 高亮结果**按行切开**（静态 diff 用：逐行上色，但不能逐行高亮）。
 *
 * 为什么整段只跑一次 hljs：块注释、多行字符串这类 token 是跨行的，逐行单独
 * 高亮会把它们从第二行起截断成无色——而 diff 的每一行都得和原文件里一个样。
 * 所以整段高亮一次，再按 `\n` 切开，切点处把未闭合的标签补上、下一行原样重开。
 *
 * 返回每行一个 HTML 片段（不含换行符），**行数与 `code.split("\n")` 一致**
 * （末尾换行会多出一个空行）——diff 行模型按同一套约定编行号，约定不一致会错位。
 */
export function highlightLines(code: string, ext: string): string[] {
  return splitHighlightedLines(highlightCode(code, ext));
}

/** 按行切分已高亮的 HTML：栈里记着本行仍未闭合的开始标签，换行时补 `</span>`、
 *  下一行开头原样重开。hljs 只产 `<span>`（无自闭合、无 void 元素），
 *  但 `/>` 仍按自闭合处理——不依赖上游的实现细节。 */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  const closeAll = () => "</span>".repeat(open.length);
  let buf = "";
  let i = 0;

  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        // 残缺标签（不该出现）：当普通文本吞掉，绝不半路抛
        buf += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) open.pop();
      else if (!tag.endsWith("/>")) open.push(tag);
      buf += tag;
      i = end + 1;
      continue;
    }
    if (ch === "\n") {
      lines.push(buf + closeAll());
      buf = open.join("");
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  lines.push(buf + closeAll());
  return lines;
}
