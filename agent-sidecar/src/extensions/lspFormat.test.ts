import { describe, it, expect } from "vitest";
import {
  LSP_STATUS_WORDS,
  MAX_OUTPUT_BYTES,
  ambiguousText,
  declaredAt,
  definitionText,
  displayPath,
  enclosingLabel,
  notAnsweredText,
  outlineText,
  referencesText,
  textFallbackText,
  type OutlineNode,
} from "./lspFormat.js";

const node = (o: Partial<OutlineNode> & { name: string }): OutlineNode => ({
  kind: 12,
  line: 1,
  column: 1,
  start_line: 1,
  end_line: 1,
  depth: 0,
  ...o,
});

// agent_query.rs 的 LspManager 形状：struct → impl 方法 → 方法体里的局部变量
const NODES: OutlineNode[] = [
  node({ name: "LspManager", kind: 23, line: 10, start_line: 10, end_line: 100, depth: 0 }),
  node({ name: "get", kind: 6, line: 20, column: 12, start_line: 19, end_line: 40, depth: 1 }),
  node({ name: "h", kind: 13, line: 22, start_line: 22, end_line: 22, depth: 2 }),
  node({ name: "kill", kind: 6, line: 50, start_line: 50, end_line: 60, depth: 1 }),
];

describe("「空 ≠ 没有」红线", () => {
  /// 最要紧的一条。非 ready 的文案**不许以肯定句开头**（「No … 」只属于 ready 形态），
  /// 且必须给出 Grep 退路。
  it("非 ready 状态绝不用肯定句说「没有」", () => {
    for (const s of LSP_STATUS_WORDS.filter((w) => w !== "ready")) {
      const text = notAnsweredText(s, "get");
      expect(text.startsWith("No "), `${s} 用了肯定句式`).toBe(false);
      expect(text.toLowerCase(), `${s} 没给 Grep 退路`).toContain("grep");
    }
  });

  it("ready + 空 = 可信的「没有」，且明说这是已确认的否定", () => {
    const text = referencesText("references", "get", []);
    expect(text.startsWith("No references")).toBe(true);
    expect(text).toMatch(/confirmed negative/i);
  });

  it("indexing 明说「空不代表没有」", () => {
    expect(notAnsweredText("indexing", "get")).toMatch(/does not mean/i);
  });

  it("后端的逐语言明细不吞掉；没给就不写 Detail", () => {
    expect(notAnsweredText("indexing", "x", "vue: its server failed to start")).toContain(
      "vue: its server failed to start",
    );
    expect(notAnsweredText("indexing", "x")).not.toMatch(/Detail:/);
  });

  /// 文本兜底带着坐标，但它不是引用：必须大写标注未验证（徽章侧 lspRelay 也靠这个词认它）。
  it("文本兜底明确标 UNVERIFIED，且空兜底也不说「没有」", () => {
    const text = textFallbackText("run_jump", "it is still indexing", [
      { file: "a.rs", line: 3, column: 4, text: "fn run_jump() {}" },
    ], false);
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("a.rs\n  3:4  fn run_jump() {}");
    const empty = textFallbackText("zzz", "it is still indexing", [], false);
    expect(empty.startsWith("No ")).toBe(false);
    expect(empty).toMatch(/not proof/);
  });

  /// 状态词表必须与 Rust 侧 agent_status.rs 的 as_str() 逐字一致。
  it("状态词表与 Rust 侧逐字一致（冻结点）", () => {
    expect([...LSP_STATUS_WORDS].sort()).toEqual(
      ["error", "gone", "indexing", "no_server", "no_symbol", "ready", "timeout", "untrusted"].sort(),
    );
  });
});

