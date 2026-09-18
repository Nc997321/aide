// 知识库面板状态闭包的回归测试。
//
// 钉住的是 spec §1.1 那个缺陷：单一 loadSeq 被空间列表与文档列表共用，导致
// loadSpaces 的 finally 复位被自己内部调用踩掉，loading 永久停在 true——
// 表现是「创建空间」按钮永久置灰。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  me: vi.fn(),
  listSpaces: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock("@/components/KnowledgeBase/kbClient", () => ({
  kb: {
    status: mocks.status,
    me: mocks.me,
    listSpaces: mocks.listSpaces,
    listDocuments: mocks.listDocuments,
    getDocument: mocks.getDocument,
  },
  // init() 会读 token 决定要不要拉当前用户；给一个非空值走「已登录」分支
  getToken: () => "t",
  setToken: vi.fn(),
  KbError: class KbError extends Error {},
}));

vi.mock("@/components/KnowledgeBase/kbRuntime", () => ({
  pushKnowledgeRuntime: vi.fn(async () => {}),
}));

import { useKnowledgeBase } from "./useKnowledgeBase";

const USER = { id: "u1", username: "u", email: null, displayName: "U", isAdmin: false };

function space(id: string) {
  return { id, key: id, name: id, description: null, visibility: "internal", role: "owner" };
}

function document_(id: string) {
  return {
    id,
    spaceId: "s1",
    parentId: null,
    slug: id,
    title: id,
    content: "",
    versionNo: 1,
    status: "draft",
    updatedAt: "2026-09-18T00:00:00Z",
  };
}

/** 手动控制 settle 时机的 promise，用来制造「在途请求」。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * KbMembers.vue:50 的 canCreateSpace，逐字抄过来。
 * 这条断言的意义就是「按钮不是灰的」——所以判据必须与组件里那个 computed 一致，
 * 不能自己另写一个近似条件。
 */
const canCreateSpace = (key: string, name: string, busy: boolean): boolean =>
  key.trim() !== "" && name.trim() !== "" && !busy;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ initialized: true });
  mocks.me.mockResolvedValue(USER);
  mocks.listSpaces.mockResolvedValue([]);
  mocks.listDocuments.mockResolvedValue([]);
});

describe("loading 复位（spec §1.1 回归）", () => {
  it("有一个可见空间时，init 结束后 loading 回到 false —— 按钮不再是灰的", async () => {
    mocks.listSpaces.mockResolvedValue([space("s1")]);

    const k = useKnowledgeBase();
    await k.init();

    expect(k.loading.value).toBe(false);
    expect(canCreateSpace("eng-handbook", "工程手册", k.loading.value)).toBe(true);
  });

  it("零个可见空间时同样复位", async () => {
    mocks.listSpaces.mockResolvedValue([]);

    const k = useKnowledgeBase();
    await k.init();

    expect(k.loading.value).toBe(false);
  });
});

describe("按资源的竞态护栏（spec §1.2）", () => {
  it("在途 openDocument 的响应不被随后的列表刷新丢弃", async () => {
    const d = deferred<ReturnType<typeof document_>>();
    mocks.getDocument.mockReturnValueOnce(d.promise);

    const k = useKnowledgeBase();
    const opening = k.openDocument("doc1");
    // 列表刷新递增的是「文档列表」的计数器，不该碰「当前文档」的
    await k.loadDocuments("s1");
    d.resolve(document_("doc1"));
    await opening;

    expect(k.activeDoc.value?.id).toBe("doc1");
  });

  it("selectSpace 作废在途的 openDocument（上一空间的响应不许落进新视图）", async () => {
    const d = deferred<ReturnType<typeof document_>>();
    mocks.getDocument.mockReturnValueOnce(d.promise);

    const k = useKnowledgeBase();
    const opening = k.openDocument("doc1");
    await k.selectSpace("s2");
    d.resolve(document_("doc1"));
    await opening;

    expect(k.activeDoc.value).toBeNull();
  });
});
