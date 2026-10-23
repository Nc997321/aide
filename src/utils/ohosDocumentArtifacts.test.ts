import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { collectDocumentArtifacts, parseDocumentArtifact } from "@aide/sdk/utils/documentArtifacts";

// 直接执行鸿蒙纯函数源码，避免另写一份测试替身。原生 UI/装饰器由 hvigor 编译验证。
const source = readFileSync(new URL("../../ohos/entry/src/main/ets/session/chat/DocumentArtifacts.ets", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const ohos = {} as { collectDocumentArtifacts: typeof collectDocumentArtifacts; parseDocumentArtifact: typeof parseDocumentArtifact };
new Function("exports", compiled.outputText)(ohos);

const artifact = { version: 1, path: "docs/design.md", title: "设计方案", summary: "交互与实现" };
const fence = (v: unknown) => `\`\`\`aide-document\n${JSON.stringify(v)}\n\`\`\`\n`;
const normalize = (result: ReturnType<typeof collectDocumentArtifacts>) => ({
  // 两端 Markdown 分段器对多余空行保留数不同，比较正文内容与段落边界。
  texts: [...result.texts].map(([i, text]) => [i, text.trim().replace(/\n{3,}/g, "\n\n")]),
  documents: result.documents.map(d => ({ version: d.version, path: d.path, title: d.title, summary: d.summary || "" })),
});

describe("鸿蒙与 SDK 的文档成果协议一致性", () => {
  const cases = [
    fence(artifact),
    `已完成。\n\n${fence(artifact)}\n继续讨论。`,
    fence({ ...artifact, summary: undefined }),
    fence({ ...artifact, path: "文档/设计 方案.markdown" }),
    fence({ ...artifact, path: "notes.txt" }),
    fence({ ...artifact, version: 2 }),
    fence({ ...artifact, summary: 42 }),
    fence({ ...artifact, path: "https://example.com/a.md" }),
    fence({ ...artifact, path: "a.md:12" }),
    fence({ ...artifact, path: "a.md#part" }),
    fence({ ...artifact, path: "bad\nname.md" }),
    fence({ ...artifact, path: "src/main.ts" }),
    '```aide-document\n{bad json}\n```',
    `\`\`\`aide-document\n${JSON.stringify(artifact)}`,
    '```aide-document\n```',
    `> ${fence(artifact).replace(/\n/g, "\n> ")}`,
    `\`\`\`\`markdown\n${fence(artifact)}\`\`\`\``,
    `~~~~markdown\n${fence(artifact)}~~~~`,
    `- 示例\n\n${fence(artifact).split("\n").map(l => `    ${l}`).join("\n")}`,
    `- 示例\n\n${fence(artifact).split("\n").map(l => `  ${l}`).join("\n")}`,
    `- 示例\n\n${fence(artifact)}`,
    fence(artifact).replace(/\n/g, "\r\n"),
    fence(artifact).replace(/```/g, "~~~~"),
    fence({ ...artifact, path: "C:\\Work\\方案.md" }) + fence({ ...artifact, path: "c:/work/方案.md" }),
    fence({ ...artifact, path: "/work/A.md" }) + fence({ ...artifact, path: "/work/a.md" }),
  ];
  it.each(cases.map((raw, index) => ({ raw, index })))("展示与降级用例 $index", ({ raw }) => {
    const blocks = [{ type: "text", text: raw }];
    expect(normalize(ohos.collectDocumentArtifacts(blocks, "/project"))).toEqual(normalize(collectDocumentArtifacts(blocks, "/project")));
  });

  it("跨块路径去重，最后一份摘要生效，解析不改写广播正文", () => {
    const blocks = [
      { type: "text", text: fence(artifact) },
      { type: "tool_call", text: fence(artifact) },
      { type: "text", text: fence({ ...artifact, path: "/project/docs/./design.md", title: "新版本" }) },
    ];
    const before = JSON.stringify(blocks);
    expect(normalize(ohos.collectDocumentArtifacts(blocks, "/project"))).toEqual(normalize(collectDocumentArtifacts(blocks, "/project")));
    expect(ohos.collectDocumentArtifacts(blocks, "/project").documents).toHaveLength(1);
    expect(JSON.stringify(blocks)).toBe(before);
  });

  it("字段校验保持一致", () => {
    for (const value of [null, [], true, { ...artifact, title: " " }, { ...artifact, title: "x".repeat(201) }, { ...artifact, summary: "x".repeat(501) }]) {
      expect(ohos.parseDocumentArtifact(JSON.stringify(value))).toEqual(parseDocumentArtifact(JSON.stringify(value)));
    }
  });
});
