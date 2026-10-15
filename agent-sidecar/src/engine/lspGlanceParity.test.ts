// `LspGlanceItem` 在 sidecar 与 aide-sdk 各有一份且必须同形（两个包无法共享类型）。
// 漂移的后果是对话里的「LSP 补充」标记**静默**显示错 / 不显示——对账不靠人眼：两份声明逐字相同
//（去掉注释与空白后比较）。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarSrc = readFileSync(resolve(here, "types.ts"), "utf8");
const sdkSrc = readFileSync(resolve(here, "../../../packages/aide-sdk/src/types/chat.ts"), "utf8");

function declaration(src: string): string {
  const at = src.indexOf("export type LspGlanceItem =");
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("};\n", at);
  return src
    .slice(at, end + 2)
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, "");
}

describe("LspGlanceItem 两份定义同形", () => {
  it("sidecar 与 SDK 逐字一致（去注释与空白）", () => {
    expect(declaration(sidecarSrc)).toBe(declaration(sdkSrc));
  });
});
