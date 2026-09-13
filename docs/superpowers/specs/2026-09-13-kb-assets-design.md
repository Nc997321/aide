# 知识库资源通道（v1）：文档内图片的存储、取用与索引隔离 — 设计

- 日期：2026-09-13
- 状态：待评审
- 范围：`knowledge-server/`（Rust）+ `src/components/KnowledgeBase/`（Vue）
- 关联：本 spec 同时处理评审中暴露的数据库完整性缺陷（见 §11）

## 1. 背景与问题（全部实锤）

### 1.1 Word 导入的图片存进去了，但永远显示不出来

三环证据，缺一不可：

**第一环 —— 图片被转成 base64 内嵌进正文。**
`src/adapter/parser/docx_to_md.rs:33` 用 `ParserConfig::default()`，而 `docx-to-md` 0.1.0 的默认值（`crates.io/.../docx-to-md-0.1.0/src/config.rs:41-45`）是：

```rust
extract_images: true,
compress_images: true,                              // 非 SVG 转 JPEG q80
image_handling_mode: ImageHandlingMode::InMarkdown, // 「embedded as base64 data: URLs」
```

于是 markdown 正文里出现 `![](data:image/jpeg;base64,…)`。**`warnings: no_warnings()` 在这个意义上是诚实的 —— 确实什么都没丢。**

**第二环 —— 前端拒绝 `data:`。**
`src/components/KnowledgeBase/markdown.ts:67` 的 `image()` 渲染器走 `safeUrl(href)`；`safeUrl`（同文件 L26-30）的白名单只有 `#`/`/` 开头与 `http:`/`https:`/`mailto:`，`data:` 被拒（注释明写「其余（javascript: / data: / vbscript:）一律拒绝」）。命中 `return escapeHtml(text)` → **图片退化成一行 alt 文本**。

**两端各自的决定都合理，合起来是坏的。** 且这是静默降级——不报错，图就是没有。

**第三环 —— 索引被 base64 污染。**
那串 base64 进了 `revisions.content` → 进 `content_tokenized`（jieba 要切它）→ 进 `tsv` 生成列。一张 100KB 截图的 base64 约 137KB 纯文本进倒排索引，产生大量噪音 token。`content` 是 `text`，图多的文档还会触发 TOAST。

### 1.2 兜底后端真丢图，且不告知

`docx_lite.rs:33` 只调 `extract_text()`，图片直接消失。而它的 warning（L43）只说「标题层级与列表结构已丢失」，**一个字没提图片**。

### 1.3 port 的注释承诺了一个没有实现的行为

`src/port/document_parser.rs` 里 `warnings` 的文档写着：

> 例如「3 个文本框未提取」「**含图片 12 张，已跳过**」

而排查全链：`docx_to_md.rs:50` 是 `no_warnings()`（空），`docx_lite.rs` 只报结构。**没有任何后端产出过这个示例中的 warning。**

### 1.4 解析失败会在磁盘上留下孤儿文件

`src/api/ingest.rs:101` 先 `tokio::fs::write(&stored_path, &data)`，解析在 `L118` 才发生。解析失败时 `?` 直接返回错误，**已写入的文件没有任何清理** —— 每次失败的上传都在 `KB_STORAGE_DIR` 里留一个永不被引用的 uuid 前缀文件。

### 1.5 背景事实（本设计的地基，已存在）

- `docker-compose.yml:45,53`：`KB_STORAGE_DIR: /app/storage` + `kbdata:/app/storage` 具名卷；README:95-97 已把它称作「附件」卷并警告 `down -v` 会连它一起删。**持久化层无需改动。**
- `state.config.storage_dir` 的全部使用点只有 `api/ingest.rs:93,99` 两处 —— **全库没有任何地方读回它**，也没有下载端点。
- 仓库中没有任何 `original_name` / `stored_path` / `mime` 落库的列。`IngestInput.stored_path` 只用于解析，解析完即丢。

## 2. 目标与非目标

**目标**

1. Word（及未来其它解析后端）导入的图片**能被看见**
2. 图片字节**不再进入正文与倒排索引**
3. 图片取用走**鉴权**，且凭据不进访问日志
4. 摄取失败**不留孤儿文件**；降级**如实上报**（补齐 §1.2/§1.3 的缺口）
5. 存储访问被抽象到端口后，可被单测注入

