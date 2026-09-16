// 图片附件的**线形状归一**：把「引擎本地路径」形式读成内嵌 base64。
//
// 为什么要有路径形式：headless 的 /invoke 有 1MB body 硬上限（headless-server.ts），
// base64 再膨胀 4/3——手机原图（2~4MB → 2.7~5.3MB）压根过不来。而「让引擎看懂一张
// 高清照片」是引擎**自己的能力**，不是某个调用方的怪癖；引擎与网关同机（网关 spawn
// 它），让网关只传路径、引擎本地读，是这条能力最省的实现。
//
// 归一在 send 入口完成（守门，对齐 outputStyle 的既有范式）：下游（buildUserMessage
// / 插队队列 / display 通道）永远只见内嵌形式，不认识 path——所以"两种线形状"的
// 复杂度到此为止，不外溢。
//
// 两道守卫，都不可省：
// 1. **尺寸上限**：路径形式绕开了 body 上限，若不给读入上限，一个巨大的路径就能把
//    sidecar 读爆内存。上限只保护**本进程**（读入 → base64 ≈ ×1.33 → JSON 副本），
//    不替 API 做裁决——API 自己的图片上限让 API 去报错。
// 2. **魔数嗅探**：读进来的必须是受支持的图片（png / jpeg / gif / webp）。否则
//    「传路径」就成了一条任意文件外带通道（读个非图片文件塞进模型请求）。嗅探同时
//    决定 media_type——字节在我们手里，权威值不该由调用方猜。
import { readFile } from "node:fs/promises";
import type { ImageAttachment, WireImageAttachment } from "./types.js";

/** 单张图片读入上限（字节）。取值依据：放得下 48MP 手机 JPEG（8~12MB）与常见扫描件，
 *  同时把最坏内存压在约 27MB/张。这是**本进程的保护线**，不是模型的能力线。 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 受支持的图片魔数嗅探；非图片返回 null。判定用文件头前几字节，不做完整解码。 */
export function sniffImageMediaType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF87a / GIF89a 共用前三字节
  if (buf.length >= 6 && buf.subarray(0, 3).toString("latin1") === "GIF") {
    return "image/gif";
  }
  // WebP 是 RIFF 容器：前 4 字节 RIFF、第 8~11 字节 WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function readImageFromPath(path: string): Promise<ImageAttachment> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e) {
    throw new Error(`图片读取失败：${path}（${(e as Error).message}）`);
  }
  if (buf.length > IMAGE_MAX_BYTES) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    throw new Error(
      `图片超过引擎读入上限：${path} 有 ${mb(buf.length)}MB，上限 ${mb(IMAGE_MAX_BYTES)}MB`,
    );
  }
  const mediaType = sniffImageMediaType(buf);
  if (!mediaType) {
    throw new Error(`不是受支持的图片（png / jpeg / gif / webp）：${path}`);
  }
  return { data: buf.toString("base64"), mediaType };
}

/** 含 path 形态的附件吗——send 入口据此决定走同步还是异步归一。同步段必须保持
 *  同步：会话标题、权限模式等副作用都在 handleSend 的同步前缀里发生，既有测试与
 *  事件顺序都依赖「无图时不被推迟一个 microtask」。 */
export function hasPathAttachment(images: WireImageAttachment[] | undefined): boolean {
  return !!images?.some((img) => "path" in img);
}

/** 内嵌形式单条 → 内嵌（校验后原样）。
 *
 *  内嵌形式的字段级校验在 headless 的 zod 边界已有一份；stdin 面（桌面）没有
 *  schema，这里补齐同一判据，避免把半成品塞进模型请求。 */
function toInline(img: { data: string; mediaType: string }): ImageAttachment {
  if (!img.data) throw new Error("图片附件缺 data（内嵌形式必须带 base64 字节）");
  if (!img.mediaType) throw new Error("内嵌图片附件必须带 mediaType");
  return { data: img.data, mediaType: img.mediaType };
}

/** 纯内嵌形式的**同步**归一（无 path 时走它，不引入 microtask 让渡）。
 *  遇到 path 抛错——调用方应先问 `hasPathAttachment`，两者是配套的一对。 */
export function normalizeInlineImages(
  images: WireImageAttachment[] | undefined,
): ImageAttachment[] | undefined {
  if (!images?.length) return undefined;
  return images.map((img) => {
    if ("path" in img) {
      throw new Error("normalizeInlineImages 不接受 path 形态（应先问 hasPathAttachment）");
    }
    return toInline(img);
  });
}

/** 线形状 → 内嵌形式（含本地文件读取）。无 images 返回 undefined（保持「不发该
 *  字段」的既有语义）。
 *
 *  抛错 = 该条 send 整体拒发：`enqueueSend` 把它报成非致命 error 帧（N1：失败要让
 *  对端看见），队列照常推进——不会静默丢消息，也不会让会话卡住。 */
export async function resolveImageAttachments(
  images: WireImageAttachment[] | undefined,
): Promise<ImageAttachment[] | undefined> {
  if (!images?.length) return undefined;
  const out: ImageAttachment[] = [];
  for (const img of images) {
    out.push("path" in img ? await readImageFromPath(img.path) : toInline(img));
  }
  return out;
}
