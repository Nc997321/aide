//! 认证：初始化 / 登录 / 邀请加入 / 登出 / 当前用户 / 用户管理。
//!
//! ⚠️ **刻意没有自助注册入口。**
//! 私有化部署下服务地址就在客户内网，"谁能注册"等价于"谁能进内网"，
//! 而 internal/public 空间对任何已登录用户可读 —— 开放注册等于把内网文档开给全公司。
//! 账号一律由管理员创建，被邀请人凭**一次性**链接领取。
//!
//! 口令用 argon2id 慢哈希，会话与邀请用随机令牌 + sha256 摘要存。
//! 强度不同是有意的：口令低熵必须抗离线爆破，令牌 256 位随机不需要。

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::AppState;
use super::extract::{SessionToken, hash_token, new_session_token};
use crate::error::{AppError, AppResult};
use crate::types::CurrentUser;

/// 邀请链接有效期。不做成配置项是因为它不该被调：
/// 太短管理员来不及发，太长则一条链接长期挂在外面。
const INVITE_TTL_HOURS: i64 = 24 * 7;

// ── DTO ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: Uuid,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub display_name: String,
    pub is_admin: bool,
}

/// 登录 / 初始化 / 领取邀请 三种入口都返回这个形状，
/// 前端拿到 token 存起来即可，不必区分自己是从哪条路进来的。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub token: String,
    pub user: UserView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    /// false 时前端应显示初始化页（创建第一个管理员）
    pub initialized: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapBody {
    pub username: String,
    pub display_name: String,
    /// 可空：不设口令就永远只能凭邀请链接进来
    pub password: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginBody {
    /// 用户名或邮箱都收
    pub account: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinBody {
    /// 管理员发来的邀请链接里的令牌
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteBody {
    pub username: String,
    pub display_name: String,
    pub is_admin: Option<bool>,
    /// 给了就直接落进该空间，省掉"加完人再加空间"两步走
    pub space_id: Option<Uuid>,
    pub space_role: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteResponse {
    /// 明文令牌**只在这一次响应里出现**——服务端只存哈希，丢了就只能重新生成
    pub token: String,
    pub username: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub display_name: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

impl From<CurrentUser> for UserView {
    fn from(u: CurrentUser) -> Self {
        Self {
            id: u.id,
            username: u.username,
            email: u.email,
            display_name: u.display_name,
            is_admin: u.is_admin,
        }
    }
}

// ── 处理器 ────────────────────────────────────────────────────────────

/// 这个实例有没有初始化过。空库 → false → 前端走引导页。
pub async fn status(State(state): State<AppState>) -> AppResult<Json<StatusResponse>> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&state.db)
        .await?;

    Ok(Json(StatusResponse {
        initialized: count > 0,
    }))
}

/// 创建第一个管理员。只在库里一个用户都没有时可用。
pub async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<BootstrapBody>,
) -> AppResult<Json<LoginResponse>> {
    let username = body.username.trim().to_ascii_lowercase();
    let display_name = body.display_name.trim();

    if username.is_empty() {
        return Err(AppError::BadRequest("用户名不能为空".into()));
    }
    if display_name.is_empty() {
        return Err(AppError::BadRequest("昵称不能为空".into()));
    }
    let password_hash = match body.password.as_deref() {
        Some(p) if p.len() < 8 => {
            return Err(AppError::BadRequest("口令至少 8 位".into()));
        }
        Some(p) => Some(hash_password(p)?),
        None => None,
    };
    let email = body
        .email
        .as_deref()
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty());

    // 用 `INSERT ... SELECT ... WHERE NOT EXISTS` 而不是「先 count 再 insert」：
    // 后者有 TOCTOU——两个并发请求能同时通过检查，建出两个管理员。
    // 这里判断与写入在**同一条语句**里，由 PG 保证原子。
    let row: Option<(Uuid, Option<String>)> = sqlx::query_as(
        r#"INSERT INTO users (username, email, password_hash, display_name, is_admin)
           SELECT $1, $2, $3, $4, true
            WHERE NOT EXISTS (SELECT 1 FROM users)
           RETURNING id, email"#,
    )
    .bind(&username)
    .bind(&email)
    .bind(&password_hash)
    .bind(display_name)
    .fetch_optional(&state.db)
    .await?;

    // 返回 0 行 = 库里已经有人了
    let Some((id, email)) = row else {
        return Err(AppError::Conflict("这个实例已经初始化过了".into()));
    };

    let token = new_session_token();
    insert_session(&state.db, id, &token, state.config.session_ttl_hours).await?;

    Ok(Json(LoginResponse {
        token,
        user: UserView {
            id,
            username,
            email,
            display_name: display_name.to_string(),
            is_admin: true,
        },
    }))
}

/// 口令登录。只有设过口令的账号能用——凭邀请链接进来的成员没有口令。
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> AppResult<Json<LoginResponse>> {
    let account = body.account.trim().to_ascii_lowercase();

    let row: Option<(Uuid, String, Option<String>, String, bool, Option<String>)> =
        sqlx::query_as(
            r#"SELECT id, username, email, display_name, is_admin, password_hash
                 FROM users
                WHERE is_active
                  AND (lower(username) = $1 OR lower(email) = $1)"#,
        )
        .bind(&account)
        .fetch_optional(&state.db)
        .await?;

    let (user_id, username, email, display_name, is_admin, stored_hash) = match row {
        Some(r) => r,
        // 用户不存在也要走一次 argon2：否则响应时间会泄露「这个账号存不存在」
        None => {
            let _ = hash_password(&body.password);
            return Err(AppError::Unauthorized);
        }
    };

    // 没有口令 = 邀请进来的成员。同样要消耗一次开销再拒绝。
    let Some(stored_hash) = stored_hash else {
        let _ = hash_password(&body.password);
        return Err(AppError::Unauthorized);
    };

    let parsed = PasswordHash::new(&stored_hash).map_err(|_| AppError::Unauthorized)?;
    Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed)
        .map_err(|_| AppError::Unauthorized)?;

    let token = new_session_token();
    insert_session(&state.db, user_id, &token, state.config.session_ttl_hours).await?;

    Ok(Json(LoginResponse {
        token,
        user: UserView {
            id: user_id,
            username,
            email,
            display_name,
            is_admin,
        },
    }))
}

