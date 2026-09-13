//! 统一错误类型与 HTTP 响应。
//!
//! 所有处理器返回 `AppResult<T>`，错误由 `IntoResponse` 统一转成 JSON。
//! 好处：处理器里只管 `?`，不用到处写状态码映射。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::port::{BlobError, ParseError};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("未登录")]
    Unauthorized,

    #[error("没有权限")]
    Forbidden,

    #[error("请求参数有误：{0}")]
    BadRequest(String),

    #[error("资源不存在：{0}")]
    NotFound(String),

    #[error("冲突：{0}")]
    Conflict(String),

    #[error("{0}")]
    Parse(#[from] ParseError),

    #[error("数据库错误")]
    Database(#[from] sqlx::Error),

    #[error("内部错误：{0}")]
    Internal(String),

    #[error("存储错误：{0}")]
    Blob(#[from] BlobError),
}

pub type AppResult<T> = Result<T, AppError>;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AppError::Parse(_) => (StatusCode::UNPROCESSABLE_ENTITY, "parse_failed"),
            AppError::Database(_) | AppError::Internal(_) | AppError::Blob(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            }
        };

        // 5xx 才打 error 日志。4xx 是客户端的事，打了就是噪音。
        if status.is_server_error() {
            tracing::error!(error = %self, "请求失败");
        }

        (
            status,
            Json(json!({
                "error": code,
                "message": self.to_string(),
            })),
        )
            .into_response()
    }
}
