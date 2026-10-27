// @vitest-environment jsdom
import { expect, it, vi, afterEach } from "vitest";
import { hydrateCodeBlockCopy } from "./codeBlockCopy";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("copies only code text, preserving directory-tree whitespace, without duplicate controls", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const root = document.createElement("div");
  root.innerHTML = '<pre><code>项目/\n  └─ <span>skills/</span>\n</code></pre>';
  hydrateCodeBlockCopy(root);
  hydrateCodeBlockCopy(root);
  expect(root.querySelectorAll("button")).toHaveLength(1);
  const button = root.querySelector("button")!;
  button.click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledWith("项目/\n  └─ skills/\n");
  expect(button.textContent).toBe("已复制");
  vi.runAllTimers();
  expect(button.textContent).toBe("复制");
});

it("reports clipboard failure without an unhandled rejection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const root = document.createElement("div");
  root.innerHTML = "<pre><code>text</code></pre>";
  hydrateCodeBlockCopy(root);
  root.querySelector("button")!.click();
  await Promise.resolve();
  expect(root.querySelector("button")!.textContent).toBe("复制失败");
});