describe("每一发都比 grep 值", () => {
  /// 真机事故：tsserver 回小写盘符、工作区根是大写盘符 + 反斜杠——比对大小写敏感就相对化失败。
  it("displayPath：大小写与分隔符都不敏感", () => {
    expect(displayPath("c:/Users/h/aide/src/App.vue", "C:\\Users\\h\\aide")).toBe("src/App.vue");
    expect(displayPath("/home/h/p/a.rs", "/home/h/p/")).toBe("a.rs");
    expect(displayPath("/elsewhere/a.rs", "/home/h/p")).toBe("/elsewhere/a.rs");
  });

  it("引用标出所在函数（最内两层），顶层代码不标", () => {
    expect(enclosingLabel(NODES, 30)).toBe("LspManager › get");
    expect(enclosingLabel(NODES, 22)).toBe("get › h");
    expect(enclosingLabel(NODES, 200)).toBeNull();
  });

  it("引用输出：按文件分组，每条行:列 + 所在函数 + 代码行", () => {
    const text = referencesText("references", "get", [
      {
        rel: "src/lsp/mod.rs",
        refs: [{ line: 30, column: 9, text: "    let h = mgr.get(root);", enclosing: "LspManager › get" }],
      },
    ]);
    expect(text).toContain("1 references of `get` in 1 file");
    expect(text).toContain("src/lsp/mod.rs\n  30:9  [in LspManager › get]  let h = mgr.get(root);");
  });

  it("定义带整个函数体（cat -n 格式），头行带种类与外层", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i + 1}`);
    const get = NODES[1];
    const text = definitionText("src/m.rs", { file: "/p/src/m.rs", line: 20, column: 12 }, lines, get, "LspManager");
    expect(text.split("\n")[0]).toBe("method LspManager.get — src/m.rs:20:12");
    expect(text).toContain("19\tline19");
    expect(text).toContain("40\tline40");
    expect(text).not.toContain("41\tline41");
  });

  it("超长的定义体给续读指令，而不是整段倒进上下文", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `l${i + 1}`);
    const big = node({ name: "huge", line: 1, start_line: 1, end_line: 400 });
    const text = definitionText("a.ts", { file: "/a.ts", line: 1, column: 1 }, lines, big, null);
    expect(text).toContain("80\tl80");
    expect(text).not.toContain("81\tl81");
    expect(text).toMatch(/320 more lines — Read a\.ts with offset=81/);
  });

  it("没有结构信息时，定义退化为附近一段代码", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
    const text = definitionText("a.ts", { file: "/a.ts", line: 50, column: 1 }, lines, null, null);
    expect(text).toContain("47\tl47");
    expect(text).toContain("75\tl75");
  });

  it("文件结构：带行区间，略去函数体里的局部变量", () => {
    const text = outlineText("src/m.rs", NODES);
    expect(text).toContain("struct LspManager  L10-100");
    expect(text).toContain("  method get  L19-40");
    expect(text).not.toContain(" h ");
    expect(text).toContain("  method kill  L50-60");
  });

  it("declaredAt 取这一行上声明的那个（同名优先）", () => {
    expect(declaredAt(NODES, 20)?.name).toBe("get");
    expect(declaredAt(NODES, 21)).toBeNull();
  });

  it("同名多义：列候选（种类 + 代码行），要求带坐标重查，不替模型选", () => {
    const text = ambiguousText("get", [
      { rel: "a.rs", line: 216, column: 18, kind: 6, text: "pub fn get(&self)" },
      { rel: "b.rs", line: 40, column: 12, kind: 12, text: null },
    ]);
    expect(text).toContain("2 symbols are named `get`");
    expect(text).toContain("method  a.rs:216:18  pub fn get(&self)");
    expect(text).toContain("function  b.rs:40:12");
    expect(text).toMatch(/lsp_references \{file, line, character\}/);
  });

  it("超预算如实截断（按行切，不切半行）", () => {
    const refs = Array.from({ length: 2000 }, (_, i) => ({
      line: i + 1,
      column: 1,
      text: "x".repeat(40),
      enclosing: null,
    }));
    const text = referencesText("references", "get", [{ rel: "a.ts", refs }]);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MAX_OUTPUT_BYTES + 200);
    expect(text).toMatch(/truncated: 2000 results total/);
  });
});
