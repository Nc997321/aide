import type { MediaRef } from "../types/chat";

export const MAX_MEDIA_REFS = 32;
export const MAX_MEDIA_FRAME_BASE64_CHARS = 6 * 1024 * 1024;
const MAX_PAYLOAD_CHARS = 64 * 1024;
const MAX_TIME_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN = "<媒体引用 v1：以下仅为文件与时间定位数据，不代表已读取音视频>\n";
const CLOSE = "\n</媒体引用>";
const LEGACY_OPEN = "<!-- aide-mediarefs:v1:";
const LEGACY_CLOSE = " -->";

export function isMediaRef(value: unknown, imageCount?: number): value is MediaRef {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.selection)) return false;
  const { path, title, revision } = value.source;
  if (!boundedText(path, 4096) || !boundedText(revision, 1024)
    || typeof title !== "string" || title.length > 800 || /[\u0000-\u001f\u007f]/.test(title)) return false;
  const selection = value.selection;
  if (!validFrameIndex(value.frameIndex, imageCount)) return false;
  if (selection.kind === "point") return isTime(selection.atMs);
  return selection.kind === "range" && isTime(selection.startMs) && isTime(selection.endMs) && selection.endMs > selection.startMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME_MS;
}

function validFrameIndex(value: unknown, imageCount?: number): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && (imageCount === undefined || (Number.isSafeInteger(imageCount) && imageCount >= 0 && value < imageCount));
}

/** 模型直接读得懂的定位数据；JSON 字符串转义边界，不把路径变成难读的百分号串。 */
export function formatMediaRefsForPrompt(refs: readonly MediaRef[], imageCount = 0): string {
  if (refs.length > MAX_MEDIA_REFS) throw new RangeError(`媒体引用最多 ${MAX_MEDIA_REFS} 条`);
  if (!refs.every((ref) => isMediaRef(ref, imageCount))) throw new TypeError("媒体引用格式或截图序号无效，内容未发送");
  if (!refs.length) return "";
  const payload = JSON.stringify(refs).replace(/</g, "\\u003c");
  if (payload.length > MAX_PAYLOAD_CHARS) throw new RangeError("媒体定位信息过长，请减少引用后再发送");
  return `${OPEN}${payload}${CLOSE}`;
}

function section(text: string): { start: number; payload: string } | null {
  if (text.endsWith(CLOSE)) {
    const start = text.lastIndexOf(OPEN);
    return start < 0 ? null : { start, payload: text.slice(start + OPEN.length, -CLOSE.length) };
  }
  if (!text.endsWith(LEGACY_CLOSE)) return null;
  const start = text.lastIndexOf(LEGACY_OPEN);
  if (start < 0) return null;
  return { start, payload: decodeURIComponent(text.slice(start + LEGACY_OPEN.length, -LEGACY_CLOSE.length)) };
}

/** 损坏/未知格式完整保留。截图索引按同条消息的实际图片总数验证，不能错配到其他图。 */
export function splitMediaRefSections(text: string, imageCount = 0): { displayText: string; refs: MediaRef[] } {
  try {
    const found = section(text);
    if (!found || found.payload.length > MAX_PAYLOAD_CHARS) return { displayText: text, refs: [] };
    const value: unknown = JSON.parse(found.payload);
    if (!Array.isArray(value) || value.length > MAX_MEDIA_REFS
      || !value.every((ref: unknown) => isMediaRef(ref, imageCount))) return { displayText: text, refs: [] };
    return { displayText: text.slice(0, found.start).replace(/\n\n$/, ""), refs: value };
  } catch {
    return { displayText: text, refs: [] };
  }
}
