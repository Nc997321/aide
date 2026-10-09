//! aide-knowledge —— 团队共享知识库服务。
//!
//! 分层：`api` → `domain` → `port` ← `adapter`
//! 依赖方向永远朝内，`adapter` 是唯一允许出现第三方解析/分词库的目录。
//!
//! 全进程只有一处把具体实现接到端口上，就是下面 `main` 里那几行 `Arc::new`。
//! 换解析库、换分词算法、换附件存储，改那里即可，`domain/` 与 `api/` 一行不动。

mod adapter;
mod api;
mod config;
mod db;
mod domain;
mod error;
mod port;
mod types;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;

use crate::adapter::blob_store::FilesystemBlobStore;
use crate::adapter::parser::ParserRegistry;
use crate::adapter::registry::RegistryChannel;
use crate::adapter::tokenizer::JiebaTokenizer;
use crate::api::{AppState, build_router};
use crate::config::Config;
use crate::domain::locking;
use crate::port::{BlobStore, ParserChain, ReleaseChannel, Tokenizer};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "aide_knowledge=info,tower_http=info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env());

    let pool: PgPool = db::create_pool(&config).await?;
    let applied = db::migrate(&pool).await?;
    if applied.is_empty() {
        tracing::info!("数据库迁移均为最新");
    } else {
        tracing::info!(migrations = ?applied, "已应用迁移");
    }

    spawn_lock_reaper(pool.clone());

    // ⚠️ 唯一的实现注入点。
    // 想换解析后端（例如把 docx-to-md 换成 office_oxide）、换分词实现，
    // 或把附件存储换成对象存储，只改这几行以及 adapter 下对应的实现文件。
    let parsers: Arc<dyn ParserChain> = Arc::new(ParserRegistry::with_defaults());
    let tokenizer: Arc<dyn Tokenizer> = Arc::new(JiebaTokenizer::new());
    let blobs: Arc<dyn BlobStore> = Arc::new(FilesystemBlobStore::new(&config.storage_dir));
    let releases: Arc<dyn ReleaseChannel> = match &config.release_repo {
        Some(repo) => Arc::new(RegistryChannel::new(repo)),
        None => Arc::new(crate::port::release_channel::Disabled),
    };

    let state = AppState {
        db: pool,
        config: config.clone(),
        parsers,
        tokenizer,
        blobs,
        releases: Arc::new(crate::domain::release::LatestRelease::new(releases)),
        // 进程内存态：重启即全部失效，这是预览票据的设计语义（见 domain/preview_token.rs）
        previews: Arc::new(crate::domain::preview_token::PreviewTokens::new()),
    };

    let app = build_router(state)?;
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    tracing::info!(addr = %listener.local_addr()?, "aide-knowledge 已启动");

    // 必须带 connect info：IP 白名单中间件靠 ConnectInfo<SocketAddr> 拿对端地址，
    // 少了这一句拿不到 IP，配了 KB_ALLOWED_CIDR 会把所有请求都挡掉。
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

/// 定时清理过期的编辑锁。
///
/// 取锁时已经顺手清掉目标文档那一行，所以这个任务只是兜底——
/// 有人取了锁再也没回来（关页面、断网），锁会在 TTL 后由这里回收。
fn spawn_lock_reaper(pool: PgPool) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(3600));
        loop {
            ticker.tick().await;

            let mut conn = match pool.acquire().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(error = %e, "清理锁时获取连接失败");
                    continue;
                }
            };

            match locking::purge_expired(&mut conn).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(released = n, "已清理过期编辑锁"),
                Err(e) => tracing::warn!(error = %e, "清理过期编辑锁失败"),
            }
        }
    });
}
