//! 目录树的结构规则。
//!
//! 「父必须是文件夹」「不能移进自己的子树」是**结构**约束，不是权限约束，
//! 也不该散落在 API 层——接口层只负责把请求翻译成对领域函数的调用。
//!
//! 与 `domain/deletion.rs` 的分工：那边管「删掉一棵子树」，这边管「能不能接上去」。

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// 祖先链的长度上限。
///
/// `visited` 已经挡住了环，这一层挡的是「环检测失效但链极长」的退化情形——
/// 宁可截断也不能让一个请求挂住（`parent_id` 是用户数据）。
const MAX_DEPTH: usize = 256;

/// 沿 `parent_id` 向上走，返回祖先链（不含自己，从最近的父开始）。
///
/// `visited` 不能省：链本身成环时（`a→b→a`）不加它会无限循环。用应用层而不是
/// `WITH RECURSIVE`，是因为 PostgreSQL 的递归 CTE 遇到环会**无限循环**
/// （除非额外带 `CYCLE` 子句），而这里带一个集合就够了。
pub async fn ancestors(conn: &mut PgConnection, node_id: Uuid) -> AppResult<Vec<Uuid>> {
    let mut chain = Vec::new();
    let mut visited = std::collections::HashSet::new();
    visited.insert(node_id);

    let mut cursor = parent_of(conn, node_id).await?;
    while let Some(pid) = cursor {
        if !visited.insert(pid) || chain.len() >= MAX_DEPTH {
            break;
        }
        chain.push(pid);
        cursor = parent_of(conn, pid).await?;
    }
    Ok(chain)
}

async fn parent_of(conn: &mut PgConnection, node_id: Uuid) -> AppResult<Option<Uuid>> {
    let row: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT parent_id FROM documents WHERE id = $1 AND deleted_at IS NULL")
            .bind(node_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(row.and_then(|(p,)| p))
}

/// 把 `node_id` 挂到 `new_parent_id` 下会不会成环（目标在自己的子树里）。
pub async fn would_cycle(
    conn: &mut PgConnection,
    node_id: Uuid,
    new_parent_id: Uuid,
) -> AppResult<bool> {
    if node_id == new_parent_id {
        return Ok(true);
    }
    Ok(ancestors(conn, new_parent_id).await?.contains(&node_id))
}

/// 目标父必须是**同一个空间里的文件夹**。
///
/// 两层校验合在一个函数里，是因为它们的失败后果同属一类（请求本身不合法），
/// 且调用方永远需要两者同时成立——拆成两个函数只会让调用方写成 `a()?; b()?`
/// 而漏掉其中一个。
pub async fn ensure_parent_is_folder(
    conn: &mut PgConnection,
    space_id: Uuid,
    parent_id: Uuid,
) -> AppResult<()> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT space_id, kind FROM documents WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(parent_id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        None => Err(AppError::BadRequest("父节点不存在".into())),
        Some((_, kind)) if kind != "folder" => {
            Err(AppError::BadRequest("只能在文件夹下建立子节点".into()))
        }
        Some((parent_space, _)) if parent_space != space_id => {
            Err(AppError::BadRequest("父节点不属于该空间".into()))
        }
        Some(_) => Ok(()),
    }
}
