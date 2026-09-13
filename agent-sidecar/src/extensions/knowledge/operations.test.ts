import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// readFileSync 默认透传真实实现；只有 readFails 打开时抛。这一臂（stat 通过、read 抛，
// 如 EACCES / EBUSY）要进程外的权限状态才触发，没有可移植的真实复现法，故用一层薄
// mock 钉住；statSync 等其余 fs 能力仍是真实现（ingest 的尺寸/存在性用例照常）。
const fsProbe = vi.hoisted(() => ({ readError: null as Error | string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const realRead = real.readFileSync;
  return {
    ...real,
    readFileSync: (path: Parameters<typeof realRead>[0], options?: Parameters<typeof realRead>[1]) => {
      if (fsProbe.readError !== null) throw fsProbe.readError;
      return realRead(path, options);
    },
  };
});
import {
  appendToDocument,
  createDocument,
  ingestFile,
  resolveWriteTarget,
  updateDocument,
} from "./operations.js";
import { KB_CONTENT_MAX_BYTES, KB_DOC_MAX_BYTES, KB_INGEST_MAX_BYTES } from "./format.js";
import type { KbClient, KbDocument, KbResult } from "./client.js";

/** 假 client：只实现被测路径用到的方法，返回值由用例给定。 */
function fakeClient(over: Partial<KbClient> = {}): KbClient {
  return {
    getJson: vi.fn(async () => ({ ok: false, failure: { kind: "not_found" } }) as KbResult<never>),
    sendJson: vi.fn(async () => ({ ok: false, failure: { kind: "server", status: 500 } }) as KbResult<never>),
    sendFile: vi.fn(async () => ({ ok: false, failure: { kind: "server", status: 500 } }) as KbResult<never>),
    ...over,
  } as KbClient;
}

const doc: KbDocument = {
  id: "d1", spaceId: "s1", slug: "a", title: "原标题", content: "旧正文", versionNo: 3, status: "published",
};

describe("resolveWriteTarget", () => {
  it("传了 spaceId → 不再拉空间列表（少一次请求）", async () => {
    const c = fakeClient();
    expect(await resolveWriteTarget(c, "s1")).toEqual({ kind: "ok", id: "s1" });
    expect(c.getJson).not.toHaveBeenCalled();
  });

  it("省略 → 拉 /api/spaces 交给决策：唯一空间自动选", async () => {
    const c = fakeClient({ getJson: vi.fn(async () => ({ ok: true, data: [{ id: "s1", name: "工程" }] }) as KbResult<never>) });
    expect(await resolveWriteTarget(c)).toEqual({ kind: "ok", id: "s1" });
  });

  it("省略 + 拉列表失败 → 失败文本（不是异常）", async () => {
    const c = fakeClient({ getJson: vi.fn(async () => ({ ok: false, failure: { kind: "unauthorized" } }) as KbResult<never>) });
    const d = await resolveWriteTarget(c);
    expect(d.kind).toBe("ask");
    expect(d.kind === "ask" && d.text).toContain("sign in again");
  });
});

describe("createDocument", () => {
  it("POST /api/documents，带 spaceId/title/content，成功回执带 documentId", async () => {
    const sendJson = vi.fn(async () => ({
      ok: true, data: { documentId: "d9", revisionId: "r9", versionNo: 1, merged: false },
    }) as KbResult<never>);
    const text = await createDocument(fakeClient({ sendJson }), {
      spaceId: "s1", title: "新文档", content: "正文",
    });
    expect(sendJson).toHaveBeenCalledWith("/api/documents", "POST", { spaceId: "s1", title: "新文档", content: "正文" });
    expect(text).toContain("Created");
    expect(text).toContain("d9");
  });

  it("有 parentId 才带 parentId（不塞 null 字段）", async () => {
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d", revisionId: "r", versionNo: 1, merged: false } }) as KbResult<never>);
    await createDocument(fakeClient({ sendJson }), { spaceId: "s1", title: "t", content: "c", parentId: "p1" });
    expect(sendJson).toHaveBeenCalledWith("/api/documents", "POST", expect.objectContaining({ parentId: "p1" }));
  });

  it("content 超 256 KiB → 拒绝且不发请求", async () => {
    const sendJson = vi.fn();
    const text = await createDocument(fakeClient({ sendJson }), {
      spaceId: "s1", title: "t", content: "x".repeat(KB_CONTENT_MAX_BYTES + 1),
    });
    expect(text).toContain("Refused");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("服务端 403 → 权限引导文本", async () => {
    const sendJson = vi.fn(async () => ({ ok: false, failure: { kind: "forbidden" } }) as KbResult<never>);
    expect(await createDocument(fakeClient({ sendJson }), { spaceId: "s1", title: "t", content: "c" }))
      .toContain("permission");
  });
});

describe("updateDocument（整篇替换，先读后写）", () => {
  it("先 GET 再用新正文 PUT，title 沿用当前版本", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r2", versionNo: 4, merged: false } }) as KbResult<never>);
    const text = await updateDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "新正文" });
    expect(getJson).toHaveBeenCalledWith("/api/documents/d1");
    expect(sendJson).toHaveBeenCalledWith("/api/documents/d1", "PUT", { title: "原标题", content: "新正文" });
    expect(text).toContain("Updated");
    expect(text).toContain("4");
  });

  it("显式 title 覆盖当前标题", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r", versionNo: 4, merged: false } }) as KbResult<never>);
    await updateDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "c", title: "新标题" });
    expect(sendJson).toHaveBeenCalledWith("/api/documents/d1", "PUT", expect.objectContaining({ title: "新标题" }));
  });

  it("读失败（404）→ 直接返回失败文本，不尝试写", async () => {
    const sendJson = vi.fn();
    const text = await updateDocument(fakeClient({ sendJson }), { documentId: "gone", content: "c" });
    expect(text).toContain("404");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("新正文超 256 KiB → 拒绝，GET 都不发（尺寸闸在读之前）", async () => {
    const getJson = vi.fn();
    const sendJson = vi.fn();
    const text = await updateDocument(fakeClient({ getJson, sendJson }), {
      documentId: "d1", content: "x".repeat(KB_CONTENT_MAX_BYTES + 1),
    });
    expect(text).toContain("Refused");
    expect(getJson).not.toHaveBeenCalled();
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("409（他人持锁）→ 带服务端 message 的重试引导", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: false, failure: { kind: "locked", message: "正被张三编辑" } }) as KbResult<never>);
    expect(await updateDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "c" }))
      .toContain("正被张三编辑");
  });
});

