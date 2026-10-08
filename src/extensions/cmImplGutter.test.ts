import { describe, it, expect } from "vitest";
import { sameFile } from "./cmImplGutter";

describe("sameFile（gutter 自引用过滤的路径比较）", () => {
  const root = "C:\\proj\\aide";

  it("绝对 vs 相对：同一文件判相等（原先裸 === 滤不掉，↓ 跳到自己）", () => {
    expect(sameFile(root, "src/composables/a.ts", "C:\\proj\\aide\\src\\composables\\a.ts")).toBe(true);
  });

  it("反斜杠 / 正斜杠混用", () => {
    expect(sameFile(root, "C:/proj/aide/src/a.ts", "C:\\proj\\aide\\src\\a.ts")).toBe(true);
  });

  it("盘符大小写不敏感（c: / C:）", () => {
    expect(sameFile("c:/proj/aide", "C:/proj/aide/src/a.ts", "c:/proj/aide/src/a.ts")).toBe(true);
  });

  it("workspaceRoot 末尾带分隔符", () => {
    expect(sameFile("/home/u/proj/", "/home/u/proj/src/a.ts", "src/a.ts")).toBe(true);
  });

  it("不同文件判不等；前缀相似的兄弟目录不误判", () => {
    expect(sameFile(root, "src/a.ts", "src/b.ts")).toBe(false);
    expect(sameFile("/home/u/proj", "/home/u/proj-other/src/a.ts", "src/a.ts")).toBe(false);
  });

  it("工作区外的绝对路径（如 node_modules 外的库声明）保持原样比较", () => {
    expect(sameFile("/home/u/proj", "/usr/lib/x.d.ts", "src/a.ts")).toBe(false);
    expect(sameFile("/home/u/proj", "/usr/lib/x.d.ts", "/usr/lib/x.d.ts")).toBe(true);
  });
});
