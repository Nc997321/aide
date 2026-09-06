//! 检索入口。
//!
//! 第一版只有全文一路（PG tsvector + 应用层中文分词）。
//! 向量与 rerank 留了口子但没接——在只有几百篇文档时，
//! 全文 + 短语高亮的命中质量远好于「先跑个 embedding 再说」。

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::AppState;
use crate::domain::search;
use crate::error::AppResult;
use crate::types::{CurrentUser, SearchHit};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub q: String,
    pub space_id: Option<Uuid>,
    pub limit: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub query: String,
    pub hits: Vec<SearchHit>,
}

pub async fn search(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<SearchParams>,
) -> AppResult<Json<SearchResponse>> {
    let mut tx = state.db.begin().await?;

    // 权限过滤在领域层做（readable_document_ids），这里不重复实现一遍。
    // 检索结果天然是「权限内」的，不存在先搜后滤导致的分页错位。
    let hits = search::search_full_text(
        &mut *tx,
        state.tokenizer.as_ref(),
        user.id,
        &params.q,
        params.space_id,
        params.limit.unwrap_or(20),
    )
    .await?;

    Ok(Json(SearchResponse {
        query: params.q,
        hits,
    }))
}
