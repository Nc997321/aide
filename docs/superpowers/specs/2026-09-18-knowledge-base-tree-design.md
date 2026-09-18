# 知识库多层级目录树 — 设计

- 日期：2026-09-18
- 状态：待评审
- 范围：`knowledge-server/`（Rust）+ `agent-sidecar/src/extensions/knowledge*`（MCP）+ `src/components/KnowledgeBase/`、`src/composables/useKnowledgeBase.ts`（Vue）
- 关联：本 spec 同时修一个已实锤的 UI 缺陷（§1.1），它与本次改动在同一批文件里，分开交付会让第一阶段的验证无法收敛

## 1. 背景与问题（全部实锤）

### 1.1 「创建空间」按钮永久置灰

**现象**：库里已有至少一个空间时，打开知识库面板 → 成员页 → 填好标识与名称，「创建」按钮仍是灰的，点了没反应。

**根因**：`src/composables/useKnowledgeBase.ts` 里**一个竞态计数器 `loadSeq` 被两个资源共用**，而 `loadSpaces` 把一个会递增该计数器的调用 await 在自己的 try 块里：

```
loadSpaces()                                    :233
  const seq = ++loadSeq                         :234   loadSeq: 0 → 1
  loading.value = true                          :235
  …await kb.listSpaces()
  if (activeSpaceId.value) await loadDocuments(…)   :244   ← loadDocuments 首行 ++loadSeq → 2
  finally { if (seq === loadSeq) loading.value = false }   :248   1 === 2 不成立 → 复位被跳过
```

`loadDocuments` 的第一行就是 `const seq = ++loadSeq`（:279），于是 `loadSpaces` 自己设的护栏被自己内部调用踩掉，**`finally` 里的 `loading = false` 被静默跳过**，`loading` 从此恒为 `true`。

**触发条件精确对应现象**：`activeSpaceId` 在 `listSpaces` 返回后被设为首个空间（:242），所以只要**该实例可见空间数 ≥ 1**，`:244` 就会被执行。0 个空间时走不到那一行，`loading` 正常复位。

> 这解释了「第一个空间建得出来、第二个建不出来」：建第一个时库里是空的，`activeSpaceId` 为 null；`createSpace`（:260）在成功后 `await loadSpaces()`（:270），此时 `activeSpaceId` 已非空 → 卡死，且此后每次重新打开面板都会重新卡一遍（组件重新挂载 → `useKnowledgeBase()` 新实例 → `init()` → `loadSpaces()` → 再次卡死）。

**连带影响**：同一个 `loading` 还绑在标题栏刷新按钮上（`KnowledgeBase.vue:151` 的 `:disabled="k.loading.value"`），所以面板一打开，**刷新按钮也是死的**。唯一复位路径是重新登录（`login()` 的 finally 无条件复位，:124）。

### 1.2 同一个计数器的第二处隐患

`loadSeq` 还被 `openDocument`（:290）共用。后果：打开一篇文档的响应，会被紧随其后的任何一次列表刷新（`loadDocuments`）丢弃——因为后者递增了同一个计数器。这条路径比 §1.1 难触发（需要用户动作与刷新在途重叠），但它与 §1.1 **同源**，修的时候必须一起处理。

### 1.3 桌面 UI 根本不能新建文档

`kb.createDocument` 定义在 `kbClient.ts:313`，grep 全 `src/` **只有这一行定义、没有任何调用点**。`useKnowledgeBase` 也没有 `createDocument`。桌面端目前只能读、编辑、删——文档一直是 agent 通过 MCP 工具建的。

所以「文件夹」不能单独交付：只给文件夹不给新建文档，用户建完文件夹会发现里面什么都放不进去。

### 1.4 树的骨架已经在了，缺的是三样

容易误判的一点：**`parentId` 的骨架早已存在**——`documents.parent_id` 自引用（`001_init.sql`）、父子同 space 的复合外键（`005_documents_parent_space.sql`）、slug 按父节点唯一的部分索引、软删递归带上整棵子树（`domain/deletion.rs`）、`POST /api/documents` 收 `parentId`（`api/documents.rs:23`）、`ingest` 收 `parent_id`（`api/ingest.rs:26`）、MCP 的 `create_document` 与 `ingest_file` 都有 `parentId` 参数、前端 `docTree.ts` 已经在算层级、侧栏也在做缩进。

真正缺的三样：

