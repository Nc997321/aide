import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// 执行鸿蒙实际服务/路由源码；仅替换平台与 IO 边界，不复制恢复算法。
function load(file: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(`../../ohos/entry/src/main/ets/${file}.ets`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, any> = {};
  new Function("exports", "require", compiled.outputText)(exports, (name: string) => dependencies[name] ?? {});
  return exports;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  class Store {
    sid = "s1";
    permissionRevision = 0;
    pendingPermissions: any[] = [];
    sysNote = "";
  }
  class Request {
    id = "";
    name = "";
    input = {};
    selections: string[] = [];
    initQuestions(questions: unknown) { this.input = questions as object; }
  }
  const api = { listPendingPermissions: vi.fn(), permissionResponse: vi.fn().mockResolvedValue(undefined) };
  const ttsModel = { speakPermission: vi.fn(), stopPermission: vi.fn() };
  const wire = {
    str: (p: any, k: string) => typeof p[k] === "string" ? p[k] : "",
    obj: (p: any, k: string) => p[k] ?? {},
  };
  const route = load("session/chat/ChatEvents", {
    "./ChatWire": wire,
    "./ChatBlocks": { PermissionRequest: Request },
    "./PermissionShape": { parseQuestions: (input: any) => input.questions ?? [] },
    "./TtsModel": { ttsModel },
    "./ReaderModel": { readerModel: { stop: vi.fn() } },
  }).routeChatEvent;
  const module = load("session/ChatModel", {
    "../sdk/api": { api },
    "./chat/ChatStore": { ChatStore: Store },
    "./chat/ChatEvents": { routeChatEvent: route },
    "./chat/ChatWire": wire,
    "./chat/TtsModel": { ttsModel },
  });
  return { model: new module.ChatModel(), api, route, ttsModel };
}

const question = (id = "q1", sid = "s1") => ({
  type: "permission_request", session_id: sid, id, name: "AskUserQuestion",
  input: { questions: [{ question: "继续吗？", options: [{ label: "继续" }] }] },
});

describe("鸿蒙晚加入会话时恢复未决交互", () => {
  it("恢复离线期间的提问；直播重叠不重复入队且保留作答草稿", async () => {
    const { model, api, route } = harness();
    api.listPendingPermissions.mockResolvedValue([question()]);
    await model.syncPendingPermissions();
    expect(model.store.pendingPermissions).toHaveLength(1);
    expect(model.store.pendingPermissions[0].name).toBe("AskUserQuestion");
    const request = model.store.pendingPermissions[0];
    request.selections = ["继续"];
    route(model.store, question());
    await model.syncPendingPermissions();
    expect(model.store.pendingPermissions).toEqual([request]);
    expect(request.selections).toEqual(["继续"]);
  });

  it("快照返回前桌面已作答：重查现势，不复活已结束的问题", async () => {
    const { model, api, route } = harness();
    const old = deferred<any[]>();
    api.listPendingPermissions.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    const sync = model.syncPendingPermissions();
    route(model.store, { type: "permission_cancelled", session_id: "s1", id: "q1" });
    old.resolve([question()]);
    await sync;
    expect(api.listPendingPermissions).toHaveBeenCalledTimes(2);
    expect(model.store.pendingPermissions).toEqual([]);
  });

  it("查询期间新请求到达：重查保留原有及新请求", async () => {
    const { model, api, route } = harness();
    const old = deferred<any[]>();
    api.listPendingPermissions.mockReturnValueOnce(old.promise).mockResolvedValueOnce([question(), question("q2")]);
    const sync = model.syncPendingPermissions();
    route(model.store, question("q2"));
    old.resolve([question()]);
    await sync;
    expect(model.store.pendingPermissions.map((p: any) => p.id)).toEqual(["q1", "q2"]);
  });

  it("切换会话或同会话重新同步时，旧响应不能覆盖当前队列", async () => {
    const { model, api } = harness();
    const old = deferred<any[]>();
    api.listPendingPermissions.mockReturnValueOnce(old.promise).mockResolvedValueOnce([question("q2", "s2")]);
    const first = model.syncPendingPermissions();
    model.store.sid = "s2";
    await model.syncPendingPermissions();
    old.resolve([question()]);
    await first;
    expect(model.store.pendingPermissions.map((p: any) => p.id)).toEqual(["q2"]);
  });

  it("重连快照移除过期请求；查询失败明确提示并保留直播队列", async () => {
    const { model, api, route, ttsModel } = harness();
    route(model.store, question());
    api.listPendingPermissions.mockRejectedValueOnce(new Error("unknown command"));
    await model.syncPendingPermissions();
    expect(model.store.sysNote).toContain("恢复失败");
    expect(model.store.pendingPermissions).toHaveLength(1);
    api.listPendingPermissions.mockResolvedValueOnce([]);
    await model.syncPendingPermissions();
    expect(model.store.pendingPermissions).toEqual([]);
    expect(ttsModel.stopPermission).toHaveBeenCalledWith("q1");
  });

  it("本端作答也等待终结广播；RPC 失败不丢失问题", async () => {
    const { model, api, route } = harness();
    route(model.store, question());
    api.permissionResponse.mockRejectedValueOnce(new Error("offline"));
    await model.respondPermission("q1", true, null);
    expect(model.store.pendingPermissions).toHaveLength(1);
    expect(model.store.sysNote).toContain("权限应答失败");
    route(model.store, { type: "permission_cancelled", session_id: "s1", id: "q1" });
    expect(model.store.pendingPermissions).toEqual([]);
  });
});
