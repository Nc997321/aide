//! 全文检索。
//!
//! 中文分词在应用层做（`port::Tokenizer`），数据库侧用 `simple` 配置吃
//! 已经分好词的输入。查询串必须走**同一个分词器**，
//! 否则「写入时切的词」和「查询时切的词」对不上，检索会莫名失灵。

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::AppResult;
use crate::port::Tokenizer;
use crate::types::SearchHit;

use super::permission;

pub async fn search_full_text(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    user_id: Uuid,
    query: &str,
    space_id: Option<Uuid>,
    limit: i32,
) -> AppResult<Vec<SearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // 权限集合在领域层算好再传进来，检索 SQL 里不出现权限推理
    let visible = permission::readable_document_ids(&mut *conn, user_id, space_id).await?;
    if visible.is_empty() {
        return Ok(Vec::new());
    }

    let tokenized = tokenizer.tokenize(trimmed);
    let limit = limit.clamp(1, 100);

    let rows: Vec<(Uuid, Uuid, String, i32, f32, String)> = sqlx::query_as(
        r#"SELECT d.id                AS document_id,
                  d.space_id,
                  r.title,
                  r.version_no,
                  ts_rank(r.tsv, q)::float4 AS rank,
                  -- StartSel/StopSel 用哨兵而不是 <b>/<mark>：
                  -- ts_headline 的输出里混着**文档正文**，而正文是团队任何人可写的。
                  -- 若直接吐 <mark>，前端就只能 v-html 信任这段 HTML（XSS 面）；
                  -- 用哨兵则前端可以先整体转义、再按哨兵切成高亮片段——
                  -- 安全性不再依赖"正文里没有尖括号"，最坏只是高亮错位。
                  ts_headline('simple'::regconfig, r.content, q,
                              'MaxFragments=3, MaxWords=24, MinWords=8, '
                              'StartSel=[[HL]], StopSel=[[/HL]]') AS snippet
             FROM revisions r
             JOIN documents d ON d.id = r.document_id
             CROSS JOIN plainto_tsquery('simple'::regconfig, $1) AS q
            WHERE r.tsv @@ q
              -- 只搜当前版本。少了这一行，同一篇文档的 N 个历史快照会一起刷屏。
              AND d.current_revision_id = r.id
              AND d.deleted_at IS NULL
              AND d.id = ANY($2::uuid[])
            ORDER BY rank DESC
            LIMIT $3"#,
    )
    .bind(&tokenized)
    .bind(&visible)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(document_id, space_id, title, version_no, rank, snippet)| SearchHit {
                document_id,
                space_id,
                title,
                version_no,
                rank,
                snippet,
            },
        )
        .collect())
}
