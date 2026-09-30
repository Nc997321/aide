import { describe, it, expect } from "vitest";
import { previewKindFor } from "./previewKind";

describe("previewKindFor", () => {
  it("认识产品既有的两种", () => {
    expect(previewKindFor("text/markdown")).toBe("markdown");
    expect(previewKindFor("text/html")).toBe("html");
  });

  it("带 charset 参数也认得", () => {
    expect(previewKindFor("text/html; charset=utf-8")).toBe("html");
    expect(previewKindFor("text/markdown;charset=UTF-8")).toBe("markdown");
  });

  it("不认识的一律退化成纯文本，绝不留白", () => {
    expect(previewKindFor("application/octet-stream")).toBe("text");
    expect(previewKindFor("")).toBe("text");
  });

  // 反向钉住：别顺手引入产品里没有的格式（spec §5.1）
  it("csv / json 没有专门预览", () => {
    expect(previewKindFor("text/csv")).toBe("text");
    expect(previewKindFor("application/json")).toBe("text");
  });
});