1. **没有「文件夹」这个身份。** 每个节点都是文档——带正文、带版本历史、带编辑锁。想建一个纯容器，只能建一篇空文档，而它和真文档在界面上长得一模一样。
2. **前端不是树，是「带缩进的平铺列表」。** `KnowledgeBase.vue:214-223` 是单层 `v-for` 加 `paddingLeft` 缩进：没有展开/折叠，`docTree.ts:9` 的缩进还封顶 3 层，再深的层级在视觉上分辨不出来。
3. **没有「移动」这个操作。** 没有任何 reparent 接口，位置建错了只能删了重建（连带丢掉版本历史）。

### 1.5 侧栏顺序不可靠（前端硬扛的原因）

`api/spaces.rs:189` 的 `ORDER BY d.parent_id NULLS FIRST, r.title` 是按**父节点的 UUID** 排序——UUID 是随机的，所以同一父节点下的子节点不保证相邻，**子节点可能排在父节点前面**。当前是平铺加缩进，于是缩进看起来会莫名其妙。

结论：节点顺序应当由前端的树组装来定，SQL 只需给一个稳定顺序即可（§4.3）。

## 2. 目标与非目标

**目标**

1. 「创建空间」按钮恢复正常（§1.1 修复 + 回归测试钉住）
2. 空间下可以有**任意深度的文件夹**，文档放在文件夹里
3. 桌面端能建文件夹、建文档、重命名、移动、删除
4. agent 能建文件夹、能移动文档（MCP 工具）
5. 现有文档与嵌套**一个不丢**，不迁移数据

**非目标（明确划出，本 spec 不设计、不预留）**

- **拖拽**（移动节点、同级排序）——本版走「⋯ → 移动到…」选择器；拖拽需要自动展开、放置指示线、非法放置反馈，工作量和出错面都大一截
- **右键菜单**——操作全部走悬停图标 + `⋯`
- **手动排序**——同级顺序是派生的（文件夹优先 + 名称），不存 `sort_order`
- **文档内链接的 slug 路由**——slug 当前只承担唯一性约束，不是 URL；本次不动它的语义
- **空间本身嵌套**（空间 → 子空间）——空间仍是权限边界，树的根是空间
- **搜索结果里出现文件夹**——文件夹没有正文，命中它没有意义（§4.4 靠数据模型天然排除，不写过滤条件）
- **向量检索 / 多模态**——维持 `migrations/optional/003_vector.sql` 的「备好不启用」
- **文档级 ACL 的行为变更**——`effective_permission` 本次不引入沿父链的权限继承（§11 风险 2）

## 3. 数据模型

新增迁移 `knowledge-server/migrations/006_documents_tree.sql`（文件名排序在 005 之后，`src/db.rs::migrate` 按文件名顺序应用）。

### 3.1 `kind`：区分文件夹与文档

```sql
ALTER TABLE documents ADD COLUMN kind text NOT NULL DEFAULT 'doc'
  CHECK (kind IN ('doc', 'folder'));
```

默认 `'doc'` 让**存量行自动成为文档**，不需要数据迁移。

### 3.2 `title` 上移到 `documents`

**问题**：标题存在 `revisions` 表里（`revisions.title`），而**文件夹没有版本历史**——没有地方放它的名字。

**方案**：标题上移到节点本身，`revisions.title` 降级为「写那一版时的快照」——它本来就是这个角色，`KbHistory` 展示历史标题用的就是它。

```sql
ALTER TABLE documents ADD COLUMN title text;
UPDATE documents d SET title = r.title FROM revisions r WHERE r.id = d.current_revision_id;
ALTER TABLE documents ALTER COLUMN title SET NOT NULL;
```

**顺带白捡两处简化**：

- **搜索引擎一行都不用改就自动排除文件夹**——`domain/search.rs` 靠 `d.current_revision_id = r.id` join，文件夹没有 revision，天然命中不了。若走「文件夹也有一版空 revision」的方案，文件夹名字会进 `tsv`，就必须补一个 `AND d.kind = 'doc'` 过滤，而过滤条件是可以被后人忘掉的。
- 侧栏列表（`api/spaces.rs::documents`）取标题不再需要 JOIN `revisions`（只剩取 `version_no` 还要）。

**代价（本设计最需要盯的一处）**：`documents.title`（权威）与 `revisions.title`（快照）成了两份。维持一致的责任落在三个写入点：`versioning::create_document`、`versioning::save_revision`、`versioning::revert_to`。三处都在 `domain/versioning.rs` 一个文件里，且**同一事务内**写入，不会出现「事务成功但只改了一半」。