describe("appendToDocument（读旧正文 → 拼接 → 整篇写回）", () => {
  it("PUT body 必须含旧正文（这就是「先读后写」的全部意义）", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r", versionNo: 5, merged: false } }) as KbResult<never>);
    const text = await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "新增段落" });
    expect(sendJson).toHaveBeenCalledWith(
      "/api/documents/d1",
      "PUT",
      expect.objectContaining({ title: "原标题", content: "旧正文\n\n新增段落" }),
    );
    expect(text).toContain("Appended");
  });

  it("读失败（404）→ 直接返回失败文本，不发 PUT", async () => {
    const sendJson = vi.fn();
    const text = await appendToDocument(fakeClient({ sendJson }), { documentId: "gone", content: "x" });
    expect(text).toContain("404");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("写回被拒（403）→ 透出权限引导，绝不谎报成功", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: false, failure: { kind: "forbidden" } }) as KbResult<never>);
    expect(await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "x" }))
      .toContain("permission");
  });

  it("追加后整篇超 1 MiB → 拒绝且不发 PUT（单次上限挡不住累积）", async () => {
    const big = { ...doc, content: "x".repeat(KB_DOC_MAX_BYTES - 10) };
    const getJson = vi.fn(async () => ({ ok: true, data: big }) as KbResult<never>);
    const sendJson = vi.fn();
    const text = await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "y".repeat(100) });
    expect(text).toContain("Refused");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("changeNote 有才带（写进版本历史）", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r", versionNo: 5, merged: false } }) as KbResult<never>);
    await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "x", changeNote: "补一条" });
    expect(sendJson).toHaveBeenCalledWith(
      "/api/documents/d1",
      "PUT",
      expect.objectContaining({ changeNote: "补一条" }),
    );
  });

  it("读回的正文不是串（形态漂移）→ 拒绝写回，不发 PUT", async () => {
    // 照 `?? ""` 拼的话写回的就只剩新段落——别人的正文被静默删掉（spec 附录 B 记过这条：
    // P1 删掉 `?? ""` 防御臂正是因为这个后果），所以这里必须宁可不写。
    const getJson = vi.fn(async () => ({ ok: true, data: { ...doc, content: undefined } }) as KbResult<never>);
    const sendJson = vi.fn();
    const text = await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "x" });
    expect(text).toContain("unexpected response");
    expect(sendJson).not.toHaveBeenCalled();
  });
});

