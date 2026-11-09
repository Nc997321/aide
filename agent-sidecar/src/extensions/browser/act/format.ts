import { asRecord } from "../format.js";

/** 动作与元素截图共用的定位失败说明，不在工具外壳复制一份。 */
export function describeResolveFailure(value: Record<string, unknown>): string {
  const lines = [`Could not find the target: ${String(value["error"] ?? "unknown")}`];
  const candidates = Array.isArray(value["candidates"]) ? value["candidates"] : [];
  if (!candidates.length) return lines.join("\n");
  lines.push("", candidateHeading(value["candidatesKind"]));
  for (const candidate of candidates) {
    const item = asRecord(candidate);
    if (item) lines.push(describeCandidate(item));
  }
  return lines.join("\n");
}

function candidateHeading(kind: unknown): string {
  if (kind === "text-hits") {
    return "Elements carrying that text (not recognized as clickable — retry with a `selector` from one of these):";
  }
  if (kind === "selector-matches") {
    return "Elements the selector matched (nothing was written — retry with `index`, or narrow the `selector`):";
  }
  return kind === "fields"
    ? "Form fields currently on the page (retry with `text` = one of these labels/names, or a `selector`):"
    : "Clickable elements currently on the page (retry with `text` or a `selector` from one of these):";
}

function describeCandidate(item: Record<string, unknown>): string {
  const text = String(item["text"] ?? "");
  const bits = [`<${String(item["tag"])}>`, text ? `"${text}"` : "(no label)"];
  if (item["id"]) bits.push(`#${String(item["id"])}`);
  else if (item["cls"]) bits.push(`.${String(item["cls"])}`);
  if (item["name"]) bits.push(`name=${String(item["name"])}`);
  if (item["type"]) bits.push(`type=${String(item["type"])}`);
  if (item["placeholder"]) bits.push(`placeholder="${String(item["placeholder"])}"`);
  return `- ${bits.join(" ")}`;
}

export function describeHit(value: Record<string, unknown>): string {
  const hit = asRecord(value["hit"]);
  if (!hit) return "an element";
  const bits = [`<${String(hit["tag"])}>`, `"${String(hit["text"])}"`];
  if (hit["id"]) bits.push(`#${String(hit["id"])}`);
  return bits.join(" ");
}

export function matchNote(value: Record<string, unknown>): string {
  const count = Number(value["matched"]);
  if (!Number.isFinite(count) || count <= 1) return "";
  const used = Number(value["usedIndex"]);
  return ` (${count} elements matched; used index ${Number.isFinite(used) ? used : 0})`;
}
