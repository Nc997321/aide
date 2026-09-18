//! 权限计算。
//!
//! **权限合并只发生在这个文件里**，不散落到 SQL，也不散落到 API 层。

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::AppResult;
use crate::types::{Permission, Role, Visibility};

fn perm_from_str(s: &str) -> Option<Permission> {
    match s {
        "read" => Some(Permission::Read),
        "write" => Some(Permission::Write),
        "admin" => Some(Permission::Admin),
        _ => None,
    }
}

/// 单篇文档的权限判定。语义是**继承 + 提升**：
///
/// 1. space 角色给出基础权限（不是该 space 成员则 None）
/// 2. `document_acl` 里显式授予的，**只提升不降低**
/// 3. space 非私有 → 所有人至少 read
///
/// 想给某人降权请改 `space_members.role`，不要指望 `document_acl`——
/// 它一旦允许降权就成了第二个权限真相源，会和 space 角色打架。
pub async fn effective_permission(
    conn: &mut PgConnection,
    user_id: Uuid,
    document_id: Uuid,
) -> AppResult<Option<Permission>> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        r#"SELECT d.space_id, s.visibility
             FROM documents d
             JOIN spaces s ON s.id = d.space_id
            WHERE d.id = $1 AND d.deleted_at IS NULL"#,
    )
    .bind(document_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some((space_id, visibility)) = row else {
        return Ok(None);
    };

    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2",
    )
    .bind(space_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;

    let acl: Option<String> = sqlx::query_scalar(
        "SELECT permission FROM document_acl WHERE document_id = $1 AND user_id = $2",
    )
    .bind(document_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;

    let mut perm = role
        .as_deref()
        .and_then(|r| Role::try_from(r).ok())
        .map(Role::base_permission);

    perm = Permission::stronger(perm, acl.as_deref().and_then(perm_from_str));

    // 可见性只放 read。不能靠「空间是 public」拿到写权限。
    if Visibility::try_from(visibility.as_str()).ok() != Some(Visibility::Private) {
        perm = Permission::stronger(perm, Some(Permission::Read));
    }

    Ok(perm)
}

/// 列出用户可读的文档 id，供检索做前置过滤。
///
/// 关于「不要把权限逻辑塞进 SQL」——那条原则说的是不做**权限推理**。
/// 而这里是**集合筛选**，几千个 id 拉回应用层算不现实，必须在 SQL 里做。
/// 它只做扁平的三路 OR，不做等级合并；等级合并仍然只有 `effective_permission` 一处。
///
/// 两处语义不会分叉：三路里任意一路命中都意味着至少 read
/// （角色最低是 read、可见性给的是 read、ACL 最低也是 read），
/// 所以「能否读」恰好等价于这三路 OR。
pub async fn readable_document_ids(
    conn: &mut PgConnection,
    user_id: Uuid,
    space_id: Option<Uuid>,
) -> AppResult<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        r#"SELECT d.id
             FROM documents d
             LEFT JOIN space_members m
                    ON m.space_id = d.space_id AND m.user_id = $1
             LEFT JOIN document_acl a
                    ON a.document_id = d.id AND a.user_id = $1
            WHERE d.deleted_at IS NULL
              AND ($2::uuid IS NULL OR d.space_id = $2)
              AND (
                    m.role IS NOT NULL
                 OR d.space_id IN (SELECT id FROM spaces WHERE visibility <> 'private')
                 OR a.permission IS NOT NULL
              )"#,
    )
    .bind(user_id)
    .bind(space_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// 用户在某个 space 里的角色，不在则返回 None
pub async fn space_role(
    conn: &mut PgConnection,
    user_id: Uuid,
    space_id: Uuid,
) -> AppResult<Option<Role>> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2",
    )
    .bind(space_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(role.as_deref().and_then(|r| Role::try_from(r).ok()))
}

/// 「在某个位置建/放节点」的写权限：有父判父，无父判 space 角色。
///
/// 建新节点（`api::documents::create`）与移动已有节点（`api::documents::patch`）
/// 共用这一条判据——两处各写一遍迟早漂移，而这类漂移的表现是「能建但不能移」，
/// 或者更糟的反向：**只判源节点不判目标位置**，于是能把自己的文档搬进一个
/// 自己没有写权限的文件夹。
pub async fn may_write_under(
    conn: &mut PgConnection,
    user_id: Uuid,
    space_id: Uuid,
    parent_id: Option<Uuid>,
) -> AppResult<bool> {
    let perm = match parent_id {
        Some(pid) => effective_permission(conn, user_id, pid).await?,
        None => space_role(conn, user_id, space_id)
            .await?
            .map(Role::base_permission),
    };
    Ok(perm.map(|p| p.at_least(Permission::Write)).unwrap_or(false))
}
