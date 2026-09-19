import { describe, it, expect } from "vitest";
import { formatLspResponse, LSP_STATUS_WORDS } from "./lspStatusText.js";
import type { LspQueryResponse } from "./lspClient.js";

const call = (status: string, extra: Partial<LspQueryResponse> = {}) =>
  formatLspResponse("references", { ok: status === "ready", status, ...extra }, { name: "get" });

describe("formatLspResponse —— 空 ≠ 没有（红线）", () => {
  /// 最要紧的一条。判据刻意做成机器可判定的：非 ready 的文案**不许以肯定句开头**
  /// （「No references found …」是只属于 ready 形态的句式），且必须给出 Grep 退路。
  ///
  /// 不能简单断言「不含 'no references' 字样」——indexing 的文案里必然出现这个短语，
  /// 但它在**否认**语境里（"an empty result does not mean …"）。这正是要区分的东西。
  it("非 ready 状态绝不用肯定句说「没有」", () => {
    for (const s of LSP_STATUS_WORDS.filter((w) => w !== "ready")) {
      const text = call(s);
      expect(text.startsWith("No "), `${s} 用了肯定句式`).toBe(false);
      expect(text.toLowerCase(), `${s} 没给 Grep 退路`).toContain("grep");
    }
  });

  it("ready + 空 = 可信的「没有」，且明说这是已确认的否定", () => {
    const text = call("ready", { results: [], count: 0 });
    expect(text.startsWith("No references found")).toBe(true);
    expect(text).toMatch(/confirmed negative/i);
  });

  it("indexing 明说「空不代表没有」并要重试", () => {
    const text = call("indexing");
    expect(text).toMatch(/does not mean/i);
    expect(text).toMatch(/retry/i);
  });

  it("no_server / untrusted 指向配置或信任，而不是让模型重试", () => {
    expect(call("no_server")).toMatch(/no language server/i);
    expect(call("untrusted")).toMatch(/not trusted|untrusted/i);
    expect(call("no_server")).not.toMatch(/retry/i);
  });

  it("timeout / gone 明确标注结果未验证", () => {
    for (const s of ["timeout", "gone"]) {
      expect(call(s), `${s} 应标注未验证`).toMatch(/unverified|unreliable/i);
    }
  });

  it("unknown status 落到兜底分支（不崩、不假称 ready）", () => {
    const text = call("something_new_from_rust");
    expect(text).toContain("something_new_from_rust");
    expect(text.startsWith("No ")).toBe(false);
  });

  /// **夹具必须照真实序列化形状写**。这里踩过：初版夹具用了扁平的
  /// `{file_path, line, column}`（我假设的形状），而 Rust 侧 `QueryResult` 是
  /// **嵌套**的 `{symbol: {file, line, column}, confidence, …}`——测试一直绿着，
  /// 真机上却输出 `undefined:undefined:1`。夹具照假设写 = 测试只验证了假设。
  it("有结果时读嵌套的 symbol.file/line/column，截断到 2KB 以内并如实说明", () => {
    const results = Array.from({ length: 200 }, (_, i) => ({
      symbol: { name: "get", kind: 6, file: `/proj/src/a${i}.rs`, line: i + 1, column: 1 },
      confidence: "structure",
    }));
    const text = formatLspResponse(
      "references",
      { ok: true, status: "ready", results },
      { name: "get" }
    );
    expect(text).toContain("/proj/src/a0.rs:1:1");
    expect(text).not.toContain("undefined");
    expect(text.length).toBeLessThan(2048);
    expect(text).toMatch(/truncated|200/i);
  });

  /// 同名多义：不替模型选，把候选列出来并明确要求它自己定。
  it("ambiguous → 列出候选并要求消歧，不假装唯一", () => {
    const candidates = [
      { name: "get", kind: 6, file_path: "/p/a.rs", line: 216, column: 18, lang: "rust" },
      { name: "get", kind: 6, file_path: "/p/b.rs", line: 40, column: 12, lang: "rust" },
    ];
    const text = formatLspResponse(
      "references",
      { ok: true, status: "ready", ambiguous: true, candidates },
      { name: "get" }
    );
    expect(text).toContain("/p/a.rs:216:18");
    expect(text).toContain("/p/b.rs:40:12");
    expect(text).toMatch(/2|two|multiple/i);
    expect(text).toMatch(/disambiguat|which one|explicit/i);
  });

  /// 按名查询在「有的语言没答上」时把**逐语言明细**放进 `error`（见 Rust 侧
  /// `agent_query::unverified_outcome`）——这层明细必须贴到模型眼前：它据此才知道该用
  /// Grep 兜哪一部分（也是 2026-09-19 假否定事故的唯一补救线索）。
  it("indexing 带上后端给的逐语言明细，不吞掉", () => {
    const text = call("indexing", {
      error:
        "no symbol named `useInlineMention` from rust answered (empty); " +
        "vue: its language server failed to start — those languages were NOT checked, " +
        "so this is not a confirmed negative.",
    });
    expect(text).toContain("vue: its language server failed to start");
    expect(text).toMatch(/not a confirmed negative/);
  });

  /// 明细只在后端真给了的时候出现——不许凭空写个 "Detail: undefined"。
  it("indexing 没带明细时不写 Detail", () => {
    expect(call("indexing")).not.toMatch(/Detail:/);
  });

  /// 消歧指示必须指向**吃坐标的**工具：`lsp_symbols` 只吃名字，照旧文案带坐标重查会
  /// 撞上 Rust 侧 `unknown tool \`symbols\`` 的死路。
  it("ambiguous 的消歧指示指向吃坐标的工具", () => {
    const text = formatLspResponse(
      "references",
      {
        ok: true,
        status: "ready",
        ambiguous: true,
        candidates: [{ name: "get", kind: 6, file_path: "/p/a.rs", line: 1, column: 1, lang: "rust" }],
      },
      { name: "get" }
    );
    expect(text).toContain("lsp_definition");
    expect(text).toContain("lsp_references");
  });

  /// `no_symbol` 目前没有产出点（按名查询不再给确认否定），措辞**不许再断言「确认没有」**
  /// ——哪天它真回来了，那句话我们给不起。
  it("no_symbol 不说「确认没有」，只给未验证 + Grep 退路", () => {
    const text = call("no_symbol");
    expect(text).not.toMatch(/\bis a confirmed negative\b/i);
    expect(text).toMatch(/not a confirmed negative/i);
    expect(text).toMatch(/grep/i);
  });

  /// 状态词表必须与 Rust 侧 src-tauri/src/lsp/agent_status.rs 的 as_str() 逐字一致：
  /// 漂移的后果是模型读到未知状态走兜底分支——**静默降级**，不报错。
  it("状态词表与 Rust 侧逐字一致（冻结点）", () => {
    expect([...LSP_STATUS_WORDS].sort()).toEqual(
      ["error", "gone", "indexing", "no_server", "no_symbol", "ready", "timeout", "untrusted"].sort()
    );
  });
});
