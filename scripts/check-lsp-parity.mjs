// 守门检查：前端 LSP 服务 id 表必须与 Rust 权威表逐条一致。
//
// 事实源：`src-tauri/crates/aide-workspace/src/detect/languages.rs` 的 `LanguageId::from_ext`（扩展名 → 服务归属）
// 与 `id_str`（服务归属 → 服务 id）。前端 `src/utils/lspLang.ts` 的 `LSP_LANG_BY_EXT`
// 是它的**影子表**——跨语言没法共享常量，只能靠对账。
//
// 为什么必须在构建期兜：漏登记/写错的值是**静默**的——该扩展名在 Aide 里完全没有 LSP
// （`.tsx`/`.jsx` 就这么漏了很久，2026-09-29 才发现），或者前端报了一个后端解析不出的
// id（`lsp_did_open` 直接 `Ok(())`），用户只看到「打开文件没反应」。
//
// 判据：两张表都解析出来，逐条比对 ext → 服务 id；解析条数过少直接报错（守卫失效不许静默通过）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUST_PATH = "src-tauri/crates/aide-workspace/src/detect/languages.rs";
const TS_PATH = "src/utils/lspLang.ts";
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
/** 两张表都应有这么多条；少于此数说明解析规则跟代码脱节了（守卫失效，必须报错）。 */
const MIN_ENTRIES = 20;

/** 取 `start..end` 之间的源码片段（两个标记都必须存在，否则守卫失效）。 */
function slice(source, start, end, file) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) {
    console.error(`✗ ${file} 里找不到解析锚点（${start} / ${end}）——守卫已失效，请同步本脚本`);
    process.exit(1);
  }
  return source.slice(from, to);
}

/** 去注释：doc 注释里的示例字符串（`"typescriptreact"` 之类）不该进 token 对账。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 扩展名字面量的字符集：字母数字 + `+ - _ .`（`ps1`、`d.ts` 这类也在内）。 */
const EXT_TOKEN = /"[a-z0-9+._-]+"/g;
const EXT_ARM = /^\s*((?:"[a-z0-9+._-]+"\s*\|\s*)*"[a-z0-9+._-]+")\s*=>\s*Some\(Self::(\w+)\)/;

/** Rust：从 `from_ext` 的 match 臂抽 ext → 变体，再用 `id_str` 把变体翻成服务 id。 */
function rustTable() {
  const source = read(RUST_PATH);
  const variantToId = new Map();
  for (const line of slice(source, "pub fn id_str", "pub fn server_binary", RUST_PATH).split("\n")) {
    const m = line.match(/Self::(\w+)\s*=>\s*"([a-z]+)"/);
    if (m) variantToId.set(m[1], m[2]);
  }
  const body = stripComments(slice(source, "pub fn from_ext", "pub fn id_str", RUST_PATH));
  const table = new Map();
  for (const line of body.split("\n")) {
    const m = line.match(EXT_ARM);
    if (!m) continue;
    const id = variantToId.get(m[2]);
    if (!id) {
      console.error(`✗ from_ext 里的 Self::${m[2]} 在 id_str 里没有对应项（${RUST_PATH}）`);
      process.exit(1);
    }
    for (const ext of m[1].match(EXT_TOKEN)) table.set(ext.slice(1, -1), id);
  }
  // **消耗对账**：match 体里的扩展名字面量必须**全部**被上面的逐行匹配吃掉。剩下的
  // 说明有臂没被解析（折行、臂里夹注释、别的奇怪写法）——正是本守卫要拦的「漏登记且
  // 不报错」形态；宁可响亮失败要求同步解析器，也不许静默放过。
  const leftovers = (body.match(EXT_TOKEN) ?? []).filter((t) => !table.has(t.slice(1, -1)));
  if (leftovers.length) {
    console.error(
      `✗ ${RUST_PATH} 的 from_ext 里有没被解析的扩展名字面量：${[...new Set(leftovers)].join(", ")}`,
    );
    console.error(
      "  （多半是臂折行 / 臂里夹注释 / 新写法；也可能是臂外字面量，如 match guard——" +
        "请同步 scripts/check-lsp-parity.mjs 的解析规则或调整写法）",
    );
    process.exit(1);
  }
  return table;
}

/** TS：抽 `LSP_LANG_BY_EXT` 表里的 `ext: "id"`（一行可多条）。 */
function tsTable() {
  const source = read(TS_PATH);
  const table = new Map();
  for (const line of slice(source, "const LSP_LANG_BY_EXT", "};", TS_PATH).split("\n")) {
    if (line.trim().startsWith("//")) continue;
    for (const m of line.matchAll(/([a-z0-9+._-]+)\s*:\s*"([a-z0-9]+)"/g)) table.set(m[1], m[2]);
  }
  return table;
}

const rust = rustTable();
const ts = tsTable();
if (rust.size < MIN_ENTRIES || ts.size < MIN_ENTRIES) {
  console.error(
    `✗ 解析出的表太小（rust=${rust.size} / ts=${ts.size}，期望 ≥${MIN_ENTRIES}）——守卫失效，不许静默通过`,
  );
  process.exit(1);
}

const diffs = [];
for (const [ext, id] of rust) {
  const shadow = ts.get(ext);
  if (shadow === undefined) diffs.push(`前端缺登记：.${ext}（Rust 归 ${id}）→ 该扩展名将没有任何 LSP`);
  else if (shadow !== id) diffs.push(`不一致：.${ext} → Rust ${id} / 前端 ${shadow}`);
}
for (const ext of ts.keys()) {
  if (!rust.has(ext)) {
    diffs.push(`前端多登记：.${ext} → Rust from_ext 里没有它（服务 id 解析不出，静默无 LSP）`);
  }
}

if (diffs.length) {
  console.error("✗ LSP 服务 id 表不一致（权威表：src-tauri/crates/aide-workspace/src/detect/languages.rs 的 from_ext + id_str）：");
  for (const d of diffs) console.error("  - " + d);
  console.error(`\n处理方式：改 ${TS_PATH} 的 LSP_LANG_BY_EXT 与 Rust 对齐（方向只有一个：Rust 是权威）。`);
  process.exit(1);
}
console.log(`✓ LSP 服务 id 表一致：${rust.size} 条扩展名（Rust from_ext ↔ 前端 lspLang.ts）`);
