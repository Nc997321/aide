import { describe, expect, it } from "vitest";
import { narrate, narrationKey, narrationText, type NarrCall } from "./narration";
import { DENY_POLICY_PREFIX, DENY_USER_PREFIX } from "./toolDenial";

const call = (name: string, input: unknown = {}, over: Partial<NarrCall> = {}): NarrCall => ({
  name,
  input,
  isPending: false,
  ...over,
});
const say = (calls: NarrCall[]) => narrationText(narrate(calls).segs);

describe("narrate：单次调用", () => {
  it("读文件：文件名 + 行号区间", () => {
    expect(say([call("Read", { file_path: "/w/src/api/expense.ts" })])).toBe("读了 expense.ts");
    expect(say([call("Read", { file_path: "C:\\w\\a.ts", offset: 12, limit: 37 })])).toBe("读了 a.ts 第 12–48 行");
  });

  it("进行中用「正在…」，标 live", () => {
    const n = narrate([call("Read", { file_path: "/a/b.ts" }, { isPending: true })]);
    expect(n.live).toBe(true);
    expect(narrationText(n.segs)).toBe("正在读 b.ts…");
  });

  it("搜索代码带命中数；没找到如实说", () => {
    expect(say([call("Grep", { pattern: "validateAmount" }, { result: "Found 4 files\na\nb\nc\nd" })])).toBe(
      "在项目里搜索了「validateAmount」，找到 4 处",
    );
    expect(say([call("Grep", { pattern: "x" }, { result: "No matches found" })])).toBe("在项目里搜索了「x」，没找到");
  });

  it("命令：失败带退出码，标 error", () => {
    const n = narrate([call("Bash", { command: "pnpm test\n# more" }, { result: "Exit code 1\nboom", isError: true })]);
    expect(n.error).toBe(true);
    expect(narrationText(n.segs)).toBe("运行了 pnpm test，失败（退出码 1）");
  });

  it("后台命令", () => {
    expect(say([call("Bash", { command: "pnpm dev", run_in_background: true })])).toBe("在后台启动了 pnpm dev");
  });

  it("被拒：说「想…」，并带拒绝方与理由", () => {
    const n = narrate([call("Bash", { command: "rm -rf dist" }, { result: `${DENY_USER_PREFIX} 先别删` })]);
    expect(narrationText(n.segs)).toBe("想运行 rm -rf dist");
    expect(n.denied?.kind).toBe("user");
    const p = narrate([call("Edit", { file_path: "/a/.env" }, { result: DENY_POLICY_PREFIX })]);
    expect(p.denied?.kind).toBe("policy");
    expect(narrationText(p.segs)).toBe("想修改 .env");
  });

  it("知识库：搜索带篇数，读文档取结果里的标题", () => {
    expect(
      say([call("mcp__aide-knowledge__search", { query: "报销" }, { result: 'Knowledge base hits for "报销" (3):\n- a' })]),
    ).toBe("在知识库里搜索了「报销」，找到 3 篇");
    expect(
      say([call("mcp__aide-knowledge__read_document", { documentId: "u" }, { result: "# 差旅报销规范 v3\ndocumentId u" })]),
    ).toBe("在知识库里读了《差旅报销规范 v3》");
  });

  it("内置浏览器：点击 / 填写 / 打开", () => {
    expect(say([call("mcp__aide-browser__browser_act", { action: "click", text: "提交" })])).toBe("在内置浏览器里点击了「提交」");
    expect(say([call("mcp__aide-browser__browser_act", { action: "fill", text: "金额", value: "99999" })])).toBe(
      "在内置浏览器里在「金额」里填了 99999",
    );
    expect(say([call("mcp__aide-browser__browser_tab", { action: "open", url: "https://oa.example.com/expense/new?x=1" })])).toBe(
      "在内置浏览器里打开了 oa.example.com/expense/new",
    );
  });

  it("操作计算机：动作用模型写的 intent，打开应用用应用名", () => {
    expect(say([call("mcp__aide-computer__computer_window", { action: "launch", app: "QQ" })])).toBe("在电脑上打开了 QQ");
    expect(say([call("mcp__aide-computer__computer_act", { intent: "给张三发送消息", steps: [] })])).toBe("在电脑上给张三发送消息");
  });

  it("代码导航：说查的是什么", () => {
    expect(say([call("mcp__aide-lsp__lsp_references", { name: "validateAmount" })])).toBe("查了 validateAmount 的引用");
    expect(say([call("mcp__aide-lsp__lsp_outline", { file: "src/a.ts" })])).toBe("看了 a.ts 的结构");
  });

  it("第三方 MCP：server + 工具名去下划线；侧栏应用去掉 app- 前缀", () => {
    expect(say([call("mcp__figma__get_file")])).toBe("用 figma 执行了「get file」");
    expect(say([call("mcp__app-api-tester__send_request")])).toBe("用 api-tester 执行了「send request」");
  });

  it("从不露出 mcp__ 原名", () => {
    const names = [
      "mcp__aide-browser__browser_eval", "mcp__aide-knowledge__update_document", "mcp__aide-docs__read_pdf",
      "mcp__aide-memory__read_memory", "mcp__aide-sessions__session_spawn", "mcp__aide-watch__watch_start",
      "mcp__aide-computer__computer_read", "mcp__x__y",
    ];
    for (const n of names) expect(say([call(n, { file_path: "/a.pdf", title: "t", root: "/r" })])).not.toContain("mcp__");
  });
});

