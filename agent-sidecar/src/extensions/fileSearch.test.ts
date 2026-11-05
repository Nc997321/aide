import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFiles } from "./fileSearch.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "aide-search-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function put(path: string) {
  const absolute = join(root, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, "fixture");
}

describe("bounded file enumeration", () => {
  it("an aborted crawl cannot claim a complete empty result", async () => {
    await put("src/example.ts");
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const result = await findFiles({ pattern: "**/*.ts" }, root);
    expect(result).toContain("incomplete");
    expect(result).not.toContain("Showing 0 of 0");
  });
  it("the recorded broad test search does not enumerate dependency/build tests", async () => {
    await Promise.all(["src/example.test.ts", "node_modules/pkg/third.test.ts", "agent-sidecar/node_modules/pkg/third.test.ts",
      "target/deps/build.test.rs", "dist/output.test.js"].map(put));
    const result = await findFiles({ pattern: "**/*test*" }, root);
    expect(result).toContain("example.test.ts");
    expect(result).not.toContain("third.test.ts");
    expect(result).not.toContain("build.test.rs");
    expect(result).not.toContain("output.test.js");
    expect(result).toContain("Showing 1 of 1");
  });

  it("explicit investigation of dependencies remains possible", async () => {
    await put("node_modules/pkg/example.test.ts");
    expect(await findFiles({ pattern: "node_modules/**/*.ts" }, root)).toContain("example.test.ts");
    expect(await findFiles({ pattern: "**/*.ts", path: join(root, "node_modules") }, root)).toContain("example.test.ts");
  });

  it("large outputs are bounded and report omitted matches", async () => {
    await Promise.all(Array.from({ length: 205 }, (_, i) => put(`src/f${i}.ts`)));
    const result = await findFiles({ pattern: "**/*.ts" }, root);
    expect(result).toContain("Showing 200 of 205");
    expect(result).toContain("Results truncated");
    expect(result.split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(200);
  });

  it("no matches are reported honestly", async () => {
    expect(await findFiles({ pattern: "**/*.rs" }, root)).toContain("Showing 0 of 0");
  });
});
