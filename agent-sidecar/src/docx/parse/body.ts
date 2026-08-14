// document.xml → IR blocks + 分节（含页眉页脚引用）。
// 只解析 model.ts 需要的子集（D2），未知元素跳过不报错；解析失败（缺 body 等）
// 抛 Error，由门面分类成 not_docx。
//
// 图片是"run 内独立块"：段落里文本与图片交错时按顺序拆成多个 Paragraph + Image 块，
// md 层按块序列输出保真（Word 图片一般独立成段，混合段落罕见）。

import type {
  Align,
  Block,
  Field,
  Image,
  PageNumberFormat,
  Paragraph,
  Run,
  Table,
  TableCell,
  TableRow,
} from "../model.js";
import { EMU_PER_PX } from "../constants.js";
import { attr, boolTag, extractBlocks, findBlock, hasTag, text, topLevelBlocks } from "./xml.js";

export type HeaderFooterType = "default" | "first" | "even";

/** sectPr 里的页眉页脚引用（rId 在所属部件的 rels 里解析，内容由 headers.ts 填充） */
export interface SectionRef {
  type: HeaderFooterType;
  rId: string;
}

/** 分节属性（sectPr 解析结果；页眉页脚正文另由 index.ts 组装） */
export interface SectionProps {
  headers: SectionRef[];
  footers: SectionRef[];
  /** 页面尺寸（twips） */
  pageSize?: { width: number; height: number };
  /** 页边距（twips） */
  pageMargins?: { top: number; right: number; bottom: number; left: number };
  pageNumberFormat?: PageNumberFormat;
  startPageNumber?: number;
  /** 首页不同 */
  titlePg?: boolean;
  /** 奇偶页不同 */
  evenAndOddHeaders?: boolean;
}

/** 部件解析上下文：rId → media 数组下标（门面预注册，部件内唯一）；media 查原始尺寸；resolveRel 查 rels Target */
export interface ImageCtx {
  resolveMedia(rId: string): number | undefined;
  media(mediaId: number): { width: number; height: number } | undefined;
  /** rId → rels Target（超链接 href 解析用；外部 URL 原样返回） */
  resolveRel(rId: string): string | undefined;
}

export interface ParsedBody {
  /** 每节：属性 + 该节正文 blocks（尾部无 sectPr 的内容并入最后一节） */
  sections: Array<{ props: SectionProps; blocks: Block[] }>;
}

const ALIGNS = new Set(["left", "center", "right", "justify"]);

function emptyProps(): SectionProps {
  return { headers: [], footers: [] };
}

/** 解析 document.xml（含 <w:body> 根）→ 分节 + blocks */
export function parseBody(docXml: string, ctx: ImageCtx): ParsedBody {
  const body = findBlock(docXml, "body");
  if (!body) throw new Error("document.xml has no <w:body>");

  const sections: ParsedBody["sections"] = [];
  let current: Block[] = [];
  let props = emptyProps();

  const flush = () => {
    sections.push({ props, blocks: current });
    current = [];
    props = emptyProps();
  };

  const innerStart = body.indexOf(">") + 1;
  for (const { name, block } of topLevelBlocks(body, innerStart, body.length)) {
    if (name === "sectPr") {
      props = parseSectPr(block);
      flush();
    } else if (name === "p") {
      // 节边界可能藏在段落 pPr 里（Word 把最后一段的 sectPr 放 pPr 内）
      const ppr = findBlock(block, "pPr");
      const inner = ppr ? findBlock(ppr, "sectPr") : undefined;
      if (inner) props = parseSectPr(inner);
      current.push(...parseParagraph(block, ctx, ppr).blocks);
      if (inner) flush();
    } else if (name === "tbl") {
      current.push(parseTable(block, ctx));
    } else if (name === "sdt") {
      // sdt（结构化文档标签）透明解析：TOC 域的标准形态是 sdt 包裹 fldChar
      current.push(...parseSdtBlocks(block, ctx));
    } else if (name === "fldSimple") {
      // fldSimple（简化域）：docx 库 SimpleField 生成形态，Word 保存时也常见
      current.push(parseFldSimple(block, ctx));
    }
    // 其它顶层元素（altChunk/…）跳过——C 档/罕见
  }

  if (sections.length === 0) {
    // 无任何 sectPr：单默认节
    return { sections: [{ props, blocks: current }] };
  }
  if (current.length > 0) {
    sections.push({ props, blocks: current });
  }
  return { sections };
}

