-- 005_documents_parent_space.sql — 约束 documents 的父子必须同 space。
--
-- 为什么是独立文件而不是并进 004：`_migrations` 按**文件名**记录已应用，
-- 往一个已经应用过的文件里追加 SQL 不会重跑。已发布的库只能走新文件这条路。
--
-- ⚠️ 事务由 src/db.rs 的 migrate() 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- 原约束 `parent_id uuid REFERENCES documents (id)` 没有任何东西保证父子同 space。
-- 而 documents_slug_uidx 用的是子节点自己的 space_id，也不会撞唯一键 ——
-- 所以数据库不拦，domain 层（ingest.rs / versioning.rs）把 parent_id 直接 bind
-- 进去同样不校验。结果是 space A 的文档能挂到 space B 的文档下，树结构跨租户：
-- 权限按 space_id 判定，于是 B 的成员会在树里看见这个节点（读正文被拦），
-- 属于结构面泄露。
--
-- parent_id 为 NULL 时按 MATCH SIMPLE 不校验，根文档不受影响。

-- ⚠️ 这条唯一索引与主键 documents_pkey (id) 是**冗余的** —— 它存在的唯一理由是
--    复合外键的被引用列必须带唯一索引。别把它当冗余索引删掉，删了外键会跟着挂。
ALTER TABLE documents ADD CONSTRAINT documents_id_space_uidx UNIQUE (id, space_id);

ALTER TABLE documents ADD CONSTRAINT documents_parent_same_space
  FOREIGN KEY (parent_id, space_id) REFERENCES documents (id, space_id);
