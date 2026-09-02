import { describe, it, expect, vi, beforeEach } from "vitest";

// mock api: lspCallHierarchy（useCallHierarchy 唯一后端依赖）
vi.mock("../api", () => ({
  api: {
    lspCallHierarchy: vi.fn(),
  },
}));

// mock useFileViewer：跳转原语只验证调用参数
const openAndScrollTo = vi.fn();
vi.mock("./useFileViewer", () => ({
  useFileViewer: () => ({ openAndScrollTo }),
}));

import { useCallHierarchy, __resetCallHierarchyForTest, callNodeKey } from "./useCallHierarchy";
import { api } from "../api";
import type { CallHierarchyNode, CallHierarchyResult } from "../types";

function node(partial: Partial<CallHierarchyNode> & { name: string; file: string; line: number }): CallHierarchyNode {
  return {
    kind: 6,
    column: 8,
    callSites: [],
    ...partial,
  };
}

function okResult(root: CallHierarchyNode | null, nodes: CallHierarchyNode[]): CallHierarchyResult {
  return { status: "ok", root, nodes };
}

describe("useCallHierarchy", () => {
  beforeEach(() => {
    __resetCallHierarchyForTest();
    vi.clearAllMocks();
  });

  it("open_hierarchy_queries_first_level", async () => {
    const root = node({ name: "init_handshake", file: "src/manager.rs", line: 639 });
    const callers = [
      node({ name: "spawn_and_init", file: "src/manager.rs", line: 269, callSites: [{ line: 287, column: 23 }, { line: 292, column: 10 }] }),
    ];
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, callers));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/src/manager.rs", line: 639, column: 8, word: "init_handshake" });
    expect(api.lspCallHierarchy).toHaveBeenCalledWith("/p", "/p/src/manager.rs", 639, 8, "incoming");
    expect(ch.root.value?.name).toBe("init_handshake");
    expect(ch.firstLevel.value.length).toBe(1);
    expect(ch.firstLevel.value[0].callSites.length).toBe(2);
    expect(ch.rootStatus.value).toBe("ok");
    expect(ch.loadingRoot.value).toBe(false);
  });

  it("open_hierarchy_unsupported_symbol_root_null", async () => {
    // prepare 空（类名/字段）→ status ok + root null：面板显示「不支持」而非错误
    (api.lspCallHierarchy as any).mockResolvedValue({ status: "ok", root: null, nodes: [] });
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "ServerHandle" });
    expect(ch.rootStatus.value).toBe("ok");
    expect(ch.root.value).toBeNull();
    // rootWord 兜底显示 gutter 点击的词
    expect(ch.rootWord.value).toBe("ServerHandle");
  });

  it("open_hierarchy_timeout_keeps_status", async () => {
    (api.lspCallHierarchy as any).mockResolvedValue({ status: "timeout", root: null, nodes: [] });
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });
    expect(ch.rootStatus.value).toBe("timeout");
    expect(ch.firstLevel.value).toEqual([]);
  });

  it("invoke_error_maps_to_not_ready", async () => {
    (api.lspCallHierarchy as any).mockRejectedValue(new Error("channel broken"));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });
    expect(ch.rootStatus.value).toBe("not_ready");
    expect(ch.loadingRoot.value).toBe(false);
  });

  it("set_direction_requeries_and_clears_expansion", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, [node({ name: "caller", file: "a.rs", line: 9 })]));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });
    // 展开一个节点（制造展开状态）
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, [node({ name: "deep", file: "a.rs", line: 20 })]));
    await ch.toggleNode(ch.firstLevel.value[0]);
    expect(ch.expandedKeys.value.size).toBe(1);

    // 换向 → 重查第一层 + 展开状态清空
    (api.lspCallHierarchy as any).mockClear();
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, [node({ name: "callee", file: "a.rs", line: 30 })]));
    await ch.setDirection("outgoing");
    expect(ch.direction.value).toBe("outgoing");
    expect(api.lspCallHierarchy).toHaveBeenCalledWith("/p", "/p/a.rs", 1, 1, "outgoing");
    expect(ch.firstLevel.value[0].name).toBe("callee");
    expect(ch.expandedKeys.value.size).toBe(0);
    expect(ch.childrenByNode.value.size).toBe(0);
  });

  it("toggle_node_lazy_expands_with_node_position", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    const caller = node({ name: "caller", file: "b.rs", line: 9 });
    (api.lspCallHierarchy as any).mockResolvedValueOnce(okResult(root, [caller]));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });

    // 展开 caller：查询点 = caller 声明位置（文件 b.rs、行 9），方向继承当前
    const deeper = [node({ name: "grand_caller", file: "c.rs", line: 40 })];
    (api.lspCallHierarchy as any).mockResolvedValueOnce(okResult(root, deeper));
    await ch.toggleNode(caller);
    expect(api.lspCallHierarchy).toHaveBeenLastCalledWith("/p", "b.rs", 9, 8, "incoming");
    expect(ch.childrenByNode.value.get(callNodeKey(caller))?.length).toBe(1);
    expect(ch.expandedKeys.value.has(callNodeKey(caller))).toBe(true);
  });

  it("toggle_node_collapse_then_cached_reexpand_no_refetch", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    const caller = node({ name: "caller", file: "b.rs", line: 9 });
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, [caller]));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });
    await ch.toggleNode(caller); // 展开加载
    expect(api.lspCallHierarchy).toHaveBeenCalledTimes(2);

    await ch.toggleNode(caller); // 收起
    expect(ch.expandedKeys.value.size).toBe(0);
    (api.lspCallHierarchy as any).mockClear();
    await ch.toggleNode(caller); // 再展开：缓存命中，不再请求
    expect(api.lspCallHierarchy).not.toHaveBeenCalled();
    expect(ch.expandedKeys.value.size).toBe(1);
  });

  it("toggle_node_failure_marks_fail_key", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    const caller = node({ name: "caller", file: "b.rs", line: 9 });
    (api.lspCallHierarchy as any).mockResolvedValueOnce(okResult(root, [caller]));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });

    (api.lspCallHierarchy as any).mockResolvedValueOnce({ status: "timeout", root: null, nodes: [] });
    await ch.toggleNode(caller);
    expect(ch.expandFailKeys.value.has(callNodeKey(caller))).toBe(true);
    expect(ch.expandedKeys.value.size).toBe(0); // 失败不算展开
    expect(ch.childrenByNode.value.get(callNodeKey(caller))).toEqual([]);

    // retryNode 清失败并重新展开
    (api.lspCallHierarchy as any).mockResolvedValueOnce(okResult(root, [node({ name: "deep", file: "c.rs", line: 20 })]));
    await ch.retryNode(caller);
    expect(ch.expandFailKeys.value.size).toBe(0);
    expect(ch.expandedKeys.value.has(callNodeKey(caller))).toBe(true);
  });

  it("stale_response_dropped_on_root_change", async () => {
    // 换根路上旧响应必须丢弃：open A pending → open B resolve → A resolve
    let resolveA: (v: CallHierarchyResult) => void = () => {};
    (api.lspCallHierarchy as any)
      .mockImplementationOnce(() => new Promise<CallHierarchyResult>((r) => { resolveA = r; }))
      .mockResolvedValueOnce(okResult(node({ name: "b_root", file: "b.rs", line: 5 }), []));
    const ch = useCallHierarchy();
    const pA = ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "a" });
    const pB = ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/b.rs", line: 5, column: 1, word: "b" });
    await pB;
    expect(ch.rootWord.value).toBe("b_root");
    resolveA(okResult(node({ name: "a_root", file: "a.rs", line: 1 }), [node({ name: "x", file: "a.rs", line: 2 })]));
    await pA;
    // A 的迟到响应被 epoch 丢弃：root 不被覆盖、firstLevel 不被污染
    expect(ch.rootWord.value).toBe("b_root");
    expect(ch.firstLevel.value).toEqual([]);
  });

  it("jump_to_node_resolves_relative_and_absolute_paths", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, []));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "C:/proj", filePath: "C:/proj/a.rs", line: 1, column: 1, word: "foo" });

    await ch.jumpToNode(node({ name: "rel", file: "src/b.rs", line: 12 }));
    expect(openAndScrollTo).toHaveBeenCalledWith("C:/proj/src/b.rs", 12, 3);

    await ch.jumpToNode(node({ name: "abs", file: "C:/other/x.rs", line: 30 }));
    expect(openAndScrollTo).toHaveBeenLastCalledWith("C:/other/x.rs", 30, 3);
  });

  it("jump_to_site_uses_call_site_position", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, []));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "C:/proj", filePath: "C:/proj/a.rs", line: 1, column: 1, word: "foo" });

    const caller = node({ name: "caller", file: "src/b.rs", line: 9, callSites: [{ line: 287, column: 23 }] });
    await ch.jumpToSite(caller, 287, 23);
    expect(openAndScrollTo).toHaveBeenCalledWith("C:/proj/src/b.rs", 287, 3);
  });

  it("clear_resets_all_state", async () => {
    const root = node({ name: "foo", file: "a.rs", line: 1 });
    (api.lspCallHierarchy as any).mockResolvedValue(okResult(root, []));
    const ch = useCallHierarchy();
    await ch.openHierarchy({ workspaceRoot: "/p", filePath: "/p/a.rs", line: 1, column: 1, word: "foo" });
    ch.clear();
    expect(ch.root.value).toBeNull();
    expect(ch.rootQuery.value).toBeNull();
    expect(ch.firstLevel.value).toEqual([]);
    expect(ch.rootStatus.value).toBeNull();
  });
});
