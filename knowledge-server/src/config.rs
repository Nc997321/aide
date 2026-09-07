//! 配置加载。
//!
//! 每一项都有默认值：缺了就用默认，不静默用错值。
//! `.env` 只作补充，不覆盖真实环境变量（方便容器里用 env 注入）。

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub db_url: String,
    pub host: String,
    pub port: u16,
    /// 附件与导入产物的落盘目录
    pub storage_dir: PathBuf,
    pub session_ttl_hours: i64,
    /// 编辑软锁有效期，前端需在此间隔内心跳续租
    pub lock_ttl_seconds: i64,
    /// 同一作者对同一文档的连续保存合并窗口，避免边写边存堆出一串无意义版本
    pub revision_merge_window_seconds: i64,
    /// 允许跨域的前端来源，逗号分隔。`*` = 全部放行（仅本机开发用）。
    ///
    /// 为什么必须可配：Tauri v2 的 WebView 页面 origin 是 `http://tauri.localhost`，
    /// 与本服务（`http://127.0.0.1:8788`）**不同源**，请求一律走 CORS 预检。
    /// 独立部署的 web 前端同理。
    pub cors_allowed_origins: Vec<String>,
    /// 允许访问的来源网段（CIDR，逗号分隔）。**留空 = 不限制**。
    ///
    /// 这是网络层准入，不是身份识别——内网私有化部署时用来把外网整个挡在门外。
    /// 例：`192.168.1.0/24,10.0.0.0/8`
    pub allowed_cidrs: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        // 读不到 .env 不是错误——环境变量可能已经由部署环境注入
        let _ = dotenvy::dotenv();

        Self {
            db_url: env("KB_DB_URL", "postgres://postgres:postgres@127.0.0.1:5432/aide_kb"),
            host: env("KB_HOST", "127.0.0.1"),
            port: env_parse("KB_PORT", 8788),
            storage_dir: PathBuf::from(env("KB_STORAGE_DIR", "./storage")),
            session_ttl_hours: env_parse("KB_SESSION_TTL_HOURS", 24 * 14),
            lock_ttl_seconds: env_parse("KB_LOCK_TTL_SECONDS", 300),
            revision_merge_window_seconds: env_parse("KB_REVISION_MERGE_WINDOW_SECONDS", 300),
            cors_allowed_origins: env_list(
                "KB_CORS_ALLOWED_ORIGINS",
                // 默认放行三种形态：Tauri v2 打包版（tauri://localhost）、Tauri v2 dev
                // （WebView 加载 http://tauri.localhost）与本机 tauri dev 的前端 dev server
                // （vite.config.ts 把端口钉在 1420，不是 5173——之前写 5173 是错的）。
                // 独立部署的浏览器前端（如 http://localhost:5173 裸 vite）不在默认里，
                // 需要时用 KB_CORS_ALLOWED_ORIGINS 显式加。
                "http://tauri.localhost,tauri://localhost,http://localhost:1420",
            ),
            allowed_cidrs: env_list("KB_ALLOWED_CIDR", ""),
        }
    }
}

fn env_list(key: &str, default: &str) -> Vec<String> {
    env(key, default)
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
