# 知识库多层级目录树 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让知识库支持任意深度的文件夹，桌面端与 agent 都能建/改/移动节点；同时修掉「创建空间」按钮永久置灰的缺陷。

**Architecture:** 节点仍然全部住在 `documents` 表里，新增 `kind ∈ {doc, folder}` 区分容器与正文；标题从 `revisions` 上移到 `documents`，因为文件夹没有版本历史、没有地方放名字。前端把后端给的扁平列表组装成真正的树（排序、展开折叠、孤儿提升都在前端算），后端只保证数据完整与结构合法。

**Tech Stack:** Rust（axum + sqlx + PostgreSQL 17）、TypeScript（Vue 3 Composition API + vitest）、`@anthropic-ai/claude-agent-sdk` 的 `tool()`。

**Spec:** `docs/superpowers/specs/2026-09-18-knowledge-base-tree-design.md`

## ⚠️ 执行期修正（实现与本文档分叉的地方）

**代码以仓库实现为准**，本文档是当时的设计意图。以下几处是执行过程中被实测或评审推翻的，
列在最前面免得有人照着下面过时的代码块抄：

1. **Task 9 的「新建」入口设计是错的**（下文那些 `startCreate(row.doc.id, 'doc')` 与
   「新建子文件夹」菜单项，都别再照抄）。原设计把两个 `+` 都写死新建文档、「新建子文件夹」
   只藏在 ⋯ 二级菜单里，结果是**根目录根本建不出文件夹**——而文件夹正是这次的核心能力。
   最终实现：两个 `+` 都开 `kbCreateItems` 的「新建文件夹 / 新建文档」二选一，⋯ 菜单
   回归「对这个节点本身的操作」。
2. **所有弹出层改用应用现成的组件**，不再用手搓的绝对定位浮层。侧栏段落是 `overflow: auto`
   的，行内浮层会被祖先**裁掉**（症状是气泡只露出下半截，用户实际撞到过）。
   `⋯` 菜单 / 移动到… → `useContextMenu` + `ContextMenu.vue`；新建空间表单 →
   `useModal().custom()` + `ModalDialog`（菜单项按仓库惯例收进 `src/menus/contextMenus.ts`）。
3. **Task 7 的成环保护已就地更正**：原写法是「挂边前查一次会不会回到自己」，那是错的
   ——环上每个节点都有父，整条环会从树里消失。改成先挂边、再从根走一遍、把走不到的提为根。
4. **Task 5 的冒烟 python 调用已就地更正**：`python - <<'EOF'` 的 heredoc 会把 stdin 占给
   脚本本身，再管道喂数据只会拿到空串——JSON 必须走 argv。

另外两条**不在本文档里、但交付时必须知道**的（写在 `knowledge-server/README.md` 里）：

- 这一版带了 schema 变更（006），**0.4.0 → 0.3.0 退不回去**：006 把 `documents.title` 设成
  NOT NULL，而 0.3.0 的建文档语句不写这列，退回后新建文档会失败（读文档照常，症状很迷惑）。
- 前端与 knowledge-server 是**分开部署**的，改了后端就必须重新发布镜像并升级服务端；
  本文档的验收清单默认这一点已满足。

## Global Constraints

- **跨平台**：路径拼接用 `PathBuf` / `path.join`，平台特有逻辑必须 `#[cfg(windows)]` 隔离。本次不涉及子进程，但不得引入新的平台假设。
- **主题 token 是配色的唯一来源**：所有颜色/背景/边框/圆角/间距走 `var(--aide-*)`，**禁止硬编码 hex**（`tailwind.config.js` 的 `theme.extend` 为空）。
- **DTO 一律 camelCase**（`#[serde(rename_all = "camelCase")]`），枚举**值**保持 snake_case 并与 SQL CHECK 字面量一致。
- **错误文案是中文**，且要写清下一步（`AppError::BadRequest("…")` 的字符串直接给用户看）。
- **迁移文件不写 `BEGIN` / `COMMIT`**——`knowledge-server/src/db.rs::migrate` 统一包事务；文件名排序决定应用顺序，往已应用的文件里追加 SQL 不会重跑，只能走新文件。
- **sidecar 新逻辑必须先判归**：MCP 工具是 extensions 层（CLAUDE.md「agent-sidecar 职责边界」）。
- **改 sidecar 必须 build**：dev 形态跑的是 `dist` 构建产物，改 `src` 后要 `pnpm build:sidecar` 并重启 tauri dev，否则「改了没生效」。
- **前端测试**：vitest，`include` 覆盖 `src/**/*.test.ts`；组件测试在文件首行加 `// @vitest-environment jsdom`；`@` 别名指向 `src`。
- **前端不引入第二份平行实现**：树的算法只有 `docTree.ts` 一处（侧栏、删除确认、搜索跳转共用）。

## 验证环境（Task 2–6 共用）

后端的端到端验证需要一套**隔离的** docker stack，不能碰用户正在跑的那个实例（内存备忘：冒烟别对用户实例跑）。

一次性准备（Windows 侧没有 docker CLI，要走 WSL）：

```bash
# 仓库根目录执行；MSYS_NO_PATHCONV 防止 git-bash 改写 /app 一类路径
cat > knowledge-server/docker-compose.smoke.yml <<'YAML'
services:
  knowledge:
    ports: !override
      - "18788:8788"
YAML
grep -q docker-compose.smoke.yml .gitignore || echo "docker-compose.smoke.yml" >> .gitignore
```

- [ ] 起栈：`wsl.exe -e sh -lc 'cd /mnt/c/Users/<user>/IdeaProjects/aide/knowledge-server && MSYS_NO_PATHCONV=1 docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.smoke.yml -p kbsmoke up -d --build'`
- [ ] 等就绪：`wsl.exe -e sh -lc 'curl -s http://127.0.0.1:18788/api/health'` —— 返回 JSON 含 `"status":"ok"`
- [ ] 跑冒烟：`wsl.exe -e sh -lc 'cd /mnt/c/Users/<user>/IdeaProjects/aide/knowledge-server && ./smoke.sh http://127.0.0.1:18788'`
- [ ] **拆栈（`-v` 会删卷，跑完必做）**：`wsl.exe -e sh -lc 'cd /mnt/c/Users/<user>/IdeaProjects/aide/knowledge-server && docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.smoke.yml -p kbsmoke down -v'`

冒烟脚本要求**干净库**（`bootstrap` 只在空库可用），所以每次「拆栈 → 起栈」都要成对做。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/composables/useKnowledgeBase.ts` | 知识库面板的状态闭包 | 改：拆竞态计数器（Task 1） |
| `src/composables/useKnowledgeBase.test.ts` | 上面那个闭包的回归测试 | 建（Task 1） |
| `knowledge-server/migrations/006_documents_tree.sql` | `kind` 列 + 标题上移 | 建（Task 2） |
| `knowledge-server/src/types.rs` | 领域类型 | 改：加 `DocumentKind`（Task 2） |
| `knowledge-server/src/domain/versioning.rs` | 版本推进 | 改：写 `documents.title`、拒绝文件夹（Task 2、5） |
| `knowledge-server/src/api/spaces.rs` | 空间与文档树列表 | 改：返回 `kind`，`title` 取 `d.title`（Task 2） |
| `knowledge-server/src/api/documents.rs` | 文档读写 | 改：`create` 收 `kind`、新增 `patch`、锁接口拒绝文件夹（Task 3、4、5） |
| `knowledge-server/src/domain/tree.rs` | **树的结构规则**（父必须是文件夹、成环检测） | 建（Task 3） |
| `knowledge-server/src/domain/permission.rs` | 权限合并的唯一边界 | 改：加 `may_write_under`（Task 3） |
| `knowledge-server/src/api/mod.rs` | 路由表 | 改：`PATCH /api/documents/{id}`（Task 4） |
| `knowledge-server/smoke.sh` | 端到端冒烟 | 改：目录树段落（Task 5） |
| `agent-sidecar/src/extensions/knowledge/{client,format,operations}.ts` | MCP 的传输 / 文案 / 多步操作 | 改（Task 6） |
| `agent-sidecar/src/extensions/knowledgeTools.ts` | MCP 工具表 | 改：两个新工具（Task 6） |
| `packages/aide-sdk/src/composables/useCustomizations.ts` | 内置扩展的前端镜像 | 改：文案补两个工具（Task 6） |
| `src/components/KnowledgeBase/docTree.ts` | 树的算法唯一产地 | 改：升级为真正的树（Task 7） |
| `docs/prototypes/2026-09-18-kb-tree.html` | 界面原型 | 建（Task 8） |
| `src/components/KnowledgeBase/KbTree.vue` | 目录树组件 | 建（Task 9） |
| `src/utils/icons.ts` | 字形表 | 改：`plus` / `more` / `caret`（Task 9） |
| `src/components/KnowledgeBase/KnowledgeBase.vue` | 知识库主区 | 改：用 `KbTree` 换掉平铺列表（Task 9） |
| `src/components/KnowledgeBase/KbGuide.vue` | 内置使用指南 | 改：补目录树一节（Task 10） |

---

### Task 1: 修 `loadSeq` 计数器冲突

**Files:**
- Modify: `src/composables/useKnowledgeBase.ts:56-58`（计数器声明）、`:252-257`（`selectSpace`）、`:278-299`（`loadDocuments` / `openDocument`）、`:233-250`（`loadSpaces`）、`:307-319`（`deleteDocument`）、`:216-231`（`logout`）
- Test: `src/composables/useKnowledgeBase.test.ts`（新建）

**Interfaces:**
- Consumes: `kb` 门面（`src/components/KnowledgeBase/kbClient.ts`）、`pushKnowledgeRuntime`（`kbRuntime.ts`）
- Produces: 无新导出。只保证 `loading` 在每次 `init()` 后回到 `false`

**背景**（照抄 spec §1.1，实现时不要重新推理）：`loadSpaces` 把 `loadDocuments` await 在自己的 `try` 里，而 `loadDocuments` 首行 `++loadSeq` 递增的是**同一个**计数器，于是 `loadSpaces` 的 `finally { if (seq === loadSeq) loading.value = false }` 判断失败、复位被跳过，`loading` 永久为 `true`。只要该实例可见空间数 ≥ 1 就会触发（`activeSpaceId` 非空 → 走到那行），表现为「创建空间」与标题栏「刷新」两个按钮一起变灰。

- [ ] **Step 1: 写失败的测试**

新建 `src/composables/useKnowledgeBase.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `pnpm vitest run src/composables/useKnowledgeBase.test.ts`
Expected: 「有一个可见空间时…」**FAIL** —— `expected true to be false`（`loading` 停在 `true`）。其余三条应已 PASS。

- [ ] **Step 3: 拆计数器**

`src/composables/useKnowledgeBase.ts:56-58`，把单一 `loadSeq` 换成四个：

```ts
  // 竞态护栏：**一个计数器只守一个状态**。
  //
  // ⚠️ 曾经的写法是单一 `loadSeq` 给空间列表与文档列表共用，而 `loadSpaces` 会
  // await `loadDocuments` —— 后者递增了同一个计数器，导致 `loadSpaces` 自己的
  // `finally` 判断失败、`loading` 永久停在 true（「创建空间」与标题栏「刷新」
  // 两个按钮一起变灰）。见 spec §1.1。
  //
  // `docSeq` 被三个调用点递增是刻意的：`openDocument` 发起请求，`selectSpace`
  // 与 `deleteDocument` 负责**作废在途请求**，否则上一空间那篇文档的响应会落进
  // 已经切走的视图。这不是「每个函数一个计数器」，而是「每个被写入的状态一个」。
  let spacesSeq = 0;
  let treeSeq = 0;
  let docSeq = 0;
  let searchSeq = 0;
```

`loadSpaces`（`:233-250`）改成：

```ts
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
```

`selectSpace`（`:252-257`）改成：

```ts
  async function selectSpace(id: string): Promise<void> {
    if (activeSpaceId.value === id) return;
    activeSpaceId.value = id;
    // 作废在途的 openDocument：上一空间的正文不该落进新空间的视图
    docSeq++;
    activeDoc.value = null;
    await loadDocuments(id);
  }
```

`loadDocuments`（`:278-287`）与 `openDocument`（`:289-299`）改成：

```ts
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
```

`deleteDocument`（`:315-318`）里清空 `activeDoc` 的那两行改成：

```ts
    if (activeDoc.value?.id === id) {
      // 与 selectSpace 同理：这篇已经不存在了，在途的 openDocument 不能再把它写回来
      docSeq++;
      activeDoc.value = null;
    }
```

`logout`（`:224-228`）里清空 `activeDoc` 的那行同样加 `docSeq++;`（放在 `activeDoc.value = null` 之前）。

- [ ] **Step 4: 跑测试，确认全绿**

Run: `pnpm vitest run src/composables/useKnowledgeBase.test.ts`
Expected: 4 passed

- [ ] **Step 5: 跑全量前端测试，确认没碰坏别的**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/composables/useKnowledgeBase.ts src/composables/useKnowledgeBase.test.ts
git commit -m "fix(kb): 单一 loadSeq 被两处共用导致创建空间按钮永久置灰

loadSpaces 把 loadDocuments await 在自己的 try 里，而后者递增同一个计数器，
于是 loadSpaces 的 finally 护栏判断失败、loading 永久停在 true——只要该实例
可见空间数 >= 1 就会触发。改成按资源分计数器（spaces/tree/doc/search），
selectSpace 与 deleteDocument 显式作废在途的 openDocument。"
```

---

### Task 2: `kind` 与标题上移落到数据模型

**Files:**
- Create: `knowledge-server/migrations/006_documents_tree.sql`
- Modify: `knowledge-server/src/types.rs`（文件末尾加 `DocumentKind`）
- Modify: `knowledge-server/src/domain/versioning.rs:144-179`（`create_document`）、`:74-80`（合并分支）、`:111-120`（新版本分支）
- Modify: `knowledge-server/src/api/spaces.rs:42-50`（`DocumentSummary`）、`:178-212`（查询与映射）
- Modify: `knowledge-server/src/api/documents.rs:150-186`（`get` 改读 `d.title`，`DocumentDetail` 加 `kind`）

**Interfaces:**
- Consumes: 无（本任务是地基）
- Produces:
  - `crate::types::DocumentKind { Doc, Folder }`，含 `as_str(self) -> &'static str`、`is_folder(self) -> bool`、`TryFrom<&str>`
  - `documents.title` 列（`NOT NULL`）是**当前标题的唯一真相**；`revisions.title` 降级为历史快照
  - `spaces::DocumentSummary` 新增字段 `kind: DocumentKind`

- [ ] **Step 1: 写迁移**

新建 `knowledge-server/migrations/006_documents_tree.sql`：

