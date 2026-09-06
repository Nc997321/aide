-- 003_vector.sql — 向量检索（可选，需要 pgvector）
--
-- ⚠️ 本文件**不在自动迁移里**。`src/db.rs::migrate` 用 `read_dir` 扫描
--    `migrations/` 且不递归，子目录不会被扫到——这是刻意的：
--    pgvector 不是原生 PostgreSQL 自带的，Windows 上要单独装，
--    让一个还没用上的能力卡住服务初始化不值得。
--
-- 启用的前提：数据库里 `SELECT * FROM pg_available_extensions WHERE name='vector'`
-- 能查到。查不到说明 pgvector 没装，本文件执行必定失败。
--
-- 执行方式（手动，装好 pgvector 之后）：
--   psql "$KB_DB_URL" -f migrations/optional/003_vector.sql
--
-- 执行成功后**补一行登记**，避免以后重复执行：
--   INSERT INTO _migrations (name) VALUES ('003_vector.sql');
--
-- ⚠️ 事务由 psql 默认自动提交，逐条语句生效；想整体回滚就自己包 BEGIN/COMMIT。

CREATE EXTENSION IF NOT EXISTS vector;

-- 向量切片。绑定 revision_id 而不是 document_id：
-- 文档一改，旧版本的 chunk 全部失效，靠外键级联清理，不会留下脏向量。
CREATE TABLE chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  revision_id  uuid NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
  ordinal      integer NOT NULL,
  heading_path text,
  content      text NOT NULL,
  token_count  integer,
  embedding    vector(1024),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chunks_revision_ordinal_uidx ON chunks (revision_id, ordinal);
CREATE INDEX chunks_document_id_idx ON chunks (document_id);

-- ⚠️ HNSW 索引故意不在这里建：空表建索引没有意义，而且会拖慢之后每一次写入。
-- 等第一批数据灌完、chunk 策略（切多长、重叠多少、标题路径带不带）定稳之后再单独执行：
--
--   CREATE INDEX chunks_embedding_idx ON chunks
--     USING hnsw (embedding vector_cosine_ops);
--
-- 维度 1024 对应 bge-m3 / bge-large-zh；换 bge-small-zh(512) 需要一并改这里的类型。
-- 这两个决策一旦定下，重建索引是全量的，别在没想清楚之前就灌数据。