**非目标（明确划出，本 spec 不设计、不预留）**

- 向量检索 / 多模态 / 视频 —— 全部不做，`migrations/optional/003_vector.sql` 维持「备好不启用」
- 独立二进制制品（HTML 原型等）—— 原型留在仓库 `docs/prototypes/`，不进知识库
- 跨文档图片去重（`sha256` 列不留，见 §4）
- 文档导出 / 打包下载
- **上传的原始文件（docx/pdf）不保留** —— 存的是解析后的知识，不是原件；解析完即删（§6.1）
- `tags` / `document_tags` / `links` 三张表的启用（见 §11.3）

## 3. 设计原则：原件与派生表示分离

本 spec 只有一个不可动摇的设计原则，它决定了后面所有取舍：

> **原件是「事实」，索引是「可重算的缓存」。**

图片字节是原件 —— 它不能被重新计算出来。倒排索引里的 token 是派生 —— 丢了可以重建。

`migrations/optional/003_vector.sql` 的 `chunks` 表已经体现了这条原则（「绑定 `revision_id` 而不是 `document_id`：文档一改，旧版本的 chunk 全部失效，靠外键级联清理」）。

**由此推出本设计里唯一一处刻意的不对称**：`assets` 绑 `document_id`，而 `chunks` 绑 `revision_id`。

- **图片是原件** → 改文档不该让它消失；回滚到旧版本，图还得在 → 绑 `document_id`
- **chunk 是派生** → 文档一改就失效重算 → 绑 `revision_id`

这不是笔误。把两者都绑 `revision_id` 会导致「保存一次，图片被重新上传一份」；都绑 `document_id` 会导致「改了文档，旧版本的向量还在搜」。**它们的生命周期本来就不同。**

## 4. 数据模型

新迁移文件：`migrations/004_assets.sql`。

> ⚠️ 编号跳过 003 是刻意的：`003_vector.sql` 已存在于 `migrations/optional/`。`migrate()` 用 `read_dir` 扫描 `migrations/` 且不递归，两者不会冲突，但用 `003_assets.sql` 会让人以为可选向量迁移被挪动了。**文件头要写这句注释。**

```sql
CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 绑 document 而非 revision：图片是原件，见 §3
  document_id   uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL,
  -- 指向 BlobStore 的键。⚠️ 不存绝对路径——容器重建后路径会变
  storage_key   text NOT NULL,
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_document_id_idx ON assets (document_id);
```

**四个刻意的「不」：**

| 不加 | 理由 |
|---|---|
| `space_id` | 可由 `document_id` 推出。存了就有漂移风险，权限检查走一次 join 即可 |
| `sha256` | 只服务于跨文档去重（非目标）。**不留死列** —— 本 spec §11.3 正在处理仓库里的死表问题，不能自己又埋一个 |
| `original_name` | Word 内嵌图没有「原文件名」这个概念，`part_path`（如 `word/media/image1.png`）对用户无意义。将来做独立制品上传时再加 |
| `alt` | alt 文本**留在 markdown 正文里**（渲染与无障碍都由它负责），取图端点只发字节、用不到。存一份进库就是不会被读的死列 |

`document_id` 为 `NOT NULL`：v1 的 assets 只来自文档解析，不存在游离资源。**不为假想的场景留可空列。**

## 5. 存储抽象：`port::BlobStore`

```
port::BlobStore                    只定义 trait 与领域类型
adapter::FilesystemBlobStore       实现 —— 唯一允许出现 std::fs / tokio::fs 的地方
```

```rust
pub trait BlobStore: Send + Sync {
    /// 写入并返回 storage_key（实现决定键的生成规则）
    fn put(&self, bytes: &[u8]) -> Result<String, BlobError>;
    fn get(&self, key: &str) -> Result<Vec<u8>, BlobError>;
    fn delete(&self, key: &str) -> Result<(), BlobError>;
}
```

**为什么现在就该抽（不是因为「将来可能换 S3」）**：这段逻辑现在硬编码在 `api/ingest.rs` 里直接 `tokio::fs::write`，**没有任何一层能对它做单测**。抽出来之后 `domain::ingest` 的测试可以注入内存实现，不必碰真实文件系统。

