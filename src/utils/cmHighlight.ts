import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { ThemeTokens } from "../themes/tokens";

/** 语法高亮从主题 token 派生（CLAUDE.md 铁律：不用 oneDark）。 */
export function createHighlightStyle(t: ThemeTokens): HighlightStyle {
  return HighlightStyle.define([
    { tag: tags.keyword, color: t.syntaxKeyword },
    { tag: [tags.typeName, tags.definition(tags.typeName)], color: t.syntaxKeyword },
    { tag: tags.string, color: t.success },
    { tag: tags.number, color: t.syntaxNumber },
    { tag: [tags.variableName, tags.literal, tags.bool, tags.null], color: t.syntaxNumber },
    { tag: tags.comment, color: t.textMuted, fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.labelName], color: t.accent },
    { tag: [tags.propertyName, tags.attributeName], color: t.info },
    { tag: [tags.className, tags.definition(tags.className)], color: t.warning },
    { tag: tags.invalid, color: t.danger },
    { tag: [tags.bracket, tags.separator], color: t.textSecondary },
  ]);
}
