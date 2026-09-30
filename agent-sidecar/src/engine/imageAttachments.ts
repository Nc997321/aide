// 图片附件的入口校验：send.images 只有内嵌 base64 一种线形状。
//
// 校验在 send 入口完成（守门，对齐 outputStyle 的既有范式）：stdin 面没有 schema，
// 半成品（缺 data / 缺 mediaType）不许进模型请求。必须保持**同步**：会话标题、权限
// 模式等副作用都在 handleSend 的同步前缀里发生，既有测试与事件顺序都依赖「不被推迟
// 一个 microtask」。
import type { ImageAttachment } from "./types.js";

/** 校验并拷贝 send.images。无 images 返回 undefined（保持「不发该字段」的既有语义）。
 *
 *  抛错 = 该条 send 整体拒发：`enqueueSend` 把它报成非致命 error 帧（N1：失败要让
 *  对端看见），队列照常推进——不会静默丢消息，也不会让会话卡住。 */
export function normalizeInlineImages(
  images: ImageAttachment[] | undefined,
): ImageAttachment[] | undefined {
  if (!images?.length) return undefined;
  return images.map((img) => {
    if (!img.data) throw new Error("图片附件缺 data（必须带 base64 字节）");
    if (!img.mediaType) throw new Error("图片附件必须带 mediaType");
    return { data: img.data, mediaType: img.mediaType };
  });
}
