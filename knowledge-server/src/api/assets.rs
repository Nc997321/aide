//! 资源取用：文档正文里的 `asset://<uuid>` 由它服务。
//!
//! 这一层只做三件事：查资源行、校验读权限、把字节发出去。
//! 权限判定走 `domain::permission`，本文件不含业务规则。
//!
//! 为什么返回 `inline` 而不是 `attachment`：它要能直接作为 `<img src>` 的响应体
//! 被浏览器渲染，而不是触发下载。前端也不是直接用 `<img src>` 指这里 ——
//! 那样发不出 `Authorization` 头，见 design spec §8.2。

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use super::AppState;
use crate::domain::permission;
use crate::error::{AppError, AppResult};
use crate::types::{CurrentUser, Permission};

/// MIME → `Content-Type` 头。任何不合法或缺失的值都退化成 `application/octet-stream`。
///
/// ⚠️ **不能只靠 `unwrap_or_else`**：`HeaderValue::from_str("")` 是 `Ok`（空头值合法），
/// 所以空 MIME 必须显式判掉，否则会发出一个空的 `Content-Type`。
///
/// 不 `unwrap`：这个值来自数据库，而带 CRLF 的脏值会让构造失败 ——
/// 那时候 500 是错的，发一个「未知类型」的 200 才对（一张图的问题不该看起来像服务挂了）。
pub fn content_type_header(mime: &str) -> HeaderValue {
    if mime.trim().is_empty() {
        return HeaderValue::from_static("application/octet-stream");
    }
    HeaderValue::from_str(mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let mut conn = state.db.acquire().await?;

    let row: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT document_id, mime, storage_key FROM assets WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;

    let Some((document_id, mime, storage_key)) = row else {
        return Err(AppError::NotFound("资源不存在".into()));
    };

    // 权限按**所属文档**判定 —— 与文档正文的可见性完全一致：
    // 看得见正文就看得见图，看不见就都看不见。
    let allowed = permission::effective_permission(&mut conn, user.id, document_id)
        .await?
        .map(|p| p.at_least(Permission::Read))
        .unwrap_or(false);
    if !allowed {
        return Err(AppError::Forbidden);
    }
    drop(conn);

    // 文件 IO → 移出 tokio 工作线程（端口是同步的）
    let blobs = state.blobs.clone();
    let bytes = tokio::task::spawn_blocking(move || blobs.get(&storage_key))
        .await
        .map_err(|e| AppError::Internal(format!("取资源任务异常退出：{e}")))??;

    Ok((
        [
            (header::CONTENT_TYPE, content_type_header(&mime)),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("inline"),
            ),
            // private：响应依赖 Authorization，绝不能被共享缓存存下来
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=3600"),
            ),
        ],
        Body::from(bytes),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::content_type_header;

    #[test]
    fn accepts_valid_mime() {
        assert_eq!(
            content_type_header("image/png").to_str().unwrap(),
            "image/png"
        );
        assert_eq!(
            content_type_header("image/jpeg").to_str().unwrap(),
            "image/jpeg"
        );
    }

    /// 带 CRLF 的值构不出合法头（注入尝试或脏数据）。
    /// 这时发一个「未知类型」的 200 才对 —— 500 会让一张图的问题看起来像服务挂了。
    #[test]
    fn falls_back_for_invalid_mime() {
        assert_eq!(
            content_type_header("not a mime\r\nX-Injected: 1")
                .to_str()
                .unwrap(),
            "application/octet-stream"
        );
    }

    /// ⚠️ 空串是**合法**的头值（`HeaderValue::from_str("")` 返回 Ok），
    /// 所以它不会走 `unwrap_or_else` 那条路，必须显式判空。
    #[test]
    fn empty_mime_falls_back_explicitly() {
        assert_eq!(
            content_type_header("").to_str().unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_header("   ").to_str().unwrap(),
            "application/octet-stream"
        );
    }
}
