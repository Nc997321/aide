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

// createKbClient 默认透传真实实现；throwRaw 打开时给出一个抛**非 Error** 的假 client——
// 这是形状漂移之外的另一条降级臂（String(e) 分支）。真实代码里只有我们自己 throw 非
// Error 才走得进去，故用一层薄 mock 把这条防御臂钉死；其余能力全是真实现。
const clientProbe = vi.hoisted(() => ({ throwRaw: null as string | null }));
vi.mock("./knowledge/client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./knowledge/client.js")>();
  return {
    ...real,
    createKbClient: (...args: Parameters<typeof real.createKbClient>) => {
      if (clientProbe.throwRaw === null) return real.createKbClient(...args);
      const boom = async (): Promise<never> => {
        throw clientProbe.throwRaw;
      };
      return { getJson: boom, sendJson: boom, sendFile: boom };
    },
  };
});

/** 会话 cwd 由调用点给：多数用例不碰磁盘（默认 /proj），ingest_file 用例传临时目录。 */
function toolByName(env: NodeJS.ProcessEnv, name: string, cwd = "/proj"): AnyTool {
  const tools = buildKnowledgeTools(env, cwd) as unknown as AnyTool[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not built`);
  return found;
}

let dir: string;
let cwdDir: string;
let credEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-tools-"));
  const file = join(dir, "knowledge.json");
  writeFileSync(file, '{"version":1,"baseUrl":"http://kb.test","token":"tok"}');
  credEnv = { [KB_CONFIG_FILE_ENV]: file } as NodeJS.ProcessEnv;
  cwdDir = mkdtempSync(join(tmpdir(), "kb-cwd-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
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
  it("4 读 + 7 写，顺序稳定", () => {
    const names = (buildKnowledgeTools(credEnv, "/proj") as unknown as { name: string }[]).map((t) => t.name);
    expect(names).toEqual([
      "search", "read_document", "list_spaces", "list_documents",
      "create_document", "create_folder", "move_document",
      "append_document", "update_document", "ingest_file", "delete_document",
    ]);
  });
});

describe("未配置凭据（恒挂的降级路径）", () => {
  it("未登录时读工具（kbCall 壳）只回引导文本，且不发请求", async () => {
    const calls = stubFetch({ status: 200, body: "{}" });
    const r = await toolByName({} as NodeJS.ProcessEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("sign in");
    expect(calls).toEqual([]);
  });

  it("未登录时写工具（kbWrite 壳）同样只回引导文本，且不发请求", async () => {
    const calls = stubFetch({ status: 200, body: "{}" });
    const r = await toolByName({} as NodeJS.ProcessEnv, "create_document")
      .handler({ title: "t", content: "c" }, undefined);
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

// 修复轮 2（评审 Important #1）：200 + 合法 JSON 但形状不对（KB 换版本 / 中间代理 /
// 部署版本不一致），格式化器解引用畸形数据会抛 TypeError 穿出 handler —— MCP 会把它
// 变成 isError，正是本模块红线禁止的。kbCall 的 catch 是唯一咽喉点，降级成文本。
describe("200 但响应形状不对（畸形 2xx）", () => {
  it("list_spaces：resolves（不是 rejects），降级成 bad_response 文本", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ not: "an array" }) });
    const p = toolByName(credEnv, "list_spaces").handler({}, undefined);
    await expect(p).resolves.toBeDefined(); // rejects 会先在这里红（红线要挡的正是它）
    const r = await p;
    expect(r.content[0]!.text).toContain("unexpected response shape");
  });

  it("list_documents：resolves（不是 rejects），降级成 bad_response 文本", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ not: "an array" }) });
    const p = toolByName(credEnv, "list_documents").handler({ spaceId: "s1" }, undefined);
    await expect(p).resolves.toBeDefined();
    const r = await p;
    expect(r.content[0]!.text).toContain("unexpected response shape");
  });
});

describe("写工具", () => {
  it("create_document：带 spaceId 直接 POST，不再拉空间列表", async () => {
    const urls = stubFetch({ status: 200, body: JSON.stringify({ documentId: "d1", revisionId: "r1", versionNo: 1, merged: false }) });
    const r = await toolByName(credEnv, "create_document")
      .handler({ spaceId: "s1", title: "标题", content: "正文" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/documents"]);
    expect(r.content[0]!.text).toContain("Created");
  });

  it("append_document：先 GET 再 PUT，PUT 正文含旧正文", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      if (init.method === "PUT") bodies.push(JSON.parse(String(init.body)));
      const body = init.method === "GET"
        ? { id: "d1", spaceId: "s1", slug: "a", title: "T", content: "旧", versionNo: 1, status: "published" }
        : { documentId: "d1", revisionId: "r", versionNo: 2, merged: false };
      return { status: 200, text: async () => JSON.stringify(body) } as Response;
    });
    const r = await toolByName(credEnv, "append_document").handler({ documentId: "d1", content: "新" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/documents/d1", "http://kb.test/api/documents/d1"]);
    expect((bodies[0] as { content: string }).content).toBe("旧\n\n新");
    expect(r.content[0]!.text).toContain("Appended");
  });

  it("写工具省略 spaceId 且多个空间 → 回问用户，不发写请求", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify([{ id: "s1", key: "a", name: "工程", visibility: "internal" }, { id: "s2", key: "b", name: "产品", visibility: "internal" }]) } as Response;
    });
    const r = await toolByName(credEnv, "create_document").handler({ title: "t", content: "c" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/spaces"]);
    expect(r.content[0]!.text).toContain("Ask the user");
  });

  it("ingest_file：相对路径按会话 cwd 解析（cwd 由 buildKnowledgeTools 第二参给）", async () => {
    writeFileSync(join(cwdDir, "note.md"), "# 笔记");
    const urls = stubFetch({ status: 201, body: JSON.stringify({ documentId: "d1", revisionId: "r1", title: "笔记", backend: "markdown" }) });
    const r = await toolByName(credEnv, "ingest_file", cwdDir).handler({ filePath: "note.md", spaceId: "s1" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/ingest?spaceId=s1"]);
    expect(r.content[0]!.text).toContain("Imported");
  });

  // kbWrite 与 kbCall 同属「永不抛」红线：写工具也会先拉 /api/spaces，畸形 2xx 下
  // decideSpace 解构非数组会抛 TypeError，没有这层 catch 就会变成 MCP 的 isError。
  it("写工具 200 但形状不对 → resolves（不是 rejects），降级成 bad_response 文本", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ not: "an array" }) });
    const p = toolByName(credEnv, "create_document").handler({ title: "t", content: "c" }, undefined);
    await expect(p).resolves.toBeDefined();
    const r = await p;
    expect(r.content[0]!.text).toContain("unexpected response shape");
  });

  it("抛出的不是 Error → 也降级成文本（String(e) 臂，不穿出 handler）", async () => {
    clientProbe.throwRaw = "boom-as-string";
    try {
      const p = toolByName(credEnv, "search").handler({ query: "x" }, undefined);
      await expect(p).resolves.toBeDefined();
      const r = await p;
      expect(r.content[0]!.text).toContain("boom-as-string");
    } finally {
      clientProbe.throwRaw = null; // 复位：漏复位会污染后续用例
    }
  });

  /** 写工具的两跳（GET 当前文档 → PUT 写回）假 fetch：GET 给 doc，其余给 save 回执。 */
  function stubReadWrite() {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      if (init.method === "PUT") bodies.push(JSON.parse(String(init.body)));
      const body = init.method === "GET"
        ? { id: "d1", spaceId: "s1", slug: "a", title: "原标题", content: "旧", versionNo: 1, status: "published" }
        : { documentId: "d1", revisionId: "r", versionNo: 2, merged: false };
      return { status: 200, text: async () => JSON.stringify(body) } as Response;
    });
    return { urls, bodies };
  }

  it("update_document：先 GET 再 PUT，title/changeNote 给了就带上", async () => {
    const { urls, bodies } = stubReadWrite();
    const r = await toolByName(credEnv, "update_document")
      .handler({ documentId: "d1", content: "新正文", title: "新标题", changeNote: "重写一节" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/documents/d1", "http://kb.test/api/documents/d1"]);
    expect(bodies[0]).toEqual({ title: "新标题", content: "新正文", changeNote: "重写一节" });
    expect(r.content[0]!.text).toContain("Updated");
  });

  it("update_document：省略 title/changeNote → 沿用当前标题、不带 changeNote", async () => {
    const { bodies } = stubReadWrite();
    await toolByName(credEnv, "update_document").handler({ documentId: "d1", content: "新正文" }, undefined);
    expect(bodies[0]).toEqual({ title: "原标题", content: "新正文" });
  });

  it("create_document：给了 parentId 就带上（嵌套文档）", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { status: 200, text: async () => JSON.stringify({ documentId: "d", revisionId: "r", versionNo: 1, merged: false }) } as Response;
    });
    await toolByName(credEnv, "create_document")
      .handler({ spaceId: "s1", title: "t", content: "c", parentId: "p1" }, undefined);
    expect(bodies[0]).toEqual({ spaceId: "s1", title: "t", content: "c", parentId: "p1" });
  });

  it("append_document：changeNote 给了就带上（写进版本历史）", async () => {
    const { bodies } = stubReadWrite();
    await toolByName(credEnv, "append_document").handler({ documentId: "d1", content: "新", changeNote: "补一条" }, undefined);
    expect(bodies[0]).toEqual({ title: "原标题", content: "旧\n\n新", changeNote: "补一条" });
  });

  it("ingest_file：给了 parentId → 进查询串（两者都可选，undefined 不进 URL）", async () => {
    writeFileSync(join(cwdDir, "note2.md"), "# 笔记");
    const urls = stubFetch({ status: 201, body: JSON.stringify({ documentId: "d", revisionId: "r", title: "笔记", backend: "markdown" }) });
    await toolByName(credEnv, "ingest_file", cwdDir)
      .handler({ filePath: "note2.md", spaceId: "s1", parentId: "p1" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/ingest?spaceId=s1&parentId=p1"]);
  });

  it("ingest_file：省略 spaceId 且多空间 → 回问用户，不上传（文件是否存在都轮不到）", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify([{ id: "s1", key: "a", name: "工程", visibility: "internal" }, { id: "s2", key: "b", name: "产品", visibility: "internal" }]) } as Response;
    });
    const r = await toolByName(credEnv, "ingest_file", cwdDir).handler({ filePath: "never-read.md" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/spaces"]);
    expect(r.content[0]!.text).toContain("Ask the user");
  });

  /** 删除的两跳假 fetch：GET 给当前文档，DELETE 给删除回执。 */
  function stubReadDelete(deletedCount = 3) {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "", url });
      const body = init.method === "GET"
        ? { id: "d1", spaceId: "s1", slug: "a", title: "废弃设计", content: "旧正文", versionNo: 2, status: "draft" }
        : { documentId: "d1", deletedCount };
      return { status: 200, text: async () => JSON.stringify(body) } as Response;
    });
    return calls;
  }

  it("delete_document：先 GET 拿标题再 DELETE，回执点名删的是哪篇、连带几篇", async () => {
    const calls = stubReadDelete(3);
    const r = await toolByName(credEnv, "delete_document").handler({ documentId: "d1" }, undefined);
    expect(calls).toEqual([
      { method: "GET", url: "http://kb.test/api/documents/d1" },
      { method: "DELETE", url: "http://kb.test/api/documents/d1" },
    ]);
    // 只给 uuid 的回执，用户无法核对删对了没有 —— 标题必须在
    expect(r.content[0]!.text).toContain("废弃设计");
    expect(r.content[0]!.text).toContain("2 sub-documents");
  });

  it("delete_document：单篇（无子文档）时不提子文档", async () => {
    stubReadDelete(1);
    const r = await toolByName(credEnv, "delete_document").handler({ documentId: "d1" }, undefined);
    expect(r.content[0]!.text).not.toContain("sub-document");
  });

  it("delete_document：读不到文档（404）→ 如实回文本，绝不发 DELETE", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? "");
      return { status: 404, text: async () => JSON.stringify({ error: "not_found", message: "文档不存在或已被删除" }) } as Response;
    });
    const r = await toolByName(credEnv, "delete_document").handler({ documentId: "gone" }, undefined);
    expect(methods).toEqual(["GET"]);
    expect(r.content[0]!.text).toContain("404");
  });
});

describe("目录树工具（create_folder / move_document）", () => {
  it("两个工具都在工具表里", () => {
    expect(() => toolByName(credEnv, "create_folder")).not.toThrow();
    expect(() => toolByName(credEnv, "move_document")).not.toThrow();
  });

  it("create_folder 发 POST，载荷带 kind=folder 与标题", async () => {
    let sent: { url: string; body: unknown } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      return {
        status: 201,
        text: async () =>
          JSON.stringify({ documentId: "f1", revisionId: "00000000-0000-0000-0000-000000000000", versionNo: 0, merged: false }),
      } as Response;
    });
    const r = await toolByName(credEnv, "create_folder").handler(
      { title: "运维手册", spaceId: "s1", parentId: "p1" },
      undefined,
    );
    expect(sent!.body).toMatchObject({ kind: "folder", title: "运维手册", spaceId: "s1", parentId: "p1" });
    expect(r.content[0]!.text).toContain("f1");
    // 回执必须点明「拿这个 id 当 parentId 用」——否则模型建完文件夹不知道下一步
    expect(r.content[0]!.text).toContain("parentId");
  });

  it("move_document 先读后写，且 PATCH 用 camelCase 的 parentId", async () => {
    const calls: { method: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ method, body: init.body ? JSON.parse(String(init.body)) : null });
      return {
        status: 200,
        text: async () =>
          method === "GET"
            ? JSON.stringify({ id: "d1", spaceId: "s1", parentId: null, slug: "d1", title: "回滚手册", content: "", versionNo: 1, status: "draft" })
            : JSON.stringify({ documentId: "d1", revisionId: "00000000-0000-0000-0000-000000000000", versionNo: 0, merged: false }),
      } as Response;
    });
    const r = await toolByName(credEnv, "move_document").handler({ documentId: "d1", parentId: "f9" }, undefined);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.body).toEqual({ parentId: "f9" });
    expect(r.content[0]!.text).toContain("回滚手册");
  });

  it("move_document 省略 parentId = 移到根（显式发 null，不是不发）", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") bodies.push(JSON.parse(String(init.body)));
      return {
        status: 200,
        text: async () =>
          init.method === "PATCH"
            ? JSON.stringify({ documentId: "d1", revisionId: "00000000-0000-0000-0000-000000000000", versionNo: 0, merged: false })
            : JSON.stringify({ id: "d1", spaceId: "s1", parentId: "f1", slug: "d1", title: "回滚手册", content: "", versionNo: 1, status: "draft" }),
      } as Response;
    });
    await toolByName(credEnv, "move_document").handler({ documentId: "d1" }, undefined);
    // 服务端用 double_option 三态区分「缺省」与「null」——这里必须发 null 才是「移到根」
    expect(bodies[0]).toEqual({ parentId: null });
  });

  it("move_document：已经在目标位置 → 不发 PATCH，如实说没动", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      return {
        status: 200,
        text: async () => JSON.stringify({ id: "d1", spaceId: "s1", parentId: "f1", slug: "d1", title: "回滚手册", content: "", versionNo: 1, status: "draft" }),
      } as Response;
    });
    const r = await toolByName(credEnv, "move_document").handler({ documentId: "d1", parentId: "f1" }, undefined);
    expect(methods).toEqual(["GET"]);
    expect(r.content[0]!.text).toContain("nothing moved");
  });
});
