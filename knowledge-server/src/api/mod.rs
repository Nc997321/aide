//! HTTP 层：路由装配 + 请求/应答的编解码。
//!
//! 这一层只做三件事：解析请求、调 `domain`、把结果序列化。
//! **不允许出现业务规则**（权限判定、版本推进、slug 生成都不在这里），
//! 也不允许出现第三方解析库的名字——需要解析能力时从 `AppState` 上的端口拿。

use std::sync::Arc;

use axum::Router;
use axum::Json;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Method, header};
use axum::routing::{get, post};
use serde_json::json;
use sqlx::PgPool;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::port::{ParserChain, Tokenizer};

pub mod auth;
pub mod documents;
pub mod extract;
pub mod ingest;
pub mod ip_filter;
pub mod search;
pub mod spaces;

/// `/api/ingest` 的请求体上限。**必须严格大于客户端 ingest 闸**（`agent-sidecar` 的
/// `KB_INGEST_MAX_BYTES` = 32 MiB）：客户端量的是**文件大小**，这里限的是**整个 multipart
/// 体**，两者之差是分帧开销（boundary、段头、结尾，几百字节且随文件名变长）——取等号的话，
/// 恰好 32 MiB 的文件（最自然的边界用例）会在客户端放行、在这里被拒。
///
/// 为什么必须显式设：axum 的 `Multipart` 提取器走 `req.with_limited_body()`，没设
/// `DefaultBodyLimit` 时落到 axum-core 的 `DEFAULT_LIMIT = 2 MiB`。那个值太小——5 MB 的
/// PDF 会卡在那条线以下，报出来的是 multer 的读体/解析错误（`ingest.rs` 把**所有**读体
/// 失败都归成 BadRequest），从外部完全看不出是尺寸问题；客户端那道 32 MiB 闸也因此形同
/// 虚设：文件先被整份读进内存、上传，再被这里模糊拒绝。
///
/// 只挂 `/api/ingest` 一条路由，**不是全局**：其余路由都是 JSON，客户端对正文另有
/// 256 KiB/次 + 1 MiB/篇 两道闸，没必要陪着放宽——尤其 `/api/auth/*` 是未鉴权入口，
/// 让它们在读体阶段就能缓冲 32 MiB 是平白多出来的面。
const INGEST_BODY_LIMIT: usize = 32 * 1024 * 1024 + 64 * 1024;

/// 全局依赖。三个端口/配置的注入点全在这里，
/// **换实现只改 `main.rs` 里构造 `AppState` 的那几行**，本文件不动。
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    /// 文档解析链（端口）。今天是 `ParserRegistry`，明天换成别的无需改动任何调用方。
    pub parsers: Arc<dyn ParserChain>,
    /// 分词器（端口）。写入与查询共用同一个实例，保证切词结果一致。
    pub tokenizer: Arc<dyn Tokenizer>,
}

/// 按配置构造 CORS 层。
///
/// 需要它的原因见 `config::cors_allowed_origins`：前端跑在 Tauri WebView
/// （origin `http://tauri.localhost`）或独立的 dev server 上，与本服务不同源。
///
/// 只放行 `Authorization` 与 `Content-Type` 两个头，且**不开** `allow_credentials`——
/// 鉴权走 Bearer 而不是 cookie，没有凭证需要跨域携带，开了反而放宽了攻击面。
fn cors_layer(config: &Config) -> CorsLayer {
    let listed: Vec<HeaderValue> = config
        .cors_allowed_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    let origin = if config.cors_allowed_origins.iter().any(|o| o == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(listed)
    };

    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

pub fn build_router(state: AppState) -> AppResult<Router> {
    let cors = cors_layer(&state.config);

    // CIDR 解析不出来就直接拒绝启动：白名单是安全边界，
    // 静默忽略一条等于悄悄开了个洞，比起不来更糟。
    let nets: Vec<ip_filter::Net> = state
        .config
        .allowed_cidrs
        .iter()
        .map(|s| {
            ip_filter::Net::parse(s)
                .map_err(|e| AppError::Internal(format!("KB_ALLOWED_CIDR 配置错误：{e}")))
        })
        .collect::<Result<_, _>>()?;

    // 空 = 不限制，连中间件都不挂，省掉每次请求的判断
    let ip_layer = axum::middleware::from_fn(move |req, next| {
        let nets = nets.clone();
        async move { ip_filter::ip_allowlist(nets, req, next).await }
    });

    let router = Router::new()
        .route("/api/health", get(health))
        // 认证。**没有 register**——刻意不做自助注册，理由见 `auth.rs` 模块头：
        // 私有化部署下开放注册等于把内网文档开给全公司，账号一律由管理员邀请。
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/bootstrap", post(auth::bootstrap))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/join", post(auth::join))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        // 用户管理，仅管理员可用
        .route("/api/users", get(auth::list_users))
        .route("/api/users/invite", post(auth::invite))
        .route("/api/users/{id}/revoke", post(auth::revoke_user))
        // 空间
        .route("/api/spaces", get(spaces::list).post(spaces::create))
        .route("/api/spaces/{id}/documents", get(spaces::documents))
        // 文档
        .route("/api/documents", post(documents::create))
        .route(
            "/api/documents/{id}",
            get(documents::get).put(documents::update),
        )
        .route("/api/documents/{id}/revisions", get(documents::revisions))
        .route("/api/documents/{id}/revert", post(documents::revert))
        .route(
            "/api/documents/{id}/lock",
            post(documents::acquire_lock).delete(documents::release_lock),
        )
        // 心跳续租。前端必须按 KB_LOCK_TTL_SECONDS 的间隔打这个接口，
        // 否则锁会在 TTL 后过期被别人取走（取锁时顺手清过期锁）
        .route(
            "/api/documents/{id}/lock/heartbeat",
            post(documents::heartbeat_lock),
        )
        // 检索
        .route("/api/search", get(search::search))
        // 摄取。请求体上限单挂这一条（默认 2 MiB 太小，理由见 INGEST_BODY_LIMIT）
        .route(
            "/api/ingest",
            post(ingest::upload).layer(DefaultBodyLimit::max(INGEST_BODY_LIMIT)),
        )
        .route("/api/ingest/formats", get(ingest::formats))
        // 顺序有讲究：axum 里**后加的层在外层**，请求先经过它。
        // trace 最外（连被拒的请求也要留痕）→ cors 次之（被拒的响应也带 CORS 头，
        // 否则浏览器只报一句 CORS 错误，看不出其实是 403）→ IP 白名单在最内。
        .layer(ip_layer)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    Ok(router)
}

/// 健康检查。除了 status，还回报**实际装配了哪些后端**。
///
/// 这不是凑数：装配错了（比如注册表里漏注册一个后端）不会报编译错误，
/// 只会表现为「某种格式导入不了」。让它在这里可见，排障时少一轮猜测。
async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "aide-knowledge",
        "parsers": state.parsers.backend_ids(),
        "tokenizer": state.tokenizer.id(),
    }))
}
