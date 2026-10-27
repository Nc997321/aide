import { describe, expect, it } from "vitest";
import { collectDocumentArtifacts, parseDocumentArtifact } from "./documentArtifacts";

const document = { version: 1, path: "docs/design.md", title: "设计方案", summary: "交互与实现" };
const fence = (v: unknown) => `\`\`\`aide-document\n${JSON.stringify(v)}\n\`\`\`\n`;
const text = (s: string) => ({ type: "text", text: s });

describe("文档成果展示协议 v1", () => {
  it("定稿与历史正文用同一解析，保留前后正文", () => {
    const result = collectDocumentArtifacts([text(`已完成。\n\n${fence(document)}\n继续讨论。`)]);
    expect(result.documents).toEqual([document]);
    expect(result.texts.get(0)).toContain("已完成。");
    expect(result.texts.get(0)).toContain("继续讨论。");
    expect(result.texts.get(0)).not.toContain("aide-document");
  });

  it("普通路径、读写工具结果、引用、列表与围栏示例都不猜成果", () => {
    for (const s of ["已写入 `docs/design.md`", `> ${fence(document).replace(/\n/g, "\n> ")}`, `\`\`\`\`markdown\n${fence(document)}\`\`\`\``, `- 示例\n\n${fence(document).split("\n").map(l => `    ${l}`).join("\n")}`]) {
      expect(collectDocumentArtifacts([text(s)]).documents).toEqual([]);
    }
    expect(collectDocumentArtifacts([{ type: "tool_call", text: fence(document) }]).documents).toEqual([]);
  });

  it("非法、未知版本、不完整声明保留原文，不吞消息", () => {
    for (const s of [fence({ ...document, version: 2 }), fence({ path: document.path }), "```aide-document\n{bad json}\n```", `\`\`\`aide-document\n${JSON.stringify(document)}`, "```aide-document\n```", fence({ ...document, path: "src/main.ts" })]) {
      const result = collectDocumentArtifacts([text(s)]);
      expect(result.documents).toEqual([]);
      expect(result.texts.size).toBe(0);
    }
  });

  it("跨正文块按解析后的文件路径去重，最后一份标题摘要生效", () => {
    const newer = { ...document, path: "/project/docs/design.md", title: "更新后的方案" };
    const result = collectDocumentArtifacts([text(fence(document)), text(fence(newer))], "/project");
    expect(result.documents).toEqual([newer]);
    expect(result.texts.size).toBe(2);
  });

  it("Windows 路径兼容反斜杠与大小写；POSIX 大小写保持独立", () => {
    expect(collectDocumentArtifacts([text(fence({ ...document, path: "C:\\Work\\设计 方案.md" }) + fence({ ...document, path: "c:/work/设计 方案.md" }))]).documents).toHaveLength(1);
    expect(collectDocumentArtifacts([text(fence({ ...document, path: "/work/A.md" }) + fence({ ...document, path: "/work/a.md" }))]).documents).toHaveLength(2);
  });

  it("接收中文空格路径和纯文本，拒绝 URI、控制字符和未支持格式", () => {
    expect(parseDocumentArtifact(JSON.stringify({ ...document, path: "文档/设计 方案.markdown" }))).not.toBeNull();
    expect(parseDocumentArtifact(JSON.stringify({ ...document, path: "notes.txt" }))).not.toBeNull();
    for (const path of ["https://example.com/doc.md", "file:///tmp/a.md", "javascript:doc.md", "doc.md:12", "bad\nname.md", "report.pdf", "a.md?x", "a.md#part"]) {
      expect(parseDocumentArtifact(JSON.stringify({ ...document, path }))).toBeNull();
    }
    expect(parseDocumentArtifact(JSON.stringify({ ...document, summary: 42 }))).toBeNull();
  });

  it("兼容 CRLF 与波浪围栏", () => {
    expect(collectDocumentArtifacts([text(fence(document).replace(/\n/g, "\r\n"))]).documents).toEqual([document]);
    expect(collectDocumentArtifacts([text(fence(document).replace(/```/g, "~~~~"))]).documents).toEqual([document]);
  });
});
