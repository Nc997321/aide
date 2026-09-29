import { describe, it, expect } from "vitest";
import { lspLangFor } from "./lspLang";

describe("lspLangFor", () => {
  it("路由 TS 家族的三种文档形态到同一个服务（.vue 由 TS 插件覆盖）", () => {
    expect(lspLangFor("src/a.ts")).toBe("typescript");
    expect(lspLangFor("src/a.tsx")).toBe("typescript");
    expect(lspLangFor("src/App.vue")).toBe("typescript");
  });

  it("React 的 .jsx 归 JavaScript（同一个 TS 服务器，另一个服务 id）", () => {
    expect(lspLangFor("src/a.jsx")).toBe("javascript");
    expect(lspLangFor("src/a.mjs")).toBe("javascript");
  });

  it("其余语言按扩展名分派", () => {
    expect(lspLangFor("src/main.rs")).toBe("rust");
    expect(lspLangFor("src/Main.java")).toBe("java");
    expect(lspLangFor("src/app.py")).toBe("python");
  });

  it("扩展名大小写不敏感；没有扩展名 / 未登记扩展名 → undefined", () => {
    expect(lspLangFor("src/Main.RS")).toBe("rust");
    expect(lspLangFor("README")).toBeUndefined();
    expect(lspLangFor("data.json")).toBeUndefined();
  });
});