/**
 * 块序列解析（顶层分派：p/tbl/sdt 递归）。sectPr 由调用方处理（parseBody 需要节边界）。
 * 供 parseBody 的 sdt 分支、单元格、页眉页脚部件共用。
 */
export function parseBlocks(xml: string, start: number, end: number, ctx: ImageCtx): Block[] {
  const out: Block[] = [];
  for (const { name, block } of topLevelBlocks(xml, start, end)) {
    if (name === "p") {
      const ppr = findBlock(block, "pPr");
      out.push(...parseParagraph(block, ctx, ppr).blocks);
    } else if (name === "tbl") {
      out.push(parseTable(block, ctx));
    } else if (name === "sdt") {
      out.push(...parseSdtBlocks(block, ctx));
    } else if (name === "fldSimple") {
      out.push(parseFldSimple(block, ctx));
    }
  }
  return out;
}

/** fldSimple（简化域）→ Field：instr 分类 + 内部 runs 作缓存 */
function parseFldSimple(fXml: string, ctx: ImageCtx): Field {
  const instr = attr(fXml, "instr") ?? "";
  const field: Field = { kind: "field", type: classifyField(instr) };
  const trimmed = instr.trim();
  if (trimmed) field.instr = trimmed;
  const innerStart = fXml.indexOf(">") + 1;
  const cachedRuns: Run[] = [];
  for (const { name, block } of topLevelBlocks(fXml, innerStart, fXml.length)) {
    if (name !== "r") continue;
    const run = parseRun(block, ctx);
    if (run !== null && !isImage(run)) cachedRuns.push(run);
  }
  if (cachedRuns.length > 0) field.cached = [{ kind: "paragraph", runs: cachedRuns }];
  return field;
}

/** sdt 透明解析：取 sdtContent 内部块序列（TOC 域等标准形态） */
function parseSdtBlocks(sdtXml: string, ctx: ImageCtx): Block[] {
  const content = findBlock(sdtXml, "sdtContent");
  if (!content) return [];
  const innerStart = content.indexOf(">") + 1;
  // TOC 域标准形态：sdt 包裹跨段落 fldChar 域（begin 在第一段，end 在最后段）
  if (hasTag(content, "fldChar")) {
    const runs = collectRuns(content, innerStart, content.length);
    const beginIdx = runs.findIndex((r) => {
      const fld = findBlock(r.block, "fldChar");
      return fld && attr(fld, "fldCharType") === "begin";
    });
    if (beginIdx >= 0) {
      return [parseField(runs, beginIdx, ctx).field];
    }
  }
  return parseBlocks(content, innerStart, content.length, ctx);
}

/** sdtContent 内所有 run（跨段落扁平化，带段落样式） */
function collectRuns(xml: string, start: number, end: number): SeqRun[] {
  const out: SeqRun[] = [];
  for (const { name, block } of topLevelBlocks(xml, start, end)) {
    if (name !== "p") continue;
    const ppr = findBlock(block, "pPr");
    let style: string | undefined;
    if (ppr) {
      const ps = findBlock(ppr, "pStyle");
      if (ps) style = attr(ps, "val");
    }
    const innerStart = block.indexOf(">") + 1;
    for (const inner of topLevelBlocks(block, innerStart, block.length)) {
      if (inner.name === "r") out.push({ ...inner, style });
    }
  }
  return out;
}