**迁移的失败模式**：若库中存在 `current_revision_id IS NULL` 的行，`UPDATE` 之后该行 `title` 仍是 NULL，`SET NOT NULL` 会**让迁移失败**。这是刻意的——这类行本身已经坏了（`api/documents.rs::get` 用 JOIN 读它，永远 404），静默兜一个 `'未命名'` 只会把问题埋起来。失败时 `migrate()` 会回滚整个事务，服务起不来，运维看到的就是这一条 SQL。

### 3.3 一条放不进数据库的不变量

想约束的语义：**文件夹没有当前版本，文档必须有**。直觉是加 CHECK：

```sql
-- 写不出来的约束，留在这里当证据
CHECK ((kind = 'folder' AND current_revision_id IS NULL)
    OR (kind = 'doc'    AND current_revision_id IS NOT NULL))
```

**这条约束加不上**：`documents.current_revision_id` 与 `revisions.document_id` 互为外键构成循环，`versioning::create_document` 必须三步走（插 documents 留空指针 → 插 revisions → 回填指针），第一步的 `current_revision_id` 必然是 NULL。而 **PostgreSQL 的 CHECK 约束不支持 `DEFERRABLE`**（只有 UNIQUE / PRIMARY KEY / FOREIGN KEY / EXCLUDE 可以），所以没法把它推迟到事务提交时校验。

结论：这条不变量由领域层维持，在 `versioning::create_document` 里用注释写明它为什么不能是数据库约束。写入侧的 `kind` 校验见 §4.2。

### 3.4 不需要改的东西

- **唯一索引** `documents_slug_uidx (space_id, COALESCE(parent_id, …), slug) WHERE deleted_at IS NULL`——同父节点下 slug 唯一，文件夹与文档一视同仁。**副产品：同一层里不允许文件夹和文档重名**，这是想要的行为。
- **父子同 space 的复合外键** `documents_parent_same_space`（005）——对文件夹同样生效。
- **软删递归** `domain/deletion.rs::soft_delete_subtree`——走 `parent_id`，与 `kind` 无关。
- **`documents_parent_id_idx`**——树的按父查询已有索引。

## 4. 后端接口

### 4.1 `POST /api/documents` 增加 `kind`

```rust
pub struct CreateDocumentBody {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub title: String,
    pub content: Option<String>,
    pub kind: Option<DocumentKind>,   // 新增，默认 Doc
}
```

- `kind = folder`：**不建 revision**，`content` 若传了非空值 → 400（不接受静默忽略）
- `kind = doc`：现有路径不变
- 文件夹的 `slug` 复用 `domain::ingest::unique_slug`（与文档同一个生成规则，保证两种入口产出的 slug 一致）

**新增校验**：`parent_id` 必须是 `kind = 'folder'` 的节点（§2 的「文档是叶子」）。当前 `api/documents.rs:96-105` 只做权限判定，不看父节点类型。

### 4.2 新增 `PATCH /api/documents/{id}`

把「重命名」与「移动」收进一个端点——它们都是**节点元数据操作**，不产生版本、不碰正文。

```rust
pub struct PatchDocumentBody {
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<Uuid>>,   // 缺省 = 不动；null = 移到根
}
```

`Option<Option<Uuid>>` 是必需的：要区分「没传这个字段」与「显式传了 null（移到根）」。serde 默认会把两者都折叠成 `None`，所以要一个 `double_option` 反序列化器（`deserialize_with` + `Option::<Uuid>::deserialize`）。

**执行顺序（顺序即正确性）**：

1. **判权**：对节点本身 `require(…, Permission::Write)`
2. **判目标位置的权限**——凡是动了 `parent_id`，就要对**目标父节点**同样判 `Write`；目标是根（`null`）时判节点所在 space 的 `space_role` 是否至少 Write（与 `documents::create` 建根节点时的判据一致，`api/documents.rs:101`）。漏掉这一步的后果是：能把文档搬进一个自己没有写权限的文件夹——这一类漏洞在「只判源节点」的写法里非常容易漏
3. **校验目标父**：必须 `kind = 'folder'` 且 `space_id` 与节点相同（移到根时无目标父，跳过）
4. **成环检测**：从目标父沿 `parent_id` 向上走，命中自身即拒绝
5. **slug 去重**：新父下若撞 slug，用 `unique_slug` 重算（移动时用户不该关心 slug）
6. 落库 `UPDATE documents SET title = COALESCE($2, title), parent_id = …, updated_at = now()`

