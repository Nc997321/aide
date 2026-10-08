import { describe, it, expect } from "vitest";
import { LspNav, columnOf, findDeclaration, identifierAt, symbolName } from "./lspNav.js";
import type { LspQueryResponse, LspTool } from "./lspClient.js";
import type { OutlineNode } from "./lspFormat.js";

const ROOT = "/proj";
const MOD = "/proj/src/lsp/mod.rs";
const CALLER = "/proj/src/runtime/pump.rs";

const FILES: Record<string, string> = {
  [MOD]: [
    "pub struct LspManager {}", // 1
    "impl LspManager {", // 2
    "    pub async fn get(&self, root: &str) -> Option<Handle> {", // 3
    "        let h = self.map.get(root);", // 4
    "        h.cloned()", // 5
    "    }", // 6
    "}", // 7
  ].join("\n"),
  [CALLER]: ["fn pump(m: &LspManager) {", "    let h = m.get(\"/x\");", "}"].join("\n"),
};

const OUTLINES: Record<string, OutlineNode[]> = {
  [MOD]: [
    { name: "LspManager", kind: 23, line: 1, column: 12, start_line: 1, end_line: 1, depth: 0 },
    { name: "impl LspManager", kind: 19, line: 2, column: 6, start_line: 2, end_line: 7, depth: 0 },
    { name: "get", kind: 6, line: 3, column: 18, start_line: 3, end_line: 6, depth: 1 },
  ],
  [CALLER]: [{ name: "pump", kind: 12, line: 1, column: 4, start_line: 1, end_line: 3, depth: 0 }],
};

const qr = (file: string, line: number, column: number) => ({ symbol: { file, line, column } });

type Script = (tool: LspTool, args: Record<string, unknown>) => LspQueryResponse;

function nav(script: Script) {
  const calls: Array<{ tool: LspTool; args: Record<string, unknown> }> = [];
  const n = new LspNav({
    cwd: ROOT,
    read: async (abs) => FILES[abs] ?? null,
    query: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "outline") {
        const symbols = OUTLINES[args.file as string];
        return symbols ? { ok: true, status: "ready", symbols } : { ok: false, status: "indexing" };
      }
      return script(tool, args);
    },
  });
  return { n, calls };
}

describe("lsp_definition：一发拿到函数体", () => {
  it("按名查 → 头行（种类 + 外层）+ 整个函数体", async () => {
    const { n } = nav(() => ({ ok: true, status: "ready", results: [qr(MOD, 3, 18)] }));
    const text = await n.definition({ name: "LspManager::get" });
    expect(text.split("\n")[0]).toBe("method impl LspManager.get — src/lsp/mod.rs:3:18");
    expect(text).toContain("3\t    pub async fn get(&self, root: &str) -> Option<Handle> {");
    expect(text).toContain("6\t    }");
    expect(text).not.toContain("7\t}");
  });

  it("位置查询：说的是谁从那个位置读出来（不再是一串路径）", async () => {
    const { n, calls } = nav((tool) =>
      tool === "text" ? { ok: true, status: "ready", matches: [] } : { ok: false, status: "indexing" },
    );
    const text = await n.definition({ file: "src/runtime/pump.rs", line: 2, character: 15 });
    expect(text).toContain("`get`");
    expect(calls.find((c) => c.tool === "text")?.args).toEqual({ name: "get" });
  });
});

describe("lsp_references：分组 + 所在函数 + 代码行", () => {
  it("按名查 → 相对路径分组、标出所在函数", async () => {
    const { n } = nav(() => ({
      ok: true,
      status: "ready",
      results: [qr(CALLER, 2, 15), qr(MOD, 4, 26)],
    }));
    const text = await n.references("references", { name: "get" });
    expect(text).toContain("2 references of `get` in 2 files");
    expect(text).toContain("src/runtime/pump.rs\n  2:15  [in pump]  let h = m.get(\"/x\");");
    expect(text).toContain("src/lsp/mod.rs\n  4:26  [in impl LspManager › get]  let h = self.map.get(root);");
  });

  it("ready + 空 = 确认没有", async () => {
    const { n } = nav(() => ({ ok: true, status: "ready", results: [] }));
    expect(await n.references("references", { name: "get" })).toMatch(/^No references of `get`.*confirmed negative/);
  });

  /// 模型「调一次最坏也不亏」：语义层没答上，同一发里就给出文本命中（标明未验证）。
  it("没答上 → 同一发里文本兜底，路径相对化、标 UNVERIFIED", async () => {
    const { n, calls } = nav((tool) =>
      tool === "text"
        ? {
            ok: true,
            status: "ready",
            matches: [{ file: "src/runtime/pump.rs", line: 2, column: 15, text: 'let h = m.get("/x");' }],
          }
        : { ok: false, status: "timeout", timedOut: true },
    );
    const text = await n.references("references", { name: "LspManager::get" });
    expect(calls.map((c) => c.tool)).toEqual(["references", "text"]);
    expect(text).toContain("did not finish within the time budget");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("src/runtime/pump.rs\n  2:15");
  });

  it("非 ready 但带回了结果：结果是铁证，照常展示", async () => {
    const { n } = nav(() => ({ ok: true, status: "indexing", results: [qr(CALLER, 2, 15)] }));
    expect(await n.references("references", { name: "get" })).toContain("1 references of `get`");
  });

  it("不信任的工作区不做文本兜底（整条路径都不该答）", async () => {
    const { n, calls } = nav(() => ({ ok: false, status: "untrusted" }));
    expect(await n.references("references", { name: "get" })).toMatch(/not trusted/);
    expect(calls.some((c) => c.tool === "text")).toBe(false);
  });

  it("同名多义：候选带种类和代码行", async () => {
    const { n } = nav(() => ({
      ok: true,
      status: "ready",
      ambiguous: true,
      candidates: [
        { name: "get", kind: 6, file_path: MOD, line: 3, column: 18, lang: "rust" },
        { name: "get", kind: 12, file_path: CALLER, line: 2, column: 15, lang: "rust" },
      ],
    }));
    const text = await n.references("references", { name: "get" });
    expect(text).toContain("method  src/lsp/mod.rs:3:18  pub async fn get(&self, root: &str)");
  });
});