/** 段落 → Block[]（拆图片/书签/域后的块序列，空段保底返回空 Paragraph） */
export function parseParagraph(pXml: string, ctx: ImageCtx, ppr: string | undefined): { blocks: Block[] } {
  const seed: Paragraph = { kind: "paragraph", runs: [] };
  if (ppr) applyParagraphProps(seed, ppr);
  const blocks = parseRunSequence(pXml, ctx, seed);
  return { blocks };
}

function applyParagraphProps(para: Paragraph, ppr: string): void {
  const style = findBlock(ppr, "pStyle");
  const styleVal = style ? attr(style, "val") : undefined;
  if (styleVal) para.style = styleVal;

  const jc = findBlock(ppr, "jc");
  const jcVal = jc ? attr(jc, "val") : undefined;
  if (jcVal && ALIGNS.has(jcVal)) para.align = jcVal as Align;

  const ind = findBlock(ppr, "ind");
  if (ind) {
    const indent: NonNullable<Paragraph["indent"]> = {};
    const l = attr(ind, "left");
    if (l !== undefined) indent.left = Number(l);
    const r = attr(ind, "right");
    if (r !== undefined) indent.right = Number(r);
    const h = attr(ind, "hanging");
    if (h !== undefined) indent.hanging = Number(h);
    if (Object.keys(indent).length > 0) para.indent = indent;
  }

  const sp = findBlock(ppr, "spacing");
  if (sp) {
    const spacing: NonNullable<Paragraph["spacing"]> = {};
    const b = attr(sp, "before");
    if (b !== undefined) spacing.before = Number(b);
    const a = attr(sp, "after");
    if (a !== undefined) spacing.after = Number(a);
    const l = attr(sp, "line");
    if (l !== undefined) spacing.line = Number(l);
    if (Object.keys(spacing).length > 0) para.spacing = spacing;
  }

  if (hasTag(ppr, "pageBreakBefore")) para.pageBreakBefore = true;

  const shd = findBlock(ppr, "shd");
  if (shd) {
    const v = attr(shd, "fill");
    if (v && v !== "auto") para.shading = v.toUpperCase();
  }
}

/** parseRun 返回联合的判别守卫（Run 无 kind 字段，不能直接 in 收窄） */
function isImage(run: Run | Image): run is Image {
  return (run as Image).kind === "image";
}

/** 段落顶层序列 → 块序列：run 归入 Paragraph，图片/书签/域/分页符拆独立块 */
function parseRunSequence(pXml: string, ctx: ImageCtx, seed: Paragraph): Block[] {
  const out: Block[] = [];
  let current = seed;
  const flush = () => {
    if (current.runs.length > 0) out.push(current);
    current = { kind: "paragraph", runs: [] };
  };

  const innerStart = pXml.indexOf(">") + 1;
  const seq = topLevelBlocks(pXml, innerStart, pXml.length);

  let i = 0;
  while (i < seq.length) {
    const { name, block } = seq[i];
    if (name === "pPr") {
      i++;
      continue;
    }
    if (name === "bookmarkStart") {
      const n = attr(block, "name");
      if (n) {
        flush();
        out.push({ kind: "bookmark", name: n, anchor: true });
      }
      i++;
      continue;
    }
    if (name === "bookmarkEnd") {
      // start/end 对只发一个目标块
      i++;
      continue;
    }
    if (name === "fldSimple") {
      // 简化域（docx 库 SimpleField 生成形态）：段落内独立块
      flush();
      out.push(parseFldSimple(block, ctx));
      i++;
      continue;
    }
    if (name === "hyperlink") {
      // 内部 runs 共享 link 信息：r:id 是 rels 引用（外部 URL），w:anchor 是内部书签
      const rId = attr(block, "id");
      const href = rId ? ctx.resolveRel(rId) : undefined;
      const anchor = attr(block, "anchor");
      const link = href ? { href } : anchor ? { anchor } : undefined;
      const hStart = block.indexOf(">") + 1;
      for (const inner of topLevelBlocks(block, hStart, block.length)) {
        if (inner.name !== "r") continue;
        const run = parseRun(inner.block, ctx, link);
        if (run === null) continue;
        if (isImage(run)) {
          flush();
          out.push(run);
        } else {
          current.runs.push(run);
        }
      }
      i++;
      continue;
    }
    if (name === "r") {
      // 段内分页符（独立分页段：`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`）
      const pageBr = findBlock(block, "br");
      if (pageBr && attr(pageBr, "type") === "page") {
        flush();
        out.push({ kind: "pagebreak" });
        i++;
        continue;
      }
      // 域：run 内 fldChar begin 起收集到 end（段内域；跨段落域由 sdt 分支处理）
      const fld = findBlock(block, "fldChar");
      if (fld && attr(fld, "fldCharType") === "begin") {
        const { field, nextIndex } = parseField(
          seq.map((s) => ({ ...s, style: seed.style })),
          i,
          ctx,
        );
        flush();
        out.push(field);
        i = nextIndex;
        continue;
      }
      const run = parseRun(block, ctx);
      if (run !== null) {
        if (isImage(run)) {
          flush();
          out.push(run);
        } else {
          current.runs.push(run);
        }
      }
      i++;
      continue;
    }
    // 其它（ins/del 修订、sdt 内容控件、proofErr 等）→ 跳过（C 档/噪音）
    i++;
  }

  if (current.runs.length > 0) out.push(current);
  if (out.length === 0) out.push(seed); // 空段保底（Word 空行语义）
  return out;
}