**成环检测为什么走应用层而不是递归 CTE**：`parent_id` 是用户数据。存量数据里成环**当前不可能**（没有 reparent 接口，新建节点不可能成为自己的祖先），但本端点落地后，一个 bug 就能造出环；而 PostgreSQL 的 `WITH RECURSIVE` 遇到环会**无限循环**（除非额外带 `CYCLE` 子句）。应用层走一遍，带 `visited` 集合与深度上限，环上原地停下。`docTree.ts::subtreeSize` 已有同款防护，两处口径一致。

**重命名不开新版本**——这正是 §3.2 标题上移的意义：改名是节点元数据，不是内容变更。

**文件夹重命名**：同样走这个端点，没有任何特殊分支。

### 4.3 `GET /api/spaces/{id}/documents` 带上 `kind` 与正确的标题

```
DocumentSummary { id, parent_id, kind, slug, title, version_no, status, updated_at }
```

- `title` 改取 `d.title`（§3.2）
- 新增 `kind`
- `version_no` 仍 `LEFT JOIN revisions`（文件夹为 NULL → 0）
- SQL 的 `ORDER BY d.parent_id NULLS FIRST, r.title`（§1.5 的坑）改成 `ORDER BY (d.kind = 'folder') DESC, d.title, d.id`——**与 §6.1 前端排序同一条规则**（文件夹优先，名称升序）。排序的权威仍是前端组装树时定的（SQL 的全表顺序不保证同一父下的子节点相邻），但让两者一致的意义在于：**不会出现「SQL 排了一种、前端排了另一种」的错位**，将来谁少排一次也不会呈现成乱序

### 4.4 写入侧的 `kind` 校验

- `PUT /api/documents/{id}`（`update`）：节点是文件夹 → 400。文件夹没有正文，不接 `update`
- `POST /api/documents/{id}/lock`、`…/lock/heartbeat`、`DELETE …/lock`：节点是文件夹 → 400。文件夹没有编辑器，不该能取到编辑锁
- `search`：**不改**（§3.2）

## 5. MCP 工具（agent 侧）

`agent-sidecar/src/extensions/knowledgeTools.ts`：

| 工具 | 动作 |
|---|---|
| `list_documents` | 输出加 `kind` 标注——模型看不见文件夹就无从指定 `parentId` |
| `create_folder` | **新增**。入参 `{ name, spaceId?, parentId? }`，与 `create_document` 同款 `resolveWriteTarget` 兜底 |
| `move_document` | **新增**。入参 `{ documentId, parentId? }`，省略 `parentId` = 移到根 |

两个新工具都是**写工具**，走现有 `kbWrite` 壳与 `canUseTool` 弹窗（不在 `allowedTools` 白名单里），与 `create_document` / `append_document` 同档。

`create_document` 与 `ingest_file` 的 `parentId` 参数描述改为「父**文件夹** id」。

`format.ts::formatDocumentList` 改为带层级与类型标注的输出——纯函数，单测直接覆盖。

**同步义务**（CLAUDE.md「sidecar 新增逻辑」规则 2）：内置 MCP 工具清单有前端镜像，新增工具必须同步登记 `packages/aide-sdk/src/composables/useCustomizations.ts`。

## 6. 前端

### 6.1 `docTree.ts`：从「算缩进」升级为真正的树

保留「树算法唯一产地」的定位（侧栏与删除确认弹窗共用）。新增：

```
buildTree(docs)        → KbTreeNode[]        组装树，排序，孤儿提升，成环保护
flatten(nodes, collapsed) → VisibleRow[]     折叠的子树不产出 → v-for 单层渲染
ancestorIds(docs, id)  → string[]            搜索跳转时展开祖先链
subtreeSize(docs, id)  → number              保留，改走树
```

**三条必须写进实现的不变量**：

1. **孤儿提升到根**：`parentId` 指向的节点不在列表里（父不可读 / 已删 / 数据异常）→ 该节点作为根渲染。**不能让任何一篇文档消失**——列表是「当前用户可读的视图」，父不可读而子可读是合法状态
2. **成环保护**：任何遍历带 `visited` 集合，环上原地停下
3. **排序：文件夹优先，各自按名称升序**（`localeCompare`，中文按拼音）。同级不存手动顺序（§2 非目标）

### 6.2 新组件 `KbTree.vue`

单层 `v-for` 渲染 `flatten()` 的结果，每行是一个节点。**不递归组件**——递归组件在深层树下会带来意料之外的更新开销，而扁平行的缩进与虚拟化都更自然。

