import { describe, it, expect } from "vitest";
import {
  KB_CONTENT_MAX_BYTES,
  KB_DOC_MAX_BYTES,
  KB_INGEST_MAX_BYTES,
  KB_NOT_CONNECTED_TEXT,
  KB_READ_MAX_CHARS,
  KB_LONG_DOC_HINT_CHARS,
  formatDocument,
  formatDocumentList,
  formatDocumentView,
  formatFailure,
  formatIngestResult,
  formatSavedDocument,
  formatSearchHits,
  formatSpaces,
  formatTooLarge,
  stripHighlight,
  warnTruncatedSource,
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
    [{ kind: "unauthorized" }, "(401)", "sign in again"],
    [{ kind: "forbidden" }, "permission", "Ask the user"],
    [{ kind: "not_found" }, "(404)", "Use search"],
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
    expect(empty).not.toContain("create_document"); // 空列表文案不点名任何工具：消息保持中性，不替模型指挥工具
  });

  it("子文档带 parentId 时追加 (under …)（列表里能看出层级）", () => {
    const text = formatDocumentList([
      { id: "d2", parentId: "d1", slug: "b", title: "子页", versionNo: 1, status: "draft", updatedAt: "2026-09-13T00:00:00Z" },
    ]);
    expect(text).toContain("(under d1)");
  });
});

describe("KB_NOT_CONNECTED_TEXT", () => {
  it("指向知识库面板登录（这是「未配置」唯一的用户可见出口）", () => {
    expect(KB_NOT_CONNECTED_TEXT).toContain("知识库 panel");
    expect(KB_NOT_CONNECTED_TEXT).toContain("sign in");
  });
});

