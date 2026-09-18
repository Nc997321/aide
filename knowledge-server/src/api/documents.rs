//! 文档读写。
//!
//! 这一层刻意薄：权限判定在 `domain::permission`，版本推进在 `domain::versioning`，
//! 锁在 `domain::locking`。这里只负责把它们按正确顺序串起来。
//! 顺序很重要——**先判权限、再查锁、最后落库**，反了就会让无权限的请求
//! 顺带把锁抢走（拒绝掉的请求留下了副作用）。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::AppState;
use crate::domain::{deletion, locking, permission, tree, versioning};
use crate::error::{AppError, AppResult};
use crate::types::{CurrentUser, DocumentKind, DocumentStatus, Permission, RevisionSummary};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentBody {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub title: String,
    pub content: Option<String>,
    /// 缺省 = 普通文档。文件夹是纯容器：不建 revision、不接受 content
    pub kind: Option<DocumentKind>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDocumentBody {
    pub title: String,
    pub content: String,
    pub change_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertBody {
    pub version_no: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetail {
    pub id: Uuid,
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub kind: DocumentKind,
    pub slug: String,
    pub title: String,
    pub content: String,
    pub version_no: i32,
    pub status: DocumentStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub document_id: Uuid,
    pub revision_id: Uuid,
    pub version_no: i32,
    /// 本次保存落进了既有版本（合并窗口内）还是新开了版本。
    /// 前端据此决定要不要提示用户「已合并进上一版本」。
    pub merged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub document_id: Uuid,
    /// 含根在内的总篇数。前端确认弹窗的预估（按文档列表算子树）与 agent 回执
    /// 共用这个口径，两处必须说同一个数。
    pub deleted_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockView {
    pub held: bool,
    pub holder: Option<locking::LockHolder>,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateDocumentBody>,
) -> AppResult<(StatusCode, Json<SaveResult>)> {
    let kind = body.kind.unwrap_or(DocumentKind::Doc);
    let title = body.title.trim();
    validate_new_node(title, kind, body.content.as_deref())?;

    let mut tx = state.db.begin().await?;

    if let Some(parent_id) = body.parent_id {
        tree::ensure_parent_is_folder(&mut tx, body.space_id, parent_id).await?;
    }

    // 判权放在结构校验之后：结构不对（父不是文件夹）时该报 400 而不是 403——
    // 用户要知道的是「这里不能放东西」，不是「你没权限」
    if !permission::may_write_under(&mut *tx, user.id, body.space_id, body.parent_id).await? {
        return Err(AppError::Forbidden);
    }

    // slug 走与摄取同一条生成逻辑，保证两种入口产出的 slug 规则一致
    let slug = crate::domain::ingest::unique_slug(&mut *tx, body.space_id, body.parent_id, title)
        .await?;

    let (document_id, revision_id, version_no) = versioning::create_node(
        &mut *tx,
        state.tokenizer.as_ref(),
        versioning::CreateInput {
            space_id: body.space_id,
            parent_id: body.parent_id,
            kind,
            slug,
            title: title.to_string(),
            content: body.content.unwrap_or_default(),
            author_id: user.id,
        },
    )
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(SaveResult {
            document_id,
            revision_id,
            version_no,
            merged: false,
        }),
    ))
}

/// 新建节点的入参校验。抽出来是因为它同时服务文档与文件夹两条路径，
/// 而两者的差别（文件夹不许带正文）恰恰最容易在复制粘贴里丢。
fn validate_new_node(title: &str, kind: DocumentKind, content: Option<&str>) -> AppResult<()> {
    if title.is_empty() {
        return Err(AppError::BadRequest("标题不能为空".into()));
    }
    // 不接受静默忽略：传了正文却建出没有正文的文件夹，是用户没被告知的丢失
    if kind.is_folder() && content.is_some_and(|c| !c.trim().is_empty()) {
        return Err(AppError::BadRequest("文件夹没有正文".into()));
    }
    Ok(())
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<DocumentDetail>> {
    let mut tx = state.db.begin().await?;
    require(&mut tx, user.id, id, Permission::Read).await?;

    // title 取 d.title（标题已从 revisions 上移到节点本身），正文仍来自当前版本
    let row: Option<(
        Uuid,
        Uuid,
        Option<Uuid>,
        String,
        String,
        String,
        String,
        i32,
        String,
    )> = sqlx::query_as(
        r#"SELECT d.id, d.space_id, d.parent_id, d.kind, d.slug,
                  d.title, r.content, r.version_no, d.status
             FROM documents d
             JOIN revisions r ON r.id = d.current_revision_id
            WHERE d.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((id, space_id, parent_id, kind, slug, title, content, version_no, status)) = row else {
        return Err(AppError::NotFound("文档没有可读取的版本".into()));
    };

    Ok(Json(DocumentDetail {
        id,
        space_id,
        parent_id,
        kind: DocumentKind::try_from(kind.as_str()).unwrap_or(DocumentKind::Doc),
        slug,
        title,
        content,
        version_no,
        // DB 里是 text + CHECK 约束，理论上只可能是三个合法值之一；
        // 万一出现意外值，退化成 draft 而不是让整个请求 500
        status: DocumentStatus::try_from(status.as_str()).unwrap_or(DocumentStatus::Draft),
    }))
}

pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateDocumentBody>,
) -> AppResult<Json<SaveResult>> {
    if body.title.trim().is_empty() {
        return Err(AppError::BadRequest("标题不能为空".into()));
    }

    let mut tx = state.db.begin().await?;
    require(&mut tx, user.id, id, Permission::Write).await?;

    // 别人正持有未过期的锁 → 直接拒绝。
    // 不做「等待锁」：团队规模下等几秒的收益远小于请求挂住的复杂度。
    if let Some(holder) = locking::current_holder(&mut *tx, id).await? {
        if holder.user_id != user.id {
            return Err(AppError::Conflict(format!(
                "文档正被 {} 编辑中",
                holder.display_name
            )));
        }
    }

    let before: Option<(i32,)> = sqlx::query_as(
        "SELECT r.version_no FROM documents d JOIN revisions r ON r.id = d.current_revision_id WHERE d.id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let before = before.map(|(v,)| v);

    let (revision_id, version_no) = versioning::save_revision(
        &mut *tx,
        state.tokenizer.as_ref(),
        &state.config,
        versioning::SaveInput {
            document_id: id,
            title: body.title.trim().to_string(),
            content: body.content,
            author_id: user.id,
            change_note: body.change_note,
            // 合并窗口交给领域层判断：前端不需要知道这个规则
            force_new_version: false,
        },
    )
    .await?;

    tx.commit().await?;

    Ok(Json(SaveResult {
        document_id: id,
        revision_id,
        version_no,
        merged: before == Some(version_no),
    }))
}

pub async fn revisions(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<RevisionSummary>>> {
    let mut tx = state.db.begin().await?;
    require(&mut tx, user.id, id, Permission::Read).await?;

    // LEFT JOIN 而不是 JOIN：用户被停用不会删行（软停用），但极端情况下
    // 作者记录缺失也不该让整份版本历史查不出来。
    let rows: Vec<(
        Uuid,
        i32,
        String,
        Uuid,
        Option<String>,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
    )> = sqlx::query_as(
        r#"SELECT r.id, r.version_no, r.title, r.author_id,
                  u.display_name AS author_name,
                  r.change_note, r.created_at
             FROM revisions r
             LEFT JOIN users u ON u.id = r.author_id
            WHERE r.document_id = $1
            ORDER BY r.version_no DESC"#,
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(
                |(id, version_no, title, author_id, author_name, change_note, created_at)| {
                    RevisionSummary {
                        id,
                        version_no,
                        title,
                        author_id,
                        author_name,
                        change_note,
                        created_at,
                    }
                },
            )
            .collect(),
    ))
}

pub async fn revert(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<RevertBody>,
) -> AppResult<Json<SaveResult>> {
    let mut tx = state.db.begin().await?;
    require(&mut *tx, user.id, id, Permission::Write).await?;

    let (revision_id, version_no) = versioning::revert_to(
        &mut *tx,
        state.tokenizer.as_ref(),
        &state.config,
        id,
        body.version_no,
        user.id,
    )
    .await?;

    tx.commit().await?;

    Ok(Json(SaveResult {
        document_id: id,
        revision_id,
        version_no,
        merged: false,
    }))
}

/// 软删一篇文档，连同它下面的整棵子树。
///
/// 判权用 `Write`，与 update / revert 同档（能改就能删）。**不看编辑锁**：删除是终结
/// 动作，不是协作——有人正开着编辑器不该拦住删除，他那边下一次保存会拿到 404。
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<DeleteResult>> {
    let mut tx = state.db.begin().await?;
    require(&mut tx, user.id, id, Permission::Write).await?;

    let deleted = deletion::soft_delete_subtree(&mut *tx, id).await?;
    tx.commit().await?;

    Ok(Json(DeleteResult {
        document_id: id,
        deleted_count: deleted.len(),
    }))
}

pub async fn acquire_lock(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<LockView>> {
    let mut tx = state.db.begin().await?;
    require(&mut *tx, user.id, id, Permission::Write).await?;

    let holder = locking::acquire(&mut *tx, &state.config, id, user.id).await?;
    tx.commit().await?;

    Ok(Json(LockView {
        held: holder.is_none(),
        holder,
    }))
}

/// 心跳续租。
///
/// 返回 `renewed: false` 意味着锁已经不在自己手上（过期被别人取走了），
/// 前端应当立刻提示用户「你已失去编辑锁」，而不是假装还在编辑。
pub async fn heartbeat_lock(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;
    require(&mut *tx, user.id, id, Permission::Write).await?;

    let renewed = locking::heartbeat(&mut *tx, &state.config, id, user.id).await?;
    tx.commit().await?;

    Ok(Json(serde_json::json!({ "renewed": renewed })))
}

pub async fn release_lock(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;
    require(&mut *tx, user.id, id, Permission::Write).await?;

    let released = locking::release(&mut *tx, id, user.id).await?;
    tx.commit().await?;

    Ok(Json(serde_json::json!({ "released": released })))
}

/// 权限前置检查。抽出来是为了保证每个写接口都走同一段逻辑——
/// 散落在各处理器里的判权迟早会漏掉一个。
async fn require(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    document_id: Uuid,
    need: Permission,
) -> AppResult<()> {
    match permission::effective_permission(conn, user_id, document_id).await? {
        Some(p) if p.at_least(need) => Ok(()),
        // 权限不够 → 403（用户知道自己看得见，只是不能改，这个信息他本来就有）
        Some(_) => Err(AppError::Forbidden),
        // 完全不可见 → 与「不存在」同码，避免用响应码探测文档是否存在
        None => Err(AppError::NotFound("文档不存在或已被删除".into())),
    }
}
