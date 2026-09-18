//! 空间（Space）：知识库的顶层容器。
//!
//! Space 是**权限的边界**：成员角色在 Space 上定义，文档默认继承，
//! `document_acl` 只能在此基础上提升。所以「谁能看到什么」这个问题的
//! 第一层答案永远在这里。

use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::AppState;
use super::auth::is_unique_violation;
use crate::domain::permission;
use crate::error::{AppError, AppResult};
use crate::types::{CurrentUser, DocumentKind, Role, Visibility};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceView {
    pub id: Uuid,
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: String,
    /// 当前用户在该空间里的角色，不是成员则为 null
    pub role: Option<Role>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSpaceBody {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    /// doc 有正文与版本历史，folder 是纯容器。前端据此决定图标与「点击是否开正文」
    pub kind: DocumentKind,
    pub slug: String,
    pub title: String,
    pub version_no: i32,
    pub status: String,
    pub updated_at: DateTime<Utc>,
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<SpaceView>>> {
    let rows: Vec<(Uuid, String, String, Option<String>, String, Option<String>)> = sqlx::query_as(
        r#"SELECT s.id, s.key, s.name, s.description, s.visibility, m.role
             FROM spaces s
             LEFT JOIN space_members m
                    ON m.space_id = s.id AND m.user_id = $1
            WHERE s.visibility <> 'private' OR m.user_id IS NOT NULL
            ORDER BY s.name"#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(id, key, name, description, visibility, role)| SpaceView {
                id,
                key,
                name,
                description,
                visibility,
                role: role.as_deref().and_then(|r| Role::try_from(r).ok()),
            })
            .collect(),
    ))
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateSpaceBody>,
) -> AppResult<Json<SpaceView>> {
    let key = body.key.trim().to_ascii_lowercase();
    validate_key(&key)?;

    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("空间名称不能为空".into()));
    }

    let visibility = match body.visibility.as_deref().unwrap_or("private") {
        "private" => Visibility::Private,
        "internal" => Visibility::Internal,
        "public" => Visibility::Public,
        other => {
            return Err(AppError::BadRequest(format!("未知的可见性：{other}")));
        }
    };

    // 建空间与「创建者是 owner」必须同事务：否则会出现无人管理的孤儿空间
    let mut tx = state.db.begin().await?;

    let inserted: Result<(Uuid,), sqlx::Error> = sqlx::query_as(
        r#"INSERT INTO spaces (key, name, description, visibility, owner_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id"#,
    )
    .bind(&key)
    .bind(name)
    .bind(&body.description)
    .bind(visibility_to_str(visibility))
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await;

    let (space_id,) = match inserted {
        Ok(v) => v,
        Err(e) if is_unique_violation(&e) => {
            return Err(AppError::Conflict(format!("空间标识 {key} 已被占用")));
        }
        Err(e) => return Err(e.into()),
    };

    sqlx::query(
        "INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(space_id)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(SpaceView {
        id: space_id,
        key,
        name: name.to_string(),
        description: body.description,
        visibility: visibility_to_str(visibility).to_string(),
        role: Some(Role::Owner),
    }))
}

/// 空间下的文档树（扁平列表，前端按 parent_id 组装成树）。
pub async fn documents(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(space_id): Path<Uuid>,
) -> AppResult<Json<Vec<DocumentSummary>>> {
    let mut tx = state.db.begin().await?;

    let visibility: Option<String> =
        sqlx::query_scalar("SELECT visibility FROM spaces WHERE id = $1")
            .bind(space_id)
            .fetch_optional(&mut *tx)
            .await?;

    let Some(visibility) = visibility else {
        return Err(AppError::NotFound("空间不存在".into()));
    };

    let role = permission::space_role(&mut *tx, user.id, space_id).await?;

    // 非成员 + 私有空间 = 看不见任何东西（不只是看不见列表）
    if role.is_none()
        && Visibility::try_from(visibility.as_str()).ok() == Some(Visibility::Private)
    {
        return Err(AppError::Forbidden);
    }

    let readable = permission::readable_document_ids(&mut *tx, user.id, Some(space_id)).await?;

    if readable.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // title 取 d.title（标题已从 revisions 上移到节点本身）；version_no 仍需
    // LEFT JOIN revisions，文件夹没有 revision → COALESCE 成 0。
    //
    // ⚠️ ORDER BY 只提供**稳定**顺序，真正的节点顺序由前端组装树时决定（同一条规则
    // 写两遍：文件夹优先、名称升序）。让 SQL 与前端一致的意义是不会出现「SQL 排了
    // 一种、前端排了另一种」的错位。
    let rows: Vec<(Uuid, Option<Uuid>, String, String, String, i32, String, DateTime<Utc>)> =
        sqlx::query_as(
            r#"SELECT d.id, d.parent_id, d.kind, d.slug, d.title,
                      COALESCE(r.version_no, 0) AS version_no,
                      d.status,
                      d.updated_at
                 FROM documents d
                 LEFT JOIN revisions r ON r.id = d.current_revision_id
                WHERE d.space_id = $1
                  AND d.deleted_at IS NULL
                  AND d.id = ANY($2::uuid[])
                ORDER BY (d.kind = 'folder') DESC, d.title, d.id"#,
        )
        .bind(space_id)
        .bind(&readable)
        .fetch_all(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(
        rows.into_iter()
            .map(
                |(id, parent_id, kind, slug, title, version_no, status, updated_at)| {
                    DocumentSummary {
                        id,
                        parent_id,
                        // DB 里是 text + CHECK，理论上只可能两个合法值之一；
                        // 万一出现意外值，退化成 doc 而不是让整个请求 500
                        kind: DocumentKind::try_from(kind.as_str()).unwrap_or(DocumentKind::Doc),
                        slug,
                        title,
                        version_no,
                        status,
                        updated_at,
                    }
                },
            )
            .collect(),
    ))
}

fn validate_key(key: &str) -> AppResult<()> {
    if key.len() < 2 || key.len() > 40 {
        return Err(AppError::BadRequest(
            "空间标识长度需在 2~40 之间".into(),
        ));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::BadRequest(
            "空间标识只能包含小写字母、数字与连字符".into(),
        ));
    }
    Ok(())
}

fn visibility_to_str(v: Visibility) -> &'static str {
    match v {
        Visibility::Private => "private",
        Visibility::Internal => "internal",
        Visibility::Public => "public",
    }
}