/// 凭一次性邀请令牌换取会话，并在这一步真正创建用户。
///
/// 用户**不是在管理员点「生成链接」时创建的**，而是在被邀请人领取时创建——
/// 这样"链接没人领"就不会在库里留下一个空账号。
pub async fn join(
    State(state): State<AppState>,
    Json(body): Json<JoinBody>,
) -> AppResult<Json<LoginResponse>> {
    let hash = hash_token(body.token.trim());

    let mut tx = state.db.begin().await?;

    let inv: Option<(String, String, bool, Option<Uuid>, Option<String>)> = sqlx::query_as(
        r#"SELECT username, display_name, is_admin, space_id, space_role
             FROM invitations
            WHERE token_hash = $1
              AND used_at IS NULL
              AND expires_at > now()"#,
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;

    // 不存在 / 已用过 / 已过期 → 同一个错误，不帮人区分这几种情况
    let Some((username, display_name, is_admin, space_id, space_role)) = inv else {
        return Err(AppError::Unauthorized);
    };

    let inserted: Result<(Uuid, Option<String>), sqlx::Error> = sqlx::query_as(
        r#"INSERT INTO users (username, display_name, is_admin)
           VALUES ($1, $2, $3)
           RETURNING id, email"#,
    )
    .bind(&username)
    .bind(&display_name)
    .bind(is_admin)
    .fetch_one(&mut *tx)
    .await;

    let (user_id, email) = match inserted {
        Ok(v) => v,
        Err(e) if is_unique_violation(&e) => {
            return Err(AppError::Conflict(format!("用户名 {username} 已被占用")));
        }
        Err(e) => return Err(e.into()),
    };

    if let (Some(space_id), Some(space_role)) = (space_id, space_role) {
        sqlx::query(
            r#"INSERT INTO space_members (space_id, user_id, role)
               VALUES ($1, $2, $3)
               ON CONFLICT (space_id, user_id) DO NOTHING"#,
        )
        .bind(space_id)
        .bind(user_id)
        .bind(&space_role)
        .execute(&mut *tx)
        .await?;
    }

    // 先标记已用。哪怕后面建会话失败，这条链接也不能再用第二次——
    // 否则一次领取失败会留下一张能反复用的门票。
    sqlx::query("UPDATE invitations SET used_at = now(), used_by = $2 WHERE token_hash = $1")
        .bind(&hash)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    let token = new_session_token();
    insert_session(&mut *tx, user_id, &token, state.config.session_ttl_hours).await?;

    tx.commit().await?;

    Ok(Json(LoginResponse {
        token,
        user: UserView {
            id: user_id,
            username,
            email,
            display_name,
            is_admin,
        },
    }))
}

pub async fn logout(
    State(state): State<AppState>,
    token: SessionToken,
) -> AppResult<Json<serde_json::Value>> {
    // 登出是幂等的：令牌本来就是无效的，删不掉也不算错误。
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(hash_token(&token.0))
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn me(user: CurrentUser) -> Json<UserView> {
    Json(UserView::from(user))
}

/// 生成一条邀请链接。只有管理员能用。
pub async fn invite(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<InviteBody>,
) -> AppResult<Json<InviteResponse>> {
    if !user.is_admin {
        return Err(AppError::Forbidden);
    }

    let username = body.username.trim().to_ascii_lowercase();
    let display_name = body.display_name.trim();

    if username.is_empty() {
        return Err(AppError::BadRequest("用户名不能为空".into()));
    }
    if display_name.is_empty() {
        return Err(AppError::BadRequest("昵称不能为空".into()));
    }
    // DDL 里也有这条 CHECK，这里提前判是为了给明确错误，而不是甩一个数据库报错
    if body.space_id.is_some() != body.space_role.is_some() {
        return Err(AppError::BadRequest(
            "spaceId 与 spaceRole 必须同时给或同时不给".into(),
        ));
    }
    if let Some(r) = body.space_role.as_deref() {
        if !matches!(r, "owner" | "admin" | "editor" | "viewer") {
            return Err(AppError::BadRequest(
                "spaceRole 只能是 owner/admin/editor/viewer".into(),
            ));
        }
    }

    let token = new_session_token();
    let expires_at: DateTime<Utc> = sqlx::query_scalar(
        r#"INSERT INTO invitations
             (token_hash, username, display_name, is_admin, space_id, space_role, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::bigint * interval '1 hour'))
           RETURNING expires_at"#,
    )
    .bind(hash_token(&token))
    .bind(&username)
    .bind(display_name)
    .bind(body.is_admin.unwrap_or(false))
    .bind(body.space_id)
    .bind(&body.space_role)
    .bind(user.id)
    .bind(INVITE_TTL_HOURS)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(InviteResponse {
        token,
        username,
        expires_at,
    }))
}