```sql
-- 006_documents_tree.sql — 目录树：节点类型 + 标题上移。
--
-- 为什么是独立文件而不是并进 005：`_migrations` 按**文件名**记录已应用，
-- 往一个已经应用过的文件里追加 SQL 不会重跑。已发布的库只能走新文件这条路。
--
-- ⚠️ 事务由 src/db.rs 的 migrate() 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- 节点类型。DEFAULT 'doc' 让**存量行自动成为文档**——它们本来就有正文，不需要数据迁移。
-- 文件夹是纯容器：没有 current_revision_id、没有版本历史、没有编辑锁。
ALTER TABLE documents ADD COLUMN kind text NOT NULL DEFAULT 'doc'
  CHECK (kind IN ('doc', 'folder'));

-- 标题从 revisions 上移到节点本身。
--
-- 起因：文件夹没有版本历史，而标题原本只存在于 revisions.title —— 文件夹的名字
-- 没有地方放。上移之后 documents.title 是当前标题的唯一真相，revisions.title 降级为
-- 「写那一版时的快照」（KbHistory 展示历史标题用的就是它）。
--
-- 白捡的两处简化：搜索引擎靠 `d.current_revision_id = r.id` join，文件夹没有
-- revision 就天然命中不了（不需要补 `AND d.kind = 'doc'` 这种会被后人忘掉的过滤）；
-- 侧栏列表取标题也不再需要 JOIN revisions。
--
-- ⚠️ 下面这条 SET NOT NULL 会**故意失败**：若库里存在 current_revision_id IS NULL
--    的行，UPDATE 之后它的 title 仍是 NULL，迁移整体回滚、服务起不来。这是刻意的——
--    这类行本身已经坏了（api/documents.rs::get 用 JOIN 读它，永远 404），静默兜一个
--    「未命名」只会把问题埋起来。真遇到就先查那条 SQL 为什么留下孤儿行。
ALTER TABLE documents ADD COLUMN title text;
UPDATE documents d SET title = r.title FROM revisions r WHERE r.id = d.current_revision_id;
ALTER TABLE documents ALTER COLUMN title SET NOT NULL;

-- ⚠️ 「文件夹没有 current_revision_id、文档必须有」这条不变量**加不成 CHECK 约束**，
--    别试着补：documents 与 revisions 互为外键构成循环，create_document 必须三步写入
--    （插 documents 留空指针 → 插 revisions → 回填指针），第一步的指针必然是 NULL，
--    而 PostgreSQL 的 CHECK 约束不支持 DEFERRABLE（只有 UNIQUE/PK/FK/EXCLUDE 可以）。
--    这条不变量由领域层维持，见 domain/versioning.rs::create_document 的注释。
```

- [ ] **Step 2: 起栈验证迁移能跑通**

按「验证环境」小节起栈，然后：

Run: `wsl.exe -e sh -lc 'MSYS_NO_PATHCONV=1 docker exec kbsmoke-db-1 psql -U aide -d aide_kb -c "\d documents"'`
Expected: 输出里含 `kind` 与 `title` 两列，且 `title` 的 `not null` 为 `t`；`kind` 默认 `'doc'::text`

跑完**先别拆栈**，Task 3–5 还要用。

- [ ] **Step 3: 加 `DocumentKind`**

`knowledge-server/src/types.rs` 末尾追加：

```rust
/// 节点类型。`doc` 有正文与版本历史，`folder` 是纯容器。
///
/// ⚠️ 「文件夹没有 current_revision_id、文档必须有」这条不变量**不是数据库约束**，
/// 原因见 migrations/006_documents_tree.sql 的注释（CHECK 不支持 DEFERRABLE，而
/// documents/revisions 的循环外键要求三步写入）。它由 domain/versioning.rs 维持。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Doc,
    Folder,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentKind::Doc => "doc",
            DocumentKind::Folder => "folder",
        }
    }

    pub fn is_folder(self) -> bool {
        matches!(self, DocumentKind::Folder)
    }
}

impl TryFrom<&str> for DocumentKind {
    type Error = ();
    fn try_from(s: &str) -> Result<Self, ()> {
        match s {
            "doc" => Ok(DocumentKind::Doc),
            "folder" => Ok(DocumentKind::Folder),
            _ => Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DocumentKind;

    #[test]
    fn document_kind_round_trips() {
        for k in [DocumentKind::Doc, DocumentKind::Folder] {
            assert_eq!(DocumentKind::try_from(k.as_str()), Ok(k));
        }
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert!(DocumentKind::try_from("chapter").is_err());
        assert!(DocumentKind::try_from("").is_err());
    }

    #[test]
    fn only_folder_is_folder() {
        assert!(DocumentKind::Folder.is_folder());
        assert!(!DocumentKind::Doc.is_folder());
    }
}
```

- [ ] **Step 4: 跑单测**

Run: `cd knowledge-server && cargo test --lib types::`（内存备忘：`--lib` 绕开杀软对测试 exe 的锁）
Expected: 3 passed。若报 `error: no library targets found`，改用 `cargo test types::`。

- [ ] **Step 5: `create_document` 写 `documents.title`**

`knowledge-server/src/domain/versioning.rs`，把 `create_document` 的第一次 INSERT 换成（注意 `$5` 被 `created_by` 与 `updated_by` 共用）：

```rust
    let (doc_id,): (Uuid,) = sqlx::query_as(
        r#"INSERT INTO documents (space_id, parent_id, slug, title, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5)
           RETURNING id"#,
    )
    .bind(input.space_id) // $1
    .bind(input.parent_id) // $2
    .bind(&input.slug) // $3
    .bind(&input.title) // $4
    .bind(input.author_id) // $5
    .fetch_one(&mut *conn)
    .await?;
```

并在该函数现有的文档注释（`/// 新建文档。` 那段）**末尾追加**一段：

```rust
///
/// ⚠️ 这里维持了一条数据库表达不了的不变量：**文件夹没有 current_revision_id，
/// 文档必须有**。加不上 CHECK 约束是因为下面这个三步舞本身（第一步的指针必然是
/// NULL），而 PostgreSQL 的 CHECK 不支持 DEFERRABLE。详见 006 迁移的注释。
```

- [ ] **Step 6: `save_revision` 两个分支都同步 `documents.title`**

同一文件，合并窗口分支（现在是 `sqlx::query("UPDATE documents SET updated_by = $2, updated_at = now() WHERE id = $1")`，约 `:74-80`）换成：

```rust
                sqlx::query(
                    "UPDATE documents
                        SET title = $2, updated_by = $3, updated_at = now()
                      WHERE id = $1",
                )
                .bind(input.document_id)
                .bind(&input.title)
                .bind(input.author_id)
```

新版本分支（约 `:111-120`）换成：

```rust
    sqlx::query(
        "UPDATE documents
            SET current_revision_id = $2, title = $3, updated_by = $4, updated_at = now()
          WHERE id = $1",
    )
    .bind(input.document_id)
    .bind(rev_id)
    .bind(&input.title)
    .bind(input.author_id)
```

- [ ] **Step 7: 列表接口返回 `kind` 与 `d.title`**

`knowledge-server/src/api/spaces.rs`：

顶部 `use` 加 `DocumentKind`：

```rust
use crate::types::{CurrentUser, DocumentKind, Role, Visibility};
```

`DocumentSummary`（`:42-50`）加字段：

```rust
pub struct DocumentSummary {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    /// doc 有正文与版本历史，folder 是纯容器。前端据此决定图标与「点击是否开正文」
    pub kind: DocumentKind,
    pub slug: String,
    pub title: String,
    pub version_no: i32,
    pub status: String,
    pub updated_at: DateTime<Utc>,
}
```

查询（`:178-194`）换成：

```rust
    // title 取 d.title（同 Task 2 的标题上移）；version_no 仍需 JOIN revisions，
    // 文件夹没有 revision → COALESCE 成 0。
    //
    // ⚠️ ORDER BY 只提供**稳定**顺序，真正的节点顺序由前端组装树时决定
    //（同一条规则写两遍：文件夹优先、名称升序）。让 SQL 与前端一致的意义是
    // 不会出现「SQL 排了一种、前端排了另一种」的错位。
    let rows: Vec<(Uuid, Option<Uuid>, String, String, String, i32, String, DateTime<Utc>)> =
        sqlx::query_as(
            r#"SELECT d.id, d.parent_id, d.kind, d.slug, d.title,
                      COALESCE(r.version_no, 0) AS version_no,
                      d.status,
                      d.updated_at
                 FROM documents d
                 LEFT JOIN revisions r ON r.id = d.current_revision_id
                WHERE d.space_id = $1
                  AND d.deleted_at IS NULL
                  AND d.id = ANY($2::uuid[])
                ORDER BY (d.kind = 'folder') DESC, d.title, d.id"#,
        )
        .bind(space_id)
        .bind(&readable)
        .fetch_all(&mut *tx)
        .await?;
```

映射（`:198-212`）换成：

```rust
    Ok(Json(
        rows.into_iter()
            .map(
                |(id, parent_id, kind, slug, title, version_no, status, updated_at)| {
                    DocumentSummary {
                        id,
                        parent_id,
                        // DB 里是 text + CHECK，理论上只可能两个合法值之一；
                        // 万一出现意外值，退化成 doc 而不是让整个请求 500
                        kind: DocumentKind::try_from(kind.as_str()).unwrap_or(DocumentKind::Doc),
                        slug,
                        title,
                        version_no,
                        status,
                        updated_at,
                    }
                },
            )
            .collect(),
    ))
```

- [ ] **Step 8: `get` 改读 `d.title`，`DocumentDetail` 带 `kind`**

`knowledge-server/src/api/documents.rs`：

顶部 `use` 加 `DocumentKind`：

```rust
use crate::types::{CurrentUser, DocumentKind, DocumentStatus, Permission, RevisionSummary};
```

`DocumentDetail`（`:42-53`）加字段：

```rust
pub struct DocumentDetail {
    pub id: Uuid,
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub kind: DocumentKind,
    pub slug: String,
    pub title: String,
    pub content: String,
    pub version_no: i32,
    pub status: DocumentStatus,
}
```

`get`（`:150-186`）的查询与解构换成：

```rust
    let row: Option<(
        Uuid,
        Uuid,
        Option<Uuid>,
        String,
        String,
        String,
        String,
        i32,
        String,
    )> = sqlx::query_as(
        r#"SELECT d.id, d.space_id, d.parent_id, d.kind, d.slug,
                  d.title, r.content, r.version_no, d.status
             FROM documents d
             JOIN revisions r ON r.id = d.current_revision_id
            WHERE d.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((id, space_id, parent_id, kind, slug, title, content, version_no, status)) = row else {
        return Err(AppError::NotFound("文档没有可读取的版本".into()));
    };

    Ok(Json(DocumentDetail {
        id,
        space_id,
        parent_id,
        kind: DocumentKind::try_from(kind.as_str()).unwrap_or(DocumentKind::Doc),
        slug,
        title,
        content,
        version_no,
        // DB 里是 text + CHECK 约束，理论上只可能是三个合法值之一；
        // 万一出现意外值，退化成 draft 而不是让整个请求 500
        status: DocumentStatus::try_from(status.as_str()).unwrap_or(DocumentStatus::Draft),
    }))
```

- [ ] **Step 9: 编译 + 跑冒烟确认没回归**

Run: `cd knowledge-server && cargo build`
Expected: 编译通过

Run: 按「验证环境」重跑 `./smoke.sh http://127.0.0.1:18788`（**先拆栈再起栈**，冒烟要求干净库）
Expected: 全绿 —— 现有断言不涉及 `title`/`kind`，这一步钉的是「标题上移没把别的东西弄坏」

- [ ] **Step 10: Commit**

```bash
git add knowledge-server/migrations/006_documents_tree.sql knowledge-server/src/types.rs knowledge-server/src/domain/versioning.rs knowledge-server/src/api/spaces.rs knowledge-server/src/api/documents.rs
git commit -m "feat(kb): 节点类型 kind + 标题从 revisions 上移到 documents

文件夹没有版本历史，标题原本只存在于 revisions.title 就没有地方放名字。
上移后 documents.title 是当前标题的唯一真相，revisions.title 降级为历史快照。
副产品：搜索靠 current_revision_id 的 join 天然排除文件夹，不需要额外过滤。"
```

---

### Task 3: 建文件夹 + 父节点必须是文件夹

**Files:**
- Create: `knowledge-server/src/domain/tree.rs`
- Modify: `knowledge-server/src/domain/mod.rs`（注册 `tree` 模块）
- Modify: `knowledge-server/src/domain/permission.rs`（加 `may_write_under`）
- Modify: `knowledge-server/src/api/documents.rs`（`create` 收 `kind`）

**Interfaces:**
- Consumes: `DocumentKind`（Task 2）、`unique_slug`（`crate::domain::ingest`）
- Produces:
  - `crate::domain::tree::ensure_parent_is_folder(conn: &mut PgConnection, space_id: Uuid, parent_id: Uuid) -> AppResult<()>`
  - `crate::domain::tree::ancestors(conn: &mut PgConnection, node_id: Uuid) -> AppResult<Vec<Uuid>>`
  - `crate::domain::tree::would_cycle(conn: &mut PgConnection, node_id: Uuid, new_parent_id: Uuid) -> AppResult<bool>`
  - `crate::domain::permission::may_write_under(conn: &mut PgConnection, user_id: Uuid, space_id: Uuid, parent_id: Option<Uuid>) -> AppResult<bool>`
  - `POST /api/documents` 接受 `kind: "doc" | "folder"`（缺省 `doc`）

- [ ] **Step 1: 建 `domain/tree.rs`**

```rust
//! 目录树的结构规则。
//!
//! 「父必须是文件夹」「不能移进自己的子树」是**结构**约束，不是权限约束，
//! 也不该散落在 API 层——接口层只负责把请求翻译成对领域函数的调用。
//!
//! 与 `domain/deletion.rs` 的分工：那边管「删掉一棵子树」，这边管「能不能接上去」。

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// 沿 `parent_id` 向上走，返回祖先链（不含自己，从最近的父开始）。
///
/// 两道护栏，都不能省：
///   - `visited` 挡住成环。`parent_id` 是用户数据，本端点落地后一个 bug 就能造出环，
///     而 PostgreSQL 的 `WITH RECURSIVE` 遇到环会**无限循环**（除非额外带 CYCLE 子句），
///     所以走应用层。
///   - `MAX_DEPTH` 挡住「环检测失效但链极长」的退化情形，宁可截断也不能挂住请求。
const MAX_DEPTH: usize = 256;

pub async fn ancestors(conn: &mut PgConnection, node_id: Uuid) -> AppResult<Vec<Uuid>> {
    let mut chain = Vec::new();
    let mut visited = std::collections::HashSet::new();
    visited.insert(node_id);

    let mut cursor: Option<Uuid> = parent_of(conn, node_id).await?;
    while let Some(pid) = cursor {
        if !visited.insert(pid) || chain.len() >= MAX_DEPTH {
            break;
        }
        chain.push(pid);
        cursor = parent_of(conn, pid).await?;
    }
    Ok(chain)
}

async fn parent_of(conn: &mut PgConnection, node_id: Uuid) -> AppResult<Option<Uuid>> {
    let row: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT parent_id FROM documents WHERE id = $1 AND deleted_at IS NULL")
            .bind(node_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(row.and_then(|(p,)| p))
}

/// 把 `node_id` 挂到 `new_parent_id` 下会不会成环（目标在自己的子树里）。
pub async fn would_cycle(
    conn: &mut PgConnection,
    node_id: Uuid,
    new_parent_id: Uuid,
) -> AppResult<bool> {
    if node_id == new_parent_id {
        return Ok(true);
    }
    Ok(ancestors(conn, new_parent_id).await?.contains(&node_id))
}

/// 目标父必须是**同一个空间里的文件夹**。
///
/// 两层校验合在一个函数里，是因为它们的失败后果同属一类（请求不合法），
/// 且调用方永远需要两者同时成立——拆成两个函数只会让调用方写成 `a()?; b()?`
/// 而漏掉其中一个。
pub async fn ensure_parent_is_folder(
    conn: &mut PgConnection,
    space_id: Uuid,
    parent_id: Uuid,
) -> AppResult<()> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT space_id, kind FROM documents WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(parent_id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        None => Err(AppError::BadRequest("父节点不存在".into())),
        Some((_, kind)) if kind != "folder" => {
            Err(AppError::BadRequest("只能在文件夹下建立子节点".into()))
        }
        Some((parent_space, _)) if parent_space != space_id => {
            Err(AppError::BadRequest("父节点不属于该空间".into()))
        }
        Some(_) => Ok(()),
    }
}
```

