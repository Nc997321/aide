import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { usePermissionRememberContext } from "./usePermissionRememberContext";
import type {
  PermissionRule,
  PermissionRuleDraft,
  PermissionSettingsView,
  ScopeAvailability,
} from "../types/permissions";

// ---------------------------------------------------------------------------
// 桩件
// ---------------------------------------------------------------------------

const avail = (scope: "local" | "user", editable: boolean): ScopeAvailability => ({
  scope,
  editable,
  reason: "",
  storagePath: null,
  description: "",
});

const viewOf = (
  rules: PermissionRule[],
  scopes: ScopeAvailability[],
): PermissionSettingsView => ({ revision: 1, rules, scopes });

const LOCAL_USER = [avail("local", true), avail("user", true)];
const USER_ONLY = [avail("local", false), avail("user", true)];
const NONE_EDITABLE = [avail("local", false), avail("user", false)];

const allowRule = (value: string): PermissionRule => ({
  id: `r-${value}`,
  scope: "user",
  order: 0,
  effect: "allow",
  tool: "Bash",
  matcher: { kind: "bash", mode: "prefix", value },
  source: { label: "test", readOnly: false },
});

const draftOf = (value: string): PermissionRuleDraft => ({
  effect: "allow",
  tool: "Bash",
  matcher: { kind: "bash", mode: "prefix", value },
});

/** 立即 resolve 固定视图的 api 桩（Mock 便于个别用例改行为）。 */
function makeApi(view: PermissionSettingsView) {
  return {
    get: vi.fn(async () => view),
    createMany: vi.fn(async () => view),
  };
}

/** get 逐次返回 views 序列的 api 桩。 */
function makeSeqApi(views: PermissionSettingsView[]) {
  let call = 0;
  const get = vi.fn(() => {
    const v = views[Math.min(call, views.length - 1)] ?? views[0] ?? viewOf([], []);
    call++;
    return Promise.resolve(v);
  });
  const createMany = vi.fn(async () => views[views.length - 1] ?? viewOf([], []));
  return { get, createMany };
}

/** 排空 watch 回调与 await 的微任务链（async 回调两层微任务，一次 nextTick 排不完）。 */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await nextTick();
}

// ---------------------------------------------------------------------------
// 快照三态
// ---------------------------------------------------------------------------

