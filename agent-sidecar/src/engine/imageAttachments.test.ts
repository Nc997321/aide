import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  IMAGE_MAX_BYTES,
  hasPathAttachment,
  normalizeInlineImages,
  resolveImageAttachments,
  sniffImageMediaType,
} from "./imageAttachments.js";

const dir = mkdtempSync(path.join(tmpdir(), "img-att-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

// 嗅探只看文件头，所以最小魔数头即可（不需要真图解码）
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
const GIF = Buffer.from("GIF89a......", "latin1");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "latin1"),
]);

describe("sniffImageMediaType — 魔数嗅探", () => {
  it("四种受支持格式各自命中", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(sniffImageMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMediaType(GIF)).toBe("image/gif");
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
  });

  it("非图片与过短缓冲一律 null（不猜）", () => {
    expect(sniffImageMediaType(Buffer.from("#!/bin/sh\ncat /etc/passwd\n", "latin1"))).toBeNull();
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMediaType(Buffer.from([0x89, 0x50]))).toBeNull();
    // RIFF 容器但不是 WEBP（如 wav）也不认
    const wave = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1")]);
    expect(sniffImageMediaType(wave)).toBeNull();
  });
});

describe("resolveImageAttachments — 线形状归一", () => {
  it("无 images / 空数组 → undefined（保持「不发该字段」的既有语义）", async () => {
    expect(await resolveImageAttachments(undefined)).toBeUndefined();
    expect(await resolveImageAttachments([])).toBeUndefined();
  });

  it("内嵌形式原样透传（对既有调用方零改动）", async () => {
    expect(await resolveImageAttachments([{ data: "aGk=", mediaType: "image/png" }])).toEqual([
      { data: "aGk=", mediaType: "image/png" },
    ]);
  });

  it("路径形式：读出字节并按魔数定媒体类型（调用方不需要传 mediaType）", async () => {
    const p = write("photo.jpg", JPEG);
    expect(await resolveImageAttachments([{ path: p }])).toEqual([
      { data: JPEG.toString("base64"), mediaType: "image/jpeg" },
    ]);
  });

  it("路径不存在 → 抛出（由 enqueueSend 报成非致命 error 帧，不静默丢消息）", async () => {
    await expect(resolveImageAttachments([{ path: path.join(dir, "nope.png") }])).rejects.toThrow(
      /图片读取失败/,
    );
  });

  it("不是图片的文件 → 抛出（挡住「传路径 = 任意文件外带通道」）", async () => {
    const p = write("secret.txt", Buffer.from("SECRET-TOKEN", "latin1"));
    await expect(resolveImageAttachments([{ path: p }])).rejects.toThrow(/不是受支持的图片/);
  });

  it("超过读入上限 → 抛出（保护本进程内存；不替 API 裁决图片是否够小）", async () => {
    const p = write("huge.png", Buffer.alloc(IMAGE_MAX_BYTES + 1));
    await expect(resolveImageAttachments([{ path: p }])).rejects.toThrow(/超过引擎读入上限/);
  });

  it("内嵌形式缺 data / 缺 mediaType → 抛出（stdin 面无 schema，这里补齐同一判据）", async () => {
    await expect(resolveImageAttachments([{ data: "", mediaType: "image/png" }])).rejects.toThrow(/缺 data/);
    await expect(resolveImageAttachments([{ data: "aGk=" } as never])).rejects.toThrow(/mediaType/);
  });
});

describe("同步归一（无 path 时的快路径）与形态判定", () => {
  it("hasPathAttachment：只有 path 形态才算（内嵌与空都不算）", () => {
    expect(hasPathAttachment(undefined)).toBe(false);
    expect(hasPathAttachment([])).toBe(false);
    expect(hasPathAttachment([{ data: "aGk=", mediaType: "image/png" }])).toBe(false);
    expect(hasPathAttachment([{ path: "/tmp/a.png" }])).toBe(true);
    expect(hasPathAttachment([{ data: "aGk=", mediaType: "image/png" }, { path: "/tmp/a.png" }])).toBe(true);
  });

  it("normalizeInlineImages：**同步**返回（不返回 Promise）——send 的同步前缀依赖这点", () => {
    const out = normalizeInlineImages([{ data: "aGk=", mediaType: "image/jpeg" }]);
    expect(out).toEqual([{ data: "aGk=", mediaType: "image/jpeg" }]);
    expect(out).not.toBeInstanceOf(Promise);
    expect(normalizeInlineImages(undefined)).toBeUndefined();
  });

  it("normalizeInlineImages 遇到 path 抛错（配对使用，误用要响）", () => {
    expect(() => normalizeInlineImages([{ path: "/tmp/a.png" }])).toThrow(/hasPathAttachment/);
  });
});
