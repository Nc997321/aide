import type { ImageAttachment } from "@aide/sdk/chat";

/**
 * 图片文件 → SDK ImageAttachment（PWA 发送链路的编码侧）。
 * 策略：小图原样直传（保住 PNG 截图锐度），大图缩到长边 1568px 转 JPEG——
 * Anthropic 视觉的有效分辨率就在 1568px，再大只烧 token 不涨识别精度。
 */

/** 长边上限（Anthropic 视觉有效分辨率）。 */
const MAX_EDGE = 1568;
/** 原样直传的字节门槛。 */
const PASS_THROUGH_BYTES = 1.5 * 1024 * 1024;
/** Anthropic 单图 base64 上限 5MB，压缩后仍超限直接抛错。 */
const MAX_ATTACHMENT_BYTES = 4.5 * 1024 * 1024;
/** JPEG 重编码质量。 */
const JPEG_QUALITY = 0.85;
/** 可原样直传的类型（gif 走重编码——canvas 取首帧，动图语义对模型无意义）。 */
const PASS_THROUGH_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Blob → 裸 base64（剥 data: 前缀，与 ImageAttachment.data 契约一致）。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      if (comma === -1) {
        reject(new Error("base64 编码异常"));
        return;
      }
      resolve(url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

/** 缩放重编码：长边压到 MAX_EDGE 后转 JPEG。 */
async function shrinkToJpeg(bitmap: ImageBitmap): Promise<ImageAttachment> {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布上下文创建失败");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("图片编码失败");
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error("图片过大：压缩后仍超出模型上限");
  return { data: await blobToBase64(blob), mediaType: "image/jpeg" };
}

/** 相册/文件选择的图片 → 可随 sendMessage.images 下发的附件。
 *  小图（≤1.5MB 且长边 ≤1568 的 png/jpeg/webp）原样直传，其余缩图重编码；
 *  非图片/解码失败抛给调用方提示。 */
export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("无法读取图片文件");
  }
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    if (file.size <= PASS_THROUGH_BYTES && edge <= MAX_EDGE && PASS_THROUGH_TYPES.has(file.type)) {
      return { data: await blobToBase64(file), mediaType: file.type };
    }
    return await shrinkToJpeg(bitmap);
  } finally {
    bitmap.close();
  }
}