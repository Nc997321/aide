// styles.xml 解析 + basedOn 继承链合并。
// IR 的 StyleDef 存"解析后的有效属性"（继承合并结果），本文件解析时就完成合并，
// 下游（body.ts 判定标题层级、md 层映射）直接读 StyleDef 即可，不再追溯样式表。

import type { Align, StyleDef } from "../model.js";
import { attr, boolTag, extractBlocks, findBlock } from "./xml.js";

/** 段落样式根元素 <w:style> 里 type 属性 → IR type；未知归 paragraph */
function styleType(raw: string): "paragraph" | "character" {
  const t = attr(raw, "type");
  return t === "character" ? "character" : "paragraph";
}

/** 字符属性解析：rPr → bold/italics/size/font/color */
function parseRPr(rpr: string | undefined): Partial<StyleDef> {
  if (!rpr) return {};
  const out: Partial<StyleDef> = {};
  if (boolTag(rpr, "b")) out.bold = true;
  if (boolTag(rpr, "i")) out.italics = true;
  const fonts = findBlock(rpr, "rFonts");
  if (fonts) {
    const ascii = attr(fonts, "ascii");
    if (ascii) out.font = ascii;
  }
  const sz = findBlock(rpr, "sz");
  if (sz) {
    const v = Number(attr(sz, "val"));
    if (Number.isFinite(v) && v > 0) out.size = v;
  }
  const color = findBlock(rpr, "color");
  if (color) {
    const v = attr(color, "val");
    if (v && /^[0-9a-fA-F]{6}$/.test(v)) out.color = `#${v.toUpperCase()}`;
  }
  return out;
}

/** 段落属性解析：pPr → align/outlineLevel */
function parsePPr(ppr: string | undefined): Partial<StyleDef> {
  if (!ppr) return {};
  const out: Partial<StyleDef> = {};
  const jc = findBlock(ppr, "jc");
  if (jc) {
    const v = attr(jc, "val");
    if (v === "center" || v === "right" || v === "justify" || v === "left") out.align = v as Align;
  }
  const lvl = findBlock(ppr, "outlineLvl");
  if (lvl) {
    const v = Number(attr(lvl, "val"));
    if (Number.isFinite(v) && v >= 0 && v <= 8) out.outlineLevel = v;
  }
  return out;
}

interface RawStyle {
  id: string;
  name?: string;
  type: "paragraph" | "character";
  basedOn?: string;
  rpr?: string;
  ppr?: string;
}

function parseRawStyle(xml: string): RawStyle {
  const out: RawStyle = {
    id: attr(xml, "styleId") ?? "",
    type: styleType(xml),
  };
  const name = findBlock(xml, "name");
  const nameVal = name ? attr(name, "val") : undefined;
  if (nameVal) out.name = nameVal;
  const based = findBlock(xml, "basedOn");
  const basedOn = based ? attr(based, "val") : undefined;
  if (basedOn) out.basedOn = basedOn;
  const rpr = findBlock(xml, "rPr");
  if (rpr) out.rpr = rpr;
  const ppr = findBlock(xml, "pPr");
  if (ppr) out.ppr = ppr;
  return out;
}

/** 空壳 StyleDef（环防御/缺父样式时用，属性全空） */
function emptyStyle(id: string): StyleDef {
  return { id, type: "paragraph" };
}

/**
 * 解析 styles.xml 为 { id → StyleDef }（含 basedOn 继承合并）。
 * 合并规则：父样式属性先入，子样式非空属性覆盖（"子覆盖父"）。
 * 防御：visited 防环（环上节点给空壳）；缺父样式按空处理。无 styles.xml → 空 Map。
 */
export function parseStyles(xml: string | undefined): Map<string, StyleDef> {
  const map = new Map<string, StyleDef>();
  if (!xml) return map;

  const raws = new Map<string, RawStyle>();
  for (const block of extractBlocks(xml, "style")) {
    const raw = parseRawStyle(block);
    if (raw.id) raws.set(raw.id, raw);
  }

  const resolve = (id: string, visited: Set<string>): StyleDef => {
    if (visited.has(id)) return emptyStyle(id);
    const raw = raws.get(id);
    if (!raw) return emptyStyle(id);
    visited.add(id);
    const base: Partial<StyleDef> = raw.basedOn ? resolve(raw.basedOn, visited) : {};
    visited.delete(id);
    return {
      ...base,
      id: raw.id,
      name: raw.name ?? base.name,
      type: raw.type,
      basedOn: raw.basedOn,
      ...parseRPr(raw.rpr),
      ...parsePPr(raw.ppr),
    };
  };

  for (const id of raws.keys()) {
    map.set(id, resolve(id, new Set()));
  }
  return map;
}
