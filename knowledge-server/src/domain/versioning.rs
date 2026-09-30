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
use crate::types::DocumentKind;

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
    // FOR UPDATE 锁文档行：两个并发保存不能算出同一个 version_no。
    // 顺手把 kind 与 mime 带出来——文件夹没有正文，不能进这条路径；
    // mime 决定可搜文本怎么派生（html 要剥标记）。
    let current: Option<(Option<Uuid>, String, String)> = sqlx::query_as(
        "SELECT current_revision_id, kind, mime
           FROM documents
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE",
    )
    .bind(input.document_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some((current_revision_id, kind, mime)) = current else {
        return Err(AppError::NotFound("文档不存在或已被删除".into()));
    };

    // 领域层自己守这条不变量，不依赖调用方先判——`update` 与 `revert_to` 两条路径
    // 都从这里过，将来再多一条也不会漏
    if DocumentKind::try_from(kind.as_str()) == Ok(DocumentKind::Folder) {
        return Err(AppError::BadRequest("文件夹没有正文，不能保存版本".into()));
    }

    // 可搜文本与分词输入都从同一次派生来——两者不同源会让「能搜到」和
    // 「高亮在哪」对不上，而那种错只能靠翻库才看得出来。
    // ⚠️ 编辑保存也要重算（spec Review Focus #4）：漏了就会搜到**旧内容**。
    let search_text = crate::domain::search_text::derive(&mime, &input.content);
    let tokenize_src = search_text.as_deref().unwrap_or(&input.content);
    let content_tokenized = tokenizer.tokenize(tokenize_src);

    // 合并窗口：同一作者的连续保存改写当前版本而不是新建，
    // 否则边写边存会在版本历史里堆出一串无意义的 v2/v3/v4。
    if !input.force_new_version {
        if let Some(rev_id) = current_revision_id {
            let merged: Option<(Uuid, i32)> = sqlx::query_as(
                r#"UPDATE revisions
                      SET title = $2, content = $3,
                          title_tokenized = $4, content_tokenized = $5,
                          search_text = $9,
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
            .bind(&content_tokenized)
            .bind(&input.change_note)
            .bind(input.author_id)
            .bind(config.revision_merge_window_seconds)
            .bind(&search_text)
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
              title_tokenized, content_tokenized, author_id, change_note, search_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id"#,
    )
    .bind(input.document_id)
    .bind(next_no)
    .bind(&input.title)
    .bind(&input.content)
    .bind(tokenizer.tokenize(&input.title))
    .bind(&content_tokenized)
    .bind(input.author_id)
    .bind(&input.change_note)
    .bind(&search_text)
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
    pub kind: DocumentKind,
    pub slug: String,
    pub title: String,
    pub content: String,
    /// 落库内容的类型（决定可搜文本怎么派生）。新建的普通文档是 markdown；
    /// 摄取来的条目由解析器给出（html 就是 text/html）。
    pub mime: String,
    pub author_id: Uuid,
}

/// 新建节点。返回 `(document_id, revision_id, version_no)`。
///
/// 文件夹**没有** revision，此时 `revision_id` 为 `Uuid::nil()`、`version_no` 为 0，
/// 调用方据此判断「这次没有产生版本」。不用 `Option` 包一层：那会让 `SaveResult`
/// 的 `revision_id: Uuid` 跟着变可空，而那个字段在真实文档场景下永远是有的——
/// 为一条分支污染整个 DTO 不划算。
///
/// ⚠️ 这里维持了一条数据库表达不了的不变量：**文件夹没有 current_revision_id，
/// 文档必须有**。加不上 CHECK 约束是因为下面这个三步舞本身（第一步的指针必然是
/// NULL），而 PostgreSQL 的 CHECK 不支持 DEFERRABLE。详见 006 迁移的注释。
pub async fn create_node(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    input: CreateInput,
) -> AppResult<(Uuid, Uuid, i32)> {
    let doc_id = insert_node(conn, &input).await?;
    if input.kind.is_folder() {
        return Ok((doc_id, Uuid::nil(), 0));
    }
    let rev_id = insert_first_revision(conn, tokenizer, doc_id, &input).await?;
    Ok((doc_id, rev_id, 1))
}

/// 插节点行。title 与 kind 在这里落库——标题上移之后它不再只存在于 revisions。
async fn insert_node(conn: &mut PgConnection, input: &CreateInput) -> AppResult<Uuid> {
    let (doc_id,): (Uuid,) = sqlx::query_as(
        r#"INSERT INTO documents (space_id, parent_id, kind, slug, title, created_by, updated_by, mime)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
           RETURNING id"#,
    )
    .bind(input.space_id)
    .bind(input.parent_id)
    .bind(input.kind.as_str())
    .bind(&input.slug)
    .bind(&input.title)
    .bind(input.author_id)
    // 文件夹也有 mime 列（NOT NULL），给默认值即可——它没有正文，没人读它
    .bind(&input.mime)
    .fetch_one(&mut *conn)
    .await?;
    Ok(doc_id)
}

/// 首个版本 + 回填指针。文件夹不走这里（它没有版本历史）。
async fn insert_first_revision(
    conn: &mut PgConnection,
    tokenizer: &dyn Tokenizer,
    doc_id: Uuid,
    input: &CreateInput,
) -> AppResult<Uuid> {
    // 与 save_revision 同一条派生规则（唯一产地见 domain::search_text）
    let search_text = crate::domain::search_text::derive(&input.mime, &input.content);
    let tokenize_src = search_text.as_deref().unwrap_or(&input.content);

    let (rev_id,): (Uuid,) = sqlx::query_as(
        r#"INSERT INTO revisions
             (document_id, version_no, title, content,
              title_tokenized, content_tokenized, author_id, search_text)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7)
           RETURNING id"#,
    )
    .bind(doc_id)
    .bind(&input.title)
    .bind(&input.content)
    .bind(tokenizer.tokenize(&input.title))
    .bind(tokenizer.tokenize(tokenize_src))
    .bind(input.author_id)
    .bind(&search_text)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query("UPDATE documents SET current_revision_id = $2 WHERE id = $1")
        .bind(doc_id)
        .bind(rev_id)
        .execute(&mut *conn)
        .await?;

    Ok(rev_id)
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
