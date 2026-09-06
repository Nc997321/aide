-- 002_search.sql — 全文检索
--
-- 中文分词**刻意不放数据库扩展**（如 zhparser），
-- 改由应用层（Rust 侧 jieba-rs）分词后写入 tokenized 列。理由见下面注释。
--
-- ⚠️ 本文件**不依赖任何扩展**，原生 PostgreSQL 就能执行。
--    向量检索在 migrations/optional/003_vector.sql，需要 pgvector 才跑得了。
--    分开的理由：pgvector 在 Windows 原生 PostgreSQL 上要单独装，
--    让它卡住服务初始化不值得——而第一版本来就不做向量检索。
--
-- ⚠️ 事务由 src/db.rs::migrate 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- 应用层分词后的词序列（空格分隔），由服务在写入 revision 时一并算出。
--
-- ── 为什么不用 zhparser ────────────────────────────────────────────
-- 1. 部署门槛：zhparser 要在数据库主机上编译安装扩展，是这套系统里
--    最容易卡住的一步，而它卡住会让整个迁移失败。
-- 2. 行为不可控：分词词典、停用词全绑在数据库版本上，想调就得动数据库。
-- 3. 与端口抽象同构：分词器在 `port::Tokenizer` 后面，换算法只改一个
--    适配器文件。如果分词在数据库里做，这层抽象就废了。
--
-- 代价：tsv 不再是「从原文自动生成」——应用写入时必须先分词再落库。
-- 这个代价换来的是分词可测试、可升级、可替换，值得。
--
-- 留着这两列（而不是只留 tsv）是为了可诊断：检索不准时能直接看
-- 分词结果对不对，不用反推。
ALTER TABLE revisions ADD COLUMN title_tokenized   text;
ALTER TABLE revisions ADD COLUMN content_tokenized text;

-- simple 配置不切中文，但会按空格切分并转小写——
-- 正好吃「上游已经分好词」的输入形态。
-- tokenized 为 NULL 时退化到原文：对英文仍可用，对中文会整段不切分。
-- 这个退化是兜底，不是正常路径——正常路径下应用层一定会填。
ALTER TABLE revisions
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, coalesce(title_tokenized, title)), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(content_tokenized, content)), 'B')
  ) STORED;

CREATE INDEX revisions_tsv_idx ON revisions USING GIN (tsv);

-- 向量切片表在 migrations/optional/003_vector.sql（需要 pgvector），不在自动迁移里。