行内元素（从左到右）：

| 位置 | 文件夹 | 文档 |
|---|---|---|
| 折叠箭头 | 有子节点时显示，点击切换 | 无 |
| 图标 | 文件夹图标 | 文件图标 |
| 名称 | 点击 = 展开/折叠 | 点击 = 打开正文 |
| 悬停 `+` | **有**，在该文件夹内新建文档 | **无** |
| 悬停 `⋯` | 有 | 有 |

`⋯` 菜单四项：**新建子文件夹 / 重命名 / 移动到… / 删除**。新建与重命名都是**内联输入行**（不弹窗）：在目标位置插一行 input，Enter 提交、Esc 取消。

`+` 只出现在文件夹行，是刻意的：文档行上出现「新建」会让「新建到哪一层」产生歧义（同级？进去？），而文件夹行的语义是确定的。**根的入口**在「文档」分组标题旁放一个同样的 `+`。

**删除确认**沿用现有实现（`KnowledgeBase.vue:93`）：文案里点明「连同 N 篇子文档」——现在 `subtreeSize` 会把文件夹一起算进去。

**移动到…** 是一个小选择器：列出当前空间的所有文件夹（树形缩进），第一项是「根」。**排除自身与自身的子树**（不可作为目标的项置灰，而不是隐藏——隐藏会让用户以为列表坏了）。

### 6.3 展开状态

按空间记在 `localStorage`（键 `aide.kb.expanded.<spaceId>`），值是被折叠节点的 id 集合。**默认全展开**——小组知识库下「打开就看到全部」比「每次点开」省事得多。

### 6.4 搜索跳转

`KbSearchView` 点一条命中 → 打开该文档的同时，**展开它的祖先链并滚到那一行**（`ancestorIds` + `scrollIntoView`），侧栏给它一个短时高亮。没有这一步，用户在树里找不到自己刚打开的那篇——文档一多就是常态。

### 6.5 空态

- 空间里没有任何节点：「这个空间还是空的」+ 一个新建入口
- 文件夹内为空：「这个文件夹是空的」
- **文件夹不会被打开**——点击文件夹只切换展开，不进入正文区。正文区只可能显示文档

## 7. 存量数据兼容

**不做数据迁移，不改写存量行。** 三条理由与代价：

1. `kind` 的 `DEFAULT 'doc'` 让所有存量行成为文档，这是对的——它们本来就有正文
2. **存量可能有「文档套文档」**（`create_document(parentId=另一篇文档)` 建过的，MCP 工具一直允许）。这类嵌套**照常渲染、照常打开**，只是 UI 不再提供「在文档下新建」的入口
3. 也就是说：**「文档是叶子」是写入约束，不是对历史的追溯**。`buildTree` 不假设节点的子节点类型，渲染层对「文档带着子节点」不做任何特殊处理

**已知代价**：这类存量嵌套在 UI 上会显示成「文档图标 + 折叠箭头」的混合形态——箭头表示它确实有子节点（是真的），但点了不会打开正文而只折叠。**这个不一致会一直存在**，直到用户手动把子节点移出去。这是刻意选择：自动迁移的写法（给嵌套文档补建文件夹、把子节点搬过去）会改变用户的文档结构，且不可逆。

## 8. 修复 `loadSeq`（§1.1）

**计数器按资源拆分**，一个计数器只守一个 ref：

| 计数器 | 守 | 谁递增 |
|---|---|---|
| `spacesSeq` | `spaces` | `loadSpaces` |
| `treeSeq` | `documents` | `loadDocuments` |
| `docSeq` | `activeDoc` | `openDocument`、`selectSpace`、`deleteDocument` |
| `searchSeq` | `searchResult` | `search` |

**`docSeq` 被三个调用点递增，是刻意的**：切换空间（`selectSpace`）与删除当前文档（`deleteDocument`）都必须**作废在途的 `openDocument`**，否则上一空间那篇文档的响应会落进已经切走的视图。这正是「一个计数器守一个 ref」的边界——它不是「每个函数一个计数器」，而是「每个被写入的状态一个」。

`loading` 只被 `loadSpaces` 与 `login` / `setup` / `join` 读写，且**每处都是 `try/finally` 无条件复位**（不再带 `seq` 判断）。`loadSpaces` 内部的 `await loadDocuments()` 保留——它现在是合法的，因为不再共用计数器。

**回归测试**（新增 `src/composables/useKnowledgeBase.test.ts`，mock `@/components/KnowledgeBase/kbClient` 与 `kbRuntime`）：

