import { describe, it, expect } from "vitest";
import { knowledgeMcpRegistration, KNOWLEDGE_READ_RULES } from "./knowledgeMcp.js";

describe("knowledgeMcpRegistration — 门控矩阵", () => {
  it("默认注册（缺省 trusted=true、无 taskTools）", () => {
    const spec = knowledgeMcpRegistration({} as NodeJS.ProcessEnv);
    expect(spec).not.toBeNull();
    expect(spec!["aide-knowledge"]).toBeDefined();
  });

  it("AIDE_KB_TOOLS=off → null", () => {
    expect(knowledgeMcpRegistration({ AIDE_KB_TOOLS: "off" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("!trusted → null（受限模式不暴露知识库读写）", () => {
    expect(knowledgeMcpRegistration({} as NodeJS.ProcessEnv, false)).toBeNull();
  });

  it("btw 任务支线（taskTools 非空）→ null（前缀最小化）", () => {
    expect(knowledgeMcpRegistration({} as NodeJS.ProcessEnv, true, ["Bash"])).toBeNull();
  });

  it("trusted 优先于 env（两道门并列，任一不满足即 null）", () => {
    expect(knowledgeMcpRegistration({} as NodeJS.ProcessEnv, false, undefined)).toBeNull();
  });
});

describe("放行规则是**工具级**的（server 级会连写工具一起放行）", () => {
  it("四条常量逐字固定", () => {
    expect(KNOWLEDGE_READ_RULES).toEqual([
      "mcp__aide-knowledge__search",
      "mcp__aide-knowledge__read_document",
      "mcp__aide-knowledge__list_spaces",
      "mcp__aide-knowledge__list_documents",
    ]);
  });

  it("没有任何一条等于 server 前缀（防漂移成 mcp__aide-knowledge）", () => {
    for (const rule of KNOWLEDGE_READ_RULES) {
      expect(rule).not.toBe("mcp__aide-knowledge");
      expect(rule.startsWith("mcp__aide-knowledge__")).toBe(true);
    }
  });
});

/**
 * 注册谱的序列化形态。SDK server 实例内含 zod v4 schema（内部 root 自引用），
 * 直接 JSON.stringify 会抛 circular structure —— 用 WeakSet replacer 去环
 * （codegraphTools.test.ts 先例）。
 */
function serializedSpec(): string {
  const spec = knowledgeMcpRegistration({} as NodeJS.ProcessEnv);
  const seen = new WeakSet();
  return JSON.stringify(spec, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

describe("instructions 是 MCP 采纳率的必需品", () => {
  it("工具描述快照 + instructions 关键句（防静默消失）", () => {
    const json = serializedSpec();
    expect(json).toMatchSnapshot();
    expect(json).toContain("mcp__aide-knowledge__search");
    // 逐句单行断言而非整串：JSON.stringify 把换行转义成 \n 两个字符，多行
    // instructions 常量永远不是序列化结果的子串——整串断言必假（假绿）。
    expect(json).toContain("USE ONLY ON EXPLICIT REQUEST");
    expect(json).toContain("never guess document ids");
    expect(json).toContain("browse instead of guessing");
    expect(json).toContain("Cite documents as 知识库《标题》");
    expect(json).toContain("FAILURES COME BACK AS TEXT");
    expect(json).toContain("it lives in a server, not in the workspace");
  });

  // 删除是这套工具里唯一不可逆的一个（软删 + 面板无恢复入口），护栏句必须逐字在位：
  // 它一旦被"精简"掉，模型就会在"帮我整理一下"这类模糊指令下自主删文档。
  it("delete_document 的护栏句在位（唯一不可逆工具）", () => {
    const json = serializedSpec();
    expect(json).toContain("delete_document");
    expect(json).toContain("explicitly asks to delete");
    expect(json).toContain("never on your own initiative");
    expect(json).toContain("no restore");
  });
});