describe("ingestFile（导入磁盘文件）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-ingest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("相对路径按会话 cwd 解析，multipart 文件名取 basename", async () => {
    writeFileSync(join(dir, "spec.md"), "# 规范\n正文");
    const sendFile = vi.fn(async () => ({
      ok: true, data: { documentId: "d1", revisionId: "r1", title: "规范", backend: "markdown" },
    }) as KbResult<never>);
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "spec.md", spaceId: "s1" });
    expect(sendFile).toHaveBeenCalledTimes(1);
    // 第三个位置参数就是上传体：只看 filename 与字节数（`as` 是为了给未定型 mock 的
    // calls 元组一个形状——不给的话 `calls[0][2]` 是「空元组没有索引 2」）。
    const upload = (
      sendFile.mock.calls[0] as unknown as [unknown, unknown, { filename: string; data: Uint8Array }]
    )[2];
    expect(sendFile).toHaveBeenCalledWith(
      "/api/ingest",
      { spaceId: "s1", parentId: undefined },
      expect.objectContaining({ filename: "spec.md" }),
    );
    expect(upload.filename).toBe("spec.md");
    expect(upload.data.byteLength).toBeGreaterThan(0);
    expect(text).toContain("Imported");
    expect(text).toContain("markdown");
  });

  it("绝对路径直接用", async () => {
    const abs = join(dir, "abs.txt");
    writeFileSync(abs, "x");
    const sendFile = vi.fn(async () => ({ ok: true, data: { documentId: "d", revisionId: "r", title: "t", backend: "markdown" } }) as KbResult<never>);
    await ingestFile(fakeClient({ sendFile }), "/some/other/cwd", { filePath: abs, spaceId: "s1" });
    const upload = (sendFile.mock.calls[0] as unknown as [unknown, unknown, { filename: string }])[2];
    expect(upload.filename).toBe("abs.txt");
  });

  it("文件不存在 → 说明相对路径规则，不发请求", async () => {
    const sendFile = vi.fn();
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "nope.md", spaceId: "s1" });
    expect(text).toContain("File not found");
    expect(text).toContain("working directory");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("路径是目录 → 明确说不是文件，不发请求", async () => {
    const sendFile = vi.fn();
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: ".", spaceId: "s1" });
    expect(text).toContain("Not a file");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("超过 32 MiB → 拒绝且不读文件、不发请求", async () => {
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(KB_INGEST_MAX_BYTES + 1));
    const sendFile = vi.fn();
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "big.bin", spaceId: "s1" });
    expect(text).toContain("Refused");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("服务端解析失败（400）→ 透出服务端 message", async () => {
    writeFileSync(join(dir, "a.xlsx"), "x");
    const sendFile = vi.fn(async () => ({
      ok: false, failure: { kind: "bad_request", message: "不支持的文件类型" },
    }) as KbResult<never>);
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "a.xlsx", spaceId: "s1" });
    expect(text).toContain("不支持的文件类型");
  });

  it("stat 过但 read 抛（EACCES）→ 报出原始原因，不发请求", async () => {
    writeFileSync(join(dir, "spec.md"), "x"); // 文件真实存在 → 尺寸闸与 isFile 都过
    fsProbe.readError = new Error("EACCES: permission denied, open 'spec.md'");
    try {
      const sendFile = vi.fn();
      const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "spec.md", spaceId: "s1" });
      expect(text).toContain("Could not read");
      expect(text).toContain("EACCES");
      expect(sendFile).not.toHaveBeenCalled();
    } finally {
      fsProbe.readError = null; // 复位：漏复位会污染后续用例
    }
  });

  it("抛的不是 Error → 也要有话说（String(e) 臂，不吞错）", async () => {
    writeFileSync(join(dir, "spec.md"), "x");
    fsProbe.readError = "boom-as-string";
    try {
      const sendFile = vi.fn();
      const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "spec.md", spaceId: "s1" });
      expect(text).toContain("Could not read");
      expect(text).toContain("boom-as-string");
      expect(sendFile).not.toHaveBeenCalled();
    } finally {
      fsProbe.readError = null;
    }
  });
});
