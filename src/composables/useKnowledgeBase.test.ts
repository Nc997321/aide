// 知识库面板状态闭包的回归测试。
//
// 钉住的是 spec §1.1 那个缺陷：单一 loadSeq 被空间列表与文档列表共用，导致
// loadSpaces 的 finally 复位被自己内部调用踩掉，loading 永久停在 true——
// 表现是「创建空间」按钮永久置灰。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  health: vi.fn(),
  me: vi.fn(),
  listSpaces: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  formats: vi.fn(),
  ingest: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock("@/components/KnowledgeBase/kbClient", () => ({
  kb: {
    status: mocks.status,
    health: mocks.health,
    me: mocks.me,
    listSpaces: mocks.listSpaces,
    listDocuments: mocks.listDocuments,
    getDocument: mocks.getDocument,
    formats: mocks.formats,
    ingest: mocks.ingest,
  },
  // init() 会读 token 决定要不要拉当前用户；给一个非空值走「已登录」分支
  getToken: () => "t",
  setToken: mocks.setToken,
  getBaseUrl: () => "http://test.invalid:8788",
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

/** 服务端错误的替身。**不带 `instanceof` 依赖**——判据（401 / network）在闭包里是
 *  结构判据，所以替身只要长得像就行（见 useKnowledgeBase 的 isUnauthorized）。 */
class KbErrorStub extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
    this.name = "KbErrorStub";
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ initialized: true });
  mocks.health.mockResolvedValue({
    status: "ok",
    service: "aide-knowledge",
    version: "0.5.0",
    parsers: [],
    tokenizer: "jieba-rs",
  });
  mocks.me.mockResolvedValue(USER);
  mocks.listSpaces.mockResolvedValue([]);
  mocks.listDocuments.mockResolvedValue([]);
  mocks.formats.mockResolvedValue({ extensions: ["md", "markdown", "txt", "docx", "pdf", "html", "htm"] });
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

describe("免登录：凭据由 Aide 自动带（spec §4.3）", () => {
  it("已有凭据时静默进入主界面，不落登录页", async () => {
    const k = useKnowledgeBase();
    await k.init();

    expect(k.user.value).not.toBeNull();
    expect(k.ready.value).toBe(true);
    expect(mocks.setToken).not.toHaveBeenCalledWith(null);
  });

  it("凭据失效（401）才落登录页，并且清掉凭据", async () => {
    mocks.me.mockRejectedValue(new KbErrorStub("unauthorized", 401));

    const k = useKnowledgeBase();
    await k.init();

    expect(k.user.value).toBeNull();
    expect(mocks.setToken).toHaveBeenCalledWith(null);
    expect(k.error.value).toContain("重新登录");
  });

  it("网络故障不清凭据——那不是凭据的问题", async () => {
    mocks.me.mockRejectedValue(new KbErrorStub("network", 0));

    const k = useKnowledgeBase();
    await k.init();

    expect(k.user.value).toBeNull();
    expect(mocks.setToken).not.toHaveBeenCalledWith(null);
    expect(k.error.value).toContain("连不上");
  });
});

describe("服务端版本：该升级时说得清，不该催时不打扰", () => {
  it("服务端没报版本（0.5.0 之前的老服务端）→ 提示升级", async () => {
    mocks.health.mockResolvedValue({ status: "ok", service: "aide-knowledge", parsers: [], tokenizer: "jieba-rs" });

    const k = useKnowledgeBase();
    await k.init();

    expect(k.needsUpgrade.value).toBe(true);
  });

  it("版本够新 → 不提示", async () => {
    mocks.health.mockResolvedValue({
      status: "ok",
      service: "aide-knowledge",
      version: "0.5.0",
      parsers: [],
      tokenizer: "jieba-rs",
    });

    const k = useKnowledgeBase();
    await k.init();

    expect(k.needsUpgrade.value).toBe(false);
    expect(k.serverVersion.value).toBe("0.5.0");
  });

  it("连不上服务时**不**判版本——那时候该说的是「连不上」", async () => {
    mocks.health.mockRejectedValue(new KbErrorStub("network", 0));

    const k = useKnowledgeBase();
    await k.init();

    expect(k.needsUpgrade.value).toBe(false);
  });
});

describe("上传：格式判定由服务端说了算（Review Focus #3）", () => {
  const file = (name: string) => new File(["x"], name, { type: "text/plain" });

  async function readyKb() {
    const k = useKnowledgeBase();
    mocks.listSpaces.mockResolvedValue([space("s1")]);
    await k.init();
    return k;
  }

  it("不认的格式当场拒绝，并把收哪些说清楚", async () => {
    const k = await readyKb();

    const id = await k.uploadFile(null, file("报表.csv"));

    expect(id).toBeNull();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(k.error.value).toContain("只收这些格式");
    expect(k.error.value).toContain("html");
  });

  it("认的格式走上传，并刷新目录", async () => {
    const k = await readyKb();
    mocks.ingest.mockResolvedValue({
      documentId: "d9",
      revisionId: "r1",
      title: "季度复盘",
      backend: "html",
      warnings: [],
    });

    const id = await k.uploadFile(null, file("复盘.html"));

    expect(id).toBe("d9");
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.listDocuments).toHaveBeenCalledWith("s1");
  });

  it("上传进度进 state：字节走到多少显示多少，结束后清掉", async () => {
    const k = await readyKb();
    const d = deferred<{
      documentId: string;
      revisionId: string;
      title: string;
      backend: string;
      warnings: string[];
    }>();
    let report: ((pct: number) => void) | null = null;
    mocks.ingest.mockImplementation((input: { onProgress?: (p: number) => void }) => {
      report = input.onProgress ?? null;
      return d.promise;
    });

    const pending = k.uploadFile(null, file("复盘.html"));
    await new Promise((r) => setTimeout(r, 0)); // 等 loadFormats 那一跳落地

    expect(report).not.toBeNull();
    expect(k.uploading.value).toEqual({ name: "复盘.html", pct: 0 });
    report?.(42);
    expect(k.uploading.value?.pct).toBe(42);

    d.resolve({
      documentId: "d9",
      revisionId: "r1",
      title: "复盘",
      backend: "html",
      warnings: [],
    });
    await pending;

    expect(k.uploading.value).toBeNull();
  });

  it("解析器的降级信息走 notice（不是红字错误）", async () => {
    const k = await readyKb();
    mocks.ingest.mockResolvedValue({
      documentId: "d9",
      revisionId: "r1",
      title: "老文档",
      backend: "docx-lite",
      warnings: ["docx-lite 后端只做文本提取：标题层级与列表结构已丢失"],
    });

    await k.uploadFile(null, file("a.docx"));

    expect(k.notice.value).toContain("标题层级");
    expect(k.error.value).toBeNull();
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
