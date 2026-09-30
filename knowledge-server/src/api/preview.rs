//! 取件地址：让「库里的产物」有一个**能直接导航过去**的只读地址。
//!
//! 两条路由，一签一兑：
//!   - `POST /api/documents/{id}/preview-token`（要 Bearer）：签一张短时票
//!   - `GET  /p/{token}`（**不要** Bearer）：凭票取原件
//!
//! 为什么兑票口不挂鉴权：右栏内嵌浏览器是直接导航过来的，发不出
//! `Authorization` 头（与 `assetLoader.ts` 走 objectURL 同一个原因）。
//! 票本身就是权限——**但只换得来那一份条目的只读字节**，换不来账号、换不来写。
//! 第三步「发布」复用同一条通路，只是把票换成持久的那种（spec §4.6）。

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use uuid::Uuid;

use super::AppState;
use super::documents::require;
use crate::error::{AppError, AppResult};
use crate::types::{CurrentUser, DocumentKind, Permission};

/// 预览票据的有效期。短是有意的：它是「点一下马上打开」的票据，
/// 不是发布链接——过期了回资料库再点一次就行。
const PREVIEW_TTL_SECS: i64 = 600;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTokenResponse {
    pub token: String,
    /// Unix 秒。前端据此提示「几分钟后失效」，不参与鉴权判定。
    pub expires_at: i64,
}

/// 签票。判权**沿用文档读权限**（看得见正文才拿得到预览地址）。
pub async fn mint_token(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<PreviewTokenResponse>> {
    let mut conn = state.db.acquire().await?;
    require(&mut conn, user.id, id, Permission::Read).await?;

    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM documents WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    if kind.as_deref().and_then(|k| DocumentKind::try_from(k).ok()) == Some(DocumentKind::Folder) {
        return Err(AppError::BadRequest("文件夹没有正文，不能预览".into()));
    }
    drop(conn);

    let (token, expires_at) = state.previews.mint(id, PREVIEW_TTL_SECS);
    Ok(Json(PreviewTokenResponse { token, expires_at }))
}

/// 取件。凭票换原件字节——票失效、条目被删都走 404，文案写清下一步。
pub async fn fetch(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Response> {
    let Some(document_id) = state.previews.redeem(&token) else {
        return Err(AppError::NotFound(
            "这个预览链接已失效，请回到资料库重新打开".into(),
        ));
    };

    let mut conn = state.db.acquire().await?;
    let row: Option<(String, String)> = sqlx::query_as(
        r#"SELECT d.mime, r.content
             FROM documents d
             JOIN revisions r ON r.id = d.current_revision_id
            WHERE d.id = $1 AND d.deleted_at IS NULL"#,
    )
    .bind(document_id)
    .fetch_optional(&mut *conn)
    .await?;
    drop(conn);

    let Some((mime, content)) = row else {
        // 条目在票的有效期里被删了 —— 与票失效同一句话，用户要做的是同一件事
        return Err(AppError::NotFound(
            "这个预览链接已失效，请回到资料库重新打开".into(),
        ));
    };

    Ok((
        [
            (header::CONTENT_TYPE, preview_content_type(&mime)),
            // 地址自带凭据且短时有效，任何一层缓存把它存下来都是错的
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            ),
        ],
        Body::from(content),
    )
        .into_response())
}

/// mime → `Content-Type` 头。
///
/// 预览的是**给人看的产物**，所以不认识/缺失的类型退化成 `text/plain; charset=utf-8`
/// 而不是 `application/octet-stream`（后者会让浏览器直接下载，白屏）。
/// `text/*` 一律补 `charset=utf-8`——库里存的都是 UTF-8 文本，不补的话
/// 中文在部分浏览器里会按 latin-1 解出乱码。
fn preview_content_type(mime: &str) -> HeaderValue {
    let mime = mime.trim();
    if mime.is_empty() {
        return HeaderValue::from_static("text/plain; charset=utf-8");
    }
    let with_charset = if mime.starts_with("text/") && !mime.contains("charset") {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };
    HeaderValue::from_str(&with_charset)
        .unwrap_or_else(|_| HeaderValue::from_static("text/plain; charset=utf-8"))
}

#[cfg(test)]
mod tests {
    use super::preview_content_type;

    #[test]
    fn html_gets_a_charset() {
        assert_eq!(
            preview_content_type("text/html").to_str().unwrap(),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn explicit_charset_is_left_alone() {
        assert_eq!(
            preview_content_type("text/html; charset=gbk").to_str().unwrap(),
            "text/html; charset=gbk"
        );
    }

    /// 未知/空类型退化成能**显示**的纯文本，而不是触发下载的 octet-stream。
    #[test]
    fn unknown_mime_degrades_to_plain_text() {
        assert_eq!(
            preview_content_type("").to_str().unwrap(),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            preview_content_type("   ").to_str().unwrap(),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            preview_content_type("not a mime\r\nX-Injected: 1")
                .to_str()
                .unwrap(),
            "text/plain; charset=utf-8"
        );
    }
}
