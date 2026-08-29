import { describe, it, expect } from "vitest";
import { parseFileLink, resolveFileLinkPath, shouldOpenExternally } from "./fileLink";

describe("parseFileLink 文件路径判定", () => {
  it("识别裸文件名与相对路径", () => {
    expect(parseFileLink("session.rs")).toEqual({ path: "session.rs", line: undefined });
    expect(parseFileLink("src/composables/useChatSession.ts")).toEqual({
      path: "src/composables/useChatSession.ts",
      line: undefined,
    });
    expect(parseFileLink("src\\components\\ChatPanel.vue")?.path).toBe("src\\components\\ChatPanel.vue");
  });

  it("识别 :行号 后缀", () => {
    expect(parseFileLink("mapper.ts:42")).toEqual({ path: "mapper.ts", line: 42 });
  });

  it("识别 Windows 盘符绝对路径", () => {
    expect(parseFileLink("C:/document/owner/aide/src/App.vue")?.path).toBe(
      "C:/document/owner/aide/src/App.vue",
    );
  });

  it("拒绝纯代码片段——这是渲染误判 bug 的回归", () => {
    expect(parseFileLink("foo.get()")).toBeNull();
    expect(parseFileLink("config.get('key')")).toBeNull();
    expect(parseFileLink("Vec<u8>")).toBeNull();
    expect(parseFileLink("npm install marked")).toBeNull();
    expect(parseFileLink("a === b")).toBeNull();
    expect(parseFileLink("permissionMode")).toBeNull();
    expect(parseFileLink("obj.method")).toBeNull(); // 无白名单扩展名
    expect(parseFileLink("image.png")).toBeNull(); // 不在可打开白名单里
  });

  it("拒绝含空白与超长文本", () => {
    expect(parseFileLink("let x = mapper.ts")).toBeNull();
    expect(parseFileLink("a/".repeat(200) + "f.ts")).toBeNull();
  });
});

describe("外部打开判定", () => {
  it("HTML 文件与 http/https 链接走系统默认程序", () => {
    expect(shouldOpenExternally("report.html")).toBe(true);
    expect(shouldOpenExternally("report.htm")).toBe(true);
    expect(shouldOpenExternally("https://blog.csdn.net/chang100111/article/details/159617774")).toBe(true);
    expect(shouldOpenExternally("http://localhost:5173")).toBe(true);
    expect(shouldOpenExternally("src/App.vue")).toBe(false);
  });
});

describe("resolveFileLinkPath 路径解析", () => {
  it("相对路径挂到工作区根", () => {
    expect(resolveFileLinkPath("src/App.vue", "C:/proj")).toBe("C:/proj/src/App.vue");
  });

  it("绝对路径与 URI 原样返回", () => {
    expect(resolveFileLinkPath("/etc/hosts", "C:/proj")).toBe("/etc/hosts");
    expect(resolveFileLinkPath("D:\\x\\y.rs", "C:/proj")).toBe("D:\\x\\y.rs");
    expect(resolveFileLinkPath("file:///C:/proj/report.html", "C:/proj")).toBe("file:///C:/proj/report.html");
    expect(resolveFileLinkPath("https://example.com/report.html", "C:/proj")).toBe("https://example.com/report.html");
  });

  it("无工作区时原样返回相对路径", () => {
    expect(resolveFileLinkPath("src/App.vue")).toBe("src/App.vue");
  });
});