/** 域解析输入：run 级元素 + 所属段落样式（跨段落域缓存分组用） */
interface SeqRun {
  name: string;
  block: string;
  style?: string;
}

/**
 * 域解析：从 begin run 起收集 instrText（begin 后）与缓存 runs（separate 后），到 end 止。
 * 支持跨段落（TOC 域标准形态：begin+instrText+separate 在第一段，end 在最后段），
 * 缓存按段落样式分组（TOC1/TOC2 → cached 条目）。
 */
function parseField(
  seq: SeqRun[],
  beginIdx: number,
  ctx: ImageCtx,
): { field: Field; nextIndex: number } {
  let instr = "";
  let separate = false;
  const cachedParas: Paragraph[] = [];
  let currentRuns: Run[] = [];
  let currentStyle: string | undefined;
  const flushCached = () => {
    if (currentRuns.length > 0) {
      const p: Paragraph = { kind: "paragraph", runs: currentRuns };
      if (currentStyle) p.style = currentStyle;
      cachedParas.push(p);
      currentRuns = [];
    }
  };
  // 从 beginIdx 起（含 begin run）：docx 库把 fldChar begin + instrText 放同一 run。
  // 顺序敏感：instrText 先收集（同 run 时它在 separate 之前），fldChar run 不进缓存。
  let i = beginIdx;
  for (; i < seq.length; i++) {
    const { name, block, style } = seq[i];
    if (name !== "r") continue; // 域中间夹杂非 run（罕见）→ 跳过继续收集
    const instrText = findBlock(block, "instrText");
    if (instrText && !separate) {
      instr += text(block, "instrText");
      // 不 continue：同 run 可能还有 fldChar（docx 库把 begin+instrText+separate 放一起）
    }
    let endFound = false;
    let hasFldChar = false;
    for (const f of extractBlocks(block, "fldChar")) {
      hasFldChar = true;
      const type = attr(f, "fldCharType");
      if (type === "end") {
        endFound = true;
        break;
      }
      if (type === "separate") separate = true;
      // 重复 begin 忽略
    }
    if (endFound) break;
    if (hasFldChar) continue;
    if (separate) {
      const run = parseRun(block, ctx);
      if (run !== null && !isImage(run)) {
        if (style !== currentStyle) {
          flushCached();
          currentStyle = style;
        }
        currentRuns.push(run);
      }
    }
    // begin 后 separate 前的普通 run（Word 不产生）→ 忽略
  }
  flushCached();

  const field: Field = { kind: "field", type: classifyField(instr) };
  const trimmed = instr.trim();
  if (trimmed) field.instr = trimmed;
  if (cachedParas.length > 0) field.cached = cachedParas;
  return { field, nextIndex: i + 1 };
}

