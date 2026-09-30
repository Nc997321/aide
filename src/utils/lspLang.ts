/**
 * 文件扩展名 → LSP **服务 id**（cmLsp / 能力查询用）。
 *
 * 服务 id 回答的是「哪个 server 服务这个文件」，**不是** didOpen 帧里发哪个 languageId
 * ——后者由 Rust 按文件形态推（`lsp::detector::document_lang_id`：`.vue` 发 `"vue"`、
 * `.tsx` 发 `"typescriptreact"`），因为 TLS 只认它自己那套 mode id。
 *
 * `.vue` 报 `typescript`：它由 `typescript-language-server` 的 `@vue/typescript-plugin`
 * 覆盖，没有独立的 vue server（`vue-language-server` 是需要客户端桥接的 proxy，驱动不了）。
 *
 * ⚠️ 权威表在 Rust：`LanguageId::from_ext`（src-tauri/crates/aide-workspace/src/detect/languages.rs，经 aide-core `lsp::detector` 使用）。两张表必须
 * 一致，漏登记 = 该扩展名在 Aide 里完全没有 LSP（`.tsx`/`.jsx` 就这么漏了很久）；
 * 一致性由构建期守卫 `pnpm check:lsp-parity` 兜。
 */

/** LSP 服务 id：与 Rust `LanguageId::id_str` 一一对应。**必须是字面量联合**——
 *  写错一个字母（`"typeScript"`）后端 `lang_from_id_str` 就解析不出，`lsp_did_open`
 *  静默 `Ok(())`，表现为「这个文件在 Aide 里完全没有 LSP」且不报错。 */
export type LspServiceId =
  | "rust"
  | "typescript"
  | "javascript"
  | "go"
  | "java"
  | "kotlin"
  | "python"
  | "dart"
  | "csharp"
  | "ruby"
  | "php"
  | "elixir";

const LSP_LANG_BY_EXT: Record<string, LspServiceId> = {
  rs: "rust",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  // Vue 单文件组件 → TS 服务（插件覆盖）
  vue: "typescript",
  go: "go",
  py: "python", pyi: "python",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  dart: "dart",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  ex: "elixir", exs: "elixir",
};

/** 未知扩展名 → undefined（不挂 LSP 扩展，不是错误）。 */
export function lspLangFor(filePath: string): LspServiceId | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LSP_LANG_BY_EXT[ext];
}
