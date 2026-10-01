//! 各 Host 的「最近项目」：Host 启动页的数据源。**属于 GUI（跟着人走），不属于 Host**——
//! 启动页要在**不连接**那台机器的情况下列出它的最近项目（连一台离线 / 要安装的 Host 只为了
//! 列清单是错的），所以由桌面自己记：每次某个窗口打开了项目，就记在它那台 Host 名下。
//!
//! - Host 由**调用窗口**决定（`HostWindows`），前端不传、也就不会记错机器。
//! - 存 `~/.aide/gui/host-recents.json`（桌面用户的家目录，与 Host 自己的数据分目录放）。
//! - 路径是 Host 原生路径，原样存、原样还给 `open_host_window`。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{Manager, Window};

use crate::host_window::HostWindows;
use crate::remote_workspace::path::HostId;

/// 本机 Host 的主机键（远程 Host 是 `wsl:…` / `ssh:…`，见 `HostId::key`）。
pub const LOCAL_KEY: &str = "local";
/// 每台 Host 最多记多少个项目。
const MAX_PER_HOST: usize = 12;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    /// 最近一次打开（毫秒时间戳）
    pub opened_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Doc {
    #[serde(default)]
    hosts: BTreeMap<String, Vec<RecentProject>>,
}

impl Doc {
    /// 记一次打开：同路径去重后置顶，超出上限的旧项丢弃。
    fn record(&mut self, host: &str, path: &str, now_ms: i64) {
        let list = self.hosts.entry(host.to_string()).or_default();
        list.retain(|p| p.path != path);
        list.insert(0, RecentProject { path: path.to_string(), opened_at: now_ms });
        list.truncate(MAX_PER_HOST);
    }

    fn forget(&mut self, host: &str, path: &str) {
        if let Some(list) = self.hosts.get_mut(host) {
            list.retain(|p| p.path != path);
            if list.is_empty() {
                self.hosts.remove(host);
            }
        }
    }
}

/// 落盘的存储。读-改-写在同一把锁里，写走临时文件 + rename（崩溃不留半截文件）。
pub struct HostRecents {
    file: PathBuf,
    lock: Mutex<()>,
}

impl HostRecents {
    pub fn at(file: PathBuf) -> Self {
        Self { file, lock: Mutex::new(()) }
    }

    pub fn at_default_location() -> Self {
        Self::at(aide_core::paths::our_config_dir().join("gui").join("host-recents.json"))
    }

    fn load(&self) -> Doc {
        // 读不了 / 解析不了 = 当空（只是个便利清单，不值得因为它坏了而打断打开项目）
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, doc: &Doc) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.file.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }

    pub fn record(&self, host: &str, path: &str, now_ms: i64) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut doc = self.load();
        doc.record(host, path, now_ms);
        self.save(&doc)
    }

    pub fn forget(&self, host: &str, path: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut doc = self.load();
        doc.forget(host, path);
        self.save(&doc)
    }

    /// 全部 Host 的最近项目（Host 键 → 新到旧）。
    pub fn all(&self) -> BTreeMap<String, Vec<RecentProject>> {
        let _g = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.load().hosts
    }

    #[cfg(test)]
    fn path(&self) -> &std::path::Path {
        &self.file
    }
}

/// 启动页的一行：一台有历史的 Host 及它的最近项目。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecentsDto {
    pub host: String,
    pub label: String,
    pub projects: Vec<RecentProject>,
}

