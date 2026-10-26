//! LSP 层碰工作区文件的**唯一出口**。
//!
//! Host 模型下 LSP 与工作区在同一台机器上（一个窗口 = 一个 Host，WSL / SSH 工作区的 LSP 就跑在
//! 那台 Host 的 aide-core 里），所以这里只是本机实现：探测走 `aide_workspace` 的同一份探测，
//! 读文件 / 搜索直接落本机文件系统。保留成一个出口的理由不变——LSP 代码不各自 `std::fs`，
//! 读法只在这里定一次。

use aide_workspace::search::{SearchOptions, SearchResponse};

use crate::lsp::detector::LanguageId;

type QueryDetectionCache = std::sync::Mutex<
    std::collections::HashMap<
        String,
        (std::time::Instant, crate::lsp::detector::LanguageDetection),
    >,
>;
static QUERY_DETECTION_CACHE: std::sync::OnceLock<QueryDetectionCache> = std::sync::OnceLock::new();

fn query_detection_cache() -> &'static QueryDetectionCache {
    QUERY_DETECTION_CACHE.get_or_init(Default::default)
}

/// 一个工作区根的访问方式（Host 上的本机文件系统）。
pub struct WorkspaceAccess;

impl WorkspaceAccess {
    pub fn of(_root: &str) -> Self {
        WorkspaceAccess
    }

    /// 获取新鲜的项目语言与真实源码语言探测报告。
    pub async fn language_detection(&self, root: &str) -> crate::lsp::detector::LanguageDetection {
        crate::lsp::detector::detect_workspace_languages_async(std::path::PathBuf::from(root)).await
    }

    /// agent 按名查询该问哪些语言的 server（= 探到的语言）。
    ///
    /// 短时缓存：按名查询与 grep 顺带作答一发就要一次，而探测是整仓有界遍历——不缓存会把
    /// 1.5s 的作答预算吃光。缓存完整报告，但仅投影其广义并集给 Agent；UI 与预检始终走新鲜探测。
    pub async fn queryable_languages(&self, root: &str) -> Vec<LanguageId> {
        const TTL: std::time::Duration = std::time::Duration::from_secs(30);
        let cache = query_detection_cache();
        if let Some((at, report)) = cache.lock().ok().and_then(|m| m.get(root).cloned()) {
            if at.elapsed() < TTL {
                return report.query_languages();
            }
        }
        let report = self.language_detection(root).await;
        let langs = report.query_languages();
        if let Ok(mut m) = cache.lock() {
            m.insert(root.to_string(), (std::time::Instant::now(), report));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::workspace_langs::{decide_preflight, LspPreflight, PreflightLang};

    fn preflight(langs: Vec<LanguageId>) -> LspPreflight {
        let langs = langs
            .into_iter()
            .map(|l| PreflightLang {
                lang: l.id_str().into(),
                installed: false,
                pack_id: Some("python"),
            })
            .collect();
        decide_preflight(true, false, false, langs)
    }

    #[tokio::test]
    async fn project_preflight_and_agent_query_use_distinct_report_projections() {
        let root =
            std::env::temp_dir().join(format!("aide_preflight_projects_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts/main.py"), "").unwrap();
        std::fs::write(root.join("scripts/helper.py"), "").unwrap();
        let path = root.to_string_lossy().into_owned();
        let access = WorkspaceAccess::of(&path);
        let report = access.language_detection(&path).await;
        assert!(report.project_languages.is_empty());
        assert!(report.source_languages.contains(&LanguageId::Python));
        assert_eq!(
            preflight(report.project_languages.clone()),
            LspPreflight::Nothing
        );
        assert!(access
            .queryable_languages(&path)
            .await
            .contains(&LanguageId::Python));

        // 同一个 scripts 目录一旦是有清单的项目，也应正常推荐；不是目录黑名单。
        std::fs::write(
            root.join("scripts/pyproject.toml"),
            "[project]\nname = 'tool'\n",
        )
        .unwrap();
        let fresh = access.language_detection(&path).await;
        assert_eq!(fresh.project_languages, vec![LanguageId::Python]);
        assert_eq!(
            preflight(fresh.project_languages.clone()),
            LspPreflight::Ask {
                langs: vec![PreflightLang {
                    lang: "python".into(),
                    installed: false,
                    pack_id: Some("python"),
                }],
            }
        );

        // Agent 的原报告在 TTL 内仍是初次探测，UI/预检的新鲜探测不覆盖它。
        let (cached_at, cached) = query_detection_cache()
            .lock()
            .unwrap()
            .get(&path)
            .unwrap()
            .clone();
        assert!(cached_at.elapsed() < std::time::Duration::from_secs(30));
        assert!(cached.project_languages.is_empty());
        assert!(cached.source_languages.contains(&LanguageId::Python));
        assert!(access
            .queryable_languages(&path)
            .await
            .contains(&LanguageId::Python));
        {
            let mut cache = query_detection_cache().lock().unwrap();
            cache.get_mut(&path).unwrap().0 =
                std::time::Instant::now() - std::time::Duration::from_secs(31);
        }
        assert!(access
            .queryable_languages(&path)
            .await
            .contains(&LanguageId::Python));
        let (_, refreshed) = query_detection_cache()
            .lock()
            .unwrap()
            .get(&path)
            .unwrap()
            .clone();
        assert_eq!(refreshed.project_languages, vec![LanguageId::Python]);
        std::fs::remove_dir_all(root).unwrap();
        query_detection_cache().lock().unwrap().remove(&path);
    }

    #[tokio::test]
    async fn preflight_project_languages_of_aide_exclude_python() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let path = root.to_string_lossy();
        let report = WorkspaceAccess::of(&path).language_detection(&path).await;
        assert!(
            report.project_languages.contains(&LanguageId::Rust),
            "{report:?}"
        );
        assert!(
            report.project_languages.contains(&LanguageId::TypeScript),
            "{report:?}"
        );
        assert!(
            !report.project_languages.contains(&LanguageId::Python),
            "{report:?}"
        );
    }
}
