-- 004_assets.sql — 文档内嵌资源（图片）的元数据。
--
-- ⚠️ 编号跳过 003 是刻意的：`003_vector.sql` 已存在于 `migrations/optional/`。
--    `src/db.rs::migrate` 用 read_dir 扫描本目录且不递归，两者不会冲突，
--    但把本文件叫 003_assets.sql 会让人以为可选向量迁移被挪动了。
--
-- ⚠️ 事务由 src/db.rs 的 migrate() 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- 正文里的图片引用写成 `asset://<id>`，字节落在 KB_STORAGE_DIR。
-- 这张表只存元数据 + 指向字节的键。
--
-- 绑 document_id 而不是 revision_id 是刻意的：**图片是原件，索引是派生**。
-- 改文档不该让图片消失，回滚到旧版本图片还得在 —— 所以它跟着文档走。
-- 对比 migrations/optional/003_vector.sql 的 chunks 绑 revision_id：
-- 那份是派生数据，文档一改就失效重算。两者生命周期不同，绑定对象也就不同。
--
-- 刻意不设的列（都有明确理由，别"顺手补上"）：
--   space_id      —— 可由 document_id 推出，存了就有漂移风险
--   sha256        —— 只服务于跨文档去重，v1 不做；留一列没人读的哈希是负债
--   original_name —— Word 内嵌图没有"原文件名"，part_path 对用户无意义
--   alt           —— alt 文本留在 markdown 正文里，取图端点只发字节，用不到
CREATE TABLE assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL,
  -- 指向 BlobStore 的键。⚠️ 不存绝对路径——容器重建后路径会变
  storage_key  text NOT NULL,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_document_id_idx ON assets (document_id);