- [ ] **Step 2: 注册模块**

`knowledge-server/src/domain/mod.rs`，在现有模块声明里按字母序加 `pub mod tree;`（与 `pub mod permission;` 相邻）。

- [ ] **Step 3: 加 `may_write_under`**

`knowledge-server/src/domain/permission.rs` 末尾追加：

```rust
/// 「在某个位置建/放节点」的写权限：有父判父，无父判 space 角色。
///
/// 建新节点（`api::documents::create`）与移动已有节点（`api::documents::patch`）
/// 共用这一条判据——两处各写一遍迟早漂移，而这类漂移的表现是「能建但不能移」，
/// 或者更糟的反向：**只判源节点不判目标位置**，于是能把自己的文档搬进一个
/// 自己没有写权限的文件夹。
pub async fn may_write_under(
    conn: &mut PgConnection,
    user_id: Uuid,
    space_id: Uuid,
    parent_id: Option<Uuid>,
) -> AppResult<bool> {
    let perm = match parent_id {
        Some(pid) => effective_permission(conn, user_id, pid).await?,
        None => space_role(conn, user_id, space_id)
            .await?
            .map(Role::base_permission),
    };
    Ok(perm.map(|p| p.at_least(Permission::Write)).unwrap_or(false))
}
```

（`Role` 与 `Permission` 已经在本文件顶部 `use crate::types::{Permission, Role, Visibility};` 引入了，不需要改 import。）

- [ ] **Step 4: `create` 收 `kind` 并用新 helper 判权**

`knowledge-server/src/api/documents.rs`：

`CreateDocumentBody` 加字段：

```rust
pub struct CreateDocumentBody {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub title: String,
    pub content: Option<String>,
    /// 缺省 = 普通文档。文件夹是纯容器：不建 revision、不接受 content
    pub kind: Option<DocumentKind>,
}
```

`create` 整个函数换成（把判权与校验下沉，主函数只留骨架）：

```rust
pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateDocumentBody>,
) -> AppResult<(StatusCode, Json<SaveResult>)> {
    let kind = body.kind.unwrap_or(DocumentKind::Doc);
    let title = body.title.trim();
    validate_new_node(title, kind, body.content.as_deref())?;

    let mut tx = state.db.begin().await?;

    if let Some(parent_id) = body.parent_id {
        tree::ensure_parent_is_folder(&mut tx, body.space_id, parent_id).await?;
    }

    // 判权放在结构校验之后：结构不对（父不是文件夹）时该报 400 而不是 403——
    // 用户要知道的是「这里不能放东西」，不是「你没权限」
    if !permission::may_write_under(&mut *tx, user.id, body.space_id, body.parent_id).await? {
        return Err(AppError::Forbidden);
    }

    let slug =
        crate::domain::ingest::unique_slug(&mut *tx, body.space_id, body.parent_id, title).await?;

    let (document_id, revision_id, version_no) = versioning::create_node(
        &mut *tx,
        state.tokenizer.as_ref(),
        versioning::CreateInput {
            space_id: body.space_id,
            parent_id: body.parent_id,
            kind,
            slug,
            title: title.to_string(),
            content: body.content.unwrap_or_default(),
            author_id: user.id,
        },
    )
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(SaveResult {
            document_id,
            revision_id,
            version_no,
            merged: false,
        }),
    ))
}

/// 新建节点的入参校验。抽出来是因为它同时服务文档与文件夹两条路径，
/// 而两者的差别（文件夹不许带正文）恰恰最容易在复制粘贴里丢。
fn validate_new_node(title: &str, kind: DocumentKind, content: Option<&str>) -> AppResult<()> {
    if title.is_empty() {
        return Err(AppError::BadRequest("标题不能为空".into()));
    }
    // 不接受静默忽略：传了正文却建出没有正文的文件夹，是用户没被告知的丢失
    if kind.is_folder() && content.is_some_and(|c| !c.trim().is_empty()) {
        return Err(AppError::BadRequest("文件夹没有正文".into()));
    }
    Ok(())
}
```

函数顶部的 `use` 加 `tree`：

```rust
use crate::domain::{deletion, locking, permission, tree, versioning};
```

- [ ] **Step 5: `versioning::create_node` 分流**

`knowledge-server/src/domain/versioning.rs`：

`CreateInput` 加字段：

```rust
pub struct CreateInput {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub kind: DocumentKind,
    pub slug: String,
    pub title: String,
    pub content: String,
    pub author_id: Uuid,
}
```

`use crate::types::DocumentKind;` 加到文件顶部的 use 区。

把现有的 `create_document` **改名为 `create_node`** 并改造成两个函数（文件夹不开版本）：

```rust
/// 新建节点。返回 (document_id, revision_id, version_no)。
///
/// 文件夹**没有** revision：`revision_id` 与 `version_no` 对它是全零值
/// （`Uuid::nil()` / 0），调用方据此判断「这次没有产生版本」。用 Option 包一层
/// 会让 `SaveResult` 的 `revision_id: Uuid` 跟着变成可空，而那个字段在真实文档
/// 场景下永远是有的——为一条分支污染 DTO 不划算。
pub async fn create_node(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    input: CreateInput,
) -> AppResult<(Uuid, Uuid, i32)> {
    let doc_id = insert_node(conn, &input).await?;
    if input.kind.is_folder() {
        return Ok((doc_id, Uuid::nil(), 0));
    }
    let rev_id = insert_first_revision(conn, tokenizer, doc_id, &input).await?;
    Ok((doc_id, rev_id, 1))
}

/// 插节点行。`title` 与 `kind` 在这里落库——标题上移之后它不再只存在于 revisions。
async fn insert_node(conn: &mut PgConnection, input: &CreateInput) -> AppResult<Uuid> {
    // ⚠️ 下面这个三步舞维持了一条数据库表达不了的不变量：文件夹没有
    // current_revision_id，文档必须有。加不上 CHECK 约束是因为第一步的指针
    // 必然是 NULL，而 PostgreSQL 的 CHECK 不支持 DEFERRABLE。详见 006 迁移的注释。
    let (doc_id,): (Uuid,) = sqlx::query_as(
        r#"INSERT INTO documents (space_id, parent_id, kind, slug, title, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING id"#,
    )
    .bind(input.space_id)
    .bind(input.parent_id)
    .bind(input.kind.as_str())
    .bind(&input.slug)
    .bind(&input.title)
    .bind(input.author_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(doc_id)
}

/// 首个版本 + 回填指针。文件夹不走这里。
async fn insert_first_revision(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    doc_id: Uuid,
    input: &CreateInput,
) -> AppResult<Uuid> {
    let (rev_id,): (Uuid,) = sqlx::query_as(
        r#"INSERT INTO revisions
             (document_id, version_no, title, content,
              title_tokenized, content_tokenized, author_id)
           VALUES ($1, 1, $2, $3, $4, $5, $6)
           RETURNING id"#,
    )
    .bind(doc_id)
    .bind(&input.title)
    .bind(&input.content)
    .bind(tokenizer.tokenize(&input.title))
    .bind(tokenizer.tokenize(&input.content))
    .bind(input.author_id)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query("UPDATE documents SET current_revision_id = $2 WHERE id = $1")
        .bind(doc_id)
        .bind(rev_id)
        .execute(&mut *conn)
        .await?;

    Ok(rev_id)
}
```

`SaveResult` 的 `version_no` 是 `i32`，文件夹回 0，前端可据此显示「—」。

- [ ] **Step 6: 修 `ingest` 的调用点**

`knowledge-server/src/domain/ingest.rs:132` 附近调用 `create_document` 的地方改为 `create_node`，`CreateInput` 补 `kind: DocumentKind::Doc`（导入永远是文档）。同文件顶部 use 区加 `use crate::types::DocumentKind;`。

Run: `cd knowledge-server && cargo build`
Expected: 编译通过，没有未使用 import 的警告

- [ ] **Step 7: 手工验证建文件夹**

先 bootstrap 一个干净栈（冒烟脚本会做），或者直接跑冒烟脚本让它把库初始化好，再用 curl：

```bash
# TOKEN 换成登录拿到的；SPACE 换成 list_spaces 拿到的 id
curl -s -X POST http://127.0.0.1:18788/api/documents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"spaceId\":\"$SPACE\",\"title\":\"设计\",\"kind\":\"folder\"}"
```
Expected: `201`，body 含 `"versionNo":0` 与 `"revisionId":"00000000-0000-0000-0000-000000000000"`

```bash
# 在同一文件夹下建文档 —— 应 201
# 在一篇文档下建文档（parentId 指向文档）—— 应 400 "只能在文件夹下建立子节点"
# 给文件夹传 content —— 应 400 "文件夹没有正文"
```

> **⚠️ 从本步起 `smoke.sh` 会红，直到 Task 5 修完它的三层子树段落。** 原因：脚本里
> 「刻意造三层」用的是**文档套文档**，而本步把这条路径变成了 400。红的原因与被测代码
> 无关，Task 5 Step 4 会修好。**在 Task 5 之前不要为了让它变绿而回退这个校验。**

- [ ] **Step 8: Commit**

```bash
git add knowledge-server/src/domain/tree.rs knowledge-server/src/domain/mod.rs knowledge-server/src/domain/permission.rs knowledge-server/src/domain/versioning.rs knowledge-server/src/domain/ingest.rs knowledge-server/src/api/documents.rs
git commit -m "feat(kb): 文件夹落地——建文件夹、父必须是文件夹、判权抽成 may_write_under

树的形状规则收进 domain/tree.rs（父类型校验 + 成环检测），权限判据
may_write_under 收进 permission.rs —— 建节点与移动节点共用一条，
避免「只判源节点不判目标位置」那类漏判。"
```

---

### Task 4: `PATCH /api/documents/{id}`——重命名与移动

**Files:**
- Modify: `knowledge-server/src/api/documents.rs`（加 `PatchDocumentBody` / `patch` / `move_node`）
- Modify: `knowledge-server/src/api/mod.rs:133-137`（路由加 `.patch(documents::patch)`）

**Interfaces:**
- Consumes: `tree::ensure_parent_is_folder` / `tree::would_cycle` / `permission::may_write_under`（Task 3）、`unique_slug`
- Produces: `PATCH /api/documents/{id}`，body `{ title?: string, parentId?: string | null }`，返回 `SaveResult`

- [ ] **Step 1: 加 DTO 与 double_option**

`knowledge-server/src/api/documents.rs`，在 `RevertBody` 之后加：

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchDocumentBody {
    pub title: Option<String>,
    /// 三态，缺一不可：缺省 = 不动父级；`null` = 移到根；有值 = 移到该文件夹。
    ///
    /// serde 默认把「字段缺失」和「显式 null」都折叠成 `None`，那样「移到根」就
    /// 无法表达（和「不改」撞成同一个值）。所以外面再包一层 Option，用
    /// `double_option` 把三种情形分开。
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<Uuid>>,
}

/// `T?` → `Option<Option<T>>`：缺失 → `None`，null → `Some(None)`，有值 → `Some(Some(v))`。
/// 配合 `#[serde(default)]` 使用（`default` 负责缺失那一档）。
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}
```

文件顶部 use 区补 `use serde::Deserializer;`（若已通过 `serde::{Deserialize, Serialize}` 引入则无需重复）。

- [ ] **Step 2: 写 `patch` 与 `move_node`**

同一文件，在 `create` 之后加：

```rust
/// 改节点的元数据：重命名、移动。**不产生版本**——这正是标题上移之后
/// 「改名是节点元数据、不是内容变更」这条语义的落点。
pub async fn patch(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchDocumentBody>,
) -> AppResult<Json<SaveResult>> {
    let mut tx = state.db.begin().await?;
    require(&mut tx, user.id, id, Permission::Write).await?;

    let node = node_identity(&mut *tx, id).await?;

    if let Some(target) = body.parent_id {
        move_node(&mut tx, user.id, id, &node, target).await?;
    }
    if let Some(title) = body.title.as_deref() {
        rename_node(&mut *tx, id, title).await?;
    }

    tx.commit().await?;

    Ok(Json(SaveResult {
        document_id: id,
        // 元数据操作不产生版本。回零值与文件夹同口径（见 versioning::create_node）
        revision_id: Uuid::nil(),
        version_no: 0,
        merged: false,
    }))
}

/// 节点的位置身份：所在空间、当前父、当前标题。
struct NodeIdentity {
    space_id: Uuid,
    parent_id: Option<Uuid>,
    title: String,
}

async fn node_identity(conn: &mut PgConnection, id: Uuid) -> AppResult<NodeIdentity> {
    let row: Option<(Uuid, Option<Uuid>, String)> =
        sqlx::query_as("SELECT space_id, parent_id, title FROM documents WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((space_id, parent_id, title)) = row else {
        return Err(AppError::NotFound("节点不存在".into()));
    };
    Ok(NodeIdentity { space_id, parent_id, title })
}

