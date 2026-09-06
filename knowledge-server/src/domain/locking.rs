//! 编辑软锁。
//!
//! `document_locks` 的主键就是 `document_id`，所以一篇文档同一时刻
//! 只可能有一行——不需要额外的互斥逻辑，靠主键冲突就够了。

use chrono::{DateTime, Utc};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::config::Config;
use crate::error::AppResult;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockHolder {
    pub user_id: Uuid,
    pub display_name: String,
    pub expires_at: DateTime<Utc>,
}

/// 取锁。
///
/// 返回 `Ok(None)` = 拿到锁；`Ok(Some(holder))` = 被别人持有。
pub async fn acquire(
    conn: &mut PgConnection,
    config: &Config,
    document_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<LockHolder>> {
    // 先清掉已过期的锁，让「别人忘了放锁」不至于把文档锁死到定时任务跑为止
    sqlx::query("DELETE FROM document_locks WHERE document_id = $1 AND expires_at <= now()")
        .bind(document_id)
        .execute(&mut *conn)
        .await?;

    let inserted: Option<(Uuid,)> = sqlx::query_as(
        r#"INSERT INTO document_locks (document_id, user_id, expires_at)
           VALUES ($1, $2, now() + ($3::bigint * interval '1 second'))
           ON CONFLICT (document_id) DO NOTHING
           RETURNING document_id"#,
    )
    .bind(document_id)
    .bind(user_id)
    .bind(config.lock_ttl_seconds)
    .fetch_optional(&mut *conn)
    .await?;

    if inserted.is_some() {
        return Ok(None);
    }

    current_holder(&mut *conn, document_id).await
}

/// 心跳续租。条件里带 user_id，所以别人抢到锁之后，
/// 前持有人的迟到心跳不会把锁续回去。
pub async fn heartbeat(
    conn: &mut PgConnection,
    config: &Config,
    document_id: Uuid,
    user_id: Uuid,
) -> AppResult<bool> {
    let res = sqlx::query(
        r#"UPDATE document_locks
              SET heartbeat_at = now(),
                  expires_at   = now() + ($3::bigint * interval '1 second')
            WHERE document_id = $1 AND user_id = $2"#,
    )
    .bind(document_id)
    .bind(user_id)
    .bind(config.lock_ttl_seconds)
    .execute(&mut *conn)
    .await?;

    Ok(res.rows_affected() > 0)
}

pub async fn release(
    conn: &mut PgConnection,
    document_id: Uuid,
    user_id: Uuid,
) -> AppResult<bool> {
    let res = sqlx::query("DELETE FROM document_locks WHERE document_id = $1 AND user_id = $2")
        .bind(document_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;

    Ok(res.rows_affected() > 0)
}

/// 清理全部过期锁，供定时任务调用。
/// `acquire` 里已经顺手清了目标文档那一行，这个扫全表是兜底。
pub async fn purge_expired(conn: &mut PgConnection) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM document_locks WHERE expires_at <= now()")
        .execute(&mut *conn)
        .await?;

    Ok(res.rows_affected())
}

/// 当前持锁人（含已过期但尚未被清理的情况），不存在则返回 None。
/// 保存接口用它判断「是不是别人正在编辑」。
pub async fn current_holder(
    conn: &mut PgConnection,
    document_id: Uuid,
) -> AppResult<Option<LockHolder>> {
    let row: Option<(Uuid, String, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT l.user_id, u.display_name, l.expires_at
             FROM document_locks l
             JOIN users u ON u.id = l.user_id
            WHERE l.document_id = $1"#,
    )
    .bind(document_id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.map(|(user_id, display_name, expires_at)| LockHolder {
        user_id,
        display_name,
        expires_at,
    }))
}
