// 图片预览 MIME 推断。
//
// 文本预览走 read_file_content（fs::read_to_string），但二进制图片无法作为 UTF-8
// 解码，故图片走 read_file_binary 拿到原始字节后用 Blob 重建，Blob 必须带正确 MIME
// 才能在 <img> 中渲染（尤其是 SVG，缺 type 时部分浏览器不渲染）。

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** 返回路径对应的图片 MIME；非图片返回 null。 */
export function imageMimeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] ?? null;
}