`FilesystemBlobStore` 的 `storage_key` 是**裸 uuid**（`Uuid::new_v4().simple()`），不带原始文件名 —— Word 内嵌图没有「原文件名」这个概念。因此实现里不需要 `sanitize_file_name`。

`sanitize_file_name` **留在 `api/ingest.rs`**：它服务的是「上传的原始 docx 临时文件落盘」（那才需要防止客户端可控的 filename 造成目录穿越），不是 blob 的键。**它的现有单测（`ingest.rs:171-175`）原地不动。**

`get`/`delete` 必须拒绝含路径分隔符或 `..` 的键 —— 键虽然由我们自己生成，但它是从数据库读回来的字符串，防的是「库里被写进脏值」这一类失效。

⚠️ trait 设计成**同步**：与 `port::DocumentParser` 同理（`document_parser.rs` 的注释：CPU/IO 密集端口保持同步，调用方 `spawn_blocking`）。这符合仓库 CLAUDE.md 的既有约定。

## 6. 端口契约变更：让图片物理上出得来

**现状**：`port::DocumentParser` 只回 `markdown` / `title` / `warnings` —— 图片**物理上无法传出 adapter**。这是 §1.1 能做到「存了却看不见」的结构性原因。

```rust
/// 解析产出的附件。领域自己的类型，不泄漏任何第三方库类型。
pub struct ParsedAsset {
    pub mime: String,
    pub bytes: Vec<u8>,
}

pub struct ParsedDocument {
    pub markdown: String,
    pub title: Option<String>,
    pub warnings: Vec<String>,
    pub assets: Vec<ParsedAsset>,   // 新增
}
```

### 占位符契约（必须写进 port 的 doc comment）

> adapter 负责把 markdown 中每个附件的位置替换为**解析期占位符** `{{asset:0}}`、`{{asset:1}}`……下标对应 `assets` 里的位置（从 0 起）。
> `domain::ingest` 负责把它替换为**持久化引用** `asset://<asset-uuid>`。
> **adapter 不知道 asset id、URL 方案、数据库的存在** —— 正如它现在不知道这些一样。

⚠️ **两种形态必须用不同的记号，这不是洁癖。** 解析期是「下标」且是临时的，持久化是「uuid」且是永久的。若两者共用 `asset://` 前缀，一旦替换环节出 bug，残留的 `asset://0` 会被下游当成一个**合法的** asset id 继续走 —— 静默指向不存在的资源，排查成本极高。

配套加一道防线：**写入 revision 前扫描残留的 `{{asset:`**，命中则记入 `warnings` 并整体移除该占位符（视为降级，不是失败 —— 与 §10.2 同一语义）。

这条契约的价值：换解析后端（docx-to-md / docx-lite / office_oxide / rwml）时，上层一行不动；反向也成立 —— 上层换 URL 方案时，所有 adapter 一行不动。

### 6.1 摄取次序：blob 的 IO 不进数据库事务

一个必须定死的实现次序 —— **asset id 由 Rust 侧生成（`Uuid::new_v4()`），不依赖数据库默认值**：

```
1. 上传的原始文件落盘 → 解析（spawn_blocking）得到 markdown + Vec<ParsedAsset>
2. 为每个 ParsedAsset 生成 uuid，BlobStore::put 写入 → 得到 storage_key
   ↑ 这一步在事务之外。blob 的键与 document_id 无关，所以不需要先有文档行
3. 用「下标 → uuid」的映射，把 markdown 里的 {{asset:i}} 换成 asset://<uuid>
4. 开事务：依次 INSERT documents / revisions / assets（显式带上面生成的 asset id）/ 更新 current_revision_id
5. commit → 删除第 1 步落盘的原始文件
```

**为什么不把 blob 写进事务里**：`BlobStore::put` 是文件 IO，把 IO 夹在事务中间会长时间占住数据库连接与行锁，且失败时事务回滚并不会撤销已经写进文件系统的字节 —— 反而制造出「库里没有、盘上有」的孤儿，正是 §1.4 要消灭的那类问题。**先写 blob 再开事务，失败时最多留下可回收的孤儿 blob，不会留下不一致的库状态。**

**原始文件不保留**：第 5 步删除上传的原始 docx。这与 §2 的非目标一致 —— 知识库存的是**解析后的知识**，不是原件。⚠️ 这是对现有行为的**变更**（现状是文件留在 `KB_STORAGE_DIR` 但无人引用），若日后需要「下载原件」，那是把原件变成一个 asset 的独立决策，不影响本设计。

