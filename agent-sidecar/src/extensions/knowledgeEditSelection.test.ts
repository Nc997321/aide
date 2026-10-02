// 「圈中什么改什么」的端到端（工具层）：用内存里的假知识库服务跑真实的 handler 链路。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnowledgeTools, SCOPED_WRITE_REFUSAL } from "./knowledgeTools.js";
import { KB_CONFIG_FILE_ENV } from "./knowledge/config.js";
import { KbScopeStore } from "./knowledge/scope.js";
import type { UserMessageBlock } from "../engine/types.js";

type AnyTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
};

const DOC_ID = "doc-1";
const BODY = "# 回滚\n\n出现故障时先切流量到旧版本再排查。\n\n第二段不能动，连标点都不能动。\n";
const SELECTED = "切流量到旧版本";

interface FakeServer {
  content: string;
  version: number;
  puts: { content: string; changeNote?: string }[];
  /** 每次 GET 回包前的钩子：模拟「别人同时改了文档」。 */
  afterGet?: (server: FakeServer) => void;
}

function stubServer(initial: string): FakeServer {
  const server: FakeServer = { content: initial, version: 3, puts: [] };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body));
      server.puts.push({ content: body.content, changeNote: body.changeNote });
      server.content = body.content;
      server.version += 1;
      return {
        status: 200,
        text: async () => JSON.stringify({ documentId: DOC_ID, revisionId: "r", versionNo: server.version, merged: false }),
      } as Response;
    }
    server.afterGet?.(server); // 在组装回包之前：钩子改的内容这一次 GET 就看得到
    const payload = {
      id: DOC_ID, spaceId: "sp", slug: "x", title: "发布流程", status: "draft",
      content: server.content, versionNo: server.version,
    };
    return { status: 200, text: async () => JSON.stringify(payload) } as Response;
  });
  return server;
}

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-sel-"));
  const file = join(dir, "knowledge.json");
  writeFileSync(file, '{"version":1,"baseUrl":"http://kb.test","token":"tok"}');
  env = { [KB_CONFIG_FILE_ENV]: file } as NodeJS.ProcessEnv;
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function kbref(over: Record<string, unknown> = {}): UserMessageBlock {
  const start = BODY.indexOf(SELECTED);
  return {
    type: "kbref", selectionId: "s1", documentId: DOC_ID, title: "发布流程", baseVersion: 3,
    start, end: start + SELECTED.length, text: SELECTED, comment: "写得更具体些",
    lineStart: 3, lineEnd: 3, precise: true, ...over,
  } as UserMessageBlock;
}

function setup(withScope = true) {
  const scopes = new KbScopeStore();
  if (withScope) scopes.replaceFromDisplay([kbref()]);
  const tools = buildKnowledgeTools(env, "/proj", scopes) as unknown as AnyTool[];
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(name);
    return t;
  };
  return { scopes, tool };
}

