import { describe, it, expect } from "vitest";
import {
  codegraphMcpRegistration,
  formatToolResponse,
  CODEGRAPH_ALLOW_RULE,
} from "./codegraphTools.js";


describe("codegraphMcpRegistration", () => {
  it("returns server spec by default, null when AIDE_CODEGRAPH_TOOLS=off", () => {
    const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv);
    expect(spec).not.toBeNull();
    expect(spec!["aide-codegraph"]).toBeDefined();
    const off = codegraphMcpRegistration("/proj", () => {}, {
      AIDE_CODEGRAPH_TOOLS: "off",
    } as NodeJS.ProcessEnv);
    expect(off).toBeNull();
  });

  describe("工作区索引开关（enabled）", () => {
    it("enabled=false → null（该工作区索引未开，不注册 MCP）", () => {
      const spec = codegraphMcpRegistration(
        "/proj",
        () => {},
        {} as NodeJS.ProcessEnv,
        true,
        false,
      );
      expect(spec).toBeNull();
    });

    it("enabled=true → 正常注册（缺省 true 向后兼容）", () => {
      const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv, true, true);
      expect(spec).not.toBeNull();
    });

    it("untrusted 优先于 enabled（两门并列，任一不满足即 null）", () => {
      const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv, false, true);
      expect(spec).toBeNull();
    });
  });

  it("allow rule matches the MCP server name prefix", () => {
    expect(CODEGRAPH_ALLOW_RULE).toBe("mcp__aide-codegraph");
  });
});

describe("formatToolResponse", () => {
  it("no_index guides agent back to Grep", () => {
    const text = formatToolResponse("find_symbol", { ok: true, status: "no_index" }, { name: "x" });
    expect(text).toContain("Grep");
    expect(text.toLowerCase()).toContain("not built");
  });

  it("structure_only explains semantic layer not ready", () => {
    const text = formatToolResponse("semantic_search", { ok: true, status: "structure_only" }, { query: "q" });
    expect(text).toContain("Grep");
  });

  it("timeout and error produce text, never throw", () => {
    expect(formatToolResponse("find_symbol", { ok: false, status: "error", timedOut: true }, { name: "x" })).toContain("timed out");
    expect(formatToolResponse("find_symbol", { ok: false, status: "error", error: "boom" }, { name: "x" })).toContain("boom");
    expect(formatToolResponse("find_symbol", { ok: false, status: "error", cancelled: true, error: "interrupted" }, { name: "x" })).toContain("interrupted");
  });

  it("zero hits says index is healthy but has no match", () => {
    const text = formatToolResponse("find_symbol", { ok: true, status: "ready", results: [] }, { name: "Foo" });
    expect(text).toContain("Foo");
    expect(text.toLowerCase()).toContain("no match");
  });

  it("find_symbol renders one compact line per result", () => {
    const text = formatToolResponse("find_symbol", {
      ok: true, status: "ready",
      results: [{ kind: "Method", name: "save", file: "src/a.ts", line: 42, parent: "UserService" }],
    }, { name: "save" });
    expect(text).toContain("Method save — src/a.ts:42 (UserService)");
  });

  it("call_graph annotates ambiguity and truncation", () => {
    const text = formatToolResponse("call_graph", {
      ok: true, status: "ready", candidates: 3, truncated: true,
      results: [{ peer: "main", peer_defs: ["b.ts:10"], call_file: "b.ts", call_line: 88 }],
    }, { name: "save", direction: "callers" });
    expect(text).toContain("3 candidate definitions");
    expect(text.toLowerCase()).toContain("truncated");
    expect(text).toContain("main (defined at b.ts:10) — called at b.ts:88");
  });

  it("semantic_search marks results as candidates to verify", () => {
    const text = formatToolResponse("semantic_search", {
      ok: true, status: "ready",
      results: [{ name: "login", kind: "Function", file: "auth.rs", line: 10, score: 0.81, snippet: "pub async fn login() {…" }],
    }, { query: "auth" });
    expect(text.toLowerCase()).toContain("candidate");
    expect(text).toContain("auth.rs:10");
  });

  it("oversized semantic snippets are hard-truncated at the formatter", () => {
    const big = "x".repeat(500);
    const text = formatToolResponse("semantic_search", {
      ok: true, status: "ready",
      results: [{ name: "f", kind: "Function", file: "a.ts", line: 1, score: 0.9, snippet: big }],
    }, { query: "q" });
    expect(text.length).toBeLessThan(700);
  });

  it("tool descriptions steer the agent away from Grep (snapshot)", () => {
    const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv);
    // SDK server 实例内含 zod v4 schema（内部 root 自引用），直接 JSON.stringify 会抛
    // circular structure —— 用 WeakSet replacer 去环，工具描述仍在序列化结果里。
    const seen = new WeakSet();
    const json = JSON.stringify(spec, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    expect(json).toMatchSnapshot();
  });

  it("server carries MCP instructions steering the model to the tools (2026-07-26 冒烟实锤的必需品)", () => {
    const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv);
    const seen = new WeakSet();
    const json = JSON.stringify(spec, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    // instructions 缺失时模型会无视工具（连 prompt 直接点名都不用），此处防回归。
    expect(json).toContain("MUST call mcp__aide-codegraph__find_symbol FIRST");
    expect(json).toContain("mcp__aide-codegraph__call_graph FIRST");
  });
});