## 7. docx 后端改造

### 7.1 方案：保持 `InMarkdown`，从 data URL 抽出图片

**不用 `ImageHandlingMode::Save`。** 读完 `docx-to-md` 源码后否掉的理由：

`render.rs:495-510` 的 `image_output_path()` 是**私有函数**，文件名派生自 `resource.part_path` 并且**会改扩展名**：

```rust
let mut name = resource.part_path.trim_matches(['/', '\\']).replace(['/', '\\', ':'], "_");
if resource.media_type == "image/jpeg" { let stem = ...; name = format!("{stem}.jpg"); }
```

要按文件名反查图片，就得复刻这段私有逻辑。crate 一改命名规则，我们**静默丢图**。

**采用的路子**：`ParserConfig::default()` 保持不变（`InMarkdown`），然后从 markdown 里把 data URL 解析出来。产出形态（`render.rs:427`）是自描述的：

```
data:{media_type};base64,{data}
```

匹配：`!\[([^\]]*)\]\(data:([^;]+);base64,([A-Za-z0-9+/=]+)\)`

alt、mime、字节三样全在 URL 里，**位置天然正确**。不需要临时目录、不需要文件名反查、不依赖任何私有 API。

**顺带成立的一个事实**：`compress_images: true` 默认开启，非 SVG 图片在解析阶段已转成 JPEG（q80）。这是**既有的**行为，本 spec 不改变它 —— 但它意味着落库的图片是压缩过的，这是已知代价，写进 §12。

### 7.2 `docx_to_md.rs` 的改动

解析 → 扫描 markdown 里的 data URL → 逐个产出 `ParsedAsset` → 把该 URL 替换为解析期占位符 `{{asset:i}}`（§6）。`warnings` 仍然为空（图片现在真的没丢）。

### 7.3 `docx_lite.rs` 的改动

它 `extract_text()`，**图片真丢且不知道丢了几个**（没有 API 可查）。把现有 warning 改为不再失实：

```
"docx-lite 后端只做文本提取：标题层级与列表结构已丢失，且不提取图片"
```

**不做 zip 探测去数图** —— 为一句文案引入新依赖不值。`warnings` 的语义是「如实上报降级」，不是「精确统计」。

## 8. 取图端点与鉴权

### 8.1 端点

`GET /api/assets/{id}`

1. 查 `assets` → `documents` 得 `space_id`（一次 join）
2. 走 `domain::permission` 校验读权限，无权返回 403（**不区分「不存在」与「无权」之外的信息**，不泄漏 id 是否存在）
3. `BlobStore::get` → 返回 `Content-Type: <mime>`、`Content-Length`、`ETag`（用 `storage_key` 派生）

`Content-Disposition: inline`（要能作为 `<img src>` 加载）。

### 8.2 鉴权：为什么不能直接 `<img src="/api/assets/{id}">`

知识库用 `Authorization: Bearer <token>`，而 **`<img src>` 无法发送自定义 header** —— 浏览器发起的图片请求不带 token，必然 401。

README「鉴权」节已排除 cookie 路线（Tauri WebView origin 是 `http://tauri.localhost`，与服务不同源；`SameSite=Lax` 挡掉，`SameSite=None` 又强制 `Secure` 而本机是 http）。**两条路都走不通，这是被环境逼出来的既定结论，不在本 spec 重新讨论。**

**采用方案：前端 `fetch` → `objectURL`**

- markdown 里存**稳定的** `asset://<asset-uuid>`
- 文档视图挂载后扫描 `img[src^="asset://"]` → 带 Bearer `fetch` → `URL.createObjectURL` → 替换 `src`
- 组件卸载时 `revokeObjectURL`

**否掉的备选：签名 URL（`?t=<hmac>&e=<ts>`）**

| | fetch → objectURL（采用） | 签名 URL（否掉） |
|---|---|---|
| 渲染器 | 保持纯函数，LRU 缓存天然安全 | 缓存会**固化签名**，过期后命中缓存显示破图，缓存键得带 token 指纹 |
| 凭据落点 | 走 header，**不进日志** | `?t=` 必然进 nginx / compose 访问日志 |
| 新代码 | objectURL 生命周期 | HMAC + 时钟 + 过期语义 |