function classifyField(instr: string): Field["type"] {
  const s = instr.trim();
  if (/^TOC\b/i.test(s)) return "toc";
  if (/^PAGE\b/i.test(s)) return "page";
  if (/^NUMPAGES\b/i.test(s)) return "numpages";
  return "other";
}

/**
 * run → Run | Image | null。
 * - drawing + blip → Image 块
 * - 纯分页 br 的 run 已在 parseRunSequence 拦走，此处 br 只当段内换行
 */
function parseRun(rXml: string, ctx: ImageCtx, link?: Run["link"]): Run | Image | null {
  if (hasTag(rXml, "drawing") && hasTag(rXml, "blip")) {
    return parseImage(rXml, ctx);
  }

  const run: Run = { text: "" };
  if (link) run.link = link;

  const rpr = findBlock(rXml, "rPr");
  if (rpr) {
    if (boolTag(rpr, "b")) run.bold = true;
    if (boolTag(rpr, "i")) run.italics = true;
    if (boolTag(rpr, "strike")) run.strike = true;
    if (hasTag(rpr, "u")) run.underline = true;
    const fonts = findBlock(rpr, "rFonts");
    if (fonts) {
      const ascii = attr(fonts, "ascii");
      if (ascii) run.font = ascii;
    }
    const sz = findBlock(rpr, "sz");
    if (sz) {
      const v = Number(attr(sz, "val"));
      if (Number.isFinite(v) && v > 0) run.size = v;
    }
    const color = findBlock(rpr, "color");
    if (color) {
      const v = attr(color, "val");
      if (v && /^[0-9a-fA-F]{6}$/.test(v)) run.color = `#${v.toUpperCase()}`;
    }
    const hl = findBlock(rpr, "highlight");
    if (hl) {
      const v = attr(hl, "val");
      if (v) run.highlight = v;
    }
    const shd = findBlock(rpr, "shd");
    if (shd) {
      const v = attr(shd, "fill");
      if (v && v !== "auto") run.shading = v.toUpperCase();
    }
  }

  // 内容序列（顺序敏感）：t → 文本；br → 段内换行（text 内嵌 \n + break 标志）；
  // tab → \t。page 型 br 已在上层拦走。
  const innerStart = rXml.indexOf(">") + 1;
  for (const { name, block } of topLevelBlocks(rXml, innerStart, rXml.length)) {
    if (name === "t") {
      run.text += text(block, "t");
    } else if (name === "br") {
      run.text += "\n";
      run.break = true;
    } else if (name === "tab") {
      run.text += "\t";
    }
  }
  return run;
}

/** run 内 drawing → Image 块；无 blip/embed 未注册/无法解析 → null（调用方跳过） */
function parseImage(rXml: string, ctx: ImageCtx): Image | null {
  const blip = findBlock(rXml, "blip");
  if (!blip) return null;
  const embed = attr(blip, "embed");
  if (!embed) return null;
  const mediaId = ctx.resolveMedia(embed);
  if (mediaId === undefined) return null;

  // 渲染尺寸：wp:extent cx/cy（EMU）→ px；缺失时用媒体原始尺寸
  const extent = findBlock(rXml, "extent");
  let width: number;
  let height: number;
  const cx = extent ? Number(attr(extent, "cx")) : NaN;
  const cy = extent ? Number(attr(extent, "cy")) : NaN;
  if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) {
    width = Math.max(1, Math.round(cx / EMU_PER_PX));
    height = Math.max(1, Math.round(cy / EMU_PER_PX));
  } else {
    const m = ctx.media(mediaId);
    width = m?.width ?? 1;
    height = m?.height ?? 1;
  }

  const docPr = findBlock(rXml, "docPr");
  const alt = docPr ? attr(docPr, "descr") : undefined;
  return { kind: "image", mediaId, width, height, alt };
}

