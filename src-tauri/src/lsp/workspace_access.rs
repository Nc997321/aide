//! LSP 层碰工作区文件的**唯一出口**（端口）。
//!
//! 本机工作区直接调 `aide_workspace`；远程工作区（WSL / SSH）向目标机上的 aide-host 要
//! **同一份实现**的结果（`lsp_detect` / `lsp_representatives` / `read_file_content` /
//! `search_in_files`）。为什么不让 LSP 代码直接读 UNC 路径：SSH 工作区的「路径」在桌面上
//! 根本不存在（`\\aide-ssh.invalid\…` 是占位形态），WSL 走 9P 也慢——而 CLAUDE.md 的
//! 远程工作区红线是「一份实现，两处运行，不许回落本机」。
//!
//! 路径约定：进出本模块的路径**一律是桌面形态**（远程 = `\\wsl.localhost\…` 那种）；与
//! 目标机 POSIX 路径的互译只在这里做（真相源仍是 `remote_workspace::path`）。

use std::sync::Arc;

use aide_workspace::search::{SearchOptions, SearchResponse};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::lsp::detector::LanguageId;
use crate::remote_workspace::path::{self as rpath, HostId};
use crate::remote_workspace::RemoteWorkspaces;

/// 一个工作区根的访问方式。
pub enum WorkspaceAccess {
    Local,
    Remote {
        host: HostId,
        svc: Arc<RemoteWorkspaces>,
    },
}

impl WorkspaceAccess {
    /// 按路径形态选实现。远程路径但远程服务不在（不该发生：lib.rs 无条件 manage）→ 报错式的
    /// Remote 不可得，退回 Local 只会去读一个本机不存在的路径——结果是「探不到」而不是跑错机器。
    pub fn of(app: &AppHandle, root: &str) -> Self {
        match rpath::parse(root) {
            Some((host, _)) => match app.try_state::<Arc<RemoteWorkspaces>>() {
                Some(svc) => WorkspaceAccess::Remote {
                    host,
                    svc: Arc::clone(svc.inner()),
                },
                None => WorkspaceAccess::Local,
            },
            None => WorkspaceAccess::Local,
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, WorkspaceAccess::Remote { .. })
    }

    async fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let WorkspaceAccess::Remote { host, svc } = self else {
            return Err("not a remote workspace".into());
        };
        svc.connection(host).await?.invoke(cmd, args, None).await
    }

    /// 该工作区涉及的语言。
    pub async fn detect_languages(&self, root: &str) -> Vec<LanguageId> {
        match self {
            WorkspaceAccess::Local => {
                crate::lsp::detector::detect_languages_async(std::path::PathBuf::from(root)).await
            }
            WorkspaceAccess::Remote { .. } => self
                .remote_detect(root)
                .await
                .map(|(langs, _)| langs)
                .unwrap_or_default(),
        }
    }

    /// agent 按名查询该问哪些语言的 server：本机 = 探到的语言；远程 = 探到的且目标机上
    /// **真有服务器**、且远程支持的（没有服务器的语言每问一次就是一次注定失败的 spawn）。
    ///
    /// 短时缓存：按名查询与 grep 顺带作答一发就要一次，而探测是整仓有界遍历（远程还多一个
    /// aide-host 往返）——真机上它和失败的 spawn 一起把 1.5s 的作答预算吃光了。
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
        let langs = match self {
            WorkspaceAccess::Local => self.detect_languages(root).await,
            WorkspaceAccess::Remote { .. } => match self.remote_detect(root).await {
                Ok((_, available)) => available
                    .into_iter()
                    .filter(|l| crate::lsp::manager::remote_supported(*l))
                    .collect(),
                // 连不上：不缓存，下一发再问（空表 = 本次 no_server）。
                Err(_) => return vec![],
            },
        };
        if let Ok(mut m) = cache.lock() {
            m.insert(root.to_string(), (std::time::Instant::now(), langs.clone()));
        }
        langs
    }

    /// 远程：探到的语言 + 其中目标机上真有服务器的（`lsp_detect`）。失败 → Err（调用方降级成空）。
    pub async fn remote_detect(&self, root: &str) -> Result<(Vec<LanguageId>, Vec<LanguageId>), String> {
        let posix = posix_of(root)?;
        let v = self.call("lsp_detect", json!({ "root": posix })).await?;
        let ids = |key: &str| -> Vec<LanguageId> {
            v.get(key)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .filter_map(crate::lsp::detector::lang_from_id_str)
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok((ids("languages"), ids("available")))
    }

    /// 该语言的代表文件（桌面形态、正斜杠），最多 `max` 个。
    pub async fn representative_sources(&self, root: &str, lang: LanguageId, max: usize) -> Vec<String> {
        match self {
            WorkspaceAccess::Local => {
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
            WorkspaceAccess::Remote { host, .. } => {
                let Ok(posix) = posix_of(root) else { return vec![] };
                let args = json!({ "root": posix, "lang": lang.id_str(), "max": max });
                match self.call("lsp_representatives", args).await {
                    Ok(Value::Array(a)) => a
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|p| rpath::to_desktop(host, p).replace('\\', "/"))
                        .collect(),
                    Ok(_) => vec![],
                    Err(e) => {
                        tracing::info!(host = %host, error = %e, "lsp: remote representative sources failed");
                        vec![]
                    }
                }
            }
        }
    }

    /// 读一个文本文件（didOpen 递给 server 的正文 / 把命中挪到名字上）。
    pub async fn read_text(&self, path: &str) -> Result<String, String> {
        match self {
            WorkspaceAccess::Local => {
                let path = path.to_string();
                tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())
            }
            WorkspaceAccess::Remote { .. } => {
                let posix = posix_of(path)?;
                match self.call("read_file_content", json!({ "path": posix })).await? {
                    Value::String(s) => Ok(s),
                    other => Err(format!("unexpected read_file_content result: {other}")),
                }
            }
        }
    }

    /// 在工作区里做一次文件内容搜索（结果里的 `file` 是相对根的路径，两端同形）。
    pub async fn search(&self, root: &str, query: &str, options: SearchOptions) -> Result<SearchResponse, String> {
        match self {
            WorkspaceAccess::Local => {
                let root = root.to_string();
                let query = query.to_string();
                tokio::task::spawn_blocking(move || {
                    aide_workspace::search::search_in_files_blocking(&query, &root, &options)
                })
                .await
                .map_err(|e| e.to_string())?
            }
            WorkspaceAccess::Remote { .. } => {
                let posix = posix_of(root)?;
                let v = self
                    .call(
                        "search_in_files",
                        json!({ "query": query, "cwd": posix, "options": options }),
                    )
                    .await?;
                serde_json::from_value(v).map_err(|e| format!("bad search result: {e}"))
            }
        }
    }
}

fn posix_of(desktop: &str) -> Result<String, String> {
    rpath::parse(desktop)
        .map(|(_, p)| p)
        .ok_or_else(|| format!("not a remote path: {desktop}"))
}
