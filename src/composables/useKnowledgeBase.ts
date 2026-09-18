// 知识库面板状态闭包：登录、空间/文档树、检索。
// 桌面专属（不进 remote-pwa），故放 src/composables 而非共享包——
// 与 useMemoryObservatory.ts 同范式。
//
// 数据通道见 components/KnowledgeBase/kbClient.ts：直连 knowledge-server 的 REST，
// **不走 aide-sdk 的 transport**，因为知识库是独立进程而非 aide 的 Rust 命令。
import { ref } from "vue";
import {
  kb,
  getToken,
  setToken,
  KbError,
  type KbUser,
  type KbSpace,
  type KbDocumentSummary,
  type KbDocument,
  type KbSearchResult,
  type KbInvite,
  type KbUserRow,
} from "@/components/KnowledgeBase/kbClient";
import { pushKnowledgeRuntime } from "@/components/KnowledgeBase/kbRuntime";

/** 主区面板开关（模块级单例，与 useMemoryObservatory 同范式）：
 *  true 时 App.vue 用 KnowledgeBase 盖住 PaneLayout，PaneLayout v-show 保活。 */
const panelOpen = ref(false);
function openPanel() {
  panelOpen.value = true;
}
function closePanel() {
  panelOpen.value = false;
}
function togglePanel() {
  panelOpen.value = !panelOpen.value;
}

