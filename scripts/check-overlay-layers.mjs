// 守门检查：全屏遮罩组件的遮罩根元素必须挂 `v-overlay-layer`。
//
// 原则（见 src/directives/overlayLayer.ts）：浮层登记处是「此刻有没有浮层盖在主区之上」的**唯一
// 事实源**，两个消费者都读它：
//   ① 内嵌浏览器的原生 WebView2 子视图要让位——否则浮层被网页吃掉下半截（只剩标题那一条）；
//   ② PermissionDialog 的 window 级 Enter/Esc 见浮层让路——否则键盘穿透到权限弹窗。
// 漏挂的代价是静默的（视觉残缺或键盘穿透），且新增浮层的人不会知道有这么个登记处，故在构建期兜。
//
// 判据：模板里出现以 `-overlay` 结尾的 class 词元的 .vue 文件，必须同时出现 `v-overlay-layer`。
// 类名约定（`xxx-overlay` = 全屏遮罩根）本仓一直守着，PermissionDialog 早先那份遮罩类名表也按它列。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIR = "src";
// 类名带 -overlay 但**不是模态遮罩**的：登记了反而永远挡住原生视图。新增例外必须在此写明理由。
const EXCEPTIONS = new Set([
  // workbench 是常驻 DOM 的悬浮 dock（pointer-events:none + 常驻，靠 --hidden 类切换），
  // 不是模态：PermissionDialog 的键盘路由也一直把它排除在外（Esc 收起走 App 的 capture handler）。
  "src/components/WorkbenchTerminal.vue",
]);
/** 取所有 class / :class 属性的值，逐个词元判断——比一条正则硬凑边界清楚。 */
const CLASS_ATTR_RE = /:?class="([^"]*)"/g;
const DIRECTIVE_RE = /v-overlay-layer/;

function isOverlayRoot(content) {
  for (const m of content.matchAll(CLASS_ATTR_RE)) {
    if (m[1].split(/\s+/).some((token) => token.endsWith("-overlay"))) return true;
  }
  return false;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (extname(name) === ".vue") yield full;
  }
}

const violations = [];
for (const file of walk(join(ROOT, SCAN_DIR))) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  if (EXCEPTIONS.has(rel)) continue;
  const content = readFileSync(file, "utf8");
  if (isOverlayRoot(content) && !DIRECTIVE_RE.test(content)) {
    violations.push(rel);
  }
}

if (violations.length) {
  console.error("✗ 以下遮罩组件没有登记到浮层登记处（遮罩根元素缺 v-overlay-layer）：");
  for (const v of violations) console.error("  - " + v);
  console.error(
    "\n处理方式：在遮罩根元素上挂 v-overlay-layer，并在 <script setup> 里 " +
      'import { vOverlayLayer } from "<相对路径>/directives/overlayLayer";',
  );
  console.error("详见 src/directives/overlayLayer.ts（漏挂 = 弹窗被网页吃掉 / 键盘穿透权限弹窗）。");
  process.exit(1);
}
console.log(`✓ 浮层登记检查通过：${SCAN_DIR} 下所有遮罩根元素均已挂 v-overlay-layer`);
