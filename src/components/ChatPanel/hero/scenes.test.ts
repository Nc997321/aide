// 欢迎页场景：选中后发送时把场景指引拼在用户输入前发给模型。
import { describe, it, expect } from "vitest";
import { SCENES, composeScenePrompt } from "./scenes";

describe("欢迎页场景注册表", () => {
  it("id 唯一，每个场景都有指引、占位文案和示例（否则就是只换文案的假控件）", () => {
    expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
    for (const s of SCENES) {
      expect(s.brief.length, s.id).toBeGreaterThan(20);
      expect(s.placeholder, s.id).not.toBe("");
      expect(s.examples.length, s.id).toBeGreaterThanOrEqual(3);
      for (const ex of s.examples) expect(ex.prompt, `${s.id}/${ex.label}`).not.toBe("");
    }
  });

  it("指引里点名的能力是 Aide 真有的：文档走 aide-docs，工作台/应用走 aide-app，幻灯片/网页走 aide-design", () => {
    const brief = (id: string) => SCENES.find((s) => s.id === id)!.brief;
    expect(brief("docs")).toContain("mcp__aide-docs__write_docx");
    expect(brief("workbench")).toContain("aide-app");
    expect(brief("app")).toContain("aide-app");
    expect(brief("slides")).toContain("aide-design");
    expect(brief("webpage")).toContain("aide-design");
    expect(brief("webpage")).toContain("单文件 HTML");
    // 没有的能力要如实说，不许让模型假装
    expect(brief("slides")).toContain("不能生成 .pptx");
  });
});

describe("composeScenePrompt", () => {
  const scene = SCENES[0];

  it("指引在前、用户输入在后，中间有分隔", () => {
    expect(composeScenePrompt(scene, "把 a.md 转成 Word")).toBe(`${scene.brief}\n\n---\n\n把 a.md 转成 Word`);
  });

  it("用户没写内容时只发指引", () => {
    expect(composeScenePrompt(scene, "  \n")).toBe(scene.brief);
  });
});