export function useKnowledgeBase() {
  const ready = ref(false); // 首次探测是否完成
  /** 服务实例有没有初始化过。null = 还没探到（服务连不上 / 正在查）。 */
  const initialized = ref<boolean | null>(null);
  const user = ref<KbUser | null>(null);
  const users = ref<KbUserRow[]>([]);
  const lastInvite = ref<KbInvite | null>(null);
  const spaces = ref<KbSpace[]>([]);
  const activeSpaceId = ref<string | null>(null);
  /** 最近一次创建成功的空间。KbMembers 的表单靠它感知"可以清空了"（与 lastInvite 同模式）。 */
  const lastCreatedSpace = ref<KbSpace | null>(null);
  const documents = ref<KbDocumentSummary[]>([]);
  const activeDoc = ref<KbDocument | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const query = ref("");
  const searching = ref(false);
  const searchResult = ref<KbSearchResult | null>(null);

  // 竞态护栏：切空间/搜词都要丢弃过期响应，否则后发先至会把界面写错。
  // 与 useMemoryObservatory 的 loadSeq 同思路。
  //
  // ⚠️ **一个计数器只守一个状态**。曾经的写法是单一 `loadSeq` 给空间列表与文档列表
  // 共用，而 `loadSpaces` 会 await `loadDocuments` —— 后者递增了同一个计数器，
  // 导致 `loadSpaces` 自己的 `finally` 判断失败、`loading` 永久停在 true
  //（「创建空间」与标题栏「刷新」两个按钮一起变灰）。
  //
  // `docSeq` 被三个调用点递增是刻意的：`openDocument` 发起请求，`selectSpace`
  // 与 `deleteDocument` 负责**作废在途请求**，否则上一空间那篇文档的响应会落进
  // 已经切走的视图。这不是「每个函数一个计数器」，而是「每个被写入的状态一个」。
  let spacesSeq = 0;
  let treeSeq = 0;
  let docSeq = 0;
  let searchSeq = 0;

  /** 统一错误文案：KbError 带服务端给的中文 message，直接显示。 */
  function fail(e: unknown, fallback: string): void {
    error.value = e instanceof KbError ? e.message : `${fallback}：${String(e)}`;
  }

  /**
   * 启动探测。顺序是有讲究的：
   *   1. 先问 status（公开接口，不需要 token）——空库要显示"创建管理员"而不是登录框
   *   2. 已初始化且有 token → 拉当前用户
   *   3. 都已初始化但没 token → 落到登录页
   */
  async function init(): Promise<void> {
    // 无条件镜像一次（含未登录）：token 被别处清掉时顺带删主进程的文件，
    // 且「改服务地址」也落到这条路径（KbLogin onBaseBlur → setBaseUrl → retry → init）。
    void pushKnowledgeRuntime();
    ready.value = false;
    error.value = null;
    initialized.value = null;

    try {
      initialized.value = (await kb.status()).initialized;
    } catch (e) {
      // 连不上服务。initialized 留 null → 界面按"已初始化"显示登录页，
      // 这样网络恢复后不用改任何状态就能直接登录。
      user.value = null;
      fail(e, "连接知识库服务失败");
      ready.value = true;
      return;
    }

    if (initialized.value === false || !getToken()) {
      user.value = null;
      ready.value = true;
      return;
    }

    try {
      user.value = await kb.me();
      await loadSpaces();
    } catch (e) {
      // me 失败时 kbClient 已清掉 token → 落到登录界面，不显示红字错误。
      // 只有"服务连不上"才值得提示，否则每次打开面板都闪一下错误很吵。
      user.value = null;
      if (e instanceof KbError && e.code === "network") fail(e, "连接知识库服务失败");
    } finally {
      ready.value = true;
    }
  }

  async function login(account: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      user.value = await kb.login(account, password);
      void pushKnowledgeRuntime();
      initialized.value = true;
      await loadSpaces();
      return true;
    } catch (e) {
      fail(e, "登录失败");
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 空库时创建第一个管理员。后端保证只有一个用户都没有时才成功。 */
  async function setup(
    username: string,
    displayName: string,
    password: string,
    email: string,
  ): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      user.value = await kb.bootstrap({
        username,
        displayName,
        // 空串当成"不设口令"：留空的成员只能凭邀请链接进入
        ...(password ? { password } : {}),
        ...(email ? { email } : {}),
      });
      void pushKnowledgeRuntime();
      initialized.value = true;
      await loadSpaces();
      return true;
    } catch (e) {
      fail(e, "初始化失败");
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 凭管理员发的一次性邀请令牌领取账号。后端在这一步才真正建用户。 */
  async function join(token: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      user.value = await kb.join(token);
      void pushKnowledgeRuntime();
      initialized.value = true;
      await loadSpaces();
      return true;
    } catch (e) {
      // 令牌错/已用/过期共用同一个 401，后端刻意不区分，别在这里猜
      fail(e, "邀请链接无效或已被使用");
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function invite(input: {
    username: string;
    displayName: string;
    isAdmin: boolean;
    spaceId: string | null;
    spaceRole: string | null;
  }): Promise<boolean> {
    error.value = null;
    try {
      lastInvite.value = await kb.invite({
        username: input.username,
        displayName: input.displayName,
        isAdmin: input.isAdmin,
        ...(input.spaceId ? { spaceId: input.spaceId } : {}),
        ...(input.spaceRole ? { spaceRole: input.spaceRole as "owner" | "admin" | "editor" | "viewer" } : {}),
      });
      return true;
    } catch (e) {
      fail(e, "生成邀请失败");
      return false;
    }
  }

  async function loadUsers(): Promise<void> {
    try {
      users.value = await kb.listUsers();
    } catch (e) {
      fail(e, "加载成员失败");
    }
  }

  async function revokeUser(id: string): Promise<void> {
    error.value = null;
    try {
      await kb.revokeUser(id);
      await loadUsers();
    } catch (e) {
      fail(e, "停用失败");
    }
  }

  async function logout(): Promise<void> {
    try {
      await kb.logout();
    } catch {
      // 服务端清不掉也不影响本地退出
    }
    setToken(null);
    void pushKnowledgeRuntime(); // token 已清 → 主进程删文件
    user.value = null;
    spaces.value = [];
    documents.value = [];
    // 作废在途的 openDocument：退出后它落回来会把正文重新填上
    docSeq++;
    activeDoc.value = null;
    searchResult.value = null;
    users.value = [];
    lastInvite.value = null;
  }

  async function loadSpaces(): Promise<void> {
    const seq = ++spacesSeq;
    loading.value = true;
    try {
      const list = await kb.listSpaces();
      if (seq !== spacesSeq) return;
      spaces.value = list;
      // 未选空间或原空间已不可见 → 落到第一个
      if (!activeSpaceId.value || !list.some((s) => s.id === activeSpaceId.value)) {
        activeSpaceId.value = list[0]?.id ?? null;
      }
      // 这里 await loadDocuments 是合法的：它走 treeSeq，不会碰 spacesSeq
      if (activeSpaceId.value) await loadDocuments(activeSpaceId.value);
    } catch (e) {
      if (seq === spacesSeq) fail(e, "加载空间失败");
    } finally {
      // 带护栏的复位：并发的两个 loadSpaces 里只有后发的那次归位，
      // 先发的提前结束时不会把后发那次正在进行的状态抹掉
      if (seq === spacesSeq) loading.value = false;
    }
  }

  async function selectSpace(id: string): Promise<void> {
    if (activeSpaceId.value === id) return;
    activeSpaceId.value = id;
    // 作废在途的 openDocument：上一空间的正文不该落进新空间的视图
    docSeq++;
    activeDoc.value = null;
    await loadDocuments(id);
  }

  /** 创建空间。成功后选中新空间（loadSpaces 保留已选 id，所以先选再刷）。 */
  async function createSpace(input: {
    key: string;
    name: string;
    visibility?: "private" | "internal" | "public";
  }): Promise<boolean> {
    error.value = null;
    try {
      const s = await kb.createSpace(input);
      lastCreatedSpace.value = s;
      activeSpaceId.value = s.id;
      await loadSpaces();
      return true;
    } catch (e) {
      fail(e, "创建空间失败");
      return false;
    }
  }

  async function loadDocuments(spaceId: string): Promise<void> {
    const seq = ++treeSeq;
    try {
      const list = await kb.listDocuments(spaceId);
      if (seq !== treeSeq) return;
      documents.value = list;
    } catch (e) {
      if (seq === treeSeq) fail(e, "加载文档失败");
    }
  }

  async function openDocument(id: string): Promise<void> {
    const seq = ++docSeq;
    activeDoc.value = null;
    try {
      const doc = await kb.getDocument(id);
      if (seq !== docSeq) return;
      activeDoc.value = doc;
    } catch (e) {
      if (seq === docSeq) fail(e, "打开文档失败");
    }
  }

  /**
   * 软删一篇文档（服务端连同子文档一起删）。成功 → 刷新侧栏。
   *
   * 删掉的正是当前打开的那篇 → 连正文一起清空：留着它，用户会对着一个已经不存在
   * 的文档继续编辑，直到保存时才收到 404。
   */
  async function deleteDocument(id: string): Promise<boolean> {
    error.value = null;
    try {
      await kb.deleteDocument(id);
    } catch (e) {
      fail(e, "删除文档失败");
      return false;
    }
    if (activeDoc.value?.id === id) {
      // 与 selectSpace 同理：这篇已经不存在了，在途的 openDocument 不能再把它写回来
      docSeq++;
      activeDoc.value = null;
    }
    const spaceId = activeSpaceId.value;
    if (spaceId) await loadDocuments(spaceId);
    return true;
  }

  async function search(q: string): Promise<void> {
    query.value = q;
    const trimmed = q.trim();
    if (!trimmed) {
      searchResult.value = null;
      return;
    }
    const seq = ++searchSeq;
    searching.value = true;
    try {
      const r = await kb.search(trimmed, {
        spaceId: activeSpaceId.value ?? undefined,
        limit: 30,
      });
      if (seq !== searchSeq) return;
      searchResult.value = r;
    } catch (e) {
      if (seq === searchSeq) fail(e, "检索失败");
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }

  function clearSearch(): void {
    query.value = "";
    searchResult.value = null;
  }

  return {
    ready,
    initialized,
    user,
    users,
    lastInvite,
    spaces,
    activeSpaceId,
    lastCreatedSpace,
    documents,
    activeDoc,
    loading,
    error,
    query,
    searching,
    searchResult,
    init,
    login,
    setup,
    join,
    invite,
    loadUsers,
    revokeUser,
    logout,
    loadSpaces,
    selectSpace,
    createSpace,
    loadDocuments,
    openDocument,
    deleteDocument,
    search,
    clearSearch,
    panelOpen,
    openPanel,
    closePanel,
    togglePanel,
  };
}