export function parseTable(tblXml: string, ctx: ImageCtx): Table {
  const widths: number[] = [];
  const grid = findBlock(tblXml, "tblGrid");
  if (grid) {
    for (const col of extractBlocks(grid, "gridCol")) {
      const w = Number(attr(col, "w"));
      if (Number.isFinite(w) && w > 0) widths.push(w);
    }
  }
  const table: Table = { kind: "table", rows: extractBlocks(tblXml, "tr").map((tr) => parseRow(tr, ctx)) };
  if (widths.length > 0) table.widths = widths;
  return table;
}

function parseRow(trXml: string, ctx: ImageCtx): TableRow {
  return { cells: extractBlocks(trXml, "tc").map((tc) => parseCell(tc, ctx)) };
}

function parseCell(tcXml: string, ctx: ImageCtx): TableCell {
  const cell: TableCell = { blocks: [] };
  const tcPr = findBlock(tcXml, "tcPr");
  if (tcPr) {
    const gridSpan = findBlock(tcPr, "gridSpan");
    const span = gridSpan ? Number(attr(gridSpan, "val")) : NaN;
    if (Number.isFinite(span) && span > 1) cell.gridSpan = span;
    const tcW = findBlock(tcPr, "tcW");
    const w = tcW ? Number(attr(tcW, "w")) : NaN;
    if (Number.isFinite(w) && w > 0) cell.width = w;
    const shd = findBlock(tcPr, "shd");
    if (shd) {
      const fill = attr(shd, "fill");
      if (fill && fill !== "auto") cell.shading = fill.toUpperCase();
    }
  }
  // 单元格内块：段落/嵌套表格/sdt（sectPr 等忽略）
  const innerStart = tcXml.indexOf(">") + 1;
  cell.blocks.push(...parseBlocks(tcXml, innerStart, tcXml.length, ctx));
  return cell;
}

/** sectPr → SectionProps（headerReference/footerReference 只记引用，内容由门面组装） */
function parseSectPr(sectXml: string): SectionProps {
  const props = emptyProps();
  for (const ref of extractBlocks(sectXml, "headerReference")) {
    const type = attr(ref, "type") ?? "default";
    const rId = attr(ref, "id");
    if (rId && (type === "default" || type === "first" || type === "even")) {
      props.headers.push({ type: type as HeaderFooterType, rId });
    }
  }
  for (const ref of extractBlocks(sectXml, "footerReference")) {
    const type = attr(ref, "type") ?? "default";
    const rId = attr(ref, "id");
    if (rId && (type === "default" || type === "first" || type === "even")) {
      props.footers.push({ type: type as HeaderFooterType, rId });
    }
  }

  const pgSz = findBlock(sectXml, "pgSz");
  if (pgSz) {
    const w = Number(attr(pgSz, "w"));
    const h = Number(attr(pgSz, "h"));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      props.pageSize = { width: w, height: h };
    }
  }
  const pgMar = findBlock(sectXml, "pgMar");
  if (pgMar) {
    const margins: Partial<NonNullable<SectionProps["pageMargins"]>> = {};
    for (const k of ["top", "right", "bottom", "left"] as const) {
      const v = Number(attr(pgMar, k));
      if (Number.isFinite(v)) margins[k] = v;
    }
    if (Object.keys(margins).length > 0) {
      props.pageMargins = margins as NonNullable<SectionProps["pageMargins"]>;
    }
  }
  const pgNumType = findBlock(sectXml, "pgNumType");
  if (pgNumType) {
    const fmt = attr(pgNumType, "fmt");
    if (fmt === "decimal" || fmt === "upperRoman" || fmt === "lowerRoman" || fmt === "upperLetter" || fmt === "lowerLetter") {
      props.pageNumberFormat = fmt;
    }
    const start = Number(attr(pgNumType, "start"));
    if (Number.isFinite(start) && start > 0) props.startPageNumber = start;
  }
  if (hasTag(sectXml, "titlePg")) props.titlePg = true;
  if (hasTag(sectXml, "evenAndOddHeaders")) props.evenAndOddHeaders = true;
  return props;
}