describe("usePermissionRememberContext 快照三态", () => {
  it("请求出现 → ready，rules 透传、scope 解析 local 优先", async () => {
    const view = viewOf([allowRule("pnpm test")], LOCAL_USER);
    const { get, createMany } = makeApi(view);
    const reqId = ref<string | null>("p1");
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api: { get, createMany },
    });
    await flush();
    expect(ctx.state.value).toEqual({
      status: "ready",
      rules: view.rules,
      scope: "local",
    });
  });

  it("local 不可编辑回退 user；双不可编辑 → ready 且 scope=null", async () => {
    const reqIdUser = ref<string | null>("p1");
    const ctxUser = usePermissionRememberContext({
      requestId: () => reqIdUser.value,
      workspacePath: () => "C:/ws",
      api: makeSeqApi([viewOf([], USER_ONLY)]),
    });
    await flush();
    expect(ctxUser.state.value).toEqual({ status: "ready", rules: [], scope: "user" });

    const reqIdNone = ref<string | null>("p1");
    const ctxNone = usePermissionRememberContext({
      requestId: () => reqIdNone.value,
      workspacePath: () => "C:/ws",
      api: makeSeqApi([viewOf([], NONE_EDITABLE)]),
    });
    await flush();
    expect(ctxNone.state.value).toEqual({ status: "ready", rules: [], scope: null });
  });

  it("无挂起请求（requestId=null）→ 保持 loading 且不调 get", async () => {
    const reqId = ref<string | null>(null);
    const { get, createMany } = makeApi(viewOf([], LOCAL_USER));
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api: { get, createMany },
    });
    await flush();
    expect(ctx.state.value).toEqual({ status: "loading" });
    expect(get).not.toHaveBeenCalled();
  });

  it("get 抛错 → failed（弹窗据此不显示记住 UI）", async () => {
    const reqId = ref<string | null>("p1");
    const get = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => undefined,
      api: { get, createMany: vi.fn(async () => viewOf([], [])) },
    });
    await flush();
    expect(ctx.state.value).toEqual({ status: "failed" });
  });

  it("请求消失（id → null）→ 同步复位 loading，作废在途 get", async () => {
    let resolveGet!: (v: PermissionSettingsView) => void;
    const pending = new Promise<PermissionSettingsView>((r) => {
      resolveGet = r;
    });
    const reqId = ref<string | null>(null);
    const get = vi.fn(() => pending);
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api: { get, createMany: vi.fn(async () => viewOf([], [])) },
    });
    reqId.value = "a";
    await nextTick(); // 回调已进入、get#1 挂起
    reqId.value = null;
    await flush();
    expect(ctx.state.value).toEqual({ status: "loading" }); // 复位且未被旧值污染
    resolveGet(viewOf([allowRule("x")], LOCAL_USER));
    await flush();
    // 作废的 get 结果不得把 ready 写回「无请求」状态
    expect(ctx.state.value).toEqual({ status: "loading" });
  });

  it("ready → 新请求：get 返回前即已复位 loading（不继承上一请求快照）", async () => {
    let blockSecond!: (v: PermissionSettingsView) => void;
    const second = new Promise<PermissionSettingsView>((r) => {
      blockSecond = r;
    });
    const reqId = ref<string | null>(null);
    let call = 0;
    const get = vi.fn(() =>
      call++ === 0 ? Promise.resolve(viewOf([allowRule("a")], LOCAL_USER)) : second,
    );
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api: { get, createMany: vi.fn(async () => viewOf([], [])) },
    });
    reqId.value = "a";
    await flush();
    expect(ctx.state.value).toEqual({
      status: "ready",
      rules: [allowRule("a")],
      scope: "local",
    });

    reqId.value = "b";
    await nextTick(); // 新请求回调已进入，get#2 挂起
    expect(ctx.state.value).toEqual({ status: "loading" }); // 同步复位，未继承旧 ready

    blockSecond(viewOf([], USER_ONLY));
    await flush();
    expect(ctx.state.value).toEqual({ status: "ready", rules: [], scope: "user" });
  });

  it("竞态：请求 A 慢 B 快，A 晚到不覆盖 B 的结果", async () => {
    let resolveA!: (v: PermissionSettingsView) => void;
    const slowA = new Promise<PermissionSettingsView>((r) => {
      resolveA = r;
    });
    const reqId = ref<string | null>(null);
    let call = 0;
    const get = vi.fn(() =>
      call++ === 0 ? slowA : Promise.resolve(viewOf([allowRule("B")], USER_ONLY)),
    );
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api: { get, createMany: vi.fn(async () => viewOf([], [])) },
    });
    reqId.value = "a";
    await nextTick(); // get#1（A）挂起
    reqId.value = "b";
    await flush(); // get#2（B）立即 resolve
    expect(ctx.state.value).toEqual({
      status: "ready",
      rules: [allowRule("B")],
      scope: "user",
    });

    resolveA(viewOf([allowRule("A")], LOCAL_USER)); // A 晚到
    await flush();
    expect(ctx.state.value).toEqual({
      status: "ready",
      rules: [allowRule("B")], // A 的过期结果已丢弃
      scope: "user",
    });
  });

  it("竞态 + 抛错：A 的 get 晚 reject 且已被 B 作废 → 不得把 failed 写进 B 的状态", async () => {
    let rejectA!: (reason: unknown) => void;
    const slowRejectA = new Promise<PermissionSettingsView>((_, rej) => {
      rejectA = rej;
    });
    const reqId = ref<string | null>(null);
    let call = 0;
    const get = vi.fn(() =>
      call++ === 0 ? slowRejectA : Promise.resolve(viewOf([allowRule("B")], LOCAL_USER)),
    );
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api: { get, createMany: vi.fn(async () => viewOf([], [])) },
    });
    reqId.value = "a";
    await nextTick(); // get#1（A）挂起（将 reject）
    reqId.value = "b";
    await flush(); // B 就绪
    rejectA(new Error("late boom")); // A 的失败晚到
    await flush();
    expect(ctx.state.value).toEqual({
      status: "ready", // catch 内的过期守卫丢弃了 A 的失败
      rules: [allowRule("B")],
      scope: "local",
    });
  });
});

