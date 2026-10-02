// `UserMessageBlock` 在 sidecar 与 aide-sdk 各有一份且必须同形（两个包无法共享类型）。
// 漂移的后果是 display **静默失效**（接收端识别不了就降级成纯文本，不报错）——所以对账不靠人眼。
// 这里按源码文本抽出新增两种块（pageref / kbref）与老的 mention 的顶层字段名（含可选标记）逐一比对。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarSrc = readFileSync(resolve(here, "types.ts"), "utf8");
const sdkSrc = readFileSync(resolve(here, "../../../packages/aide-sdk/src/types/chat.ts"), "utf8");

/** 从 `open` 之后的第一个 `{` 起，取与之配对的 `}` 之间的内容（括号计数，容忍嵌套字面量类型）。 */
function braceBody(src: string, from: number): string {
  const start = src.indexOf("{", from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  throw new Error("括号不配对");
}

/** 顶层字段名（带 `?` 的可选标记），忽略嵌套 `{}` 里的内容与 `type` 判别字段。 */
function topLevelFields(body: string): string[] {
  let depth = 0;
  let flat = "";
  for (const ch of body) {
    if (ch === "{") depth += 1;
    if (depth === 0) flat += ch;
    if (ch === "}") depth -= 1;
  }
  const names = [...flat.matchAll(/(?:^|[;\n,{])\s*(\w+)(\??)\s*:/g)].map((m) => `${m[1]}${m[2]}`);
  return names.filter((n) => n !== "type").sort();
}

function sidecarBlock(type: string): string[] {
  const at = sidecarSrc.indexOf(`type: "${type}"`);
  expect(at, `sidecar types.ts 里没有 ${type} 块`).toBeGreaterThan(-1);
  // type 字段所在的那个 `{`（往回找最近的）
  const open = sidecarSrc.lastIndexOf("{", at);
  return topLevelFields(braceBody(sidecarSrc, open));
}

function sdkInterface(name: string): string[] {
  const at = sdkSrc.indexOf(`export interface ${name} `);
  expect(at, `chat.ts 里没有 interface ${name}`).toBeGreaterThan(-1);
  return topLevelFields(braceBody(sdkSrc, at));
}

describe("UserMessageBlock 两份定义同形", () => {
  it("kbref：字段（含可选性）一致", () => {
    expect(sidecarBlock("kbref")).toEqual(sdkInterface("KbRef"));
  });

  it("pageref：字段（含可选性）一致", () => {
    expect(sidecarBlock("pageref")).toEqual(sdkInterface("PageRef"));
  });

  it("mention：字段一致（抽取器自检：对一个老块也成立）", () => {
    const sdkAt = sdkSrc.indexOf('{ type: "mention"');
    const sdk = topLevelFields(braceBody(sdkSrc, sdkAt));
    expect(sidecarBlock("mention")).toEqual(sdk);
  });

  it("抽取器不是空转：kbref 至少有选区授权的关键字段", () => {
    expect(sidecarBlock("kbref")).toEqual(expect.arrayContaining(["selectionId", "documentId", "start", "end", "text"]));
  });
});