**决定性理由是「凭据落点」**：README 里连邀请链接都特意用 `#<token>` 形式、写明「贴进工单系统时 token 不会落到服务日志里」。签名 URL 与这个仓库明确的立场冲突。

**已知代价**：`markdown.ts:71` 现在的 `loading="lazy"` 对 `asset://` 失效（src 在 JS 替换前是占位符，浏览器不会预加载）。v1 接受 —— 一篇文档的图片数量有限。若将来成为问题，用 `IntersectionObserver` 补，不影响本设计。

## 9. 前端改动

| 文件 | 改动 |
|---|---|
| `KnowledgeBase/kbClient.ts` | 加 `getAsset(id): Promise<Blob>`（沿用现有 `request` 门面的 Bearer 注入）。**`id` 从 `asset://<uuid>` 里剥出**，前端不拼 URL 路径 —— 端点路径只在 kbClient 一处出现 |
| `KnowledgeBase/markdown.ts` | `image()` 的白名单**只加 `asset://` 前缀**。⚠️ **不动共用的 `safeUrl`** —— 它同时服务 `<a href>`，放开它会改变链接的协议策略 |
| `KnowledgeBase/KbDocumentView.vue` | 挂载后解析 `asset://` 图片 → fetch → objectURL；卸载 revoke |

⚠️ `markdown.ts` 的 LRU 缓存（L88-90）缓存的是「markdown → html」。因为 markdown 里存的是**稳定的** `asset://`，缓存不会因 token 变化而失效 —— 这正是选 §8.2 方案的原因。

## 10. 错误处理与降级

### 10.1 修掉孤儿文件（§1.4）

按 §6.1 的次序重写 `api/ingest.rs` 的上传流程。与现状的差别集中在两处 **`?` 之前必须清理**：

1. 落盘 → 解析（`spawn_blocking`）
   **解析失败 → 先删已落盘的文件 → 再返回错误**（现状是 `?` 直接返回，文件留下）
2. blob 上传 → 替换占位符 → 开事务
   **事务失败 → 删掉本次已 put 的 blob → 再返回错误**（否则留下「库里没有、盘上有」的孤儿）
3. commit 成功后删原始文件

第 2 条尤其容易漏：`?` 在 Rust 里太好写，而它每次都会跳过清理。

### 10.2 单张图片失败不整体失败

某张图 `BlobStore::put` 失败 → 把该图的**解析期占位符** `{{asset:i}}` 整体移除（此时尚未替换成 `asset://`，见 §6.1 的次序）→ 记入 `warnings`：

```
「3 张图片上传失败，已省略」
```

**与 `ParseOutcome.warnings` 的既有语义一致**（`document_parser.rs`：保留 warnings 是为了让「导入后内容少了」能被解释清楚，而不是变成玄学），也与仓库 CLAUDE.md 的「降级如实上报（丢失信息进 `warnings`）」一致。

### 10.3 取图失败不能让文档消失

403/404/网络错误 → 该 `<img>` 退化为 alt 文本。**整篇文档必须照常渲染** —— 这是仓库既有的降级约定（CLAUDE.md：「display 缺失/未知形态 → 纯文本或跳过该块，整条消息不能消失」）。

## 11. 同批处理的既有缺陷

### 11.1 `documents.parent_id` 可以跨 space —— 本次一并修

**问题**：`documents.parent_id uuid REFERENCES documents (id)` 没有任何约束保证父子同 `space_id`。`documents_slug_uidx` 用的是子节点自己的 `space_id`，所以也不会撞唯一键 —— **数据库不拦**。而 domain 层（`ingest.rs:98/105`、`versioning.rs:145/150`）把 `parent_id` 直接 bind 进去，同样没有校验。

**后果**：space A 的文档可以挂在 space B 的文档下，树结构跨租户；权限按 `space_id` 判定，于是 B 的成员会在树里看见这个节点（读正文被拦），属于**结构面泄露**。

**修法**（`004_assets.sql` 内）：

```sql
ALTER TABLE documents ADD CONSTRAINT documents_id_space_uidx UNIQUE (id, space_id);
ALTER TABLE documents ADD CONSTRAINT documents_parent_same_space
  FOREIGN KEY (parent_id, space_id) REFERENCES documents (id, space_id);
```

