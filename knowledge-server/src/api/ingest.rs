//! 摄取入口：上传文件 → 解析 → 落成文档。
//!
//! ⚠️ 这个文件的价值在于它**什么解析逻辑都没有**。
//! 它只做三件事：把上传的字节落盘、把 CPU 密集的解析丢给 `spawn_blocking`、
//! 把领域层产出的结果序列化。解析由谁完成、怎么分派、失败了怎么回退，
//! 全是 `port::ParserChain` 那一侧的事。
//!
//! 于是「换掉 docx-to-md」这个动作的改动面 = 一个 adapter 文件，
//! 本文件与 `domain::ingest` 一行都不用动。

use axum::Json;
use axum::extract::{Multipart, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::AppState;
use crate::domain::{ingest, permission};
use crate::error::{AppError, AppResult};
use crate::types::{CurrentUser, Permission};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadQuery {
    pub space_id: Uuid,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResponse {
    pub document_id: Uuid,
    pub revision_id: Uuid,
    pub title: String,
    /// 实际生效的解析后端。留痕是为了排障：
    /// 「这篇文档为什么结构丢了」——一看 backend 就知道它回落过。
    pub backend: String,
    /// 解析器自报的降级信息，例如「含图片 12 张，已跳过」
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatsResponse {
    pub extensions: Vec<String>,
}

pub async fn formats(State(state): State<AppState>) -> Json<FormatsResponse> {
    Json(FormatsResponse {
        extensions: state.parsers.supported_extensions(),
    })
}

pub async fn upload(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<IngestResponse>)> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("读取上传内容失败：{e}")))?
        .ok_or_else(|| AppError::BadRequest("请求体里没有文件字段".into()))?;

    let file_name = field
        .file_name()
        .unwrap_or("upload.bin")
        .to_string();

    let data = field
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("读取文件内容失败：{e}")))?;

    if data.is_empty() {
        return Err(AppError::BadRequest("上传的文件是空的".into()));
    }

    let mut tx = state.db.begin().await?;

    let allowed = permission::space_role(&mut *tx, user.id, query.space_id)
        .await?
        .map(|r| r.base_permission().at_least(Permission::Write))
        .unwrap_or(false);
    if !allowed {
        return Err(AppError::Forbidden);
    }
    tx.commit().await?;

    // 落盘。文件名加 uuid 前缀，避免同名文件互相覆盖，
    // 也避免原始文件名里的路径分隔符造成目录穿越。
    tokio::fs::create_dir_all(&state.config.storage_dir)
        .await
        .map_err(|e| AppError::Internal(format!("创建存储目录失败：{e}")))?;

    let safe_name = sanitize_file_name(&file_name);
    let stored_name = format!("{}_{}", Uuid::new_v4().simple(), safe_name);
    let stored_path = state.config.storage_dir.join(stored_name);

    tokio::fs::write(&stored_path, &data)
        .await
        .map_err(|e| AppError::Internal(format!("写入文件失败：{e}")))?;

    let input = ingest::IngestInput {
        space_id: query.space_id,
        parent_id: query.parent_id,
        original_name: file_name,
        stored_path: stored_path.clone(),
        author_id: user.id,
    };

    // 解析是 CPU 密集的同步操作，必须挪出 tokio 的工作线程。
    // 这一步也是端口发挥作用的时刻：这里只知道有个 ParserChain，
    // 不知道背后是 docx-to-md、docx-lite 还是 pdf-extract。
    let parsers = state.parsers.clone();
    let parse_input = input.clone();
    let parsed = tokio::task::spawn_blocking(move || {
        ingest::parse_file(parsers.as_ref(), &parse_input)
    })
    .await
    .map_err(|e| AppError::Internal(format!("解析任务异常退出：{e}")))??;

    let mut tx = state.db.begin().await?;
    let outcome = ingest::ingest_parsed(&mut *tx, state.tokenizer.as_ref(), &input, parsed).await?;
    tx.commit().await?;

    tracing::info!(
        document_id = %outcome.document_id,
        backend = outcome.backend,
        size_bytes = data.len(),
        "文档摄取完成"
    );

    Ok((
        StatusCode::CREATED,
        Json(IngestResponse {
            document_id: outcome.document_id,
            revision_id: outcome.revision_id,
            title: outcome.title,
            backend: outcome.backend.to_string(),
            warnings: outcome.warnings,
        }),
    ))
}

/// 只保留文件名部分，并剔除路径分隔符。
///
/// 不能只靠前端传来的名字—— multipart 的 filename 是客户端可控的，
/// 直接用它拼路径就是目录穿越。
fn sanitize_file_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("upload.bin")
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect::<String>();

    if base.trim().is_empty() {
        "upload.bin".to_string()
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_file_name;

    #[test]
    fn strips_path_traversal() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\tmp\\a.docx"), "a.docx");
    }
}
