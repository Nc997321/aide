// IR 样式表 → docx 库样式选项（纯对象，IStylesOptions.paragraphStyles/characterStyles）。
// 跳过 docx 库自带样式（Normal/Heading1-6 等），其余按类型生成；
// TOC1/TOC2 兜底：TOC 域缓存条目引用它们，缺失时 Word 显示会退化。

import {
  AlignmentType,
  type ICharacterStyleOptions,
  type IParagraphStyleOptions,
  type IRunStylePropertiesOptions,
} from "docx";
import type { StyleDef } from "../model.js";

/** docx 库自带样式（DefaultStylesFactory），无需重复生成 */
const SKIP_IDS = new Set([
  "Normal",
  "DefaultParagraphFont",
  "TableNormal",
  "NoList",
  "Hyperlink",
  "Title",
  "Subtitle",
  "Quote",
  "IntenseQuote",
  "ListParagraph",
]);

const ALIGN_MAP: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

function runProps(def: StyleDef): IRunStylePropertiesOptions {
  return {
    ...(def.bold ? { bold: true } : {}),
    ...(def.italics ? { italics: true } : {}),
    ...(def.size ? { size: def.size } : {}),
    ...(def.font ? { font: def.font } : {}),
    ...(def.color ? { color: def.color } : {}),
  };
}

/** IR 样式表 → docx 样式选项（跳过自带样式与 Heading1-6） */
export function stylesToDocx(
  styles: Map<string, StyleDef>,
): { paragraphStyles: IParagraphStyleOptions[]; characterStyles: ICharacterStyleOptions[] } {
  const paragraphStyles: IParagraphStyleOptions[] = [];
  const characterStyles: ICharacterStyleOptions[] = [];
  for (const def of styles.values()) {
    if (SKIP_IDS.has(def.id)) continue;
    if (/^Heading[1-6]$/i.test(def.id)) continue;
    if (def.type === "character") {
      characterStyles.push({ id: def.id, name: def.name, basedOn: def.basedOn, run: runProps(def) });
    } else {
      paragraphStyles.push({
        id: def.id,
        name: def.name,
        basedOn: def.basedOn,
        run: runProps(def),
        paragraph: def.align ? { alignment: ALIGN_MAP[def.align] } : undefined,
      });
    }
  }
  return { paragraphStyles, characterStyles };
}

/** TOC1/TOC2 兜底样式（styles 里缺失时补上，TOC 域缓存条目引用） */
export function tocFallbackStyles(
  styles: Map<string, StyleDef>,
): { paragraphStyles: IParagraphStyleOptions[] } {
  const paragraphStyles: IParagraphStyleOptions[] = [];
  if (!styles.has("TOC1")) {
    paragraphStyles.push({
      id: "TOC1",
      name: "toc 1",
      basedOn: "Normal",
      run: { size: 24 },
      paragraph: { indent: { left: 0 } },
    });
  }
  if (!styles.has("TOC2")) {
    paragraphStyles.push({
      id: "TOC2",
      name: "toc 2",
      basedOn: "TOC1",
      run: { size: 24 },
      paragraph: { indent: { left: 360 } },
    });
  }
  return { paragraphStyles };
}

/**
 * Caption/TableCaption 兜底样式（styles 里缺失时补上，[TOC:figures]/[TOC:tables] 的
 * \t 指令按它们收集）。Caption 是 Word 题注样式（居中、小字）；TableCaption 基于它。
 */
export function captionFallbackStyles(
  styles: Map<string, StyleDef>,
): { paragraphStyles: IParagraphStyleOptions[] } {
  const paragraphStyles: IParagraphStyleOptions[] = [];
  // styleId 与 name 必须与 TOC \t 指令里的样式名一致（Word 按 styleId 匹配，实测）：
  // [TOC:figures] → \t "FigureCaption,1"、[TOC:tables] → \t "TableCaption,1"
  // 不能用 "Caption"（Word 内置样式名）：实测任何 name="caption" 的样式都会被 Word
  // 强制规范化 styleId（"Caption"→"ac"），\t 指令匹配失败。用完全自定义名避开。
  if (!styles.has("FigureCaption")) {
    paragraphStyles.push({
      id: "FigureCaption",
      name: "FigureCaption",
      basedOn: "Normal",
      run: { size: 21 },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 } },
    });
  }
  if (!styles.has("TableCaption")) {
    paragraphStyles.push({
      id: "TableCaption",
      name: "TableCaption",
      basedOn: "FigureCaption",
      run: { size: 21 },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 } },
    });
  }
  return { paragraphStyles };
}