fn label_of(key: &str) -> String {
    if key == LOCAL_KEY {
        "本机".to_string()
    } else {
        // 键坏了（手改文件）就原样显示，不丢这条
        HostId::parse_key(key).map(|h| h.label()).unwrap_or_else(|| key.to_string())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 调用窗口连着的 Host 键：Host 窗口 = 它的 Host，其余 = 本机。
fn host_key_of(window: &Window) -> String {
    window
        .app_handle()
        .state::<HostWindows>()
        .host_of(window.label())
        .map(|h| h.key())
        .unwrap_or_else(|| LOCAL_KEY.to_string())
}

/// 记一次「本窗口的 Host 打开了这个项目」。Host 由调用窗口定。
#[tauri::command]
pub async fn host_recents_record(window: Window, path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Ok(());
    }
    let key = host_key_of(&window);
    tokio::task::spawn_blocking(move || HostRecents::at_default_location().record(&key, &path, now_ms()))
        .await
        .map_err(|e| e.to_string())?
}

/// 各 Host 的最近项目（最近打开的 Host 在前）。
#[tauri::command]
pub async fn host_recents_list() -> Result<Vec<HostRecentsDto>, String> {
    tokio::task::spawn_blocking(|| {
        let mut rows: Vec<HostRecentsDto> = HostRecents::at_default_location()
            .all()
            .into_iter()
            .map(|(host, projects)| HostRecentsDto { label: label_of(&host), host, projects })
            .filter(|r| !r.projects.is_empty())
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.projects.first().map(|p| p.opened_at).unwrap_or(0)));
        rows
    })
    .await
    .map_err(|e| e.to_string())
}

/// 从某台 Host 的最近项目里去掉一项（不动磁盘上的项目本身）。
#[tauri::command]
pub async fn host_recents_forget(host: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || HostRecents::at_default_location().forget(&host, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自清理的临时目录（桌面 crate 不引 tempfile 只为这几个测试）。
    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store() -> (TempDir, HostRecents) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aide-host-recents-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let s = HostRecents::at(dir.join("gui").join("host-recents.json"));
        (TempDir(dir), s)
    }

    fn paths(s: &HostRecents, host: &str) -> Vec<String> {
        s.all().get(host).map(|v| v.iter().map(|p| p.path.clone()).collect()).unwrap_or_default()
    }

    /// 最近的在前；重复打开同一项目 = 置顶而不是堆一条重复。
    #[test]
    fn newest_first_and_reopening_moves_to_front() {
        let (_d, s) = store();
        s.record("local", "C:\\a", 1).unwrap();
        s.record("local", "C:\\b", 2).unwrap();
        s.record("local", "C:\\a", 3).unwrap();
        assert_eq!(paths(&s, "local"), ["C:\\a", "C:\\b"]);
        assert_eq!(s.all()["local"][0].opened_at, 3);
    }

    /// 各 Host 各记各的：同一路径在两台 Host 上是两个项目，互不覆盖。
    #[test]
    fn hosts_are_independent() {
        let (_d, s) = store();
        s.record("wsl:Debian", "/home/u/proj", 1).unwrap();
        s.record("ssh:devbox", "/home/u/proj", 2).unwrap();
        assert_eq!(paths(&s, "wsl:Debian"), ["/home/u/proj"]);
        assert_eq!(paths(&s, "ssh:devbox"), ["/home/u/proj"]);
        s.forget("wsl:Debian", "/home/u/proj").unwrap();
        assert!(paths(&s, "wsl:Debian").is_empty());
        assert_eq!(paths(&s, "ssh:devbox"), ["/home/u/proj"], "forgetting on one Host leaves the other");
    }

    #[test]
    fn capped_per_host_dropping_the_oldest() {
        let (_d, s) = store();
        for i in 0..(MAX_PER_HOST + 5) {
            s.record("local", &format!("/p{i}"), i as i64).unwrap();
        }
        let got = paths(&s, "local");
        assert_eq!(got.len(), MAX_PER_HOST);
        assert_eq!(got[0], format!("/p{}", MAX_PER_HOST + 4));
        assert!(!got.contains(&"/p0".to_string()));
    }

    /// 文件坏了 / 不存在不挡路：当空，下一次记录照常写出一份好文件。
    #[test]
    fn corrupt_or_missing_file_reads_as_empty_and_recovers() {
        let (_d, s) = store();
        assert!(s.all().is_empty());
        std::fs::create_dir_all(s.path().parent().unwrap()).unwrap();
        std::fs::write(s.path(), b"{ not json").unwrap();
        assert!(s.all().is_empty());
        s.record("local", "/x", 1).unwrap();
        assert_eq!(paths(&s, "local"), ["/x"]);
    }

    #[test]
    fn labels_cover_local_remote_and_garbage_keys() {
        assert_eq!(label_of("local"), "本机");
        assert_eq!(label_of("wsl:Debian"), "WSL: Debian");
        assert_eq!(label_of("ssh:devbox"), "SSH: devbox");
        assert_eq!(label_of("???"), "???");
    }
}