describe("narrate：合并", () => {
  it("读多个文件：列举前 3 个 + 等", () => {
    const calls = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => call("Read", { file_path: `/w/${f}` }));
    expect(say(calls)).toBe("读了 4 个文件：a.ts、b.ts、c.ts 等");
  });

  it("同一文件读 / 改多次", () => {
    expect(say([call("Read", { file_path: "/a.ts" }), call("Read", { file_path: "/a.ts" })])).toBe("读了 a.ts（2 段）");
    expect(say([call("Edit", { file_path: "/a.ts" }), call("Edit", { file_path: "/a.ts" })])).toBe("修改了 a.ts（2 处）");
  });

  it("浏览器：做完把改变页面的动作串起来，查看 / 等待不写进去", () => {
    const calls = [
      call("mcp__aide-browser__browser_tab", { action: "open", url: "https://oa.example.com/new" }),
      call("mcp__aide-browser__browser_read"),
      call("mcp__aide-browser__browser_act", { action: "fill", text: "金额", value: "99999" }),
      call("mcp__aide-browser__browser_wait"),
      call("mcp__aide-browser__browser_act", { action: "click", text: "提交" }),
    ];
    expect(say(calls)).toBe("在内置浏览器里打开了 oa.example.com/new，在「金额」里填了 99999，并点击了「提交」");
  });

  it("浏览器：超过 3 个动作写「等 N 步」；只看没动就说最后一步", () => {
    const acts = Array.from({ length: 5 }, (_, i) => call("mcp__aide-browser__browser_act", { action: "click", text: `b${i}` }));
    expect(say(acts)).toMatch(/等 5 步$/);
    expect(say([call("mcp__aide-browser__browser_tabs"), call("mcp__aide-browser__browser_read")])).toBe(
      "在内置浏览器里查看了页面内容",
    );
  });

  it("进行中：同一行原地替换成正在跑的那一步", () => {
    const calls = [
      call("mcp__aide-computer__computer_window", { action: "launch", app: "QQ" }),
      call("mcp__aide-computer__computer_act", { intent: "给张三发送消息" }, { isPending: true }),
    ];
    const n = narrate(calls);
    expect(n.live).toBe(true);
    expect(narrationText(n.segs)).toBe("正在电脑上给张三发送消息…");
  });

  it("计数类进行中带进度", () => {
    const calls = [call("Read", { file_path: "/a.ts" }), call("Read", { file_path: "/b.ts" }, { isPending: true })];
    expect(say(calls)).toBe("正在读 b.ts…（已完成 1 个）");
  });

  it("知识库：搜索 + 读文档串成一句", () => {
    const calls = [
      call("mcp__aide-knowledge__search", { query: "报销" }, { result: 'Knowledge base hits for "报销" (3):' }),
      call("mcp__aide-knowledge__read_document", {}, { result: "# 规范\n" }),
    ];
    expect(say(calls)).toBe("在知识库里搜索了「报销」，找到 3 篇，并读了《规范》");
  });

  it("多条命令其中失败的标出来", () => {
    const calls = [call("Bash", { command: "a" }), call("Bash", { command: "b" }, { isError: true, result: "x" })];
    const n = narrate(calls);
    expect(n.error).toBe(true);
    expect(narrationText(n.segs)).toBe("运行了 2 条命令：a、b，其中 1 次没成功");
  });
});

describe("narrationKey", () => {
  it("内置类按类分，第三方按 server 分", () => {
    expect(narrationKey("Grep")).toBe(narrationKey("Glob"));
    expect(narrationKey("mcp__aide-browser__browser_act")).toBe(narrationKey("mcp__aide-browser__browser_read"));
    expect(narrationKey("mcp__figma__a")).not.toBe(narrationKey("mcp__github__a"));
    expect(narrationKey("Read")).not.toBe(narrationKey("Edit"));
  });
});