describe("写侧文案与尺寸常量", () => {
  it("尺寸常量就是设计定的三个数（不是拍脑袋的近似值）", () => {
    expect(KB_CONTENT_MAX_BYTES).toBe(256 * 1024);
    expect(KB_DOC_MAX_BYTES).toBe(1024 * 1024);
    expect(KB_INGEST_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it("formatTooLarge 说清超了什么、上限多少、下一步怎么办", () => {
    const text = formatTooLarge("content", KB_CONTENT_MAX_BYTES);
    expect(text).toContain("content");
    expect(text).toContain("256 KiB");
    expect(text).toContain("Split");
  });

  it("formatTooLarge 在 MiB 档不显示成 1024 KiB", () => {
    expect(formatTooLarge("the file", KB_INGEST_MAX_BYTES)).toContain("32 MiB");
    expect(formatTooLarge("the file", KB_INGEST_MAX_BYTES)).not.toContain("KiB");
  });

  it("formatSavedDocument 带动词、documentId 与版本号；合并窗口单独提示", () => {
    const text = formatSavedDocument({ documentId: "d1", revisionId: "r1", versionNo: 4, merged: false }, "Created");
    expect(text).toContain("Created");
    expect(text).toContain("d1");
    expect(text).toContain("4");
    expect(text).not.toContain("merge window");
    expect(formatSavedDocument({ documentId: "d1", revisionId: "r1", versionNo: 2, merged: true }, "Updated"))
      .toContain("merge window");
  });

  it("formatIngestResult 带标题/documentId/parser；有 warnings 时如实列出", () => {
    const base = formatIngestResult({ documentId: "d1", revisionId: "r1", title: "规范", backend: "docx-to-md" });
    expect(base).toContain("规范");
    expect(base).toContain("d1");
    expect(base).toContain("docx-to-md");
    expect(base).not.toContain("warnings");
    expect(
      formatIngestResult({ documentId: "d1", revisionId: "r1", title: "规范", backend: "docx-lite", warnings: ["结构丢失"] }),
    ).toContain("结构丢失");
  });

  it("warnTruncatedSource：旧文没超读上限 → 空串（不乱吓人）", () => {
    expect(warnTruncatedSource("x".repeat(KB_READ_MAX_CHARS))).toBe("");
  });

  it("warnTruncatedSource：旧文超读上限 → 说清尾部可能已丢 + 给出回滚路径", () => {
    const text = warnTruncatedSource("x".repeat(KB_READ_MAX_CHARS + 1));
    expect(text).toContain("longer than read_document can show");
    expect(text).toContain("version history");
    expect(text).toContain(String(KB_READ_MAX_CHARS + 1)); // 旧文有多长要报出来
  });
});

describe("formatDocumentList 的节点类型标注", () => {
  /** 摘要的最小构造：本组用例只关心 kind / 标题 / 版本。 */
  function node(id: string, title: string, kind: string, versionNo = 1) {
    return {
      id,
      parentId: null,
      kind,
      slug: id,
      title,
      versionNo,
      status: "draft",
      updatedAt: "2026-09-18T00:00:00Z",
    };
  }

  it("文件夹标 [folder]，文档标 [doc] —— 模型据此知道哪个能当 parentId", () => {
    const text = formatDocumentList([node("f1", "运维手册", "folder", 0), node("d1", "回滚手册", "doc")]);
    expect(text).toContain("[folder] 运维手册");
    expect(text).toContain("[doc] 回滚手册");
  });

  it("文件夹不显示版本号（版本对容器没有意义，显示只会误导）", () => {
    const text = formatDocumentList([node("f1", "运维手册", "folder", 0)]);
    expect(text).toContain("[folder] 运维手册");
    expect(text).not.toContain("v0");
  });

  it("kind 缺省按 doc 兜底 —— 老服务端不带这个字段时不能把节点吞掉", () => {
    const text = formatDocumentList([
      { id: "d1", parentId: null, slug: "d1", title: "旧文档", versionNo: 1, status: "draft", updatedAt: "2026-09-18T00:00:00Z" },
    ]);
    expect(text).toContain("[doc] 旧文档");
  });
});

describe("formatDocumentView（read_document 的按需读取）", () => {
  const doc = (content: string): KbDocument =>
    ({ id: "d1", spaceId: "s1", title: "手册", versionNo: 3, status: "published", content }) as KbDocument;
  const BODY = "# 手册\n前言\n## 回滚\n步骤\n### 库\n迁移\n## 监控\n看板";

  it("没有选择器 = 整篇（短文档不带提示）", () => {
    const out = formatDocumentView(doc(BODY), {});
    expect(out).toContain("看板");
    expect(out).not.toContain("Note: this document is long");
  });

  it("长文档整篇读：提示在正文之前，并点名 outline / section", () => {
    const out = formatDocument(doc(`# t\n${"x".repeat(KB_LONG_DOC_HINT_CHARS)}`));
    expect(out.indexOf("Note: this document is long")).toBeGreaterThan(-1);
    expect(out.indexOf("Note: this document is long")).toBeLessThan(out.indexOf("xxxx"));
    expect(out).toContain("outline: true");
  });

  it("outline：标题 + 行区间，不含正文", () => {
    const out = formatDocumentView(doc(BODY), { outline: true });
    expect(out).toContain("L3-L6");
    expect(out).toContain("## 回滚");
    expect(out).toContain("### 库");
    expect(out).not.toContain("看板");
    expect(out).toContain("section");
  });

  it("outline 无标题：直说并给出按行读的出路", () => {
    const out = formatDocumentView(doc("只有正文"), { outline: true });
    expect(out).toContain("No headings");
    expect(out).toContain("startLine");
  });

  it("section：只返回这一节（含子节），头部写明行区间", () => {
    const out = formatDocumentView(doc(BODY), { section: "回滚" });
    expect(out).toContain('section "回滚", lines 3-6 of 8');
    expect(out).toContain("迁移");
    expect(out).not.toContain("看板");
  });

  it("section 多处命中：列出候选；没命中：列出现有标题", () => {
    const two = doc("## 回滚 A\nx\n## 回滚 B\ny");
    expect(formatDocumentView(two, { section: "回滚" })).toContain("matches 2 headings");
    const none = formatDocumentView(doc(BODY), { section: "不存在" });
    expect(none).toContain('No heading matches "不存在"');
    expect(none).toContain("## 监控");
  });

  it("行区间：闭区间；省略 endLine = 到文末；越界与反向给文本提示", () => {
    expect(formatDocumentView(doc(BODY), { startLine: 3, endLine: 4 })).toContain("lines 3-4 of 8");
    expect(formatDocumentView(doc(BODY), { startLine: 7 })).toContain("看板");
    expect(formatDocumentView(doc(BODY), { startLine: 99 })).toContain("beyond the end");
    expect(formatDocumentView(doc(BODY), { startLine: 5, endLine: 2 })).toContain("Empty range");
  });

  it("优先级 outline > section > 行区间", () => {
    const out = formatDocumentView(doc(BODY), { outline: true, section: "回滚", startLine: 1 });
    expect(out).toContain("Outline");
  });

  it("单节超长也截断并给出收窄办法", () => {
    const out = formatDocumentView(doc(`## 大\n${"y".repeat(KB_READ_MAX_CHARS + 10)}`), { section: "大" });
    expect(out).toContain("Truncated");
    expect(out).toContain("startLine");
  });
});

