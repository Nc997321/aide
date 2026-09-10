import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectImageUnsupported, findSessionJsonl, rollbackImageMessage } from "./imageRollback.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "aide-rollback-"));
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const SYNTHETIC_400 = {
  type: "assistant",
  isApiErrorMessage: true,
  apiErrorStatus: 400,
  message: {
    role: "assistant",
    model: "<synthetic>",
    content: [{ type: "text", text: "API Error: 400 this model does not support image input (ref: abc)" }],
  },
};

describe("detectImageUnsupported", () => {
  it("recognizes the synthetic assistant 400 (real SDK shape)", () => {
    expect(detectImageUnsupported(SYNTHETIC_400)).toBe(true);
  });

  it("recognizes the result error shape", () => {
    expect(detectImageUnsupported({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 400,
      errors: ["API Error: 400 this model does not support image input"],
    })).toBe(true);
  });

  it("recognizes the real SDK event shape: is_api_error_message (snake_case)", () => {
    // 2026-08-21 smoke 实锤：jsonl 写 camelCase，但 SDK 事件流转发时是
    // is_api_error_message: true（且无 apiErrorStatus 字段）——camelCase 分支
    // 实际永不命中，回滚从未触发。这个用例钉住 snake_case 形态。
    expect(detectImageUnsupported({
      type: "assistant",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: 400 this model does not support image input (ref: abc)" }] },
      is_api_error_message: true,
    })).toBe(true);
  });

  it.each([
    { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 401, message: { content: [{ type: "text", text: "Unauthorized" }] } },
    { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 400, message: { content: [{ type: "text", text: "invalid model" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "normal reply" }] } },
    { type: "result", subtype: "success", is_error: false },
  ])("does not misclassify %o", (msg) => {
    expect(detectImageUnsupported(msg)).toBe(false);
  });
});

describe("findSessionJsonl", () => {
  it("finds the jsonl by id across project folders", () => {
    const root = tempDir();
    mkdirSync(join(root, "C--Users-heaven-IdeaProjects-aide"), { recursive: true });
    const target = join(root, "C--Users-heaven-IdeaProjects-aide", "abc-123.jsonl");
    writeFileSync(target, "{}");

    expect(findSessionJsonl(root, "abc-123")).toBe(target);
    expect(findSessionJsonl(root, "missing")).toBeNull();
  });
});

describe("rollbackImageMessage", () => {
  it("removes the last image-bearing user message and synthetic 400 lines, keeping order", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    const before = [
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "x" } }, { type: "text", text: "看这张图" }] } }),
      line(SYNTHETIC_400),
    ].join("\n");
    writeFileSync(file, before);

    const result = rollbackImageMessage(file);

    expect(result).toEqual({ text: "看这张图", removed: true, kind: "user" });
    const after = readFileSync(file, "utf8");
    expect(after).not.toContain("看这张图");
    expect(after).not.toContain("does not support image");
    expect(after).toContain("hello");
    expect(after).toContain('"hi"');
  });

  it("model-read image (tool_result): replaces image with error text, keeps tool_use pairing", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    const before = [
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "keep" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.png" } }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", data: "y" } }] }] } }),
      line(SYNTHETIC_400),
    ].join("\n");
    writeFileSync(file, before);

    const result = rollbackImageMessage(file);

    // 场景 B：不回填输入框（用户文本仍在历史里），但确实发生了回滚
    expect(result).toEqual({ text: "", removed: true, kind: "tool" });
    const after = readFileSync(file, "utf8");
    // tool_use 配对保留（行不删），tool_result 图片被替换为错误文本 + is_error
    expect(after).toContain('"tool_use"');
    expect(after).toContain('"tool_result"');
    expect(after).toContain("图片输入不可用");
    expect(after).toContain('"is_error":true');
    expect(after).not.toContain('"type":"image"');
    // synthetic 400 行仍被清掉（错误文本里故意含 "does not support image" 短语，
    // 所以按 isApiErrorMessage 特征断言，不按短语）
    expect(after).not.toContain("isApiErrorMessage");
  });

  it("model-read image: user text block alongside tool_result stays in history", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    const before = [
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "看下这个目录" }, { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", data: "y" } }] }] } }),
    ].join("\n");
    writeFileSync(file, before);

    const result = rollbackImageMessage(file);

    expect(result).toEqual({ text: "", removed: true, kind: "tool" });
    const after = readFileSync(file, "utf8");
    // 用户文本保留（消息不删），只有图片被替换
    expect(after).toContain("看下这个目录");
    expect(after).toContain("图片输入不可用");
    expect(after).not.toContain('"type":"image"');
  });

  it("removes only the last image-bearing message, not earlier ones", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    const before = [
      line({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "a" } }, { type: "text", text: "第一张" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "b" } }, { type: "text", text: "第二张" }] } }),
    ].join("\n");
    writeFileSync(file, before);

    const result = rollbackImageMessage(file);

    expect(result).toEqual({ text: "第二张", removed: true, kind: "user" });
    const after = readFileSync(file, "utf8");
    expect(after).toContain("第一张");
    expect(after).not.toContain("第二张");
  });

  it("scenario A truncates by byte: drops trailing incomplete lines and works with CRLF", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    // CRLF 行尾 + 带图消息之后有一条半截写入的不完整行（CLI 被杀时的残留）
    const before = [
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "x" } }, { type: "text", text: "看这张图" }] } }),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial write not finish',
    ].join("\r\n");
    writeFileSync(file, before);

    const result = rollbackImageMessage(file);

    expect(result).toEqual({ text: "看这张图", removed: true, kind: "user" });
    const after = readFileSync(file, "utf8");
    expect(after).toContain("hello");
    expect(after).not.toContain("看这张图");
    expect(after).not.toContain("partial write");
  });

  it("does not touch the file when there is no image-bearing message", () => {
    const dir = tempDir();
    const file = join(dir, "s.jsonl");
    const before = line({ type: "user", message: { role: "user", content: [{ type: "text", text: "plain" }] } });
    writeFileSync(file, before);

    const result = rollbackImageMessage(file);

    expect(result).toEqual({ text: "", removed: false, kind: "user" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("returns removed:false for a missing file", () => {
    expect(rollbackImageMessage(join(tempDir(), "nope.jsonl"))).toEqual({ text: "", removed: false, kind: "user" });
  });
});
