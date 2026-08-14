// OOXML → IR 门面：jszip 解包 → 各部件解析 → DocxDocument。
// parse.ts（read 门面）已从 mammoth 切换到本模块 + md/toMarkdown；
// 错误分类复用 classifyDocxError，分类后抛 DocxParseError（reason 供上层转文本提示）。

import JSZip from "jszip";
import { imageSize } from "image-size";
import type { DocxDocument, HeaderFooter, MediaFile, Section } from "../model.js";
import { DOCX_MAX_IMAGE_BYTES } from "../constants.js";
import { classifyDocxError } from "../parse.js";
import { parseBody, type ImageCtx } from "./body.js";
import { parseHeaderFooter } from "./headers.js";
import { parseStyles } from "./styles.js";
import { attr, extractBlocks } from "./xml.js";

/** 解析失败结构化原因（与 parse.ts 的 classifyDocxError 对齐，too_large/not_found 属 handler 层） */
export type DocxParseReason = "not_docx" | "encrypted" | "unknown";

export class DocxParseError extends Error {
  constructor(
    public readonly reason: DocxParseReason,
    detail: string,
  ) {
    super(detail);
    this.name = "DocxParseError";
  }
}

/** 单个 OOXML 部件：XML 文本 + 其 rels（rId → Target） */
interface Part {
  xml: string;
  rels: Map<string, string>;
}

const IMAGE_TYPES: Record<string, MediaFile["type"]> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  bmp: "bmp",
};

const IMAGE_TARGET_RE = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

/** rels Target → zip 内路径（document.xml.rels 的 target 相对 word/，如 header1.xml） */
function partZipPath(target: string): string {
  const clean = target.replace(/^\.\//, "");
  if (clean.startsWith("/")) return clean.slice(1);
  if (clean.startsWith("word/")) return clean;
  return `word/${clean}`;
}

async function loadPart(zip: JSZip, zipPath: string): Promise<Part | null> {
  const file = zip.file(zipPath);
  if (!file) return null;
  let xml: string;
  try {
    xml = await file.async("string");
  } catch (err) {
    const { reason, detail } = classifyDocxError(err);
    throw new DocxParseError(reason, detail);
  }
  const rels = new Map<string, string>();
  const relsPath = zipPath.replace(/^word\//, "word/_rels/") + ".rels";
  const relsFile = zip.file(relsPath);
  if (relsFile) {
    const relsXml = await relsFile.async("string");
    for (const rel of extractBlocks(relsXml, "Relationship")) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (id && target) rels.set(id, target);
    }
  }
  return { xml, rels };
}

/**
 * 解析 .docx buffer → 统一文档模型（IR）。
 * 失败抛 DocxParseError（reason 分类），调用方 catch 后转文本提示。
 * media 预注册（rels 里所有图片部件），按注册顺序编号；同文件去重；
 * 超 DOCX_MAX_IMAGE_BYTES / 非支持类型（webp/svg 等）/ 读失败 → 跳过该图（Image 块也不产出）。
 */
export async function parseDocxToModel(buffer: Buffer): Promise<DocxDocument> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    const { reason, detail } = classifyDocxError(err);
    throw new DocxParseError(reason, detail);
  }

  const docPart = await loadPart(zip, "word/document.xml");
  if (!docPart) throw new DocxParseError("not_docx", "missing word/document.xml");
  const doc: Part = docPart; // 收窄为非空（闭包内 resolveHeaderFooter 引用）

  // 页眉页脚部件：按 document rels 里的 header/footer 类型加载
  const parts = new Map<string, Part>();
  for (const target of doc.rels.values()) {
    if (/header|footer/i.test(target)) {
      const zipPath = partZipPath(target);
      const part = await loadPart(zip, zipPath);
      if (part) parts.set(zipPath, part);
    }
  }

  // media 预注册：所有部件 rels 的图片 target → MediaFile
  const mediaList: MediaFile[] = [];
  const rIdToMediaId = new Map<string, number>();
  const mediaByPath = new Map<string, number>();
  const registerMedia = async (rels: Map<string, string>): Promise<void> => {
    for (const [rId, target] of rels) {
      if (!IMAGE_TARGET_RE.test(target)) continue;
      const zipPath = partZipPath(target);
      const existing = mediaByPath.get(zipPath);
      if (existing !== undefined) {
        rIdToMediaId.set(rId, existing);
        continue;
      }
      const file = zip.file(zipPath);
      if (!file) continue;
      let buf: Buffer;
      try {
        buf = await file.async("nodebuffer");
      } catch {
        continue;
      }
      if (buf.length > DOCX_MAX_IMAGE_BYTES) continue;
      let size: { width?: number; height?: number; type?: string };
      try {
        size = imageSize(buf);
      } catch {
        continue;
      }
      const type = size.type ? IMAGE_TYPES[size.type.toLowerCase()] : undefined;
      if (!type || !size.width || !size.height) continue;
      const idx = mediaList.length;
      mediaList.push({ data: buf, type, width: size.width, height: size.height });
      mediaByPath.set(zipPath, idx);
      rIdToMediaId.set(rId, idx);
    }
  };
  await registerMedia(doc.rels);
  for (const part of parts.values()) await registerMedia(part.rels);

  // 部件内 rId → mediaId 查表（rId 部件内唯一；跨部件同号由 rels 归属过滤）
  const makeCtx = (rels: Map<string, string>): ImageCtx => ({
    resolveMedia: (rId) => (rels.has(rId) ? rIdToMediaId.get(rId) : undefined),
    media: (mediaId) => mediaList[mediaId],
    resolveRel: (rId) => (rels.has(rId) ? rels.get(rId) : undefined),
  });

  const stylesFile = zip.file("word/styles.xml");
  const styles = parseStyles(stylesFile ? await stylesFile.async("string") : undefined);

  const body = parseBody(doc.xml, makeCtx(doc.rels));
  const sections: Section[] = body.sections.map((s) => {
    const headers: HeaderFooter[] = resolveHeaderFooter(s.props.headers);
    const footers: HeaderFooter[] = resolveHeaderFooter(s.props.footers);
    const section: Section = { headers, footers, blocks: s.blocks };
    if (s.props.pageSize) section.pageSize = s.props.pageSize;
    if (s.props.pageMargins) section.pageMargins = s.props.pageMargins;
    if (s.props.pageNumberFormat) section.pageNumberFormat = s.props.pageNumberFormat;
    if (s.props.startPageNumber !== undefined) section.startPageNumber = s.props.startPageNumber;
    if (s.props.titlePg) section.titlePg = true;
    if (s.props.evenAndOddHeaders) section.evenAndOddHeaders = true;
    return section;
  });

  return { sections, styles, media: mediaList };

  function resolveHeaderFooter(
    refs: Array<{ type: "default" | "first" | "even"; rId: string }>,
  ): HeaderFooter[] {
    return refs.flatMap((ref) => {
      const target = doc.rels.get(ref.rId);
      const part = target ? parts.get(partZipPath(target)) : undefined;
      if (!part) return [];
      return [{ type: ref.type, blocks: parseHeaderFooter(part.xml, makeCtx(part.rels)) }];
    });
  }
}
