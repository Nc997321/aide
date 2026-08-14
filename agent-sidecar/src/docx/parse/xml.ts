// 轻量 XML 遍历工具（OOXML 子集专用，字符串扫描实现，不引第三方）。
//
// docx 里的 XML 是规范化输出：无 CDATA、无处理指令、文本中的 < 一律转义为 &lt;，
// 实体仅 &amp; &lt; &gt; &quot; &apos;（+ 少量数字实体）。这种输入用带引号感知的
// 字符串扫描足够健壮，不需要完整 DOM。
//
// 设计要点：
// - 命名空间前缀按 localName 比较（w:p / p 视为同一标签），调用方不关心前缀
// - matchBlock 基于同名开/闭标签深度计数取完整块（支持嵌套与自闭合）
// - 属性匹配允许任意命名空间前缀（attr(x, "embed") 能命中 r:embed）
// - 遇到未闭合块不抛异常，按"块延伸到文件末尾"兜底——上层分类成 not_docx 交给调用方

/** qname → localName（`w:p` → `p`；无前缀原样返回） */
export function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

/** 正则转义（attr 的 name 参数拼进 RegExp） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** XML 实体解码（含 &#NN; 数字实体） */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, name: string) => {
    if (name.startsWith("#")) {
      const code = Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY_MAP[m] ?? m;
  });
}

/**
 * 从 pos 起找下一个开标签 `<qname ...>`（跳过注释/处理指令/闭标签/声明）。
 * 返回开标签 `<` 的位置；找不到返回 -1。name 按 localName 比较。
 */
export function findOpenTag(xml: string, pos: number, name: string): number {
  for (;;) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) return -1;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return -1;
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return -1;
      pos = end + 2;
      continue;
    }
    const next = xml[lt + 1];
    if (next === "/" || next === "!" || next === undefined) {
      pos = lt + 1;
      continue;
    }
    let i = lt + 1;
    while (i < xml.length && !/[\s/>]/.test(xml[i])) i++;
    if (localName(xml.slice(lt + 1, i)) === name) return lt;
    pos = lt + 1;
  }
}

/** 找任意开标签（topLevelBlocks 用）：返回 localName 与位置，找不到返回 null */
export function findOpenTagAny(xml: string, pos: number): { name: string; at: number } | null {
  for (;;) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) return null;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return null;
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return null;
      pos = end + 2;
      continue;
    }
    const next = xml[lt + 1];
    if (next === "/" || next === "!" || next === undefined) {
      pos = lt + 1;
      continue;
    }
    let i = lt + 1;
    while (i < xml.length && !/[\s/>]/.test(xml[i])) i++;
    if (i === lt + 1) {
      pos = lt + 1;
      continue;
    }
    return { name: localName(xml.slice(lt + 1, i)), at: lt };
  }
}

export interface XmlBlock {
  /** 块起始（开标签 `<` 位置） */
  start: number;
  /** 块结束（闭标签 `>` 之后，或自闭合 `/>` 之后） */
  end: number;
  /** true = 自闭合 `<w:p/>`（无内容无闭标签） */
  selfClosing: boolean;
  /** 标签 qname（含前缀，如 `w:p`；text 提取闭标签内容长度用） */
  qname: string;
}

/**
 * 从开标签位置提取完整块：`<w:p ...>...</w:p>` 或 `<w:p/>`。
 * 同名嵌套按深度计数（`<w:p>` 内不会再嵌 `<w:p>`，但表格/单元格等场景通用成立）。
 * 属性值内的 `<` 不出现（XML 规范要求转义），扫描时跳过引号只防 `>` 误判闭标签。
 * 未找到闭标签 → 块延伸到文件末尾（健壮性兜底，不抛）。
 */