describe("参数补全：模型只记得一半时替它补另一半", () => {
  it("{name, file} → 在该文件里找到声明位置，按位置查（同名多义直接消歧）", async () => {
    const { n, calls } = nav(() => ({ ok: true, status: "ready", results: [] }));
    await n.references("references", { name: "get", file: "src/lsp/mod.rs" });
    const q = calls.find((c) => c.tool === "references")!;
    expect(q.args).toEqual({ file: MOD, line: 3, character: 18 });
  });

  it("{file, line} 没给列 → 取该行第一个非关键字标识符", async () => {
    const { n, calls } = nav(() => ({ ok: true, status: "ready", results: [] }));
    await n.definition({ file: MOD, line: 3 });
    expect(calls.find((c) => c.tool === "definition")!.args).toEqual({ file: MOD, line: 3, character: 18 });
  });

  // 真机 2026-09-30：结构给的是声明起点 / 文档注释行，按那个列查引用 = 查 `async` / 注释里的词
  //（后者回「确认没有引用」）。列必须挪到名字本身上。
  it("{name, file} 结构位置不在名字上 → 在声明范围里找到名字本身", async () => {
    const file = "/proj/src/sched.rs";
    FILES[file] = ["impl S {", "    /// 发起一次运行。manual 触发时", "    pub async fn start_run(&self) {", "    }", "}"].join("\n");
    OUTLINES[file] = [{ name: "start_run", kind: 6, line: 2, column: 5, start_line: 2, end_line: 4, depth: 1 }];
    const { n, calls } = nav(() => ({ ok: true, status: "ready", results: [] }));
    await n.references("references", { name: "start_run", file });
    expect(calls.find((c) => c.tool === "references")!.args).toEqual({ file, line: 3, character: 18 });
  });

  it("{name, file} 结构没好 → 取声明行，不取第一处调用", async () => {
    const file = "/proj/src/chat.ts";
    FILES[file] = ["const x = sendMessage(1);", "export function other() {}", "  async function sendMessage(p: string) {", "}"].join("\n");
    const { n, calls } = nav(() => ({ ok: true, status: "ready", results: [] }));
    await n.references("references", { name: "sendMessage", file });
    expect(calls.find((c) => c.tool === "references")!.args).toEqual({ file, line: 3, character: 18 });
  });

  it("findDeclaration：关键字声明与方法声明，调用语句不算", () => {
    expect(findDeclaration(["  run(1);", "  run(x: number): void {"], "run")).toEqual({ line: 2, character: 3 });
    expect(findDeclaration(["foo();"], "foo")).toBeNull();
    expect(findDeclaration(["pub(crate) fn go() {}"], "go")).toEqual({ line: 1, character: 15 });
  });

  it("columnOf / identifierAt / symbolName", () => {
    expect(columnOf("    pub async fn get(&self)", undefined)).toBe(18);
    expect(columnOf("let x = foo.get(1)", "get")).toBe(13);
    expect(identifierAt("let h = m.get(x);", 12)).toBe("get");
    expect(identifierAt("   ", 2)).toBeNull();
    expect(symbolName("LspManager::get")).toBe("get");
    expect(symbolName("api.sendMessage")).toBe("sendMessage");
    expect(symbolName("src/a.rs:3:1")).toBeUndefined();
  });
});

describe("lsp_symbols / lsp_outline", () => {
  it("一次多个名字，各自带种类、外层、声明行", async () => {
    const { n } = nav((_t, args) =>
      args.name === "get"
        ? { ok: true, status: "ready", results: [qr(MOD, 3, 18)] }
        : { ok: true, status: "ready", results: [qr(CALLER, 1, 4)] },
    );
    const text = await n.symbols({ names: ["get", "pump", "get"] });
    expect(text).toContain("`get` — method in impl LspManager · src/lsp/mod.rs:3:18, lines 3-6\n    pub async fn get");
    expect(text).toContain("`pump` — function · src/runtime/pump.rs:1:4, lines 1-3");
    expect(text.match(/`get` —/g)).toHaveLength(1);
  });

  it("outline 接相对路径，输出带行区间的结构", async () => {
    const { n } = nav(() => ({ ok: false, status: "error" }));
    const text = await n.outline({ file: "src/lsp/mod.rs" });
    expect(text).toContain("Structure of src/lsp/mod.rs");
    expect(text).toContain("  method get  L3-6");
  });
});