1. `listSpaces` 返回 ≥1 个空间 → `await init()` 之后 `loading === false`
2. 上一条成立的前提下，`KbMembers` 的 `canCreateSpace` 判据（key 非空 + name 非空 + `!busy`）成立 —— 即**按钮不再是灰的**
3. 在途 `openDocument` 被 `loadDocuments` 抢先后，`openDocument` 的结果**仍然落地**（钉住 §1.2）
4. `selectSpace` 会作废在途 `openDocument`

## 9. 分期与验收

原型与后端互不依赖，可并行；顺序上原型先给你看，避免 Vue 写完才发现交互不是你要的。

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | §8 修 bug + 回归测试 | `pnpm test` 绿；手动：已有空间的情况下按钮可点 |
| 2 | §3 迁移 + §4 接口 | `smoke.sh` 扩展段全绿（见下） |
| 3 | §5 MCP 工具 + 镜像登记 | `knowledgeTools.test.ts` / `format.test.ts` 绿；真机会话里 agent 能建文件夹 |
| 4a | **HTML 原型**（`docs/prototypes/2026-09-18-kb-tree.html`） | **给你看，你点头才进 4b** |
| 4b | §6 前端 | `docTree.test.ts` / `KbTree.test.ts` 绿；手动走一遍建/改名/移动/删/搜索跳转 |
| 5 | 内置《使用指南》（`KbGuide.vue`）补上目录树一节 | 打开指南能读到 |

**`smoke.sh` 扩展段**（在现有「三层子树」段旁边加）：建文件夹 → 文件夹内建文档 → 列表带 `kind` 与正确 `title` → 移动文档到另一文件夹 → **搜索命中里不出现文件夹** → 重命名后旧标题不再出现 → 删文件夹连带子树 → 把文档移进自己的子树被拒 → 在文档下建子节点被拒。

## 10. 测试

| 层 | 位置 | 覆盖 |
|---|---|---|
| 后端单测 | `knowledge-server/src/` 内 `#[cfg(test)]`（现有约定，无 dev-dependencies） | `kind` 解析、`double_option` 反序列化（缺省 / null / 有值 三分支）、成环检测的纯函数部分 |
| 后端端到端 | `knowledge-server/smoke.sh`（需干净库 + docker，见内存备忘「冒烟别对用户实例跑」） | §9 的整段 |
| 前端单测 | `docTree.test.ts` | `buildTree` 排序、孤儿提升、成环、`flatten` 折叠、`ancestorIds`、`subtreeSize` 含文件夹 |
| 前端单测 | `useKnowledgeBase.test.ts`（新） | §8 四条 |
| 前端组件 | `KbTree.test.ts`（新） | 折叠切换、`⋯` 菜单项、内联输入 Enter/Esc、`+` 只在文件夹行出现 |
| MCP | `knowledgeTools.test.ts` / `format.test.ts` | 两个新工具的存在与参数、`kind` 标注输出 |

## 11. 风险与未决

1. **两份 title（§3.2）**——本设计最大的长期债。缓解：三个写入点在同一文件、同一事务；`documents.title` 是唯一被读的，`revisions.title` 只被 `KbHistory` 与被 `tsv` 生成列引用。**若未来出现「标题不同步」的 bug，第一嫌疑就是这里。**

2. **权限仍是单节点判定，不沿父链继承。** `domain/permission.rs::effective_permission` 只看节点自己的 `space_id` + 该节点的 `document_acl`，**不向上走 `parent_id`**（`api/documents.rs:94` 的注释说「有父文档就继承父文档的权限」，但实现只取了父节点自身的权限，没有递归）。本次**不改变**这个语义：文件夹是节点，权限判定与文档完全同构，所以「把文档移进一个更严的文件夹不会收紧它的权限」。这是一个已存在的语义空洞，不属于本次范围，但**因为「文件夹」会让人直觉地以为权限沿目录树继承，这个空洞会变得更容易被误解**，所以记在这里。

3. **`PATCH` 的移动没有撤销。** 移动是静默的（菜单点完立即生效），移错位置要靠用户自己再移回来。不做撤销栈：状态简单比可撤销重要，且移错一处比误删好收拾得多。

4. **删除文件夹的连带范围**——`subtreeSize` 的计数现在包含文件夹本身，确认弹窗的措辞「连同 N 篇子文档」需要改成「N 个项目」（否则把 3 个文件夹数成 3 篇文档）。这是验收时要看的一处文案。