`parent_id` 为 NULL 时按 MATCH SIMPLE 不校验，根文档不受影响。

`documents_id_space_uidx` 与主键 `documents_pkey (id)` 是冗余的 —— 它存在的唯一理由是**复合外键的被引用列必须带唯一索引**。加这条注释，否则将来有人会把它当冗余索引删掉，然后外键跟着挂。

⚠️ **迁移必须先跑 pre-flight 校验** —— 若存量数据已有违规行，加约束会失败：

```sql
SELECT c.id, c.space_id AS child_space, p.space_id AS parent_space
FROM documents c JOIN documents p ON p.id = c.parent_id
WHERE c.space_id <> p.space_id;
```

有结果则**中止迁移并人工处置**（改 `space_id` 或置 `parent_id` 为 NULL），不静默改写数据。

### 11.2 `documents.current_revision_id` 可空 —— ⚠️ 更正我先前的错误判断

**我此前说**「用可延迟 FK 把三步插入压成两步，并让列变 NOT NULL」。

**这是错的。** `NOT NULL` 是列约束、**在语句执行时立即检查，不可延迟**；`DEFERRABLE` 只作用于外键约束。所以「先插文档（指针为空）+ 延迟检查 FK」并不能让 `NOT NULL` 通过。

**真正可行的做法是反转插入顺序**（需把 `revisions.document_id` 的外键也设为可延迟）：

1. 生成 document id
2. `INSERT revisions`（引用尚不存在的 document，延迟到 commit 检查）
3. `INSERT documents`（`current_revision_id` 非空，指向刚插入的 revision）
4. commit → 两个外键一并检查

但这要重排 `domain/versioning.rs` 与 `domain/ingest.rs` 两处的写入顺序，并让 PG 的延迟外键检查在 commit 时承担更多工作。

**决定：本次不做。** 理由：这是可读性/严谨性收益，不是缺陷——`current_revision_id` 为 NULL 的窗口被事务包住，外部不可见。而改动面（两处写入路径重排 + 外键语义变更）与「修一个看不见的问题」不成比例。**登记为待办，留待触碰 versioning 时顺势处理。**

（这条更正的意义：先前那个判断如果不纠正，会被当成一个「一条 ALTER TABLE 就好」的小活接下去，然后在实现时才发现代价完全不同。）

### 11.3 三张死表 —— 需要决策，不塞进本 spec

`tags`、`document_tags`、`links` 在 `src/` 中被引用 **0 次**（`grep -roi` 宽松匹配亦为 0，含注释）。

`links` 的设计最完整（含 `kind: ref|embed`、悬空链接的 `target_title` 回填、孤儿/枢纽文档度量），**但没有任何代码读写它**；`tags` / `document_tags` 连设计意图注释都没有。

**这不是本 spec 该顺手决定的事**——它取决于「还打不打算做标签与双链」，而 §2 已经把双链类能力划出非目标。**建议单独立项处理，本 spec 只登记。**

### 11.4 `links` 的设计弱点 —— 同 11.3，登记不修

若将来启用 `links`，`PRIMARY KEY (source_id, target_title)` 有三个后果需要先解决：重命名目标文档要 fan-out 重写入链的 `target_title`；同名文档无法区分导致 `target_id` 回填歧义；以及 PK 前导列是 `source_id`，**服务不了**「目标建好后回填悬空链接」的查询（缺 `(target_title) WHERE target_id IS NULL` 索引）。**本 spec 不处理，仅在实现 `links` 时作为前置约束。**

### 11.5 用户不可删除的沉默副作用 —— 注释级，顺手登记

`spaces.owner_id`、`documents.created_by`、`revisions.author_id` 对 `users` 都是默认 NO ACTION，因此**删除任何建过文档的用户都会失败**（其余子表是 CASCADE / SET NULL，不对称）。

对 10-30 人内部团队、只走 `is_active` 软停用，这是可接受的 —— 但它在 `001_init.sql` 里是**沉默的**，而该文件其它地方注释写得很足。**修法是在 `001_init.sql` 补一段注释说明这条不对称是有意的**（不改 schema，因此不占本次迁移）。

## 12. 已知代价（明确接受，不当作 bug 修）

