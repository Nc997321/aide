import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";

/**
 * 按文件扩展名动态加载 CodeMirror 语言包（CodeEditor 与 DiffViewer 共用）。
 * 未知扩展名 / 加载失败 → 空数组（无语法高亮，不报错）。
 */
export async function loadLanguageExtension(e: string): Promise<Extension> {
  try {
    switch (e) {
      case "ts":
      case "tsx":
      case "js":
      case "jsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        const isTs = e === "ts" || e === "tsx";
        const isJsx = e === "tsx" || e === "jsx";
        return javascript({ typescript: isTs, jsx: isJsx });
      }
      case "rs": {
        const { rust } = await import("@codemirror/lang-rust");
        return rust();
      }
      case "java": {
        const { java } = await import("@codemirror/lang-java");
        return java();
      }
      case "py": {
        const { python } = await import("@codemirror/lang-python");
        return python();
      }
      case "json":
      case "jsonl": {
        const { json } = await import("@codemirror/lang-json");
        return json();
      }
      case "md":
      case "mdx": {
        const { markdown } = await import("@codemirror/lang-markdown");
        return markdown();
      }
      case "html":
      case "htm": {
        const { html } = await import("@codemirror/lang-html");
        return html();
      }
      case "css":
      case "scss":
      case "less": {
        const { css } = await import("@codemirror/lang-css");
        return css();
      }
      case "vue": {
        const { vue } = await import("@codemirror/lang-vue");
        return vue();
      }
      // yaml / properties 无官方 lezer 语法包，用 legacy-modes（CM5 模式移植）
      // 包 StreamLanguage；语言包动态 import 保持按扩展名代码分割。
      case "yaml":
      case "yml": {
        const { yaml } = await import("@codemirror/legacy-modes/mode/yaml");
        return StreamLanguage.define(yaml);
      }
      case "properties": {
        const { properties } = await import("@codemirror/legacy-modes/mode/properties");
        return StreamLanguage.define(properties);
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}
