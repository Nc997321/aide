//! 「有新版本」提示的数据来源：`GET /api/update/status`（登录即可看）。
//!
//! 知识库服务装在用户自己的服务器上，以前出了新版没人知道。这里回答「当前是哪版、最新
//! 发布的是哪版、从哪个仓库拉」，界面据此提示并给出升级命令（命令里带上目标版本——
//! 用户的 `.env` / 旧 compose 文件可能钉着旧版本号，见前端 updateBanner.ts）。
//! **本服务不执行升级**：升级仍是管理员在服务器上跑那条命令。

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use super::AppState;
use crate::error::AppResult;
use crate::types::CurrentUser;

#[derive(Deserialize)]
pub struct StatusQuery {
    /// 带上 = 跳过「最新版」缓存（用户点了「检查更新」）
    refresh: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// 本服务当前版本（与 /api/health 同源；本地构建是 `dev`）
    current: String,
    /// 发布渠道上的最新版本；查不到为 null，原因在 error
    latest: Option<String>,
    /// 镜像仓库地址（拼升级命令用）；没配发布渠道为 null
    repo: Option<String>,
    /// 查询失败的原因（离线内网、仓库私有…）。界面不拿它吓人，只用于排障
    error: Option<String>,
}

pub async fn status(
    State(state): State<AppState>,
    _user: CurrentUser,
    Query(q): Query<StatusQuery>,
) -> AppResult<Json<UpdateStatus>> {
    let repo = state.releases.repo().map(str::to_string);
    let (latest, error) = if repo.is_some() {
        match state.releases.latest(q.refresh.is_some()).await {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(e)),
        }
    } else {
        (None, None)
    };
    Ok(Json(UpdateStatus { current: state.config.version.clone(), latest, repo, error }))
}