pub async fn list_users(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Vec<UserRow>>> {
    if !user.is_admin {
        return Err(AppError::Forbidden);
    }

    let rows: Vec<(
        Uuid,
        String,
        Option<String>,
        String,
        bool,
        bool,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
    )> = sqlx::query_as(
        r#"SELECT id, username, email, display_name, is_admin, is_active, created_at, last_seen_at
             FROM users
            ORDER BY created_at"#,
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(
                |(id, username, email, display_name, is_admin, is_active, created_at, last_seen_at)| {
                    UserRow {
                        id,
                        username,
                        email,
                        display_name,
                        is_admin,
                        is_active,
                        created_at,
                        last_seen_at,
                    }
                },
            )
            .collect(),
    ))
}

/// 停用用户。软停用而不是删行——`revisions.author_id` 还引用着他，
/// 删掉会让历史版本失去作者。
pub async fn revoke_user(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    if !user.is_admin {
        return Err(AppError::Forbidden);
    }
    if id == user.id {
        return Err(AppError::BadRequest("不能停用自己".into()));
    }

    let r = sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound("用户不存在".into()));
    }

    // 顺带踢掉他所有会话：不然停用后旧 token 还能用到过期
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── 内部 ──────────────────────────────────────────────────────────────

/// 泛型 executor：`&PgPool` 和 `&mut PgConnection` 都能传，
/// 这样 `join` 里建会话能和"标记邀请已用"待在同一个事务里。
pub async fn insert_session<'a, E>(
    executor: E,
    user_id: Uuid,
    token: &str,
    ttl_hours: i64,
) -> AppResult<()>
where
    E: sqlx::Executor<'a, Database = sqlx::Postgres>,
{
    sqlx::query(
        r#"INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + ($3::bigint * interval '1 hour'))"#,
    )
    .bind(user_id)
    .bind(hash_token(token))
    .bind(ttl_hours)
    .execute(executor)
    .await?;

    Ok(())
}

pub fn hash_password(password: &str) -> AppResult<String> {
    // 自己出盐而不是用 `hash_password()` 的自动出盐：
    // 后者要求 password-hash 开启 getrandom 特性，而 uuid 的随机源已经够好。
    // 16 字节正是 PHC 规范推荐的盐长（uuid 恰好 16 字节）。
    Argon2::default()
        .hash_password_with_salt(password.as_bytes(), Uuid::new_v4().as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(format!("口令哈希失败：{e}")))
}

pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(
        e,
        sqlx::Error::Database(d) if d.is_unique_violation()
    )
}
