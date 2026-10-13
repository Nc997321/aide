import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 应用页面里那一半的桥（src-tauri/src/commands/aide_app.js）。它是随包发给应用的纯脚本，
 * 这里把它放进一个假的 window 里跑：外层（Aide 主页面）由测试扮演。
 * 重点是进程输出那一段——Host 的事件只报「有新的了」，正文要按序号取回来，不能重、不能漏。
 */
const SOURCE = readFileSync(new URL("../../src-tauri/src/commands/aide_app.js", import.meta.url), "utf8");

interface Sent {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function boot() {
  const sent: Sent[] = [];
  let onMessage: (e: { source: unknown; data: unknown }) => void = () => {};
  const parent = { postMessage: (m: Sent) => sent.push(m) };
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: typeof onMessage) => {
      if (type === "message") onMessage = fn;
    },
  };
  const quiet = { error: () => {}, log: () => {} };
  new Function("window", "console", "document", SOURCE)(win, quiet, { documentElement: { style: { setProperty() {} } } });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    aide: win.aide as any,
    sent,
    /** 外层回一次调用。 */
    async reply(method: string, result: unknown) {
      const i = sent.findIndex((m) => m.method === method);
      if (i < 0) throw new Error(`应用没有调用 ${method}`);
      const [m] = sent.splice(i, 1);
      onMessage({ source: parent, data: { aideApp: 1, id: m.id, ok: true, result } });
      await tick();
      return m.params;
    },
    /** 外层推一条事件。 */
    async push(event: string, payload: unknown) {
      onMessage({ source: parent, data: { aideApp: 1, event, payload } });
      await tick();
    },
    pending: (method: string) => sent.filter((m) => m.method === method).length,
  };
}

const line = (seq: number, text: string) => ({ seq, stream: "stdout", text });
const attached = (lines: unknown[], head: number, over: Record<string, unknown> = {}) => ({
  lines,
  first: 1,
  head,
  running: true,
  code: null,
  killed: false,
  ...over,
});

describe("aide-app.js：进程输出", () => {
  it("run 之后按序号取正文，事件只当「有新的了」；退出只报一次", async () => {
    const page = boot();
    const got: any[] = [];
    const started = page.aide.process.run({ command: "npm", args: ["run", "build"] });
    expect(await page.reply("process.run", { runId: "r1" })).toEqual({ command: "npm", args: ["run", "build"] });
    await started;
    page.aide.on("process:r1", (e: unknown) => got.push(e));

    // 第一趟：从头取
    expect(await page.reply("process.attach", attached([line(1, "a"), line(2, "b")], 2))).toEqual({ runId: "r1", since: 0 });
    expect(got.map((e) => e.data)).toEqual(["a", "b"]);
    expect(page.pending("process.attach")).toBe(0);

    // Host 说有新的：从上次看到的地方接着取，事件里的载荷本身不交给应用
    await page.push("process:r1", { type: "output", head: 3 });
    expect(got).toHaveLength(2);
    expect(await page.reply("process.attach", attached([line(3, "c")], 3))).toEqual({ runId: "r1", since: 2 });
    expect(got.map((e) => e.data)).toEqual(["a", "b", "c"]);

    // 结束：最后一趟取到「不在跑了」，报一次 exit；之后再来事件也不再取
    await page.push("process:r1", { type: "exit", code: 3, killed: false, head: 3 });
    await page.reply("process.attach", attached([], 3, { running: false, code: 3 }));
    expect(got.at(-1)).toEqual({ type: "exit", code: 3, killed: false });
    await page.push("process:r1", { type: "exit", code: 3, killed: false, head: 3 });
    expect(page.pending("process.attach")).toBe(0);
    expect(got.filter((e) => e.type === "exit")).toHaveLength(1);
  });

  it("取的途中又来了通知：不并发取，取完再取一趟", async () => {
    const page = boot();
    const got: any[] = [];
    page.aide.on("process:r9", (e: unknown) => got.push(e));
    void page.aide.process.attach("r9", { since: 5 });
    await page.push("process:r9", { type: "output", head: 7 });
    await page.push("process:r9", { type: "output", head: 8 });
    expect(page.pending("process.attach")).toBe(1);

    expect(await page.reply("process.attach", attached([line(6, "f"), line(7, "g")], 7))).toEqual({ runId: "r9", since: 5 });
    expect(await page.reply("process.attach", attached([line(8, "h")], 8))).toEqual({ runId: "r9", since: 7 });
    expect(got.map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  it("一趟没取完（行数有上限）接着取；缓冲滚过去了如实报丢了多少行", async () => {
    const page = boot();
    const got: any[] = [];
    page.aide.on("process:r2", (e: unknown) => got.push(e));
    void page.aide.process.attach("r2");
    // 缓冲里最早是第 101 行：前 100 行没了
    await page.reply("process.attach", attached([line(101, "x")], 102, { first: 101 }));
    expect(got[0]).toEqual({ type: "gap", lost: 100 });
    // head 还在前面：不等事件，直接再取
    expect(await page.reply("process.attach", attached([line(102, "y")], 102, { first: 101 }))).toEqual({ runId: "r2", since: 101 });
    expect(got.filter((e) => e.type === "output").map((e) => e.data)).toEqual(["x", "y"]);
  });

  it("没人跟的进程来了事件：不理（应用没要它的输出）", async () => {
    const page = boot();
    await page.push("process:r404", { type: "output", head: 9 });
    expect(page.pending("process.attach")).toBe(0);
  });
});

describe("aide-app.js：其余新接口只是把参数摆对", () => {
  it("find 取出文件数组；search / stat / editor.open / workspace.info 原样转", async () => {
    const page = boot();
    const found = page.aide.fs.find("package.json", { limit: 5 });
    expect(await page.reply("fs.find", { files: ["a/package.json"] })).toEqual({ name: "package.json", limit: 5 });
    expect(await found).toEqual(["a/package.json"]);

    void page.aide.fs.search("TODO", { mask: "*.ts" });
    expect(await page.reply("fs.search", {})).toEqual({ query: "TODO", mask: "*.ts" });
    void page.aide.editor.open("src/a.ts", { line: 4 });
    expect(await page.reply("editor.open", null)).toEqual({ path: "src/a.ts", line: 4 });
    void page.aide.workspace.info();
    expect(await page.reply("workspace.info", null)).toEqual({});
  });

  it("后端推的事件、文件变化按频道交给应用", async () => {
    const page = boot();
    const got: unknown[] = [];
    page.aide.on("build", (e: unknown) => got.push(e));
    page.aide.fs.watch((e: unknown) => got.push(e));
    await page.push("build", { step: 2 });
    await page.push("fs", { dirs: ["src"] });
    expect(got).toEqual([{ step: 2 }, { dirs: ["src"] }]);
  });
});
