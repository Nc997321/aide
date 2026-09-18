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
-- 代价：documents.title 与 revisions.title 成了两份，前者权威。维持一致的责任落在
-- domain/versioning.rs 的三个写入点（create_node / save_revision 的两个分支），
-- 三处都在同一个文件、同一个事务里。
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
--    这条不变量由领域层维持，见 domain/versioning.rs::create_node 的注释。

-- 树的按父查询已有 documents_parent_id_idx（001），不需要新索引。
