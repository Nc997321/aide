import { describe, it, expect } from "vitest";
import { getFileIcon, DEFAULT_ICON, FILE_ICONS, MARKDOWN_ICON, HTML_ICON } from "./fileIcons";

const letters = (name: string) => getFileIcon(name).badge?.strokes.length;

describe("getFileIcon", () => {
  it("语言文件画字母徽标", () => {
    expect(letters("Main.java")).toBe(1);
    expect(letters("lib.rs")).toBe(2);
    expect(getFileIcon("App.tsx")).toEqual(getFileIcon("a.ts"));
  });

  it("Markdown / HTML 与知识库共用同一份定义", () => {
    expect(getFileIcon("README.MD")).toBe(MARKDOWN_ICON);
    expect(getFileIcon("index.html")).toBe(HTML_ICON);
  });

  it("徽标字形落在色块内（16 格，含笔宽）", () => {
    for (const def of Object.values(FILE_ICONS)) {
      for (const s of def.badge?.strokes ?? []) {
        if (s.dx === 0 && s.dy === 0) continue; // 整幅字形
        expect(s.dx).toBeGreaterThanOrEqual(1.5 + def.badge!.width / 2);
        expect(s.dx + 4).toBeLessThanOrEqual(14.5 - def.badge!.width / 2);
      }
    }
  });

  it("接受完整路径（两种分隔符）", () => {
    expect(getFileIcon("src/main/Foo.java")).toBe(FILE_ICONS.java);
    expect(getFileIcon("C:\\proj\\src\\x.ts")).toBe(FILE_ICONS.ts);
  });

  it("按文件名识别优先于扩展名", () => {
    expect(getFileIcon("Dockerfile").badge).toBeDefined();
    expect(getFileIcon("pom.xml")).not.toBe(FILE_ICONS.xml);
    expect(getFileIcon("Cargo.lock")).toBe(FILE_ICONS.lock);
  });

  it("无扩展名 / 未知扩展名回落默认图标", () => {
    expect(getFileIcon("LICENSE")).toBe(DEFAULT_ICON);
    expect(getFileIcon("a.unknownext")).toBe(DEFAULT_ICON);
  });
});
