import { describe, it, expect } from "vitest";
import {
  KB_NOT_CONNECTED_TEXT,
  KB_READ_MAX_CHARS,
  formatDocument,
  formatDocumentList,
  formatFailure,
  formatSearchHits,
  formatSpaces,
  stripHighlight,
} from "./format.js";
import type { KbDocument, KbFailure } from "./client.js";

describe("stripHighlight", () => {
  it("剥掉 [[HL]] / [[/HL]] 哨兵，保留文字", () => {
    expect(stripHighlight("部署[[HL]]回滚[[/HL]]流程")).toBe("部署回滚流程");
  });
});

describe("formatFailure（每条失败原因都给下一步，永不抛）", () => {
  // 第三项 = 该臂的「下一步」针：只钉回显抓不到「漏写下一步」，必须逐臂机械断言。
  const cases: [KbFailure, string, string][] = [
    [{ kind: "unauthorized" }, "sign in again", "sign in again"],
    [{ kind: "forbidden" }, "permission", "Ask the user"],
    [{ kind: "not_found" }, "search", "Use search"],
    [{ kind: "locked", message: "被占用" }, "被占用", "Wait a moment and retry"],
    [{ kind: "bad_request", message: "标题不能为空" }, "标题不能为空", "Correct the input"],
    [{ kind: "server", status: 502 }, "502", "Retry once"],
    [{ kind: "network", baseUrl: "http://kb:8788", detail: "ECONNREFUSED" }, "http://kb:8788", "Retry once"],
    [{ kind: "timeout" }, "timed out", "Retry once"],
    [{ kind: "bad_response", detail: "not JSON" }, "not JSON", "could not be parsed"],
  ];

  it.each(cases)("%o 的文案含关键指引与下一步", (failure, needle, nextStep) => {
    const text = formatFailure(failure);
    expect(typeof text).toBe("string");
    expect(text).toContain(needle);
    expect(text).toContain(nextStep); // 「每臂都给下一步」这条约束的机械检查
  });

  it("unauthorized 明确说不需要开新会话（现读凭据，重登即生效）", () => {
    expect(formatFailure({ kind: "unauthorized" })).toContain("no new session");
  });

  it("network 文案带 baseUrl 但不含 token", () => {
    const text = formatFailure({ kind: "network", baseUrl: "http://kb:8788", detail: "ECONNREFUSED" });
    expect(text).toContain("http://kb:8788");
    expect(text).not.toContain("Bearer");
  });
});

describe("formatSearchHits", () => {
  it("命中列表带 documentId / 空间 / 摘要", () => {
    const text = formatSearchHits({
      query: "部署",
      hits: [
        { documentId: "d1", spaceId: "s1", title: "上线检查", versionNo: 3, rank: 0.5, snippet: "[[HL]]部署[[/HL]]前" },
      ],
    });
    expect(text).toContain("d1");
    expect(text).toContain("上线检查");
    expect(text).toContain("v3");
    expect(text).toContain("部署前");
    expect(text).not.toContain("[[HL]]");
  });

  it("零命中给换关键词的指引（不是错误）", () => {
    const text = formatSearchHits({ query: "不存在的东西", hits: [] });
    expect(text).toContain("不存在的东西");
    expect(text.toLowerCase()).toContain("no match");
  });
});

describe("formatDocument", () => {
  const doc: KbDocument = {
    id: "d1", spaceId: "s1", slug: "a", title: "标题", content: "正文", versionNo: 7, status: "published",
  };

  it("带标题 / id / 版本号 / 正文", () => {
    const text = formatDocument(doc);
    expect(text).toContain("标题");
    expect(text).toContain("d1");
    expect(text).toContain("7");
    expect(text).toContain("正文");
  });

  it("超长截断并注明（不静默丢内容）", () => {
    const text = formatDocument({ ...doc, content: "x".repeat(KB_READ_MAX_CHARS + 10) });
    expect(text).toContain("Truncated");
    expect(text.length).toBeLessThan(KB_READ_MAX_CHARS + 500);
  });
});

describe("formatSpaces / formatDocumentList", () => {
  it("空间列表带 id 与名称", () => {
    const text = formatSpaces([{ id: "s1", key: "eng", name: "工程", visibility: "internal", role: "editor" }]);
    expect(text).toContain("s1");
    expect(text).toContain("工程");
    expect(text).toContain("editor");
  });

  it("零空间时给出检查成员资格的指引", () => {
    expect(formatSpaces([])).toContain("no knowledge base spaces");
  });

  it("文档列表带 id / 版本 / 更新时间；空列表不提到不存在的工具", () => {
    const text = formatDocumentList([
      { id: "d1", parentId: null, slug: "a", title: "标题", versionNo: 2, status: "published", updatedAt: "2026-09-13T00:00:00Z" },
    ]);
    expect(text).toContain("d1");
    expect(text).toContain("v2");
    const empty = formatDocumentList([]);
    expect(empty).toContain("no documents");
    expect(empty).not.toContain("create_document"); // P1 没有写工具，文案不许点名不存在的工具
  });
});

describe("KB_NOT_CONNECTED_TEXT", () => {
  it("指向知识库面板登录（这是「未配置」唯一的用户可见出口）", () => {
    expect(KB_NOT_CONNECTED_TEXT).toContain("知识库 panel");
    expect(KB_NOT_CONNECTED_TEXT).toContain("sign in");
  });
});
