import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnowledgeTools } from "./knowledgeTools.js";
import { KB_CONFIG_FILE_ENV } from "./knowledge/config.js";

/** 取工具定义（按名字），并调用它的 handler ——与真实模型调用同一条代码路径。
 *  handler 的入参用 `unknown`（不用 `any`）：测试传的都是对象字面量，收窄在这里没有价值。 */
type AnyTool = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
};

function toolByName(env: NodeJS.ProcessEnv, name: string): AnyTool {
  const tools = buildKnowledgeTools(env) as unknown as AnyTool[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not built`);
  return found;
}

let dir: string;
let credEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-tools-"));
  const file = join(dir, "knowledge.json");
  writeFileSync(file, '{"version":1,"baseUrl":"http://kb.test","token":"tok"}');
  credEnv = { [KB_CONFIG_FILE_ENV]: file } as NodeJS.ProcessEnv;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** 用假 fetch 顶掉全局 fetch（client.ts 的默认参数在调用时读全局，所以能顶掉）。 */
function stubFetch(reply: { status: number; body: string }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return { status: reply.status, text: async () => reply.body } as Response;
  });
  return calls;
}

describe("buildKnowledgeTools", () => {
  it("P1 只暴露 4 个读工具", () => {
    const names = (buildKnowledgeTools(credEnv) as unknown as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["search", "read_document", "list_spaces", "list_documents"]);
  });
});

describe("未配置凭据（恒挂的降级路径）", () => {
  it("任何工具都返回「未连接 + 去登录」，且不发请求", async () => {
    const calls = stubFetch({ status: 200, body: "{}" });
    const r = await toolByName({} as NodeJS.ProcessEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("sign in");
    expect(calls).toEqual([]);
  });
});

describe("search", () => {
  it("拼 q / spaceId / limit，返回命中", async () => {
    const calls = stubFetch({
      status: 200,
      body: JSON.stringify({
        query: "部署",
        hits: [{ documentId: "d1", spaceId: "s1", title: "上线", versionNo: 1, rank: 0.9, snippet: "[[HL]]部署[[/HL]]" }],
      }),
    });
    const r = await toolByName(credEnv, "search").handler({ query: "部署", spaceId: "s1", limit: 5 }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/search?q=%E9%83%A8%E7%BD%B2&spaceId=s1&limit=5");
    expect(r.content[0]!.text).toContain("d1");
  });

  it("401 → 引导重新登录（不是抛错）", async () => {
    stubFetch({ status: 401, body: '{"error":"unauthorized","message":"登录已失效"}' });
    const r = await toolByName(credEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("sign in again");
  });

  it("网络失败 → 带 baseUrl 的文本", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await toolByName(credEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("http://kb.test");
  });
});

describe("read_document", () => {
  it("取全文并做 URL 编码（id 不会拼出额外路径段）", async () => {
    const calls = stubFetch({
      status: 200,
      body: JSON.stringify({ id: "d/1", spaceId: "s1", slug: "a", title: "T", content: "正文", versionNo: 2, status: "published" }),
    });
    const r = await toolByName(credEnv, "read_document").handler({ documentId: "d/1" }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/documents/d%2F1");
    expect(r.content[0]!.text).toContain("正文");
  });

  it("404 → 引导回 search", async () => {
    stubFetch({ status: 404, body: '{"error":"not_found","message":"不存在"}' });
    const r = await toolByName(credEnv, "read_document").handler({ documentId: "x" }, undefined);
    expect(r.content[0]!.text).toContain("search");
  });
});

describe("list_spaces / list_documents", () => {
  it("list_spaces 打 /api/spaces 并渲染空间", async () => {
    const calls = stubFetch({
      status: 200,
      body: JSON.stringify([{ id: "s1", key: "eng", name: "工程", visibility: "internal" }]),
    });
    const r = await toolByName(credEnv, "list_spaces").handler({}, undefined);
    expect(calls[0]).toBe("http://kb.test/api/spaces");
    expect(r.content[0]!.text).toContain("工程");
  });

  it("list_documents 打空间文档树", async () => {
    const calls = stubFetch({ status: 200, body: JSON.stringify([]) });
    const r = await toolByName(credEnv, "list_documents").handler({ spaceId: "s1" }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/spaces/s1/documents");
    expect(r.content[0]!.text).toContain("no documents");
  });
});

// 以下 2 条超出 brief（brief 的 9 条逐字未动）——钉的是 tool 层「永不抛」红线：
// 裸 encodeURIComponent 对孤立代理项（"\uD800"）抛 URIError 会穿出 handler
// （实测 URIError: URI malformed），而 zod 的 z.string() 不拦它。
// 编码归属地在 client.ts 的 spaceDocsPath（修复轮 1 起由它导出），工具层只调用。
describe("list_documents 的 spaceId 编码兜底", () => {
  it("孤立代理项不抛，落到 U+FFFD 再编码", async () => {
    const calls = stubFetch({ status: 200, body: JSON.stringify([]) });
    const r = await toolByName(credEnv, "list_documents").handler({ spaceId: "s\uD800" }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/spaces/s%EF%BF%BD/documents");
    expect(r.content[0]!.text).toContain("no documents");
  });

  it("合法代理对（emoji）不被改写", async () => {
    const calls = stubFetch({ status: 200, body: JSON.stringify([]) });
    await toolByName(credEnv, "list_documents").handler({ spaceId: "s😀" }, undefined);
    // 期望值写死字面量（不用 encodeURIComponent 当自己的判据）：F0 9F 98 80 是 U+1F600 的 UTF-8
    expect(calls[0]).toBe("http://kb.test/api/spaces/s%F0%9F%98%80/documents");
  });
});