1. **图片在解析阶段被转成 JPEG q80** —— `docx-to-md` 的 `compress_images: true` 默认行为。落库的不是原始字节。若要保真需改该配置，会影响文件体积，**本次不动**。
2. **`asset://` 图片失去 `loading="lazy"`** —— 见 §8.2。数量有限，接受。
3. **矢量图（SVG）**：`compress_images` 只跳过非 SVG，SVG 原样保留 —— 但它作为 `<img src>` 由浏览器渲染，其内部脚本不会执行（`<img>` 上下文不跑 JS），这是安全的。**不要在 v1 把它改成 `<object>` 或内联。**
4. **每篇文档的图片各自入库，不去重** —— 同一张 logo 出现在 10 篇文档里就是 10 份。§2 已划为非目标。

## 13. 测试计划

### 13.1 Rust

| 目标 | 测法 |
|---|---|
| `FilesystemBlobStore` 的路径穿越防护 | 搬移 `api/ingest.rs:171-175` 现有单测；补 `put/get/delete` 往返 |
| 占位符替换（**带值路径优先**） | 内存 `BlobStore` 注入 → `domain::ingest`：N 张图 → markdown 里 N 个 `{{asset:i}}` 变成 `asset://<uuid>`；**顺序不能错位**（第 2 张图换成的是第 2 个 uuid） |
| 空 assets 正路径 | 0 张图 → markdown 无任何 `{{asset:` 残留、`assets` 为空、文档正常落库 |
| 残留占位符防线（§6） | 构造一个「替换环节被跳过」的路径 → 断言写入前 `{{asset:` 被移除且 `warnings` 命中；**断言落库正文里没有 `{{asset:` 也没有 `asset://0` 形态** |
| docx 抽图 | 仓库内造一个真含图 docx 作 fixture；断言 `assets.len() == 图数`、markdown 无 `data:` 残留、无 `{{asset:` 残留 |
| 单图失败降级 | 注入一个第 2 次调用必失败的 `BlobStore` → 断言文档仍导入成功、占位符已移除、`warnings` 含条数 |
| 解析失败不留孤儿 | 上传不支持的扩展名 → 断言 `KB_STORAGE_DIR` 文件数不变 |
| docx-lite warning 文案 | 断言含「不提取图片」 |
| `parent_id` 跨 space 被拒 | 建 space A/B 两篇文档 → 尝试 B 的子节点挂到 A → 断言约束报错 |
| `parent_id` 同 space 正常 | 正路径（**带值路径**） |
| 根文档不受影响 | `parent_id = NULL` 正常插入 |

### 13.2 TypeScript

| 目标 | 测法 |
|---|---|
| `markdown.ts` 放行 `asset://` | 渲染 `![](asset://abc)` → 断言产出 `<img src="asset://abc">` |
| `safeUrl` 未被放宽 | `![](javascript:alert(1))` 仍退化为纯文本；`<a href="data:text/html,...">` 仍被拒 —— **两条防回归** |
| LRU 缓存不因对象 URL 失效 | 同 markdown 渲染两次 → 断言命中缓存且 html 相同（§8.2 方案的核心价值） |

### 13.3 端到端

`smoke.sh` 追加一段：上传含图 docx → 取 `GET /api/assets/{id}` → 断言 `Content-Type` 与字节长度一致 → 越权空间取图返回 403。

## 14. 影响面 / 迁移与回滚

**迁移**：`004_assets.sql` 纯新增表 + `documents` 加约束。**约束可能因存量数据失败 → 必须先跑 §11.1 的 pre-flight 查询。**

**回滚**：README 的既有约定适用 —— 本次**动了 `migrations/`**，因此「能不能直接退标签」的答案是**不能直接退**（`sqlx` 不会往回走）。退版需手工 `DROP TABLE assets` + 删两个约束。**发布说明里要写明这一点。**

**不动的东西**：`docker-compose.yml`（`kbdata` 卷已在）、现有 docx/pdf 解析链的回退顺序、`chunks` 表、`migrations/optional/`。

## 15. 未决事项

1. **§8.2 的鉴权方案**：本 spec 采用「fetch → objectURL」并给出了否掉签名 URL 的理由（凭据不进日志）。**这是需要评审确认的一处判断**——若认为签名 URL 的浏览器缓存收益更重要，则 §9 的前端改动与 §13.2 的缓存测试要跟着改。
2. **§11.3 三张死表的去留**：登记待决，不在本 spec 范围。
