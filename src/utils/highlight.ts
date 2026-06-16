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
hljs.registerLanguage("plaintext", plaintext);

export { hljs };

export const extToLang: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust",
  json: "json", jsonc: "json",
  xml: "xml", html: "html", htm: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", less: "css",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "bash",
  py: "python", pyw: "python",
  md: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
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