/// 重命名。文件夹与文档走同一条：两边都只是「节点叫什么」。
async fn rename_node(conn: &mut PgConnection, id: Uuid, title: &str) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("标题不能为空".into()));
    }
    sqlx::query("UPDATE documents SET title = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(title)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// 移动。顺序即正确性，别调换：
///   1. 判**目标位置**的写权限（不是源节点——只判源节点就能把文档搬进没权限的文件夹）
///   2. 目标必须是同空间的文件夹
///   3. 目标不能在自己的子树里
///   4. slug 在新父下重算（用户移动时不该关心 slug）
async fn move_node(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    id: Uuid,
    node: &NodeIdentity,
    target: Option<Uuid>,
) -> AppResult<()> {
    // 目标就是当前父 → 空操作。不早退的话下面的 slug 重算会撞上自己
    if target == node.parent_id {
        return Ok(());
    }

    if !permission::may_write_under(&mut **tx, user_id, node.space_id, target).await? {
        return Err(AppError::Forbidden);
    }
    if let Some(pid) = target {
        tree::ensure_parent_is_folder(&mut **tx, node.space_id, pid).await?;
        if tree::would_cycle(&mut **tx, id, pid).await? {
            return Err(AppError::BadRequest("不能把节点移动到它自己的子树里".into()));
        }
    }

    let slug = crate::domain::ingest::unique_slug(&mut **tx, node.space_id, target, &node.title).await?;

    sqlx::query(
        "UPDATE documents SET parent_id = $2, slug = $3, updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(target)
    .bind(&slug)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
```

文件顶部 use 区确认有 `use sqlx::PgConnection;`（`require` 已经在用），并加 `use crate::error::AppResult;`（已有）。

- [ ] **Step 3: 挂路由**

`knowledge-server/src/api/mod.rs:133-137`：

```rust
        .route(
            "/api/documents/{id}",
            get(documents::get)
                .put(documents::update)
                .patch(documents::patch)
                .delete(documents::delete),
        )
```

- [ ] **Step 4: 编译**

Run: `cd knowledge-server && cargo build`
Expected: 编译通过

- [ ] **Step 5: 手工验证三种 body 形态**

```bash
# 改标题：应该成功，且 GET 回来的 title 变了、versionNo 没变
curl -s -X PATCH http://127.0.0.1:18788/api/documents/$DOC \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"新名字"}'

# 移到根（显式 null）：应该成功，parentId 变 null
curl -s -X PATCH http://127.0.0.1:18788/api/documents/$DOC \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"parentId":null}'

# 空 body：两个字段都不动，应 200
curl -s -X PATCH http://127.0.0.1:18788/api/documents/$DOC \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

# 移进自己的子树：应 400 "不能把节点移动到它自己的子树里"
# 移进一篇文档下：应 400 "只能在文件夹下建立子节点"
```

**三种 body 形态都要亲手试**——`double_option` 的正确性只能在这里看出来，编译期不报错。

- [ ] **Step 6: Commit**

```bash
git add knowledge-server/src/api/documents.rs knowledge-server/src/api/mod.rs
git commit -m "feat(kb): PATCH /api/documents/{id} —— 重命名与移动

重命名不产生版本（标题上移之后改名是节点元数据）。移动的顺序即正确性：
先判目标位置的写权限（不是源节点），再判目标类型、成环、slug 重算。
parentId 用 double_option 三态表达：缺省 / null（移到根）/ 有值。"
```

---

### Task 5: 文件夹拒绝正文操作 + 冒烟覆盖目录树

**Files:**
- Modify: `knowledge-server/src/domain/versioning.rs`（`save_revision` 开头加 kind 校验）
- Modify: `knowledge-server/src/api/documents.rs`（加 `require_doc`，三个锁接口改用它）
- Modify: `knowledge-server/smoke.sh`（加目录树段落）

**Interfaces:**
- Consumes: `DocumentKind`（Task 2）、`tree`（Task 3）、`PATCH`（Task 4）
- Produces: 无新导出；行为契约：文件夹上的 `PUT` / 取锁 / 续租 / 释放锁一律 400

- [ ] **Step 1: `save_revision` 挡住文件夹**

`knowledge-server/src/domain/versioning.rs`，把 `save_revision` 开头那段 `SELECT current_revision_id … FOR UPDATE` 换成：

```rust
    // FOR UPDATE 锁文档行：两个并发保存不能算出同一个 version_no。
    // 顺手把 kind 带出来——文件夹没有正文，不能进这条路径。
    let current: Option<(Option<Uuid>, String)> = sqlx::query_as(
        "SELECT current_revision_id, kind
           FROM documents
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE",
    )
    .bind(input.document_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some((current_revision_id, kind)) = current else {
        return Err(AppError::NotFound("文档不存在或已被删除".into()));
    };

    // 领域层自己守这条不变量，不依赖调用方先判——`update` / `revert_to` 两条
    // 路径都从这里过，将来再多一条也不会漏
    if DocumentKind::try_from(kind.as_str()) == Ok(DocumentKind::Folder) {
        return Err(AppError::BadRequest("文件夹没有正文，不能保存版本".into()));
    }
```

- [ ] **Step 2: 锁接口挡住文件夹**

`knowledge-server/src/api/documents.rs`，在 `require` 之后加：

```rust
/// 正文类操作的前置检查：权限之外还要挡住文件夹。
///
/// 与 `require` 的分工：`require` 只管权限（读接口也用它），这里多一道类型闸。
/// 保存/回滚走 `versioning::save_revision` 里那条领域层校验，不需要经过这里；
/// 三个锁接口不落版本，所以单独挡。
async fn require_doc(
    conn: &mut PgConnection,
    user_id: Uuid,
    document_id: Uuid,
    need: Permission,
) -> AppResult<()> {
    require(conn, user_id, document_id, need).await?;
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM documents WHERE id = $1 AND deleted_at IS NULL")
            .bind(document_id)
            .fetch_optional(&mut *conn)
            .await?;
    if kind.as_deref() == Some("folder") {
        return Err(AppError::BadRequest("文件夹没有正文，不能编辑".into()));
    }
    Ok(())
}
```

把 `acquire_lock` / `heartbeat_lock` / `release_lock` 三个函数里的 `require(&mut tx, user.id, id, Permission::Write).await?;` 换成 `require_doc(&mut tx, user.id, id, Permission::Write).await?;`。

- [ ] **Step 3: 编译**

Run: `cd knowledge-server && cargo build`
Expected: 编译通过

- [ ] **Step 4: 冒烟脚本加目录树段落**

> **⚠️ 先修一条会被这次改动打破的现有断言。** 脚本里「刻意造三层（父→子→孙）」那一段用的是
> **文档套文档**（`parentId` 指向另一篇文档，见 `smoke.sh:304-315`）。Task 3 之后这条路径
> 变成 400 —— 不修的话冒烟从 Task 3 起就一直红，而红的原因和被测代码无关。

脚本里**已经有的**辅助函数（不要新造）：
- `expect 实际 期望 说明` —— 不等就 `exit 1` 并打 ✗，相等打 ✓。**没有 `fail` 函数**，别调用它。
- `say 标题` —— 打段落标题。
- `field JSON DOT_PATH` —— 取字段。
- 状态码走 `STATUS="$(cat "$CODE_FILE")"`（命令替换开子 shell，赋值传不回来）。
- **中文不能出现在 argv 上**（`smoke.sh:40-42` 的 Windows GBK 教训）：带中文的查询串一律用
  `curl -G --data-urlencode 'q@-'` 从 stdin 喂。

**第一件事：把三层子树改用文件夹。** 把 `smoke.sh` 里那三个 `POST /api/documents` 的
`parentId` 改成文件夹 id —— 先建两个文件夹，让「父→子→孙」落在文件夹里：

```bash
body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"title\":\"冒烟删除根\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建删除测试根文件夹 → 201"
DEL_ROOT="$(field "$body" documentId)"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$DEL_ROOT\",\"title\":\"冒烟中间层\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建中间层文件夹 → 201"
DEL_MID="$(field "$body" documentId)"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$DEL_MID\",\"title\":\"冒烟父文档\",\"content\":\"父文档。关键词：貔貅。\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建父文档 → 201"
DEL_DOC_ID="$(field "$body" documentId)"
```

改造后的形状是**三层文件夹 + 最里层一篇文档**（`冒烟删除根/冒烟中间层/冒烟父文档`），
原来那两篇子/孙文档删掉不再需要——「只删一层的实现过不了」这条断言反而更强了：
现在必须穿过两层文件夹才够得着最里面那篇。

**保留 `貔貅` 这个关键词只放在最里层那篇文档上**（文件夹没有正文，放不了关键词），
下面的检索正向基线照常成立。

在这段**之后**插入目录树段落：

```bash
say "目录树：建 / 移 / 改名"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"title\":\"运维手册\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "建文件夹 → 201"
FOLDER="$(field "$body" documentId)"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$FOLDER\",\"title\":\"部署\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "文件夹下建子文件夹（多层）→ 201"
SUB="$(field "$body" documentId)"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$SUB\",\"title\":\"回滚手册\",\"content\":\"# 回滚\\n\\n正文。\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "201" "文件夹下建文档 → 201"
INNER="$(field "$body" documentId)"

# 列表要带 kind，标题取 documents.title，同级文件夹排在文档之前
body="$(api GET "/api/spaces/$SPACE_ID/documents" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "拉取目录树 → 200"
# ⚠️ 数据走 **argv** 而不是 stdin：`python - <<'EOF'` 的 heredoc 把 stdin 占给脚本
#    本身了，再管道喂数据只会拿到空串（`field()` 用的是同一条路子）。
"$PY" -c '
import sys, json
docs = json.loads(sys.argv[1])
by_id = {d["id"]: d for d in docs}
folder, sub, inner = sys.argv[2], sys.argv[3], sys.argv[4]
assert by_id[folder]["kind"] == "folder", "文件夹的 kind 不是 folder"
assert by_id[inner]["kind"] == "doc", "文档的 kind 不是 doc"
assert by_id[folder]["title"] == "运维手册", "标题没有取 documents.title"
assert by_id[inner]["parentId"] == sub, "parentId 不对"
# 排序断言：同级里文件夹必须全部排在文档之前
siblings = [d["kind"] for d in docs if d["parentId"] == folder]
assert siblings == sorted(siblings, key=lambda k: 0 if k == "folder" else 1), "同级里文件夹没有排在前面"
print("  ✓ kind / 标题 / 排序")
' "$body" "$FOLDER" "$SUB" "$INNER"

# 移动：文档从 SUB 挪到 FOLDER
body="$(api PATCH "/api/documents/$INNER" "{\"parentId\":\"$FOLDER\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "移动文档 → 200"
body="$(api GET "/api/documents/$INNER" "" "$TOKEN_B")"
expect "$(field "$body" parentId)" "$FOLDER" "移动后 parentId 变了"

# 重命名：不产生新版本（标题上移之后改名是节点元数据）
body="$(api PATCH "/api/documents/$INNER" '{"title":"回滚手册（旧）"}' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "200" "重命名 → 200"
body="$(api GET "/api/documents/$INNER" "" "$TOKEN_B")"
expect "$(field "$body" title)" "回滚手册（旧）" "重命名后标题变了"
expect "$(field "$body" versionNo)" "1" "重命名没有产生新版本"

say "目录树：非法操作必须被拒"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$INNER\",\"title\":\"非法子节点\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文档下不许建子节点 → 400"

body="$(api POST /api/documents "{\"spaceId\":\"$SPACE_ID\",\"title\":\"非法文件夹\",\"content\":\"x\",\"kind\":\"folder\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文件夹不许带正文 → 400"

body="$(api PATCH "/api/documents/$FOLDER" "{\"parentId\":\"$SUB\"}" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "不能移进自己的子树 → 400"

body="$(api PUT "/api/documents/$FOLDER" '{"title":"x","content":"y"}' "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文件夹不能保存正文 → 400"

body="$(api POST "/api/documents/$FOLDER/lock" "" "$TOKEN_B")"
STATUS="$(cat "$CODE_FILE")"
expect "$STATUS" "400" "文件夹不能取编辑锁 → 400"

say "目录树：文件夹不进检索"

# 拿文件夹的**完整标题**去搜，必须一条都命中不了——文件夹没有 revision，
# 因而没有 tsv，这是「搜索天然排除文件夹」的直接验收。
# ⚠️ 中文走 stdin（argv 在 Windows git-bash 下会被转成 GBK）
body="$(printf '%s' '运维手册' | curl -sS --max-time 15 -G "$BASE/api/search" \
  --data-urlencode 'q@-' \
  -H "Accept: application/json" -H "Authorization: Bearer $TOKEN_B" \
  -w $'\n%{http_code}')"
STATUS="${body##*$'\n'}"
body="${body%$'\n'*}"
expect "$STATUS" "200" "按文件夹标题检索 → 200"
expect "$(field "$body" hits.0.documentId)" "" "按文件夹标题检索命中数 0"
```

**⚠️ 插入前先做两件核对**（否则脚本会在意想不到的地方退出）：
1. `grep -n 'FOLDER\|DEL_ROOT\|DEL_MID\|INNER\|SUB=' smoke.sh` —— 确认新变量名没和现有的撞
2. 上面第一段改写要**替换**掉原有的三层子树建文档代码，不是追加。改完 `grep -c 'parentId.*DEL_DOC_ID' smoke.sh` 应该只剩你新写的那处

- [ ] **Step 5: 跑冒烟**

拆栈 → 起栈 → Run: `./smoke.sh http://127.0.0.1:18788`
Expected: 全绿，含新增的「目录树」三段

- [ ] **Step 6: 拆栈**

Run: 按「验证环境」的拆栈命令（`down -v`）
Expected: 容器与卷都没了（`wsl.exe -e sh -lc 'docker ps -a | grep kbsmoke'` 无输出）

- [ ] **Step 7: Commit**

```bash
git add knowledge-server/src/domain/versioning.rs knowledge-server/src/api/documents.rs knowledge-server/smoke.sh
git commit -m "feat(kb): 文件夹拒绝正文操作 + 冒烟覆盖目录树

save_revision 在领域层挡住文件夹（update/revert 两条路径都从这里过），
三个锁接口用 require_doc 单独挡。冒烟新增目录树三段：建/移/改名、
六条非法操作必须 400、检索必须排除文件夹。"
```

---

### Task 6: MCP 工具——`create_folder` 与 `move_document`

**Files:**
- Modify: `agent-sidecar/src/extensions/knowledge/client.ts:36-44`（`KbDocumentSummary` 加 `kind`）
- Modify: `agent-sidecar/src/extensions/knowledge/format.ts`（`formatDocumentList`）
- Modify: `agent-sidecar/src/extensions/knowledge/operations.ts`（加 `createFolder` / `moveDocument`）
- Modify: `agent-sidecar/src/extensions/knowledgeTools.ts`（两个新工具 + 描述修订）
- Modify: `packages/aide-sdk/src/composables/useCustomizations.ts:77`
- Test: `agent-sidecar/src/extensions/knowledge/format.test.ts`、`agent-sidecar/src/extensions/knowledgeTools.test.ts`

**Interfaces:**
- Consumes: `POST /api/documents` 的 `kind`（Task 3）、`PATCH /api/documents/{id}`（Task 4）
- Produces:
  - `operations.createFolder(client: KbClient, args: NewFolder) => Promise<string>`
  - `operations.moveDocument(client: KbClient, args: MoveArgs) => Promise<string>`
  - MCP 工具名 `create_folder` / `move_document`

- [ ] **Step 1: 写失败的测试**

`agent-sidecar/src/extensions/knowledge/format.test.ts` 追加（保持文件里现有的 import 风格）：

```ts
describe("formatDocumentList 的 kind 标注", () => {
  function summary(id: string, title: string, kind: string, parentId: string | null = null) {
    return { id, parentId, kind, slug: id, title, versionNo: kind === "folder" ? 0 : 1, status: "draft", updatedAt: "2026-09-18T00:00:00Z" };
  }

  it("文件夹标注 [folder]，文档标注 [doc]", () => {
    const out = formatDocumentList([
      summary("f1", "运维手册", "folder"),
      summary("d1", "回滚手册", "doc", "f1"),
    ]);
    expect(out).toContain("[folder] 运维手册");
    expect(out).toContain("[doc] 回滚手册");
  });

  it("缺 kind 的老数据退化成 doc，不炸", () => {
    const out = formatDocumentList([
      { id: "d1", parentId: null, slug: "d1", title: "旧文档", versionNo: 1, status: "draft", updatedAt: "2026-09-18T00:00:00Z" },
    ]);
    expect(out).toContain("[doc] 旧文档");
  });
});
```

`agent-sidecar/src/extensions/knowledgeTools.test.ts` 追加：

```ts
describe("目录树工具", () => {
  it("工具表里有 create_folder 与 move_document", () => {
    const names = buildKnowledgeTools({} as NodeJS.ProcessEnv, process.cwd()).map((t) => t.name);
    expect(names).toContain("create_folder");
    expect(names).toContain("move_document");
  });
});
```

（若该文件已有的 import 里没有 `buildKnowledgeTools`，从 `"./knowledgeTools.js"` 引入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run agent-sidecar/src/extensions/knowledge/format.test.ts agent-sidecar/src/extensions/knowledgeTools.test.ts`
Expected: FAIL —— `formatDocumentList` 输出里没有 `[folder]` 标注；工具表里没有 `create_folder`

- [ ] **Step 3: `client.ts` 加 `kind`**

```ts
export interface KbDocumentSummary {
  id: string;
  parentId?: string | null;
  /** "doc" | "folder"。老服务端不带这个字段，消费方按 doc 兜底。 */
  kind?: string;
  slug: string;
  title: string;
  versionNo: number;
  status: string;
  updatedAt: string;
}
```

- [ ] **Step 4: `format.ts` 的 `formatDocumentList`**

```ts
export function formatDocumentList(docs: KbDocumentSummary[]): string {
  if (docs.length === 0) {
    return "This space has no documents yet.";
  }
  const lines = docs.map((d) => {
    // 老服务端没有 kind 字段 → 按 doc 兜底（降级不能整条消失）
    const kind = d.kind === "folder" ? "folder" : "doc";
    const under = d.parentId ? ` under ${d.parentId}` : "";
    const ver = kind === "folder" ? "" : `, v${d.versionNo}`;
    return `- [${kind}] ${d.title} — id ${d.id}${under}${ver}, updated ${d.updatedAt}`;
  });
  return (
    `Nodes in this space (${docs.length}) — [folder] is a container, [doc] holds the content:\n` +
    lines.join("\n")
  );
}
```

- [ ] **Step 5: `operations.ts` 加两个操作**

```ts
export interface NewFolder {
  spaceId: string;
  title: string;
  parentId?: string;
}

export interface MoveArgs {
  documentId: string;
  /** 省略 = 移到根 */
  parentId?: string;
}

/**
 * 建文件夹。与 `createDocument` 分开而不是加个 `kind` 开关：两者的入参不同
 * （文件夹没有 content），工具面也不同（模型看得到工具描述）。
 */
export async function createFolder(client: KbClient, args: NewFolder): Promise<string> {
  const saved = await client.sendJson<KbSaveResult>("/api/documents", "POST", {
    spaceId: args.spaceId,
    title: args.title,
    kind: "folder",
    ...(args.parentId ? { parentId: args.parentId } : {}),
  });
  return saved.ok
    ? `Created the knowledge base folder. documentId ${saved.data.documentId}. Use it as parentId when creating documents inside it.`
    : formatFailure(saved.failure);
}

/**
 * 移动节点。
 *
 * **先读一跳**：标题要用于回执（用户得核对搬走的是不是他说的那篇），且 404/403
 * 必须在读这一跳如实返回——和 `deleteDocument` 同一条理由。另外读回来的
 * `parentId` 让「已经是这个位置」能被识别成空操作，不至于让模型以为搬成功了。
 */
export async function moveDocument(client: KbClient, args: MoveArgs): Promise<string> {
  const cur = await client.getJson<KbDocument>(docPath(args.documentId));
  if (!cur.ok) return formatFailure(cur.failure);

  const target = args.parentId ?? null;
  if ((cur.data.parentId ?? null) === target) {
    return `"${cur.data.title}" is already ${target ? `under ${target}` : "at the top level"} — nothing moved.`;
  }

  const res = await client.sendJson<unknown>(docPath(args.documentId), "PATCH", {
    parentId: target,
  });
  if (!res.ok) return formatFailure(res.failure);

  const where = target ? `under folder ${target}` : "to the top level of the space";
  return `Moved "${cur.data.title}" ${where} (documentId ${args.documentId}).`;
}
```

`KbSaveResult` 与 `KbDocument` 已在该文件的 import 里；确认 `docPath` 也在（是的，`updateDocument` 在用）。

- [ ] **Step 6: `knowledgeTools.ts` 加两个工具**

在 `buildCreateDocumentTool` 之后加：

```ts
function buildCreateFolderTool(env: NodeJS.ProcessEnv) {
  return tool(
    "create_folder",
    "Create a knowledge base FOLDER (a container node that holds no content). Use it to build a directory structure before filing documents into it — then pass the folder's id as `parentId` to create_document or ingest_file.",
    {
      title: z.string().describe("Folder name, e.g. '运维手册'"),
      spaceId: z.string().optional().describe("Target space id from list_spaces. Omit only when the user's target is unambiguous."),
      parentId: z.string().optional().describe("Parent folder id to nest under. Omit for a top-level folder."),
    },
    (args) =>
      kbWrite(env, async (client) => {
        const target = await resolveWriteTarget(client, args.spaceId);
        if (target.kind === "ask") return target.text;
        return createFolder(client, {
          spaceId: target.id,
          title: args.title,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        });
      }),
  );
}

function buildMoveDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "move_document",
    "Move an existing knowledge base node (document or folder) to another folder, or back to the top level. This changes where it sits in the tree — it does not change its content or its id. Use list_documents to find the target folder's id first.",
    {
      documentId: z.string().describe("Id of the node to move (document or folder)"),
      parentId: z.string().optional().describe("Destination FOLDER id. Omit to move it to the top level of its space."),
    },
    (args) =>
      kbWrite(env, (client) =>
        moveDocument(client, {
          documentId: args.documentId,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        }),
      ),
  );
}
```

import 补 `createFolder, moveDocument`（加在现有 `./knowledge/operations.js` 那组里），工具表补两项：

```ts
export function buildKnowledgeTools(env: NodeJS.ProcessEnv, cwd: string) {
  return [
    buildSearchTool(env),
    buildReadDocumentTool(env),
    buildListSpacesTool(env),
    buildListDocumentsTool(env),
    buildCreateDocumentTool(env),
    buildCreateFolderTool(env),
    buildMoveDocumentTool(env),
    buildAppendDocumentTool(env),
    buildUpdateDocumentTool(env),
    buildIngestFileTool(env, cwd),
    buildDeleteDocumentTool(env),
  ];
}
```

同时改两处描述：

- `buildListDocumentsTool` 的描述末尾加：`"Each line is tagged [folder] or [doc]; pass a [folder] id as parentId to create or move things into it."`
- `buildCreateDocumentTool` 的 `parentId` 描述改成：`"Parent FOLDER id to nest under. Omit for a top-level document. Only folders can hold children."`
- `buildIngestFileTool` 的 `parentId` 描述改成同一句。
- `buildDeleteDocumentTool` 的描述里 `"every sub-document under it"` 改成 `"everything under it (sub-folders and documents)"`。

- [ ] **Step 7: 前端镜像同步**

`packages/aide-sdk/src/composables/useCustomizations.ts:77` 那一行里：

- 把 `写 create_document / append_document / update_document / ingest_file / delete_document 每次要你确认` 改成 `写 create_document / create_folder / move_document / append_document / update_document / ingest_file / delete_document 每次要你确认`
- 把 `其中 delete_document 连带子文档、界面无恢复入口` 改成 `其中 move_document 会改变目录结构、delete_document 连带子文件夹与子文档、界面无恢复入口`

- [ ] **Step 8: build + 跑测试**

Run: `pnpm build:sidecar && pnpm vitest run agent-sidecar/src/extensions/`
Expected: 构建成功；测试全绿

- [ ] **Step 9: 真机验证（需要 tauri dev 重启）**

重启 tauri dev（内存备忘：dev 跑 dist 产物），在会话里让 agent 建一个文件夹再把文档移进去。如果 agent 无视新工具，去 `agent-sidecar` 的日志里看工具表是否注册成功——CLAUDE.md 记过「MCP 工具光注册模型会无视」的教训，必要时靠工具描述里的「Use it to…」把它和 `list_documents` 串起来。

- [ ] **Step 10: Commit**

```bash
git add agent-sidecar/src/extensions/ packages/aide-sdk/src/composables/useCustomizations.ts
git commit -m "feat(kb): MCP 加 create_folder 与 move_document

list_documents 的输出按 [folder]/[doc] 标注类型，模型才看得见哪些节点
能当 parentId。move_document 先读一跳：回执要点名搬的是哪一篇，
且「已经在这个位置」要能被识别成空操作。"
```

---

### Task 7: `docTree.ts` 升级为真正的树

**Files:**
- Modify: `src/components/KnowledgeBase/docTree.ts`（整体重写，保留 `depthOf` / `subtreeSize` 导出以兼容现有调用点）
- Modify: `src/components/KnowledgeBase/docTree.test.ts`

**Interfaces:**
- Consumes: `KbDocumentSummary`（Task 9 会给它加 `kind`，本任务先按 `kind?: string` 可选处理）
- Produces:
  - `buildTree(docs: KbDocumentSummary[]): KbTreeNode[]`
  - `flatten(nodes: KbTreeNode[], collapsed: ReadonlySet<string>): VisibleRow[]`
  - `ancestorIds(docs: KbDocumentSummary[], id: string): string[]`
  - `subtreeSize(docs: KbDocumentSummary[], rootId: string): number`（签名不变）
  - `depthOf(docs: KbDocumentSummary[]): Record<string, number>`（签名不变，改由 `buildTree` 派生）
  - `interface KbTreeNode { doc: KbDocumentSummary; children: KbTreeNode[]; isFolder: boolean }`
  - `interface VisibleRow { doc: KbDocumentSummary; depth: number; isFolder: boolean; hasChildren: boolean }`

- [ ] **Step 1: 写失败的测试**

`src/components/KnowledgeBase/docTree.test.ts` 整体换成：

```ts
// 扁平文档列表 → 树（纯函数，不依赖 Vue）。
//
// 本模块是这份「树」的唯一算法产地：侧栏渲染、折叠、删除确认、搜索跳转全从这里取数。
// 各算各的迟早漂移——侧栏缩进看着是 4 篇，弹窗却说「将连带删除 2 篇」。
import { describe, it, expect } from "vitest";
import { buildTree, flatten, ancestorIds, depthOf, subtreeSize } from "./docTree";
import type { KbDocumentSummary } from "./kbClient";

/** 造摘要：本模块只关心 id / parentId / title / kind，其余字段给足类型即可。 */
function doc(
  id: string,
  parentId: string | null = null,
  kind: "doc" | "folder" = "doc",
): KbDocumentSummary {
  return {
    id,
    parentId,
    kind,
    slug: id,
    title: id,
    versionNo: kind === "folder" ? 0 : 1,
    status: "draft",
    updatedAt: "2026-09-18T00:00:00Z",
  };
}

const folder = (id: string, parentId: string | null = null) => doc(id, parentId, "folder");

describe("buildTree", () => {
  it("父在列表里就挂进去，层级正确", () => {
    const tree = buildTree([folder("f"), doc("a", "f"), doc("b", "a")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].doc.id).toBe("f");
    expect(tree[0].children[0].doc.id).toBe("a");
    expect(tree[0].children[0].children[0].doc.id).toBe("b");
  });

  it("父不在列表里（父不可读 / 已删）→ 提升为根，绝不能消失", () => {
    const tree = buildTree([doc("a", "看不见的父")]);
    expect(tree.map((n) => n.doc.id)).toEqual(["a"]);
  });

  it("父子成环 → 不死循环，节点不丢", () => {
    const tree = buildTree([doc("a", "b"), doc("b", "a")]);
    const seen = new Set<string>();
    const walk = (ns: ReturnType<typeof buildTree>): void => {
      for (const n of ns) {
        expect(seen.has(n.doc.id)).toBe(false); // 每个节点最多出现一次
        seen.add(n.doc.id);
        walk(n.children);
      }
    };
    walk(tree);
    expect(seen.size).toBe(2);
  });

  it("同级排序：文件夹优先，其余按名称", () => {
    const tree = buildTree([
      doc("z", null),
      folder("a"),
      doc("a", null),
      folder("z"),
    ]);
    // title 就是 id，所以名称序 = a < z
    expect(tree.map((n) => n.doc.id)).toEqual(["a", "z", "a", "z"]);
    expect(tree.map((n) => n.isFolder)).toEqual([true, true, false, false]);
  });

  it("kind 缺省按文档处理（老数据 / 老服务端）", () => {
    const bare = { id: "x", parentId: null, slug: "x", title: "x", versionNo: 1, status: "draft", updatedAt: "" };
    expect(buildTree([bare])[0].isFolder).toBe(false);
  });
});

describe("flatten", () => {
  const tree = buildTree([folder("f"), doc("a", "f"), folder("g", "f"), doc("b", "g")]);

  it("默认全展开，深度递增", () => {
    expect(flatten(tree, new Set()).map((r) => [r.doc.id, r.depth])).toEqual([
      ["f", 0],
      ["a", 1],
      ["g", 1],
      ["b", 2],
    ]);
  });

  it("折叠父节点 → 整棵子树不产出", () => {
    expect(flatten(tree, new Set(["f"])).map((r) => r.doc.id)).toEqual(["f"]);
  });

  it("折叠只影响自己那一支", () => {
    expect(flatten(tree, new Set(["g"])).map((r) => r.doc.id)).toEqual(["f", "a", "g"]);
  });

  it("hasChildren 反映的是有没有子节点，与折叠状态无关", () => {
    const rows = flatten(tree, new Set());
    expect(rows.find((r) => r.doc.id === "a")?.hasChildren).toBe(false);
    expect(rows.find((r) => r.doc.id === "f")?.hasChildren).toBe(true);
  });
});

describe("ancestorIds", () => {
  it("从最近的父开始列到根", () => {
    const docs = [folder("f"), folder("g", "f"), doc("b", "g")];
    expect(ancestorIds(docs, "b")).toEqual(["g", "f"]);
  });

  it("根节点没有祖先", () => {
    expect(ancestorIds([doc("a")], "a")).toEqual([]);
  });

  it("成环时原地停下（数据畸形也不能挂住 UI）", () => {
    expect(ancestorIds([doc("a", "b"), doc("b", "a")], "a")).toEqual(["b"]);
  });
});

describe("depthOf", () => {
  it("顶层 0，逐层 +1", () => {
    const docs = [folder("a"), doc("b", "a"), doc("c", "b")];
    expect(depthOf(docs)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("不再封顶——超过 3 层继续往右推（本版来了真正的树）", () => {
    const docs = [folder("a"), folder("b", "a"), folder("c", "b"), folder("d", "c"), doc("e", "d")];
    expect(depthOf(docs)).toEqual({ a: 0, b: 1, c: 2, d: 3, e: 4 });
  });

  it("父不在列表里（孤儿）按顶层算，不抛", () => {
    expect(depthOf([doc("a", "缺")])).toEqual({ a: 0 });
  });
});

describe("subtreeSize", () => {
  it("叶子（没有子节点）= 1，即它自己", () => {
    expect(subtreeSize([doc("a")], "a")).toBe(1);
  });

  it("整棵子树：父 + 2 子 + 1 孙 = 4", () => {
    const docs = [doc("p"), doc("c1", "p"), doc("c2", "p"), doc("g", "c1")];
    expect(subtreeSize(docs, "p")).toBe(4);
  });

  it("文件夹连同里面的东西一起算（删除确认弹窗要的数）", () => {
    const docs = [folder("f"), doc("a", "f"), folder("g", "f"), doc("b", "g")];
    expect(subtreeSize(docs, "f")).toBe(4);
    expect(subtreeSize(docs, "g")).toBe(2);
  });

  it("只数自己这一支，兄弟子树不计入", () => {
    const docs = [doc("p"), doc("c1", "p"), doc("c2", "p"), doc("g", "c1")];
    expect(subtreeSize(docs, "c1")).toBe(2);
    expect(subtreeSize(docs, "c2")).toBe(1);
  });

  it("id 不在列表里 → 0（列表是当前空间的视图，可能已不含它）", () => {
    expect(subtreeSize([doc("a")], "不在")).toBe(0);
  });

  it("父子成环也不死循环（数据畸形时宁可少数，不能挂住 UI）", () => {
    expect(subtreeSize([doc("a", "b"), doc("b", "a")], "a")).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/KnowledgeBase/docTree.test.ts`
Expected: FAIL —— `buildTree` / `flatten` / `ancestorIds` 未导出；`depthOf` 的「超过 3 层」用例失败（现在封顶 3）

- [ ] **Step 3: 重写 `docTree.ts`**

```ts
// 扁平文档列表 → 树（纯函数，不依赖 Vue）。
//
// 服务端 `/api/spaces/{id}/documents` 给的是扁平列表（id + parentId + kind），
// 树在客户端现算。本模块是这份「树」的唯一算法产地：**侧栏渲染、折叠、删除确认
// 弹窗、搜索跳转都从这里取数**。各算各的迟早漂移——侧栏看着是 4 篇，
// 弹窗却说「将连带删除 2 篇」。
import type { KbDocumentSummary } from "./kbClient";

/** 树节点。`doc` 保留原始摘要，渲染层不用再回头查。 */
export interface KbTreeNode {
  doc: KbDocumentSummary;
  children: KbTreeNode[];
  isFolder: boolean;
}

/** 摊平后的一行：`depth` 直接当缩进用，折叠的子树不产出。 */
export interface VisibleRow {
  doc: KbDocumentSummary;
  depth: number;
  isFolder: boolean;
  /** 只是「有没有子节点」，与当前折没折叠无关——决定折叠箭头显不显示 */
  hasChildren: boolean;
}

/** kind 缺省当文档：老服务端没有这个字段，降级不能让节点变成文件夹。 */
function isFolder(doc: KbDocumentSummary): boolean {
  return doc.kind === "folder";
}

/**
 * 同级排序：**文件夹优先，各自按名称升序**。
 *
 * 用 `localeCompare` 而不是 `<`：中文按拼音排才对（`<` 比的是码位，
 * 汉字会排成一团乱序）。`id` 兜底保证同名的两个节点顺序稳定。
 */
function compareNodes(a: KbDocumentSummary, b: KbDocumentSummary): number {
  if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
  return a.title.localeCompare(b.title, "zh") || a.id.localeCompare(b.id);
}

/**
 * 扁平列表 → 树。
 *
 * 两条必须写进实现的不变量：
 *
 * 1. **孤儿提升到根**：`parentId` 指向的节点不在列表里（父不可读 / 已删 / 数据异常）时，
 *    该节点作为根渲染。列表是「当前用户可读的视图」，父不可读而子可读是合法状态——
 *    **不能让任何一篇文档消失**。
 *
 * 2. **成环保护**：`parentId` 是用户数据，`a→b→a` 必须原地停下。这里比「挂之前验一次」
 *    多走一步：环上**每个**节点都有父，所以第一遍挂边时它们一个都进不了根集——
 *    光靠「验一次再挂」整条环会从树里消失。所以第二遍把「从根走不到的」逐个提为根。
 */
export function buildTree(docs: KbDocumentSummary[]): KbTreeNode[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const children = new Map<string, KbDocumentSummary[]>();
  const roots: KbDocumentSummary[] = [];

  // ① 挂边。父在列表里（且不是自己）就挂过去，否则进根集
  for (const d of docs) {
    const parent = d.parentId === null ? undefined : byId.get(d.parentId);
    if (!parent || parent.id === d.id) {
      roots.push(d);
      continue;
    }
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(d);
    else children.set(parent.id, [d]);
  }

  // ② 从根走一遍，把够不着的（成环的那些）逐个提为根。visited 让环原地停下。
  const visited = new Set<string>();
  const adopt = (d: KbDocumentSummary): void => {
    if (visited.has(d.id)) return;
    visited.add(d.id);
    for (const child of children.get(d.id) ?? []) adopt(child);
  };
  for (const r of roots) adopt(r);
  for (const d of docs) {
    if (visited.has(d.id)) continue;
    roots.push(d);
    adopt(d);
  }

  // ③ 成形 + 排序。`built` 同时兜住递归：环上的节点在 ② 里已被拆开，
  //    但万一还有残留，`built` 会在第二次遇到时把它挡掉，不会无限递归。
  const built = new Set<string>();
  const build = (d: KbDocumentSummary): KbTreeNode => {
    built.add(d.id);
    return {
      doc: d,
      isFolder: isFolder(d),
      children: (children.get(d.id) ?? [])
        .filter((c) => !built.has(c.id))
        .sort(compareNodes)
        .map(build),
    };
  };

  return roots.sort(compareNodes).map(build);
}

/** 摊平成可见行。`collapsed` 里的节点不展开其子树。 */
export function flatten(
  nodes: KbTreeNode[],
  collapsed: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (list: KbTreeNode[], depth: number): void => {
    for (const n of list) {
      out.push({ doc: n.doc, depth, isFolder: n.isFolder, hasChildren: n.children.length > 0 });
      if (!collapsed.has(n.doc.id)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** 祖先链，从最近的父开始。搜索跳转时用它展开路径。成环时原地停下。 */
export function ancestorIds(docs: KbDocumentSummary[], id: string): string[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const start = byId.get(id);
  if (!start) return [];

  const chain: string[] = [];
  const visited = new Set<string>([id]);
  let cur = start.parentId === null ? undefined : byId.get(start.parentId);
  while (cur && !visited.has(cur.id)) {
    chain.push(cur.id);
    visited.add(cur.id);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return chain;
}

/** 每篇文档的层级（顶层 0）。由树派生——层级与排序必须来自同一棵树。 */
export function depthOf(docs: KbDocumentSummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of flatten(buildTree(docs), new Set())) out[row.doc.id] = row.depth;
  return out;
}

/**
 * `rootId` 及其全部子孙的数量（**含根自己**——与删除接口回执的 `deletedCount` 同口径）。
 * `rootId` 不在列表里 → 0：列表是当前空间的可读视图，可能已不含它。
 *
 * 走树而不是走 parentId 的邻接表：成环时 `buildTree` 已经把环拆开了（环上至少有
 * 一个节点被提为根），这里就只需要数自己这一支，不会再撞上环。
 */
export function subtreeSize(docs: KbDocumentSummary[], rootId: string): number {
  const find = (nodes: KbTreeNode[]): KbTreeNode | undefined => {
    for (const n of nodes) {
      if (n.doc.id === rootId) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const root = find(buildTree(docs));
  if (!root) return 0;

  const count = (n: KbTreeNode): number =>
    1 + n.children.reduce((sum, c) => sum + count(c), 0);
  return count(root);
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm vitest run src/components/KnowledgeBase/docTree.test.ts`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/components/KnowledgeBase/docTree.ts src/components/KnowledgeBase/docTree.test.ts
git commit -m "refactor(kb): docTree 从「算缩进」升级为真正的树

buildTree / flatten / ancestorIds 三个纯函数，加两条不变量：孤儿提升到根
（父不可读的子节点不能消失）、成环保护（数据畸形不能挂住 UI）。
depthOf 不再封顶 3 层，subtreeSize 改走树。"
```

---

### Task 8: HTML 原型（**用户点头才进 Task 9**）

**Files:**
- Create: `docs/prototypes/2026-09-18-kb-tree.html`

**Interfaces:**
- Consumes: 无（单文件，自己带假数据）
- Produces: 界面形态的确认——Task 9 的 markup 与 class 名从这里抄

**这是本计划唯一的评审门。** 原型不通过就不要开始 Task 9。

- [ ] **Step 1: 调用 frontend-design 技能**

**先读 `frontend-design` 技能再动手**（用户点名要求）。原型的要求：

- **单文件 HTML**，无构建、无外部依赖（`docs/prototypes/` 里现有的文件都是这个形态）
- 用假数据造出 3 层结构，含空文件夹、名字很长的节点、名称含中文与英文混排的节点
- 必须能看出这几个状态：**文件夹展开 / 折叠 / 文档 / 空文件夹**、悬停时浮出的 `+` 与 `⋯`、`⋯` 打开后的菜单、内联重命名输入框、移动到…的选择器
- 颜色走现有主题的语义 token（把 `src/themes/` 里 glass 主题的 `--aide-*` 变量值抄进原型的 `:root`），**不要自己发明配色**
- 侧栏宽度与现有 `KnowledgeBase.vue` 的 `.kb-side` 一致（220px），这样评审时能看出真实比例

- [ ] **Step 2: 自验渲染**

用 headless Edge 截图自验（内存备忘：headless Edge 截图可自验 CSS 效果）：

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless --disable-gpu \
  --screenshot=docs/prototypes/2026-09-18-kb-tree.png --window-size=900,700 \
  "file:///C:/Users/<user>/IdeaProjects/aide/docs/prototypes/2026-09-18-kb-tree.html"
```

- [ ] **Step 3: 交给用户看，等明确点头**

把文件路径给用户，说明这一版要确认的是：**层级缩进量、文件夹与文档的图标区分、悬停图标的出现位置、`⋯` 菜单的措辞**。

**收到肯定的答复之前不要开始 Task 9。** 收到修改意见就改原型、再给用户看，循环到点头为止。

- [ ] **Step 4: Commit（用户点头之后）**

```bash
git add docs/prototypes/2026-09-18-kb-tree.html
git commit -m "docs(kb): 目录树界面原型（已确认）"
```

---

### Task 8.5: 空间重命名接口 + 空间段改造

**来源**：原型评审时用户指出——「创建空间」埋在成员页里，明显不合理；空间行也该有
`+` 与 `⋯`。评审只勾了**重命名**一项，**不做**删除空间、改可见性、成员入口捷径。

**Files:**
- Modify: `knowledge-server/src/api/spaces.rs`（加 `PatchSpaceBody` / `patch`）
- Modify: `knowledge-server/src/api/mod.rs:130`（路由加 `.patch`）
- Create: `src/components/KnowledgeBase/KbSpaceList.vue`
- Create: `src/components/KnowledgeBase/KbSpaceList.test.ts`
- Modify: `src/components/KnowledgeBase/KnowledgeBase.vue`（空间分组换成 `KbSpaceList`）
- Modify: `src/components/KnowledgeBase/KbMembers.vue`（**删掉**「创建空间」整块）
- Modify: `src/components/KnowledgeBase/kbClient.ts`（加 `patchSpace`）
- Modify: `src/composables/useKnowledgeBase.ts`（加 `renameSpace`）

**Interfaces:**
- Consumes: `SpaceView`（`spaces.rs`）、`kb.listSpaces` / `kb.createSpace`
- Produces:
  - `PATCH /api/spaces/{id}`，body `{ name: string }`，返回 `SpaceView`
  - `kb.patchSpace(id, { name })`
  - `useKnowledgeBase().renameSpace(id, name) => Promise<boolean>`
  - `KbSpaceList.vue` props `{ spaces, activeId, busy }`，emits `select: [id]`、`create: [key, name, visibility]`、`rename: [id, name]`

- [ ] **Step 1: 后端 `PATCH /api/spaces/{id}`**

`knowledge-server/src/api/spaces.rs` 末尾加：

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSpaceBody {
    pub name: String,
}

/// 改空间元数据。**只开放 name**：`key` 是对外标识（邀请链接、将来的 URL 都用它），
/// 改了会断链；`visibility` 的改动面比它看起来大（改 public = 全实例可读，
/// 改 private = 非成员立刻看不见），都不适合顺手放在一个重命名入口里。
pub async fn patch(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(space_id): Path<Uuid>,
    Json(body): Json<PatchSpaceBody>,
) -> AppResult<Json<SpaceView>> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("空间名称不能为空".into()));
    }

    let mut tx = state.db.begin().await?;

    // 判**空间内**的角色，不是全局管理员——空间是权限边界，
    // 改它的名字该由这个空间的管理者决定，而不是任何一个 is_admin
    let role = permission::space_role(&mut *tx, user.id, space_id).await?;
    let allowed = role
        .map(|r| matches!(r, Role::Owner | Role::Admin))
        .unwrap_or(false);
    if !allowed {
        return Err(AppError::Forbidden);
    }

    let updated: Option<(String, String, Option<String>, String)> = sqlx::query_as(
        r#"UPDATE spaces SET name = $2, updated_at = now()
            WHERE id = $1
        RETURNING key, name, description, visibility"#,
    )
    .bind(space_id)
    .bind(name)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((key, name, description, visibility)) = updated else {
        return Err(AppError::NotFound("空间不存在".into()));
    };

    tx.commit().await?;

    Ok(Json(SpaceView {
        id: space_id,
        key,
        name,
        description,
        visibility,
        role: Some(role.expect("上面已确认调用者有角色")),
    }))
}
```

顶部的 `use` 补 `Role`：

```rust
use crate::types::{CurrentUser, DocumentKind, Role, Visibility};
```

路由（`api/mod.rs:130`）：

```rust
        .route("/api/spaces", get(spaces::list).post(spaces::create))
        .route(
            "/api/spaces/{id}",
            axum::routing::patch(spaces::patch),
        )
        .route("/api/spaces/{id}/documents", get(spaces::documents))
```

- [ ] **Step 2: 编译 + 手工验证**

Run: `cd knowledge-server && cargo build --bin aide-knowledge`
Expected: 编译通过

按「验证环境」起栈后：

```bash
# owner 改自己空间的名 → 200，key 不变
# 非成员改别人的空间 → 403
# 空名字 / 全空白 → 400
```

**三条都要亲手试**——尤其第二条，它是「空间是权限边界」这句话的唯一兑现点。

- [ ] **Step 3: 写前端测试（先失败）**

`src/components/KnowledgeBase/KbSpaceList.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbSpaceList from "./KbSpaceList.vue";
import type { KbSpace } from "./kbClient";

enableAutoUnmount(afterEach);

const SPACES: KbSpace[] = [
  { id: "s1", key: "eng", name: "工程手册", description: null, visibility: "internal", role: "owner" },
  { id: "s2", key: "prod", name: "产品档案", description: null, visibility: "private", role: "editor" },
];

function mountList() {
  return mount(KbSpaceList, {
    props: { spaces: SPACES, activeId: "s1", busy: false },
    global: { stubs: { Icon: true } },
  });
}

describe("KbSpaceList", () => {
  it("每行显示名称与角色", () => {
    const w = mountList();
    expect(w.text()).toContain("工程手册");
    expect(w.text()).toContain("owner");
    expect(w.text()).toContain("editor");
  });

  it("⋯ 只给一个「重命名」（评审只勾了这一项）", async () => {
    const w = mountList();
    await w.find("[data-space='s1'] [data-kb-more]").trigger("click");
    const items = w.findAll("[data-kb-menu] button").map((b) => b.text());
    expect(items).toEqual(["重命名"]);
  });

  it("重命名 Enter 提交并发 rename，key 不参与", async () => {
    const w = mountList();
    await w.find("[data-space='s1'] [data-kb-more]").trigger("click");
    await w.find("[data-kb-menu] button").trigger("click");
    await w.find("[data-space-rename]").setValue("工程手册（新）");
    await w.find("[data-space-rename]").trigger("keydown.enter");
    expect(w.emitted("rename")?.[0]).toEqual(["s1", "工程手册（新）"]);
  });

  it("＋ 开浮层，填标识与名称后发 create", async () => {
    const w = mountList();
    await w.find("[data-space-add]").trigger("click");
    const inputs = w.findAll("[data-space-form] input");
    await inputs[0]!.setValue("eng2");
    await inputs[1]!.setValue("工程手册二");
    await w.find("[data-space-form] .btn.primary").trigger("click");
    expect(w.emitted("create")?.[0]).toEqual(["eng2", "工程手册二", "internal"]);
  });

  it("标识不合法时创建按钮禁用（少一次无谓往返）", async () => {
    const w = mountList();
    await w.find("[data-space-add]").trigger("click");
    const inputs = w.findAll("[data-space-form] input");
    await inputs[0]!.setValue("Bad Key!");
    await inputs[1]!.setValue("名字");
    expect(w.find("[data-space-form] .btn.primary").attributes("disabled")).toBeDefined();
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm vitest run src/components/KnowledgeBase/KbSpaceList.test.ts`
Expected: FAIL —— 组件文件不存在

- [ ] **Step 5: 写 `KbSpaceList.vue`**

按 Task 8 原型里「空间段」那张卡实现。要点（原型里逐条确认过的）：

- 行语法与文档树一致：名字占满、副信息在右、`⋯` 悬停浮出
- **角色常驻**（不操作时也要知道自己在各空间里的身份）；悬停/菜单打开时让位给 `⋯`。
  ⚠️ `.menu-open` 必须与 `:hover` 同规则——菜单打开后鼠标会移到菜单上，行本身不再是
  `:hover`，角色会冒出来和 `⋯` 叠住
- `+` 开小浮层（220px 塞不下三个字段）：标识 / 名称 / 可见性 + 取消/创建
- 标识的前端校验与后端 `validate_key` 同规则（2~40 位，小写字母/数字/连字符）——
  **客户端的校验只为省一次往返，服务端仍是唯一权威**，不一致时以服务端的 400 为准

- [ ] **Step 6: 接进主区并拆掉成员页那块**

`KnowledgeBase.vue`：空间分组换成

```vue
          <div class="kb-sidesec">
            <div class="kb-sec-title">
              <span>空间</span>
              <button class="kb-iconbtn" v-tooltip="'新建空间'" @click="spaceRef?.startCreate()">
                <Icon name="plus" :size="11" />
              </button>
            </div>
            <KbSpaceList
              ref="spaceRef"
              :spaces="k.spaces.value"
              :active-id="k.activeSpaceId.value"
              :busy="k.loading.value"
              @select="(id) => void k.selectSpace(id)"
              @create="(key, name, vis) => void k.createSpace({ key, name, visibility: vis })"
              @rename="(id, name) => void k.renameSpace(id, name)"
            />
          </div>
```

`useKnowledgeBase.ts` 加：

```ts
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
```

`kbClient.ts` 门面加：

```ts
  patchSpace(id: string, input: { name: string }): Promise<KbSpace> {
    return request("PATCH", `/api/spaces/${id}`, input);
  },
```

`KbMembers.vue`：**删掉整个「创建空间」section**（`<section class="kb-block">` 里那个
`<h3>创建空间</h3>` 到它的 `</section>`），连同 `spaceKey` / `spaceName` /
`spaceVisibility` / `canCreateSpace` / `onCreateSpace` / `lastCreatedSpace` 的 watch，
以及 `createSpace` 这个 emit。相应地 `KnowledgeBase.vue` 里传给 `KbMembers` 的
`@create-space` 与 `:last-created-space` 也要删。

⚠️ `lastCreatedSpace` 在 `useKnowledgeBase` 里还有别的消费者吗？删之前
`grep -rn "lastCreatedSpace" src/` 确认；没有就一并删掉，**不留死代码**。

- [ ] **Step 7: 跑测试 + 手动走一遍**

Run: `pnpm test`
Expected: 全绿（`KbMembers` 若有测试会因删块而红——那正是要更新的地方）

tauri dev 里：`+` 建空间、`⋯` 改名、成员页里**看不到**创建空间那块、非管理员/非空间成员改名被拒。

- [ ] **Step 8: Commit**

```bash
git add knowledge-server/src/api/spaces.rs knowledge-server/src/api/mod.rs \
        src/components/KnowledgeBase/ src/composables/useKnowledgeBase.ts
git commit -m "feat(kb): 空间重命名接口 + 空间段搬进侧栏

创建空间原本埋在成员页里，与「空间」这个一级概念不匹配。现在空间分组标题旁
有 +（小浮层：标识/名称/可见性），每行悬停浮出 ⋯ → 重命名。

后端 PATCH /api/spaces/{id} **只开放 name**：key 是对外标识改了会断链，
visibility 的改动面比它看起来大，都不适合顺手搭在重命名上。权限判空间内的
owner/admin，不是全局管理员——空间是权限边界。"
```

---

### Task 9: 前端目录树

**Files:**
- Modify: `src/utils/icons.ts`（加 `plus` / `more` / `caret` 三个字形）
- Create: `src/components/KnowledgeBase/KbTree.vue`
- Create: `src/components/KnowledgeBase/KbTree.test.ts`
- Modify: `src/components/KnowledgeBase/KnowledgeBase.vue:212-225`（文档分组换成 `KbTree`）
- Modify: `src/components/KnowledgeBase/kbClient.ts`（`KbDocumentSummary` 加 `kind`，加 `patchDocument`）
- Modify: `src/composables/useKnowledgeBase.ts`（加 `createNode` / `createFolder` / `patchNode` / 展开状态）

**Interfaces:**
- Consumes: `buildTree` / `flatten` / `ancestorIds` / `subtreeSize`（Task 7）、REST 的 `kind` 与 `PATCH`（Task 3、4）、原型的 markup（Task 8）
- Produces:
  - `KbTree.vue` props `{ documents: KbDocumentSummary[]; activeId: string | null; spaceId: string | null; busy: boolean }`，emits `open: [id]`、`created: []`、`changed: []`
  - `useKnowledgeBase` 新增 `createFolder(name, parentId)`、`createNode(title, parentId)`、`patchNode(id, {title?, parentId?})`、`expandedFor(spaceId)`、`toggleExpanded(spaceId, id)`、`revealNode(id)`

- [ ] **Step 1: 加三个字形**

`src/utils/icons.ts` 的 `GLYPHS` 里，在 `folder` 那一行旁边加：

```ts
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  more: '<circle cx="4" cy="8" r="0.9" class="f"/><circle cx="8" cy="8" r="0.9" class="f"/><circle cx="12" cy="8" r="0.9" class="f"/>',
  // 折叠箭头。默认朝右（折叠态），展开时用 CSS 转 90° 指向下——
  // 一个字形两种状态，省掉两个几乎一样的路径
  caret: '<path d="M6.5 4L10.5 8L6.5 12"/>',
```

- [ ] **Step 2: `kbClient.ts` 加 `kind` 与 `patchDocument`**

`KbDocumentSummary` 加：

```ts
  /** "doc" | "folder"。老服务端不带这个字段，消费方按 doc 兜底。 */
  kind?: "doc" | "folder";
```

`KbDocument` 继承它，天然带上。

`createDocument` 的入参加 `kind`（现有的 `createSpace`、`listDocuments` 不动）：

```ts
  createDocument(input: {
    spaceId: string;
    parentId?: string | null;
    title: string;
    content?: string;
    /** 缺省 = 普通文档 */
    kind?: "doc" | "folder";
  }): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("POST", "/api/documents", input);
  },
```

门面里 `deleteDocument` 之后加：

```ts
  /** 改节点元数据：重命名、移动。**不产生版本**（标题上移之后改名是节点元数据）。 */
  patchDocument(
    id: string,
    input: { title?: string; parentId?: string | null },
  ): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("PATCH", `/api/documents/${id}`, input);
  },
```

- [ ] **Step 3: `useKnowledgeBase` 加写操作与展开状态**

在 `createSpace` 之后加：

```ts
  /** 建文件夹。成功后刷新列表；返回新节点 id（失败返回 null）。 */
  async function createFolder(name: string, parentId: string | null): Promise<string | null> {
    return createNode(name, parentId, "folder");
  }

  /** 建文档。文件夹与文档走同一条载荷，只有 kind 不同。 */
  async function createDocument(title: string, parentId: string | null): Promise<string | null> {
    return createNode(title, parentId, "doc");
  }

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

  /** 重命名 / 移动。成功后刷新列表与当前正文（标题可能变了）。 */
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
    // 改的正是当前打开的这篇 → 正文区顶部显示的标题要跟着变
    if (input.title !== undefined && activeDoc.value?.id === id) await openDocument(id);
    return true;
  }
```

展开状态（放在 `search` 之前）：

```ts
  // ── 展开 / 折叠 ──
  //
  // 按空间记在 localStorage：值是被**折叠**的节点 id（存折叠集合而不是展开集合，
  // 因为默认是全展开——新节点自动可见，不需要在每次加载后补写状态）。
  const expandedSeq = ref(0); // 只是为了让 computed 依赖变化；真正的数据在下面这个 Map

  function storageKey(spaceId: string): string {
    return `aide.kb.collapsed.${spaceId}`;
  }

  function collapsedFor(spaceId: string | null): Set<string> {
    if (!spaceId) return new Set();
    try {
      const raw = localStorage.getItem(storageKey(spaceId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
    } catch {
      // 存的东西坏了就当没折叠过——读状态失败不能拦住整个面板
      return new Set();
    }
  }

  function toggleCollapsed(spaceId: string | null, id: string): void {
    if (!spaceId) return;
    const next = collapsedFor(spaceId);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(storageKey(spaceId), JSON.stringify([...next]));
    } catch {
      // 存储写不进去（配额 / 隐私模式）只影响「记住折叠状态」，不该打断交互
    }
    expandedSeq.value++;
  }

  /** 展开某节点的整条祖先链（搜索跳转用）。 */
  function revealNode(id: string): void {
    const spaceId = activeSpaceId.value;
    if (!spaceId) return;
    const next = collapsedFor(spaceId);
    let changed = false;
    for (const ancestor of ancestorIds(documents.value, id)) {
      if (next.delete(ancestor)) changed = true;
    }
    if (!changed) return;
    try {
      localStorage.setItem(storageKey(spaceId), JSON.stringify([...next]));
    } catch {
      // 同上
    }
    expandedSeq.value++;
  }
```

顶部 import 补 `ancestorIds`：`import { ancestorIds } from "@/components/KnowledgeBase/docTree";`

`return` 对象里补上新导出：`createNode, createFolder, createDocument, patchNode, collapsedFor, toggleCollapsed, revealNode, expandedSeq`。

（`createFolder` / `createDocument` 是 `createNode` 的两个薄包装，语义上更直白；`KnowledgeBase.vue` 用的是 `createNode`——因为「建文件夹还是建文档」在那边是运行时的 `kind` 变量。）

`logout()` 里**不要**清 localStorage 的折叠状态——它是按 spaceId 存的，换个人登录看到的还是同一批空间的折叠偏好，无害。

- [ ] **Step 4: 写组件测试（先失败）**

`src/components/KnowledgeBase/KbTree.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { enableAutoUnmount } from "@vue/test-utils";
import KbTree from "./KbTree.vue";
import type { KbDocumentSummary } from "./kbClient";

// 内存备忘：window-listener / 全局监听的组件测试必须 enableAutoUnmount，
// 否则残留监听器会吞掉后续按键，症状难查
enableAutoUnmount(afterEach);

function node(id: string, parentId: string | null, kind: "doc" | "folder"): KbDocumentSummary {
  return { id, parentId, kind, slug: id, title: id, versionNo: kind === "folder" ? 0 : 1, status: "draft", updatedAt: "" };
}

const DOCS = [node("f", null, "folder"), node("a", "f", "doc"), node("g", "f", "folder")];

function mountTree(over: Partial<{ activeId: string | null; collapsed: Set<string> }> = {}) {
  return mount(KbTree, {
    props: {
      documents: DOCS,
      activeId: null,
      spaceId: "s1",
      busy: false,
      collapsed: new Set<string>(),
      ...over,
    },
    global: { stubs: { Icon: true } },
  });
}

describe("KbTree", () => {
  it("默认全展开：文件夹下的子节点都渲染", () => {
    const w = mountTree();
    expect(w.findAll("[data-kb-node]").length).toBe(3);
  });

  // 组件是**受控**的：折叠状态由父层持有（它才读写 localStorage），所以
  // 「点击发事件」与「收到折叠集合后不渲染子树」要分两条断言测，
  // 不能指望一次 trigger 就让 children 消失。
  it("点文件夹的折叠箭头 → 发出 toggle", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-caret]").trigger("click");
    expect(w.emitted("toggle")?.[0]).toEqual(["f"]);
  });

  it("collapsed 里有的文件夹 → 子树不渲染，文件夹自己还在", () => {
    const w = mountTree({ collapsed: new Set(["f"]) });
    expect(w.findAll("[data-kb-node]").map((n) => n.attributes("data-kb-node"))).toEqual(["f"]);
  });

  it("点文档发 open，点文件夹不发", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='a'] [data-kb-label]").trigger("click");
    expect(w.emitted("open")?.[0]).toEqual(["a"]);

    await w.find("[data-kb-node='g'] [data-kb-label]").trigger("click");
    expect(w.emitted("open")).toHaveLength(1);
  });

  it("+ 只出现在文件夹行", () => {
    const w = mountTree();
    expect(w.find("[data-kb-node='f'] [data-kb-add]").exists()).toBe(true);
    expect(w.find("[data-kb-node='a'] [data-kb-add]").exists()).toBe(false);
  });

  it("文件夹的 ⋯ 菜单四项：新建子文件夹 / 重命名 / 移动到… / 删除", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    const items = w.findAll("[data-kb-menu] button").map((b) => b.text());
    expect(items).toEqual(["新建子文件夹", "重命名", "移动到…", "删除"]);
  });

  it("文档的 ⋯ 菜单没有「新建子文件夹」（文档是叶子）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='a'] [data-kb-more]").trigger("click");
    const items = w.findAll("[data-kb-menu] button").map((b) => b.text());
    expect(items).toEqual(["重命名", "移动到…", "删除"]);
  });

  it("重命名走内联输入：Enter 提交并发 patch", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    await w.findAll("[data-kb-menu] button")[1].trigger("click");
    const input = w.find("[data-kb-rename]");
    await input.setValue("新名字");
    await input.trigger("keydown.enter");
    expect(w.emitted("patch")?.[0]).toEqual(["f", { title: "新名字" }]);
  });

  it("重命名 Esc 取消，不发 patch", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    await w.findAll("[data-kb-menu] button")[1].trigger("click");
    await w.find("[data-kb-rename]").trigger("keydown.esc");
    expect(w.emitted("patch")).toBeFalsy();
    expect(w.find("[data-kb-rename]").exists()).toBe(false);
  });

  it("空文件夹行下带一句空态提示，非空文件夹没有", () => {
    const w = mountTree();
    // DOCS 里 g 是空文件夹，f 不是
    expect(w.find("[data-kb-node='g'] [data-kb-empty]").exists()).toBe(true);
    expect(w.find("[data-kb-node='f'] [data-kb-empty]").exists()).toBe(false);
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm vitest run src/components/KnowledgeBase/KbTree.test.ts`
Expected: FAIL —— 组件文件不存在

- [ ] **Step 6: 写 `KbTree.vue`**

按 Task 8 原型确认下来的 markup 与 class 名来写。**脚本部分**：

```vue
<script setup lang="ts">
// 目录树。单层 v-for 渲染 flatten() 的结果——不递归组件：扁平行的缩进更自然，
// 深层树下也不会有意料之外的更新开销。
//
// 树的算法全在 ./docTree（唯一产地）。本组件只负责渲染与交互，不自己算层级。
import { computed, ref } from "vue";
import Icon from "@/components/Icon.vue";
import { buildTree, flatten, type KbTreeNode } from "./docTree";
import type { KbDocumentSummary } from "./kbClient";

const props = defineProps<{
  documents: KbDocumentSummary[];
  activeId: string | null;
  spaceId: string | null;
  /** 被折叠的节点 id。由父层持有（它才读写 localStorage），本组件只读。 */
  collapsed: ReadonlySet<string>;
  busy: boolean;
}>();

const emit = defineEmits<{
  open: [id: string];
  toggle: [id: string];
  /** 新建：父文件夹 id（null = 根）、类型、标题（标题在内联输入里收集，一起交出去） */
  create: [parentId: string | null, kind: "doc" | "folder", title: string];
  patch: [id: string, input: { title?: string; parentId?: string | null }];
  remove: [id: string];
}>();

/** 树容器。只用于 scrollToNode 里查 DOM。 */
const root = ref<HTMLElement | null>(null);

const tree = computed<KbTreeNode[]>(() => buildTree(props.documents));
const rows = computed(() => flatten(tree.value, props.collapsed));

/** 当前打开菜单的节点 id；null = 没有菜单 */
const menuFor = ref<string | null>(null);
/** 正在重命名的节点 id 与草稿 */
const renaming = ref<string | null>(null);
const renameDraft = ref("");
/** 正在新建的位置：{ parentId, kind } */
const creating = ref<{ parentId: string | null; kind: "doc" | "folder" } | null>(null);
const createDraft = ref("");
/** 正在选移动目标 */
const movingFor = ref<string | null>(null);

/** 所有文件夹，供「移动到…」选择器用。排除自身与自身子树由调用方（父层）负责过滤。 */
const folders = computed(() => {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: KbTreeNode[], depth: number): void => {
    for (const n of nodes) {
      if (n.isFolder) out.push({ id: n.doc.id, label: `${"　".repeat(depth)}${n.doc.title}` });
      walk(n.children, depth + 1);
    }
  };
  walk(tree.value, 0);
  return out;
});

function onLabelClick(row: { doc: KbDocumentSummary; isFolder: boolean; hasChildren: boolean }): void {
  menuFor.value = null;
  if (row.isFolder) emit("toggle", row.doc.id);
  else emit("open", row.doc.id);
}

function startRename(id: string, title: string): void {
  menuFor.value = null;
  renaming.value = id;
  renameDraft.value = title;
}

function commitRename(): void {
  const id = renaming.value;
  if (!id) return;
  const title = renameDraft.value.trim();
  // 空名字直接取消：服务端也会拒，但没必要为此跑一趟
  if (title) emit("patch", id, { title });
  renaming.value = null;
}

function startCreate(parentId: string | null, kind: "doc" | "folder"): void {
  menuFor.value = null;
  creating.value = { parentId, kind };
  createDraft.value = "";
}

function commitCreate(): void {
  const at = creating.value;
  if (!at) return;
  const title = createDraft.value.trim();
  if (title) emit("create", at.parentId, at.kind, title);
  creating.value = null;
}

/** 新建行的缩进：跟它要落进去的那一层对齐（目标父的深度 + 1）。 */
const creatingDepth = computed(() => {
  const at = creating.value;
  if (!at?.parentId) return 0;
  const parent = rows.value.find((r) => r.doc.id === at.parentId);
  return parent ? parent.depth + 1 : 0;
});

/** 搜索跳转用：把某一行滚进视野。`CSS.escape` 防 id 里的特殊字符破坏选择器。 */
function scrollToNode(id: string): void {
  root.value
    ?.querySelector(`[data-kb-node="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

// 根入口（分组标题旁那个 +）与搜索跳转都由父层调用
defineExpose({ startCreate, scrollToNode });
</script>
```

**模板**（结构固定，class 名按原型的产出填）：

```vue
<template>
  <div ref="root" class="kb-tree">
    <div
      v-for="row in rows"
      :key="row.doc.id"
      class="kb-row"
      :class="{ on: row.doc.id === activeId, folder: row.isFolder }"
      :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
      :data-kb-node="row.doc.id"
    >
      <button
        v-if="row.isFolder && row.hasChildren"
        data-kb-caret
        class="kb-caret"
        :class="{ open: !collapsed.has(row.doc.id) }"
        v-tooltip="collapsed.has(row.doc.id) ? '展开' : '折叠'"
        @click.stop="emit('toggle', row.doc.id)"
      >
        <Icon name="caret" :size="11" />
      </button>
      <span v-else class="kb-caret-spacer" />

      <Icon :name="row.isFolder ? 'folder' : 'file'" :size="12" />

      <!-- 重命名中：就地换成输入框，不弹窗 -->
      <input
        v-if="renaming === row.doc.id"
        data-kb-rename
        ref="renameInput"
        v-model="renameDraft"
        class="kb-inline-input"
        @keydown.enter="commitRename"
        @keydown.esc="renaming = null"
        @blur="commitRename"
        v-focus
      />
      <span v-else data-kb-label class="kb-label" @click="onLabelClick(row)">
        {{ row.doc.title }}
      </span>

      <!-- 空文件夹：词标而不是另起一行——另起一行会跟着缩进，看着像它的孩子 -->
      <span v-if="row.isFolder && !row.hasChildren" data-kb-empty class="kb-empty-mark">空</span>

      <span class="kb-row-actions">
        <button
          v-if="row.isFolder"
          data-kb-add
          class="kb-rowbtn"
          v-tooltip="'在这个文件夹里新建文档'"
          @click.stop="startCreate(row.doc.id, 'doc')"
        >
          <Icon name="plus" :size="11" />
        </button>
        <button data-kb-more class="kb-rowbtn" @click.stop="menuFor = menuFor === row.doc.id ? null : row.doc.id">
          <Icon name="more" :size="11" />
        </button>
      </span>

      <div v-if="menuFor === row.doc.id" data-kb-menu class="kb-menu">
        <!-- 文档是叶子，没有「在文档下新建」这回事 -->
        <button v-if="row.isFolder" @click="startCreate(row.doc.id, 'folder')">新建子文件夹</button>
        <button @click="startRename(row.doc.id, row.doc.title)">重命名</button>
        <button @click="movingFor = row.doc.id; menuFor = null">移动到…</button>
        <button class="danger" @click="menuFor = null; emit('remove', row.doc.id)">删除</button>
      </div>
    </div>

    <!-- 新建中的内联输入行，缩进跟它要落进去的那一层对齐 -->
    <div v-if="creating" class="kb-row" :style="{ paddingLeft: `${6 + creatingDepth * 14}px` }">
      <span class="kb-caret-spacer" />
      <Icon :name="creating.kind === 'folder' ? 'folder' : 'file'" :size="12" />
      <input
        data-kb-new
        v-model="createDraft"
        class="kb-inline-input"
        :placeholder="creating.kind === 'folder' ? '文件夹名' : '文档标题'"
        @keydown.enter="commitCreate"
        @keydown.esc="creating = null"
        @blur="commitCreate"
        v-focus
      />
    </div>

    <!-- 移动到…：列出现有文件夹（第一项是根）。自身与自身子树由父层过滤后传进来 -->
    <div v-if="movingFor" data-kb-move class="kb-move">
      <p>移动到…</p>
      <button @click="emit('patch', movingFor!, { parentId: null }); movingFor = null">根目录</button>
      <button
        v-for="f in folders"
        :key="f.id"
        @click="emit('patch', movingFor!, { parentId: f.id }); movingFor = null"
      >
        {{ f.label }}
      </button>
    </div>
  </div>
</template>
```

**三处必须补进 `<script>` 的实现细节**（模板里引用了，别漏）：

1. `v-focus` 自定义指令（输入框挂载即聚焦）。`<script setup>` 里局部的自定义指令必须以 `v` 开头命名：

```ts
const vFocus = {
  mounted: (el: HTMLElement) => (el as HTMLInputElement).focus(),
};
```

2. **「移动到…」要排除自身与自身的子树**——目标在自己的子树里会被服务端 400，但不该让用户撞上去才知道。命中项**置灰而不是隐藏**：隐藏会让用户以为列表坏了，置灰能让他明白「这个不能选」。

模板里给选择器的按钮加 `:disabled="selfSubtree.has(f.id)"`：

```ts
/** 自身 + 自身子树：不能作为移动目标。 */
const selfSubtree = computed<Set<string>>(() => {
  const moving = movingFor.value;
  if (!moving) return new Set();
  const out = new Set<string>();
  const collect = (n: KbTreeNode): void => {
    out.add(n.doc.id);
    n.children.forEach(collect);
  };
  const walk = (nodes: KbTreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.doc.id === moving) {
        collect(n);
        return true;
      }
      if (walk(n.children)) return true;
    }
    return false;
  };
  walk(tree.value);
  return out;
});
```

3. **空文件夹的「空」标记**：模板里那句 `data-kb-empty` 用到了 `row.hasChildren`（Task 7 的 `VisibleRow` 已经带了）。样式上它是个弱化的词标，`flex: 0 0 auto` 且不吃 `margin-left: auto`——否则会跟 `kb-row-actions` 的推动布局打架。

- [ ] **Step 7: 跑组件测试**

Run: `pnpm vitest run src/components/KnowledgeBase/KbTree.test.ts`
Expected: 全绿

- [ ] **Step 8: 接进知识库主区**

`src/components/KnowledgeBase/KnowledgeBase.vue`：

- 引入 `KbTree`，把 `:212-225` 的「文档」分组换成：

```vue
          <div class="kb-sidesec grow">
            <div class="kb-sec-title kb-sec-title-row">
              <span>文档</span>
              <button
                class="kb-iconbtn"
                v-tooltip="'在根目录新建文档'"
                :disabled="!k.activeSpaceId.value"
                @click="treeRef?.startCreate(null, 'doc')"
              >
                <Icon name="plus" :size="11" />
              </button>
            </div>
            <KbTree
              v-if="k.documents.value.length"
              ref="treeRef"
              :documents="k.documents.value"
              :active-id="activeDocId"
              :space-id="k.activeSpaceId.value"
              :collapsed="collapsed"
              :busy="k.loading.value"
              @open="(id) => void openDoc(id)"
              @toggle="(id) => k.toggleCollapsed(k.activeSpaceId.value, id)"
              @create="(parentId, kind, title) => void onCreateNode(parentId, kind, title)"
              @patch="(id, input) => void k.patchNode(id, input)"
              @remove="(id) => void onDeleteDoc(id)"
            />
            <p v-else class="kb-none">这个空间还没有文档</p>
          </div>
```

- 脚本里加：

```ts
const treeRef = ref<InstanceType<typeof KbTree> | null>(null);

/** 折叠集由父层持有：只有它知道 localStorage 与当前空间（树组件只读渲染）。 */
const collapsed = computed(() => {
  // expandedSeq 只是触发重算的哨兵，真正的数据在 localStorage 里
  void k.expandedSeq.value;
  return k.collapsedFor(k.activeSpaceId.value);
});

/** 新建节点：标题在内联输入里收集，由树组件随 emit 一起交出来。 */
async function onCreateNode(
  parentId: string | null,
  kind: "doc" | "folder",
  title: string,
): Promise<void> {
  const id = await k.createNode(title, parentId, kind);
  // 新建文档 → 直接打开它（用户建完就是要写）；新建文件夹 → 什么都不做
  if (id && kind === "doc") await openDoc(id);
  // 在折叠着的文件夹里新建 → 把它展开，否则新节点看不见
  if (id && parentId) k.revealNode(parentId);
}
```

- 删除确认的文案（`:96`）改掉「篇」这个量词——它现在要覆盖文件夹：

```ts
  const subs = total > 1 ? `，连同 ${total - 1} 个项目` : "";
  const ok = window.confirm(
    `删除「${title}」${subs}？\n删除后它不再出现在任何列表、检索与正文，且没有恢复入口。`,
  );
```

- `onDeleteDoc` 里 `subtreeSize` 的口径不变（Task 7 已经把它改成走树）。

- 搜索跳转：`KbSearchView` 的 `@open` 处理里，打开文档之后调一次 `k.revealNode(id)`，再 `nextTick` 后 `scrollIntoView`：

```ts
async function openFromSearch(id: string): Promise<void> {
  await openDoc(id);
  k.revealNode(id);
  await nextTick();
  treeRef.value?.scrollToNode(id);
}
```

`KbTree` 用 `defineExpose` 补一个 `scrollToNode(id)`：

```ts
function scrollToNode(id: string): void {
  const el = root.value?.querySelector(`[data-kb-node="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: "nearest" });
}
```

`root` 是 `ref<HTMLElement | null>`，绑在 `.kb-tree` 上。

- [ ] **Step 9: 跑全量前端测试**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 10: 手动走一遍（tauri dev）**

按 `run` 技能或 `pnpm dev` 起应用，打开知识库面板，逐个验证：

1. 建文件夹 → 出现在列表里，点它只折叠不打开正文
2. 文件夹里建文档 → 内联输入 Enter 后文档出现，且自动打开
3. 重命名 → 列表与正文区标题都变，**版本号不变**（打开版本历史确认没多一版）
4. 移动到… → 换位置后树结构正确
5. 删除文件夹 → 确认弹窗说「连同 N 个项目」
6. 折叠一个文件夹 → 关掉面板再打开，折叠状态还在
7. 搜索一篇深层文档 → 点结果，侧栏自动展开并滚到那一行

- [ ] **Step 11: Commit**

```bash
git add src/utils/icons.ts src/components/KnowledgeBase/
git commit -m "feat(kb): 前端目录树——建文件夹/建文档/重命名/移动/删除

单层 v-for 渲染 flatten 的结果（不递归组件），折叠状态按空间记在
localStorage（存折叠集合，默认全展开）。搜索跳转自动展开祖先链并滚到该行。"
```

---

### Task 10: 使用指南补目录树一节

**Files:**
- Modify: `src/components/KnowledgeBase/KbGuide.vue`

**Interfaces:**
- Consumes: 前九步落地的全部能力
- Produces: 用户能在面板里读到的说明

- [ ] **Step 1: 读现有指南的结构**

打开 `src/components/KnowledgeBase/KbGuide.vue`（238 行），找到讲「空间 / 文档」的那一节，照它的小标题层级与语气续写。

- [ ] **Step 2: 补一节「目录树」**

内容要点（**不要写成功能清单**，照现有指南的语气写成「怎么用」）：

- 节点分两种：文件夹（容器）与文档（放正文）。文件夹点一下是展开/折叠，不会打开正文
- 建：文件夹行悬停出 `+`（在里面新建文档）；分组标题旁的 `+` 是在根目录新建
- 改：`⋯` 里有新建子文件夹 / 重命名 / 移动到… / 删除
- 重命名不产生新版本——**改名只是改了它叫什么**，正文的历史不受影响
- 删除文件夹会连它里面的所有东西一起删，且**没有恢复入口**（现有的删除警告段落要同步这句）
- agent 也能建文件夹和搬文档，但它每次都会先问你（写工具都要过确认弹窗）

- [ ] **Step 3: 自验渲染**

Run: `pnpm vitest run src/components/KnowledgeBase/`（确保没碰坏其它测试），然后在 tauri dev 里打开知识库面板 → 侧栏「使用指南」，读一遍新增段落，确认渲染正常（标点、层级、没有裸 markdown）。

- [ ] **Step 4: Commit**

```bash
git add src/components/KnowledgeBase/KbGuide.vue
git commit -m "docs(kb): 使用指南补目录树一节"
```

---

## 收尾验收

全部任务完成后跑一遍：

- [ ] `pnpm test` 全绿
- [ ] `pnpm build` 通过（含 `check:sync-io` 构建期守卫）
- [ ] `cd knowledge-server && cargo build && cargo test --lib` 通过
- [ ] 按「验证环境」起一套干净栈 → `./smoke.sh http://127.0.0.1:18788` 全绿 → 拆栈
- [ ] tauri dev 里手工走 Task 9 Step 10 的七条

对照 spec §11 的风险再确认一遍：

- [ ] **两份 title**：建、存、回滚三条路径都写了 `documents.title`（Task 2 Step 5/6 覆盖）；改名后 `KbHistory` 里历史版本的标题仍是旧的（那是快照，正确）
- [ ] **权限不沿父链继承**：本次没有改变这个语义，但文件夹会让它更容易被误解——如果用户问到「文件夹能不能设权限」，答案是**不能**，权限仍只在空间与单个节点上
- [ ] **存量「文档套文档」**：这类嵌套照常渲染与打开，只是不能再往里加东西；UI 上会显示成「文档图标 + 折叠箭头」
- [ ] **删除文案**：`subtreeSize` 的计数含文件夹本身，确认弹窗用的是「个项目」而不是「篇子文档」