// ---------------------------------------------------------------------------
// persistRemember 落盘
// ---------------------------------------------------------------------------

describe("persistRemember 落盘（现拉 + 语义过滤 + fail-closed）", () => {
  /** 已 ready 的上下文；persistView = 落盘前现拉将返回的视图。 */
  async function readyCtx(persistView: PermissionSettingsView) {
    const api = makeApi(viewOf([], LOCAL_USER));
    const reqId = ref<string | null>("p1");
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api,
    });
    await flush(); // 初始 ready（get#1）
    api.get.mockImplementation(async () => persistView);
    return { ctx, api };
  }

  it("总是现拉（第二次 get）+ 语义过滤后 createMany，携带钉住的工作区", async () => {
    const persistView = viewOf([allowRule("cd")], LOCAL_USER);
    const { ctx, api } = await readyCtx(persistView);
    const result = await ctx.persistRemember({
      scope: "local",
      rules: [draftOf('cd "C:/ws"'), draftOf("cargo check")],
    });
    expect(api.get).toHaveBeenCalledTimes(2); // 落盘前现拉，不读挂起期快照
    expect(result).toEqual({ outcome: "persisted", scope: "local", count: 1 });
    expect(api.createMany).toHaveBeenCalledWith(
      "local",
      [draftOf("cargo check")], // cd 段被现有宽前缀规则覆盖→滤掉
      "C:/ws",
    );
  });

  it("挂起期间规则库新增等价规则 → all-covered，不写入", async () => {
    const { ctx, api } = await readyCtx(viewOf([allowRule("cargo check")], LOCAL_USER));
    const result = await ctx.persistRemember({
      scope: "local",
      rules: [draftOf("cargo check")],
    });
    expect(result).toEqual({ outcome: "all-covered" });
    expect(api.createMany).not.toHaveBeenCalled();
  });

  it("现拉视图里原 scope 已不可写 → 回退重解析；双不可写 → no-editable-scope", async () => {
    const fallback = await readyCtx(viewOf([], USER_ONLY));
    const resultFallback = await fallback.ctx.persistRemember({
      scope: "local",
      rules: [draftOf("cargo check")],
    });
    expect(resultFallback).toEqual({ outcome: "persisted", scope: "user", count: 1 });
    expect(fallback.api.createMany).toHaveBeenCalledWith("user", [draftOf("cargo check")], "C:/ws");

    const none = await readyCtx(viewOf([], NONE_EDITABLE));
    const resultNone = await none.ctx.persistRemember({
      scope: "local",
      rules: [draftOf("cargo check")],
    });
    expect(resultNone).toEqual({ outcome: "no-editable-scope" });
    expect(none.api.createMany).not.toHaveBeenCalled();
  });

  it("现拉失败 / 写入失败 → fail-closed：跳过持久化返回 failed（不降级直写）", async () => {
    const api = makeApi(viewOf([], LOCAL_USER));
    const reqId = ref<string | null>("p1");
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api,
    });
    await flush();
    api.get.mockRejectedValueOnce(new Error("ipc down"));
    const resultGetFail = await ctx.persistRemember({
      scope: "local",
      rules: [draftOf("cargo check")],
    });
    expect(resultGetFail).toEqual({ outcome: "failed", error: "ipc down" });
    expect(api.createMany).not.toHaveBeenCalled();

    api.createMany.mockRejectedValueOnce(new Error("disk full"));
    const resultWriteFail = await ctx.persistRemember({
      scope: "local",
      rules: [draftOf("cargo check")],
    });
    expect(resultWriteFail).toEqual({ outcome: "failed", error: "disk full" });
  });

  it("非 Error 形状的异常（无 message）→ error 取异常本身的字符串化", async () => {
    const api = makeApi(viewOf([], LOCAL_USER));
    const reqId = ref<string | null>("p1");
    const ctx = usePermissionRememberContext({
      requestId: () => reqId.value,
      workspacePath: () => "C:/ws",
      api,
    });
    await flush();
    api.get.mockRejectedValueOnce("raw transport failure");
    const result = await ctx.persistRemember({
      scope: "local",
      rules: [draftOf("cargo check")],
    });
    expect(result).toEqual({ outcome: "failed", error: "raw transport failure" });
  });
});