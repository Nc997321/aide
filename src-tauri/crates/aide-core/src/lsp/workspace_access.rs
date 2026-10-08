//! LSP 层碰工作区文件的**唯一出口**。
//!
//! Host 模型下 LSP 与工作区在同一台机器上（一个窗口 = 一个 Host，WSL / SSH 工作区的 LSP 就跑在
//! 那台 Host 的 aide-core 里），所以这里只是本机实现：探测走 `aide_workspace` 的同一份探测，
//! 读文件 / 搜索直接落本机文件系统。保留成一个出口的理由不变——LSP 代码不各自 `std::fs`，
//! 读法只在这里定一次。

use aide_workspace::search::{SearchOptions, SearchResponse};

use crate::lsp::detector::LanguageId;

/// 一个工作区根的访问方式（Host 上的本机文件系统）。
pub struct WorkspaceAccess;

impl WorkspaceAccess {
    pub fn of(_root: &str) -> Self {
        WorkspaceAccess
    }

    /// 该工作区涉及的语言。
    pub async fn detect_languages(&self, root: &str) -> Vec<LanguageId> {
        crate::lsp::detector::detect_languages_async(std::path::PathBuf::from(root)).await
    }

    /// agent 按名查询该问哪些语言的 server（= 探到的语言）。
    ///
    /// 短时缓存：按名查询与 grep 顺带作答一发就要一次，而探测是整仓有界遍历——不缓存会把
    /// 1.5s 的作答预算吃光。
    pub async fn queryable_languages(&self, root: &str) -> Vec<LanguageId> {
        type Cache = std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<LanguageId>)>>;
        static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
        const TTL: std::time::Duration = std::time::Duration::from_secs(30);
        let cache = CACHE.get_or_init(Default::default);
        if let Some((at, langs)) = cache.lock().ok().and_then(|m| m.get(root).cloned()) {
            if at.elapsed() < TTL {
                return langs;
            }
        }
        let langs = self.detect_languages(root).await;
        if let Ok(mut m) = cache.lock() {
            m.insert(root.to_string(), (std::time::Instant::now(), langs.clone()));
        }
        langs
    }

    /// 该语言的代表文件（正斜杠），最多 `max` 个。
    pub async fn representative_sources(&self, root: &str, lang: LanguageId, max: usize) -> Vec<String> {
        let root = std::path::PathBuf::from(root);
        tokio::task::spawn_blocking(move || {
            crate::lsp::detector::representative_sources(&root, lang, max)
                .into_iter()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .collect()
        })
        .await
        .unwrap_or_default()
    }

    /// 读一个文本文件（didOpen 递给 server 的正文 / 把命中挪到名字上）。
    pub async fn read_text(&self, path: &str) -> Result<String, String> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }

    /// 在工作区里做一次文件内容搜索（结果里的 `file` 是相对根的路径）。
    pub async fn search(&self, root: &str, query: &str, options: SearchOptions) -> Result<SearchResponse, String> {
        let root = root.to_string();
        let query = query.to_string();
        tokio::task::spawn_blocking(move || {
            aide_workspace::search::search_in_files_blocking(&query, &root, &options)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}
