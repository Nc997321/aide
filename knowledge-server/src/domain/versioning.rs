//! 版本管理。
//!
//! 保存即新建 revision —— 没有独立的「保存」和「发版」两个动作。
//! 团队文档不需要发布流程这个概念，每次保存都是一个可回滚的版本。
//!
//! 注意这里依赖的是 `port::Tokenizer` 而不是某个具体分词库：
//! 换分词算法不需要改这个文件。

use sqlx::PgConnection;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::port::Tokenizer;

pub struct SaveInput {
    pub document_id: Uuid,
    pub title: String,
    pub content: String,
    pub author_id: Uuid,
    pub change_note: Option<String>,
    /// true 时跳过合并窗口，强制开新版本（回滚等场景必须如此）
    pub force_new_version: bool,
}

/// 保存。返回 (revision_id, version_no)。
pub async fn save_revision(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    config: &Config,
    input: SaveInput,
) -> AppResult<(Uuid, i32)> {
    // FOR UPDATE 锁文档行：两个并发保存不能算出同一个 version_no
    let current: Option<(Option<Uuid>,)> = sqlx::query_as(
        "SELECT current_revision_id
           FROM documents
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE",
    )
    .bind(input.document_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some((current_revision_id,)) = current else {
        return Err(AppError::NotFound("文档不存在或已被删除".into()));
    };

    // 合并窗口：同一作者的连续保存改写当前版本而不是新建，
    // 否则边写边存会在版本历史里堆出一串无意义的 v2/v3/v4。
    if !input.force_new_version {
        if let Some(rev_id) = current_revision_id {
            let merged: Option<(Uuid, i32)> = sqlx::query_as(
                r#"UPDATE revisions
                      SET title = $2, content = $3,
                          title_tokenized = $4, content_tokenized = $5,
                          change_note = COALESCE($6, change_note)
                    WHERE id = $1
                      AND author_id = $7
                      AND created_at > now() - ($8::bigint * interval '1 second')
                  RETURNING id, version_no"#,
            )
            .bind(rev_id)
            .bind(&input.title)
            .bind(&input.content)
            .bind(tokenizer.tokenize(&input.title))
            .bind(tokenizer.tokenize(&input.content))
            .bind(&input.change_note)
            .bind(input.author_id)
            .bind(config.revision_merge_window_seconds)
            .fetch_optional(&mut *conn)
            .await?;

            if let Some(row) = merged {
                sqlx::query(
                    "UPDATE documents
                        SET title = $2, updated_by = $3, updated_at = now()
                      WHERE id = $1",
                )
                .bind(input.document_id)
                .bind(&input.title)
                .bind(input.author_id)
                .execute(&mut *conn)
                .await?;
                return Ok(row);
            }
        }
    }

    let next_no: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version_no), 0) + 1 FROM revisions WHERE document_id = $1",
    )
    .bind(input.document_id)
    .fetch_one(&mut *conn)
    .await?;

    let (rev_id,): (Uuid,) = sqlx::query_as(
        r#"INSERT INTO revisions
             (document_id, version_no, title, content,
              title_tokenized, content_tokenized, author_id, change_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id"#,
    )
    .bind(input.document_id)
    .bind(next_no)
    .bind(&input.title)
    .bind(&input.content)
    .bind(tokenizer.tokenize(&input.title))
    .bind(tokenizer.tokenize(&input.content))
    .bind(input.author_id)
    .bind(&input.change_note)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query(
        "UPDATE documents
            SET current_revision_id = $2, title = $3, updated_by = $4, updated_at = now()
          WHERE id = $1",
    )
    .bind(input.document_id)
    .bind(rev_id)
    .bind(&input.title)
    .bind(input.author_id)
    .execute(&mut *conn)
    .await?;

    Ok((rev_id, next_no))
}

pub struct CreateInput {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub slug: String,
    pub title: String,
    pub content: String,
    pub author_id: Uuid,
}

/// 新建文档。
///
/// ⚠️ documents 与 revisions 互为外键（documents.current_revision_id → revisions.id，
/// revisions.document_id → documents.id）构成循环，所以必须三步走：
/// 先插 document 留空指针 → 插首个 revision → 回填指针。三步在同一事务内。
///
/// ⚠️ 这里维持了一条数据库表达不了的不变量：**文件夹没有 current_revision_id，
/// 文档必须有**。加不上 CHECK 约束是因为上面这个三步舞本身（第一步的指针必然是
/// NULL），而 PostgreSQL 的 CHECK 不支持 DEFERRABLE。详见 006 迁移的注释。
pub async fn create_document(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    input: CreateInput,
) -> AppResult<(Uuid, Uuid)> {
    // title 与 revisions.title 同时写：上移之后 documents.title 是当前标题的
    // 唯一真相，revisions.title 只是这一次写入的快照
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

    Ok((doc_id, rev_id))
}

/// 回滚 = 把旧版本内容**复制成一个新版本**，而不是把指针往回指。
///
/// 指针回退看着省事，但有两个问题：
///   1. 历史不再单调，「最新版本」在语义上倒流，下次保存会分叉出两个未来
///   2. `revisions.tsv` 是生成列，指针回退不会让它重算——检索会继续命中旧内容
pub async fn revert_to(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    config: &Config,
    document_id: Uuid,
    version_no: i32,
    user_id: Uuid,
) -> AppResult<(Uuid, i32)> {
    let target: Option<(String, String)> = sqlx::query_as(
        "SELECT title, content FROM revisions WHERE document_id = $1 AND version_no = $2",
    )
    .bind(document_id)
    .bind(version_no)
    .fetch_optional(&mut *conn)
    .await?;

    let Some((title, content)) = target else {
        return Err(AppError::NotFound(format!("目标版本 v{version_no} 不存在")));
    };

    save_revision(
        &mut *conn,
        tokenizer,
        config,
        SaveInput {
            document_id,
            title,
            content,
            author_id: user_id,
            change_note: Some(format!("回滚到 v{version_no}")),
            // 必须强制开新版本：否则会命中合并窗口，把刚保存的内容改回旧版本，
            // 而且历史里看不出发生过回滚
            force_new_version: true,
        },
    )
    .await
}