export function matchBlock(xml: string, openAt: number): XmlBlock {
  let i = openAt + 1;
  while (i < xml.length && !/[\s/>]/.test(xml[i])) i++;
  const qname = xml.slice(openAt + 1, i);
  const closeTag = `</${qname}>`;

  // 扫开标签尾部（引号感知，`/>` 自闭合）
  let inQuote = false;
  let tagEnd = -1;
  for (; i < xml.length; i++) {
    const c = xml[i];
    if (inQuote) {
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      continue;
    }
    if (c === ">") {
      tagEnd = i;
      break;
    }
  }
  if (tagEnd < 0) return { start: openAt, end: xml.length, selfClosing: false, qname };
  if (xml[tagEnd - 1] === "/")
    return { start: openAt, end: tagEnd + 1, selfClosing: true, qname };

  // 深度计数找闭标签
  let depth = 1;
  let pos = tagEnd + 1;
  const openPrefix = `<${qname}`;
  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) break;
    if (xml.startsWith(closeTag, lt)) {
      depth--;
      if (depth === 0)
        return { start: openAt, end: lt + closeTag.length, selfClosing: false, qname };
      pos = lt + closeTag.length;
    } else if (xml.startsWith(openPrefix, lt)) {
      // 同名开标签：后一个字符必须是名字边界（防 w:pPr 误判成 w:p）
      const after = xml[lt + openPrefix.length];
      if (after === undefined || /[\s/>]/.test(after)) {
        if (after !== "/") depth++;
      }
      pos = lt + 1;
    } else {
      pos = lt + 1;
    }
  }
  return { start: openAt, end: xml.length, selfClosing: false, qname };
}

/** 区域内所有顶层块（不递归进嵌套）：返回 localName + 块文本。区域内无顶层块 → 空数组。 */
export function topLevelBlocks(
  xml: string,
  start: number,
  end: number,
): Array<{ name: string; block: string }> {
  const out: Array<{ name: string; block: string }> = [];
  let pos = start;
  for (;;) {
    const found = findOpenTagAny(xml, pos);
    if (!found || found.at >= end) break;
    const m = matchBlock(xml, found.at);
    out.push({ name: found.name, block: xml.slice(m.start, m.end) });
    pos = m.end;
  }
  return out;
}

/** 递归提取所有 name 块（含嵌套层），按文档顺序 */
export function extractBlocks(xml: string, name: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const at = findOpenTag(xml, pos, name);
    if (at < 0) break;
    const m = matchBlock(xml, at);
    out.push(xml.slice(m.start, m.end));
    pos = m.end;
  }
  return out;
}

/** 第一个 name 块（不存在返回 undefined） */
export function findBlock(xml: string, name: string): string | undefined {
  const at = findOpenTag(xml, 0, name);
  if (at < 0) return undefined;
  const m = matchBlock(xml, at);
  return xml.slice(m.start, m.end);
}

/** 是否存在该标签 */
export function hasTag(xml: string, name: string): boolean {
  return findOpenTag(xml, 0, name) >= 0;
}

/**
 * 开标签上的属性值（允许任意命名空间前缀，如 attr(blip, "embed") 命中 r:embed）。
 * 不存在返回 undefined；值做实体解码。
 */
export function attr(xml: string, name: string): string | undefined {
  const gt = xml.indexOf(">");
  if (gt < 0) return undefined;
  const open = xml.slice(0, gt);
  const re = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${escapeRegExp(name)}\\s*=\\s*"([^"]*)"`);
  const m = open.match(re);
  return m ? decodeEntities(m[1]) : undefined;
}

/**
 * 拼接所有 name 标签的文本内容（文档顺序；如 "t" 拼全部 `<w:t>`、"instrText" 拼域指令），
 * 空格原样保留（xml:space="preserve"），实体解码。自闭合空标签无输出。
 */
export function text(xml: string, name = "t"): string {
  const parts: string[] = [];
  let pos = 0;
  for (;;) {
    const at = findOpenTag(xml, pos, name);
    if (at < 0) break;
    const m = matchBlock(xml, at);
    if (!m.selfClosing) {
      const gt = xml.indexOf(">", at);
      const contentEnd = m.end - m.qname.length - 3; // `</` + qname + `>`
      if (contentEnd > gt + 1) parts.push(decodeEntities(xml.slice(gt + 1, contentEnd)));
    }
    pos = m.end;
  }
  return parts.join("");
}

/** bool 语义：标签存在且 val 不是 0/false/off 即 true；<w:b/>（无 val）→ true */
export function boolTag(container: string, name: string): boolean {
  const block = findBlock(container, name);
  if (!block) return false;
  const v = attr(block, "val");
  if (v === undefined) return true;
  const low = v.toLowerCase();
  return !(low === "0" || low === "false" || low === "off");
}
