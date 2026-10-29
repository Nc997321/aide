// 普通输入统一走 AInput；原生 input 只用于非文本控件及 AInput 自身。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("vue/compiler-sfc");
const { parse: parseTemplate } = createRequire(require.resolve("vue/compiler-sfc"))("@vue/compiler-dom");
const root = fileURLToPath(new URL("..", import.meta.url));
const nativeTypes = new Set(["checkbox", "radio", "file", "range", "color", "hidden"]);
const errors = [];
let count = 0;

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { scan(path); continue; }
    if (!entry.name.endsWith(".vue")) continue;
    const file = relative(root, path).replaceAll("\\", "/");
    if (file === "src/ui/AInput.vue") continue;
    const { descriptor } = parse(readFileSync(path, "utf8"));
    if (!descriptor.template) continue;
    const ast = parseTemplate(descriptor.template.content);
    function visit(node) {
      if (node.type === 1 && node.tag === "input") {
        const type = node.props.find(p => p.type === 6 && p.name === "type")?.value?.content;
        if (!nativeTypes.has(type)) {
          errors.push(`${file}:${descriptor.template.loc.start.line + node.loc.start.line - 1} 普通输入请使用 AInput`);
        }
      }
      if (node.type === 1 && node.tag === "AInput") count++;
      for (const child of node.children ?? []) visit(child);
    }
    visit(ast);
  }
}
scan(join(root, "src"));
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Input components: ${count} inputs use AInput; no raw text inputs`);
}
