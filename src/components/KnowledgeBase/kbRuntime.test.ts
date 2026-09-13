import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setTransport } from "@aide/sdk";
import { pushKnowledgeRuntime } from "./kbRuntime";

/**
 * 假传输：记录 invoke 的真实命令名与参数——命令名/参数名（camelCase → Rust snake_case）
 * 拼错了真跑 app 才会发现，这是唯一能在单测里把它们钉住的地方。
 * failWith：模拟主进程侧失败（写文件失败等），验「失败不抛」契约。
 */
function installFakeTransport(failWith?: Error): { cmd: string; args: unknown }[] {
  const calls: { cmd: string; args: unknown }[] = [];
  setTransport({
    async invoke<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ cmd: command, args: params });
      if (failWith) throw failWith;
      return undefined as T;
    },
    async listen() {
      return () => {};
    },
  });
  return calls;
}

describe("pushKnowledgeRuntime", () => {
  beforeEach(() => {
    // 根 vitest 是 environment: node，没有 localStorage（kbClient 依赖它）
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("把 localStorage 里的 baseUrl + token 原样推给主进程", async () => {
    const calls = installFakeTransport();
    localStorage.setItem("aide.kb.baseUrl", "http://kb:8788");
    localStorage.setItem("aide.kb.token", "tok-1");

    await pushKnowledgeRuntime();

    expect(calls).toEqual([
      { cmd: "knowledge_set_runtime_config", args: { baseUrl: "http://kb:8788", token: "tok-1" } },
    ]);
  });

  it("未登录时推 baseUrl + null（主进程据此删文件）", async () => {
    const calls = installFakeTransport();

    await pushKnowledgeRuntime();

    expect(calls).toEqual([
      {
        cmd: "knowledge_set_runtime_config",
        args: { baseUrl: "http://127.0.0.1:8788", token: null },
      },
    ]);
  });

  it("推送失败不抛（调用方是 fire-and-forget，抛了会变成未处理拒绝）", async () => {
    const calls = installFakeTransport(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(pushKnowledgeRuntime()).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalled(); // 失败要留痕，不是空 catch
  });
});
