//! 登录态提取。
//!
//! 做成一个 axum extractor，是为了让「必须登录」变成签名上的一件事：
//! 处理器形参里写了 `CurrentUser`，就自动带上鉴权，不需要在每个函数体开头手写检查。

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::AppState;
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::types::CurrentUser;

/// 会话令牌 → 落库用的摘要。
///
/// 只存摘要不存原文：DB 泄露时令牌不能被直接复用。
/// 用 sha256 而不是 argon2——令牌本身是 256 位随机数，没有低熵问题，
/// 不需要慢哈希，而登录接口每个请求都要查一次，慢哈希纯属浪费。
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn new_session_token() -> String {
    // 两个 v4 拼成 64 个 hex 字符。uuid 的随机源已经够用，不额外引 rand。
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// 从 `Authorization: Bearer <token>` 里取令牌。
///
/// ⚠️ 刻意**不用 cookie**：Tauri v2 的 WebView 页面 origin 是 `http://tauri.localhost`，
/// 与本服务不同源。跨站 cookie 会被 `SameSite=Lax` 挡掉；改成 `SameSite=None`
/// 又强制要求 `Secure`，而本机是 http——两条路都走不通，这是死结，不是配置问题。
///
/// Bearer token 顺带带来三个好处：服务端无状态（查 sessions 表即可）、
/// 三种前端（Tauri / 独立 web / 手机 PWA）共用同一套鉴权、
/// 不用碰浏览器 cookie 那套 `SameSite`/`Secure`/`credentials` 的相互作用。
pub fn token_from_headers(parts: &Parts) -> Option<String> {
    let header = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    header
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

pub async fn resolve_user(
    pool: &PgPool,
    config: &Config,
    token: &str,
) -> AppResult<CurrentUser> {
    let hash = hash_token(token);

    // 两条时间线上的判据，缺一不可：
    //   - `expires_at > now()`：滑动窗口（会被下面的续期推后）
    //   - `created_at > 下界`：**绝对上限**（钉死在创建时刻，续期推不动它）
    // 下界由 domain::session 算出，不把天数硬编进 SQL——那样就测不到了。
    let hard_bound =
        crate::domain::session::earliest_live_created_at(chrono::Utc::now(), config.session_hard_ttl_hours);

    let row: Option<(Uuid, String, Option<String>, String, bool)> = sqlx::query_as(
        r#"SELECT u.id, u.username, u.email, u.display_name, u.is_admin
             FROM sessions s
             JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1
              AND s.expires_at > now()
              AND s.created_at > $2
              AND u.is_active"#,
    )
    .bind(&hash)
    .bind(hard_bound)
    .fetch_optional(pool)
    .await?;

    let Some((id, username, email, display_name, is_admin)) = row else {
        // 令牌不存在、已过期、超过绝对上限返回同一个错误：
        // 不帮攻击者区分这几种情况
        return Err(AppError::Unauthorized);
    };

    slide_session(pool, config, &hash).await;
    Ok(CurrentUser {
        id,
        username,
        email,
        display_name,
        is_admin,
    })
}

/// 滑动续期（节流）。
///
/// 鉴权**已经通过**之后才走这里，所以它只是「顺便把窗口往后挪」：
/// 只有快到期了（剩余不足一个节流窗口）才写库，不然每个请求都写一次纯属浪费。
/// 失败只记日志、不影响这次请求——续期不成的最坏后果是用户下次要重新登录，
/// 而不是这次请求失败。
async fn slide_session(pool: &PgPool, config: &Config, hash: &str) {
    let now = chrono::Utc::now();
    let threshold =
        crate::domain::session::slide_threshold(now, config.session_ttl_hours, SLIDE_THROTTLE_HOURS);

    // ⚠️ 续期**不**受绝对上限截断：窗口可以推到 created_at + hard_ttl 之后，
    //    但那没用——上面那条 `created_at > 下界` 判据与 expires_at 无关，
    //    到了绝对死线照样 401。
    let res = sqlx::query(
        r#"UPDATE sessions
              SET expires_at = now() + ($2::bigint * interval '1 hour')
            WHERE token_hash = $1
              AND expires_at < $3"#,
    )
    .bind(hash)
    .bind(config.session_ttl_hours)
    .bind(threshold)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::warn!(error = %e, "会话续期失败（不影响本次请求）");
    }
}

/// 续期节流窗口：一天最多续一次。写成常量而不是配置项——
/// 它只影响写库频率，不是安全参数（安全参数是 TTL 与绝对上限）。
const SLIDE_THROTTLE_HOURS: i64 = 24;

/// 原始会话令牌。登出要用它删 session 行——`CurrentUser` 里没有令牌本身。
pub struct SessionToken(pub String);

impl FromRequestParts<AppState> for SessionToken {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        token_from_headers(parts)
            .map(SessionToken)
            .ok_or(AppError::Unauthorized)
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = token_from_headers(parts).ok_or(AppError::Unauthorized)?;

        resolve_user(&state.db, &state.config, &token).await
    }
}
