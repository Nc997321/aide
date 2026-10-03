// 知识库面板状态闭包：登录、空间/文档树、检索。
// 桌面专属（不进 remote-pwa），故放 src/composables 而非共享包——
// 与 useMemoryObservatory.ts 同范式。
//
// 数据通道见 components/KnowledgeBase/kbClient.ts：直连 knowledge-server 的 REST，
// **不走 aide-sdk 的 transport**，因为知识库是独立进程而非 aide 的 Rust 命令。
import { computed, ref } from "vue";
import {
  kb,
  getBaseUrl,
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
import { ancestorIds } from "@/components/KnowledgeBase/docTree";
import {
  needsUpgrade as serverNeedsUpgrade,
  MIN_SERVER_VERSION,
} from "@/components/KnowledgeBase/serverVersion";

/** 未见过的空间 = 没折叠过任何东西 = 全展开。共享同一个空集，避免每次渲染新建对象。 */
const NO_COLLAPSE: ReadonlySet<string> = new Set();

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
  const documents = ref<KbDocumentSummary[]>([]);
  const activeDoc = ref<KbDocument | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** 非失败类提示（解析器的降级信息等）。与 `error` 分开：那些不是错误，
   *  用红字报会把「少了几张图」说成「出事了」。 */
  const notice = ref<string | null>(null);

  /** 服务端认的扩展名（懒加载一次，进程内存缓存）。**唯一权威**：前端不硬编格式表。 */
  const formats = ref<string[]>([]);

  /** 正在上传的文件与**字节**进度（0..100）。null = 没有上传在跑。
   *  99% 之后字节已发完，剩的是服务端解析 + 落库——界面据此改口叫「正在处理」。 */
  const uploading = ref<{ name: string; pct: number } | null>(null);

  /** 服务端自报的版本（`/api/health` 的 version）。null = 没探到（连不上 / 老服务端没这字段）。 */
  const serverVersion = ref<string | null>(null);
  /** 探过服务端了没有。**没探到版本也算探过**——老服务端没有 version 字段，
   *  那正是最需要提示的一档，不能因为"没拿到值"就不提示。 */
  const versionProbed = ref(false);

  /** 服务端太旧：界面据此说清怎么办（不挡用）。判据在 serverVersion.ts。 */
  const needsUpgrade = computed(() => versionProbed.value && serverNeedsUpgrade(serverVersion.value));

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

  /** 凭据失效（服务端 401）。**结构判据而不是 instanceof**：判据要能在测试替身上跑。 */
  function isUnauthorized(e: unknown): boolean {
    if (typeof e !== "object" || e === null) return false;
    const err = e as { code?: unknown; status?: unknown };
    return err.code === "unauthorized" || err.status === 401;
  }

  /** 网络层失败（服务没起 / 地址不对）。与 401 分开是有意的：一次网络抖动
   *  不该变成一次重新登录。 */
  function isNetworkFailure(e: unknown): boolean {
    if (typeof e !== "object" || e === null) return false;
    return (e as { code?: unknown }).code === "network";
  }

  /**
   * 启动探测。顺序是有讲究的：
   *   1. 先问 status（公开接口，不需要 token）——空库要显示"创建管理员"而不是登录框
   *   2. 已初始化且有 token → 拉当前用户（**免登录**：凭据由 Aide 替你带着）
   *   3. 没凭据 / 凭据失效 → 落兜底登录页
   *
   * 免登录免掉的是**门槛**（让你输账号口令），不是身份：凭据仍在、仍每次带上
   * （服务端 auth::me 照常校验 Bearer）。也**不是**"本机请求一律信任"——那等于拆锁。
   */
  async function init(): Promise<void> {
    // 无条件镜像一次（含未登录）：token 被别处清掉时顺带删主进程的文件，
    // 且「改服务地址」也落到这条路径（KbLogin onBaseBlur → setBaseUrl → retry → init）。
    void pushKnowledgeRuntime();
    ready.value = false;
    error.value = null;
    initialized.value = null;
    // 每次都重探：改服务地址（KbLogin 的 retry）之后要跟着换判断
    serverVersion.value = null;
    versionProbed.value = false;

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

    // 服务端版本（够不够新，见 serverVersion.ts）。**探不到就不判**：这时候用户
    // 面对的是「连不上」，不是「该升级」，两条提示不该同时冒出来。
    // 放在 status 之后、登录判断之前——登录页也要能看到「你的服务该升级了」。
    try {
      serverVersion.value = (await kb.health()).version ?? null;
      versionProbed.value = true;
    } catch {
      versionProbed.value = false;
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
      // ⚠️ 两种失败必须分开走，混成一条的代价是「一次网络抖动 = 重新登录一次」：
      //   401 → 凭据真的失效了：清本地凭据（与镜像文件），落兜底页
      //   其余 → **绝不动凭据**，只提示重试
      user.value = null;
      if (isUnauthorized(e)) {
        setToken(null);
        void pushKnowledgeRuntime(); // token 已清 → 主进程删镜像文件
        error.value = "登录已过期，请重新登录";
      } else if (isNetworkFailure(e)) {
        error.value = `连不上知识库服务（${getBaseUrl()}），稍后重试`;
      } else {
        fail(e, "连接知识库服务失败");
      }
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
      // 折叠状态在这里装载（此刻才知道有哪些空间），而不是在 collapsedFor 里懒加载——
      // 那个函数会被 computed 在渲染期调用，渲染期写状态会触发递归更新告警
      for (const s of list) {
        if (!(s.id in collapsed.value)) collapsed.value[s.id] = readStoredCollapsed(s.id);
      }
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
      activeSpaceId.value = s.id;
      await loadSpaces();
      return true;
    } catch (e) {
      fail(e, "创建空间失败");
      return false;
    }
  }

  // ── 目录树：展开 / 折叠 ──
  //
  // 按空间各记一份。localStorage 是持久层，`collapsed` 是内存态（渲染读它）。
  // 存的是**被折叠**的节点而不是展开的——默认全展开，新节点自动可见，
  // 不需要每次加载后补写状态。
  //
  // ⚠️ 载入必须在 `loadSpaces` 里做（那时才知道有哪些空间），**不能**在
  // `collapsedFor` 里懒加载：那个函数会被 computed 在渲染期调用，
  // 渲染期写状态会触发 Vue 的递归更新告警。
  const collapsed = ref<Record<string, Set<string>>>({});

  function readStoredCollapsed(spaceId: string): Set<string> {
    try {
      const raw = localStorage.getItem(`aide.kb.collapsed.${spaceId}`);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
      // 存的东西坏了就当没折叠过——读状态失败不能拦住整个面板
      return new Set();
    }
  }

  function persistCollapsed(spaceId: string): void {
    try {
      localStorage.setItem(
        `aide.kb.collapsed.${spaceId}`,
        JSON.stringify([...(collapsed.value[spaceId] ?? [])]),
      );
    } catch {
      // 写不进去（配额 / 隐私模式）只影响「记住折叠状态」，不该打断交互
    }
  }

  /** 纯读，渲染期安全。没见过的空间返回空集（= 全展开）。 */
  function collapsedFor(spaceId: string | null): ReadonlySet<string> {
    if (!spaceId) return NO_COLLAPSE;
    return collapsed.value[spaceId] ?? NO_COLLAPSE;
  }

  function toggleCollapsed(spaceId: string | null, id: string): void {
    if (!spaceId) return;
    if (!(spaceId in collapsed.value)) collapsed.value[spaceId] = readStoredCollapsed(spaceId);
    const set = collapsed.value[spaceId]!;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    persistCollapsed(spaceId);
  }

  /** 展开某个节点**自己**与它的整条祖先链（搜索跳转、在折叠的文件夹里新建时用）。 */
  function revealNode(id: string): void {
    const spaceId = activeSpaceId.value;
    if (!spaceId) return;
    if (!(spaceId in collapsed.value)) collapsed.value[spaceId] = readStoredCollapsed(spaceId);
    const set = collapsed.value[spaceId]!;

    let changed = set.delete(id);
    for (const ancestor of ancestorIds(documents.value, id)) {
      if (set.delete(ancestor)) changed = true;
    }
    if (changed) persistCollapsed(spaceId);
  }

  /** 重命名空间。服务端只收 name 字段——key 改了会断链，可见性改动面太大。 */
  async function renameSpace(id: string, name: string): Promise<boolean> {
    error.value = null;
    try {
      await kb.patchSpace(id, { name });
    } catch (e) {
      fail(e, "重命名失败");
      return false;
    }
    await loadSpaces();
    return true;
  }

  /** 建文件夹。`createNode` 的两个薄包装——调用点写起来更直白，语义更醒目。 */
  async function createFolder(name: string, parentId: string | null): Promise<string | null> {
    return createNode(name, parentId, "folder");
  }

  /** 建文档。 */
  async function createDocument(title: string, parentId: string | null): Promise<string | null> {
    return createNode(title, parentId, "doc");
  }

  /**
   * 建节点。文件夹与文档走同一条载荷，只有 kind 不同。
   * 返回新节点 id（失败返回 null，错误已进 `error`）。
   */
  async function createNode(
    title: string,
    parentId: string | null,
    kind: "doc" | "folder",
  ): Promise<string | null> {
    const spaceId = activeSpaceId.value;
    if (!spaceId) return null;
    error.value = null;
    try {
      const r = await kb.createDocument({
        spaceId,
        title,
        kind,
        ...(parentId ? { parentId } : {}),
      });
      await loadDocuments(spaceId);
      return r.documentId;
    } catch (e) {
      fail(e, kind === "folder" ? "创建文件夹失败" : "创建文档失败");
      return null;
    }
  }

  /**
   * 拉一次「服务端认哪些格式」。缓存住——它随服务端版本变，不会随会话变。
   * 失败不设为 error（用户下一步动作会再报一次，且它不阻塞任何东西）。
   */
  async function loadFormats(): Promise<string[]> {
    if (formats.value.length) return formats.value;
    try {
      formats.value = (await kb.formats()).extensions;
    } catch {
      // 下拉框的 accept 拿不到就用空的；真正的拒绝在 uploadFile 里，那里会报错
    }
    return formats.value;
  }

  /**
   * 上传一个文件进来（人主动放东西进去，不再只能靠跟 agent 说一句）。
   *
   * 认哪些格式**由服务端说了算**（`GET /api/ingest/formats`）：本地先按它预检，
   * 不认的当场拒绝并说清收哪些——**静默收下是最糟的一类错**（东西进了库，
   * 但没人知道它其实没被正确理解）。
   *
   * 返回新文档 id（失败 null，原因已进 `error`）。
   */
  async function uploadFile(parentId: string | null, file: File): Promise<string | null> {
    const spaceId = activeSpaceId.value;
    if (!spaceId) return null;
    error.value = null;
    notice.value = null;

    // 拿不到列表（服务没起 / 接口挂了）时**不预判**：让服务端去拒绝。
    // 用一份空表把合法上传拦下来，比不拦更糟——那看起来像「资料库什么都不收了」。
    const allowed = await loadFormats();
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (allowed.length && !allowed.includes(ext)) {
      error.value = `资料库只收这些格式：${allowed.join(" / ")}（收到的是 ${file.name}）`;
      return null;
    }

    uploading.value = { name: file.name, pct: 0 };
    loading.value = true;
    try {
      const r = await kb.ingest({
        spaceId,
        parentId,
        file,
        onProgress: (pct) => {
          // 上传可能已经被下一次上传顶掉（同名同进度都无所谓）：只更新当前这一条
          if (uploading.value?.name === file.name) uploading.value.pct = pct;
        },
      });
      // 解析器自报的降级信息如实显示（「导入后内容少了」要能解释清楚）
      if (r.warnings.length) notice.value = r.warnings.join("；");
      await loadDocuments(spaceId);
      return r.documentId;
    } catch (e) {
      fail(e, "上传失败");
      return null;
    } finally {
      uploading.value = null;
      loading.value = false;
    }
  }

  /** 重命名 / 移动。成功后刷新列表；改的若是当前打开的那篇，正文区的标题也要跟着变。 */
  async function patchNode(
    id: string,
    input: { title?: string; parentId?: string | null },
  ): Promise<boolean> {
    error.value = null;
    try {
      await kb.patchDocument(id, input);
    } catch (e) {
      fail(e, "修改失败");
      return false;
    }
    const spaceId = activeSpaceId.value;
    if (spaceId) await loadDocuments(spaceId);
    if (input.title !== undefined && activeDoc.value?.id === id) await openDocument(id);
    return true;
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
   * 原位重新读取当前文档：**不先清空 activeDoc**（openDocument 会清，正文视图随之卸载重建）。
   * AI 改写落地后用它——视图不能被卸载：圈选卡片、对话线程、滚动位置都在这个视图里，
   * 卸掉就是用户读着回复时整张卡片消失。读失败不覆盖现有正文，只报错。
   */
  async function reloadDocument(id: string): Promise<void> {
    const seq = ++docSeq;
    try {
      const doc = await kb.getDocument(id);
      if (seq !== docSeq || activeDoc.value?.id !== id) return;
      activeDoc.value = doc;
    } catch (e) {
      if (seq === docSeq) fail(e, "刷新文档失败");
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
    documents,
    activeDoc,
    loading,
    error,
    notice,
    formats,
    loadFormats,
    uploading,
    uploadFile,
    serverVersion,
    needsUpgrade,
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
    renameSpace,
    loadDocuments,
    createNode,
    createFolder,
    createDocument,
    patchNode,
    collapsedFor,
    toggleCollapsed,
    revealNode,
    openDocument,
    reloadDocument,
    deleteDocument,
    search,
    clearSearch,
    panelOpen,
    openPanel,
    closePanel,
    togglePanel,
  };
}