describe("edit_selection", () => {
  it("只改圈选那一段：前后原样，写入后读回核对，变更说明带上用户意见", async () => {
    const server = stubServer(BODY);
    const { tool } = setup();
    const r = await tool("edit_selection").handler({ selectionId: "s1", newText: "把入口流量全部切回上一个稳定版本" }, undefined);
    const start = BODY.indexOf(SELECTED);
    expect(server.puts).toHaveLength(1);
    const written = server.puts[0]!.content;
    expect(written.slice(0, start)).toBe(BODY.slice(0, start));
    expect(written.endsWith(BODY.slice(start + SELECTED.length))).toBe(true);
    expect(written).toContain("第二段不能动，连标点都不能动。");
    expect(written).toContain("把入口流量全部切回上一个稳定版本");
    expect(server.puts[0]!.changeNote).toContain("写得更具体些");
    expect(r.content[0]!.text).toContain("Edited the selection");
    expect(r.content[0]!.text).toContain("everything outside the selection is unchanged");
  });

  it("agent 没有「范围」参数：入参只有 selectionId / newText / changeNote", () => {
    stubServer(BODY);
    const { tool } = setup();
    expect(Object.keys(tool("edit_selection").inputSchema).sort()).toEqual(["changeNote", "newText", "selectionId"]);
  });

  it("文档在圈选之后被改过（原文不在原位）→ 拒绝，不写", async () => {
    const server = stubServer("新增了一行。\n" + BODY);
    const { tool } = setup();
    const r = await tool("edit_selection").handler({ selectionId: "s1", newText: "x" }, undefined);
    expect(server.puts).toHaveLength(0);
    expect(r.content[0]!.text).toContain("no longer where the user selected");
    expect(r.content[0]!.text).toContain("select the text again");
  });

  it("没有这个选区 id / 本轮没圈选 → 拒绝", async () => {
    const server = stubServer(BODY);
    const a = setup();
    const r1 = await a.tool("edit_selection").handler({ selectionId: "s9", newText: "x" }, undefined);
    expect(r1.content[0]!.text).toContain("Selections available this turn: s1");
    const b = setup(false);
    const r2 = await b.tool("edit_selection").handler({ selectionId: "s1", newText: "x" }, undefined);
    expect(r2.content[0]!.text).toContain("has not selected anything");
    expect(server.puts).toHaveLength(0);
  });

  it("写入后读回发现选区之外变了 → 如实告警", async () => {
    const server = stubServer(BODY);
    let gets = 0;
    server.afterGet = (s) => {
      gets += 1;
      if (gets === 2) s.content = "有人同时在开头加了字。" + s.content; // 第二次 GET = 写后核对
    };
    const { tool } = setup();
    const r = await tool("edit_selection").handler({ selectionId: "s1", newText: "改" }, undefined);
    expect(r.content[0]!.text).toContain("WARNING");
  });

  it("改成功后范围移到新文本：同一轮可以对同一选区再改一次，且仍只动这一段", async () => {
    const server = stubServer(BODY);
    const { tool } = setup();
    await tool("edit_selection").handler({ selectionId: "s1", newText: "第一版改写" }, undefined);
    await tool("edit_selection").handler({ selectionId: "s1", newText: "第二版改写" }, undefined);
    expect(server.puts).toHaveLength(2);
    const start = BODY.indexOf(SELECTED);
    const final = server.puts[1]!.content;
    expect(final.slice(0, start)).toBe(BODY.slice(0, start));
    expect(final.endsWith(BODY.slice(start + SELECTED.length))).toBe(true);
    expect(final).toContain("第二版改写");
    expect(final).not.toContain("第一版改写");
  });
});

describe("圈选生效期间，其余写工具一律拒绝", () => {
  const writeCalls: [string, unknown][] = [
    ["update_document", { documentId: DOC_ID, content: "整篇重写" }],
    ["append_document", { documentId: DOC_ID, content: "追加" }],
    ["create_document", { title: "新文档", content: "x", spaceId: "sp" }],
    ["create_folder", { title: "新目录", spaceId: "sp" }],
    ["move_document", { documentId: DOC_ID, parentId: null }],
    ["delete_document", { documentId: DOC_ID }],
    ["ingest_file", { filePath: "a.md", spaceId: "sp" }],
  ];

  it.each(writeCalls)("%s 被拒绝，且不发任何请求", async (name, args) => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (...a: unknown[]) => {
      calls.push(a);
      return { status: 200, text: async () => "{}" } as Response;
    });
    const { tool } = setup();
    const r = await tool(name).handler(args, undefined);
    expect(r.content[0]!.text).toBe(SCOPED_WRITE_REFUSAL);
    expect(calls).toHaveLength(0);
  });

  it("读工具不受影响", async () => {
    const server = stubServer(BODY);
    const { tool } = setup();
    const r = await tool("read_document").handler({ documentId: DOC_ID }, undefined);
    expect(r.content[0]!.text).toContain("第二段不能动");
    expect(server.puts).toHaveLength(0);
  });

  it("下一条不带圈选的用户消息到达后，写工具恢复可用", async () => {
    const server = stubServer(BODY);
    const { tool, scopes } = setup();
    scopes.replaceFromDisplay([{ type: "text", text: "好，那你再整体润色一下" }]);
    await tool("update_document").handler({ documentId: DOC_ID, content: "整篇" }, undefined);
    expect(server.puts).toHaveLength(1);
  });
});
