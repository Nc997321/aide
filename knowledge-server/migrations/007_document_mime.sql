-- 007_document_mime.sql — 条目的存储类型 + 派生可搜文本。
-- 背景：docs/superpowers/specs/2026-09-30-aide-library-design.md §5.2
--
-- ⚠️ 事务由 src/db.rs 的 migrate() 统一包裹，本文件内不要写 BEGIN / COMMIT。

-- mime 描述的是**库里存的那份内容**的类型，不是上传时的文件类型：
-- docx/pdf 传进来会被解析成 markdown，所以它们的产物类型仍是 text/markdown。
-- 值由服务端按扩展名决定（adapter/parser/html.rs），**不采信客户端
-- 给的 Content-Type**——那是发送方自己声明的，正是 spec §4.3 禁止的那类信任。
-- DEFAULT 让存量行自动成为 markdown：它们本来就是。
ALTER TABLE documents ADD COLUMN mime text NOT NULL DEFAULT 'text/markdown';

-- 派生可搜文本。NULL = 与 content 相同（md 及一切「原文即可搜」的条目）。
--
-- 存一份而不是每次现算，是因为 tsv 是**生成列**、必须由表里的列算（002_search.sql），
-- 且检索高亮片段也从它切——现算的话每查一次都要重跑一遍剥标记。
-- 代价：md 条目与 content 重复一份。002_search.sql 为 title_tokenized/content_tokenized
-- 付过同样的冗余，理由相同：可诊断，且换了派生规则能一眼看出对不对。
ALTER TABLE revisions ADD COLUMN search_text text;
