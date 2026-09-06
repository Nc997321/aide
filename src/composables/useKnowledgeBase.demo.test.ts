// 演示模式的单测：只覆盖 demo 路径——真实 fetch 路径由端到端与后端联调测，
// 这里只确保「不连服务器也能把知识库的样子渲染出来」的承诺不破。
//
// 重要：useKnowledgeBase 是模块级单例（panelOpen 同范式），
// 每个测试用例要么 enterDemo 后单独清理（exitDemo），要么不复用。
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock 整个 kbClient。demo 路径下不会被调用；列在这里只是为了万一有非预期调用时不挂。
const api = vi.hoisted(() => ({
  status: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  bootstrap: vi.fn(),
  join: vi.fn(),
  logout: vi.fn(),
  listSpaces: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  search: vi.fn(),
  invite: vi.fn(),
  listUsers: vi.fn(),
  revokeUser: vi.fn(),
  health: vi.fn(),
  formats: vi.fn(),
  createSpace: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  revisions: vi.fn(),
  revert: vi.fn(),
}));
vi.mock("@/components/KnowledgeBase/kbClient", () => ({
  kb: api,
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
  // 简单 class 让 instanceof KbError 走通（demo 路径用不到，但保留语义以防回归时误触发）
  KbError: class KbError extends Error {},
  getBaseUrl: vi.fn(() => "http://127.0.0.1:8788"),
  setBaseUrl: vi.fn(),
  inviteLink: vi.fn(() => ""),
  parseInviteToken: vi.fn(() => ""),
}));

import { useKnowledgeBase } from "./useKnowledgeBase";
import { DEMO_DOCS, DEMO_SPACES, demoSearch } from "@/components/KnowledgeBase/demoData";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useKnowledgeBase — 演示模式", () => {
  it("enterDemo 后 user/spaces/activeSpaceId/documents 立刻就绪，不发任何请求", () => {
    const k = useKnowledgeBase();
    expect(k.demoMode.value).toBe(false);
    expect(k.user.value).toBe(null);
    expect(k.ready.value).toBe(false);

    k.enterDemo();

    expect(k.demoMode.value).toBe(true);
    expect(k.ready.value).toBe(true);
    expect(k.user.value).not.toBe(null);
    expect(k.user.value?.isAdmin).toBe(false); // 成员入口隐藏
    expect(k.user.value?.displayName).toBe("演示数据");
    expect(k.initialized.value).toBe(true);
    expect(k.spaces.value).toEqual(DEMO_SPACES);
    expect(k.activeSpaceId.value).toBe(DEMO_SPACES[0]?.id);
    // 当前空间过滤后的文档列表（非全集）
    expect(k.documents.value.every((d) => d.spaceId === k.activeSpaceId.value)).toBe(true);
    expect(k.activeDoc.value).toBe(null);
    expect(k.error.value).toBe(null);
    // 任何真实 API 都不该被调用
    expect(api.status).not.toHaveBeenCalled();
    expect(api.listSpaces).not.toHaveBeenCalled();
    expect(api.listDocuments).not.toHaveBeenCalled();
  });

  it("exitDemo 回到欢迎页：demoMode=false, user=null, ready=true（不重连）", () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    k.openDocument(DEMO_DOCS[0].id); // 让 activeDoc 有值

    k.exitDemo();

    expect(k.demoMode.value).toBe(false);
    expect(k.user.value).toBe(null);
    expect(k.spaces.value).toEqual([]);
    expect(k.documents.value).toEqual([]);
    expect(k.activeDoc.value).toBe(null);
    expect(k.initialized.value).toBe(null);
    expect(k.ready.value).toBe(true);
    // 仍然没发请求
    expect(api.logout).not.toHaveBeenCalled();
    expect(api.status).not.toHaveBeenCalled();
  });

  it("demo 下 logout 走 exitDemo，不打 kb.logout", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    await k.logout();

    expect(k.demoMode.value).toBe(false);
    expect(api.logout).not.toHaveBeenCalled();
  });

  it("demo 下 init 立即 ready=true，不打 kb.status", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    // 故意把 ready 翻回 false 模拟某种边界调用
    k.ready.value = false;
    await k.init();

    expect(k.ready.value).toBe(true);
    expect(api.status).not.toHaveBeenCalled();
  });

  it("demo 下 search 走 demoSearch，结果包装成 KbSearchResult", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    // 选第一个空间，避免命中跨空间文档
    const firstSpaceId = DEMO_SPACES[0].id;

    await k.search("502");

    expect(api.search).not.toHaveBeenCalled();
    expect(k.searchResult.value).not.toBe(null);
    expect(k.searchResult.value?.query).toBe("502");
    // demoSearch 在第一个空间下应该至少命中「故障排查：网关 502」
    const hitIds = (k.searchResult.value?.hits ?? []).map((h) => h.documentId);
    expect(hitIds).toContain("demo-doc-4");
    // 命中空间限定在当前空间
    for (const h of k.searchResult.value?.hits ?? []) {
      expect(h.spaceId).toBe(firstSpaceId);
    }
  });

  it("demo 下 search('') 清空结果且不打 kb", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    await k.search("502");
    expect(k.searchResult.value).not.toBe(null);

    await k.search("");
    expect(k.searchResult.value).toBe(null);
    expect(api.search).not.toHaveBeenCalled();
  });

  it("demo 下 openDocument 从 DEMO_DOCS 直取，保留 content", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();

    await k.openDocument("demo-doc-1");

    expect(api.getDocument).not.toHaveBeenCalled();
    expect(k.activeDoc.value).not.toBe(null);
    expect(k.activeDoc.value?.title).toBe("新人入职指南");
    expect(k.activeDoc.value?.content).toContain("新人入职指南");
    expect(k.activeDoc.value?.content).toContain("pnpm install");
  });

  it("demo 下 openDocument(id) 找不到时 activeDoc=null 且不打 kb", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();

    await k.openDocument("non-existent");

    expect(k.activeDoc.value).toBe(null);
    expect(api.getDocument).not.toHaveBeenCalled();
  });

  it("demo 下 loadSpaces 重置为 DEMO_SPACES 并触发对应文档加载", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    // 清掉再 loadSpaces，应能从假数据恢复
    k.spaces.value = [];
    k.documents.value = [];

    await k.loadSpaces();

    expect(k.spaces.value).toEqual(DEMO_SPACES);
    expect(api.listSpaces).not.toHaveBeenCalled();
    expect(api.listDocuments).not.toHaveBeenCalled();
    expect(k.documents.value.length).toBeGreaterThan(0);
  });

  it("demo 下 selectSpace 切换空间时 loadDocuments 走过滤", async () => {
    const k = useKnowledgeBase();
    k.enterDemo();
    // 切到第二个空间（demo-space-product）
    const targetId = DEMO_SPACES[1].id;

    await k.selectSpace(targetId);

    expect(k.activeSpaceId.value).toBe(targetId);
    expect(k.activeDoc.value).toBe(null);
    expect(k.documents.value.every((d) => d.spaceId === targetId)).toBe(true);
    expect(api.listDocuments).not.toHaveBeenCalled();
  });
});