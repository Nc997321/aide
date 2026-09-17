//! 书签（收藏夹）：领域类型 + 存储 + 导入编排。
//!
//! **边界**：书签是浏览器子系统的**旁支数据能力**——不参与引擎/注册表/事件，故不挂在
//! `BrowserFacade` 上（门面编排的是"视图"相关能力）。命令层与未来的 agent 工具都直接调本模块。
//! 这正好是"机制/用途分离"的落地：存储只认识「一条 URL + 标题」，谁写进来的、从哪个文件导入的，
//! 它不认识——所以用户手点收藏、导入文件、将来 agent 自己收藏，三条来源共用同一条 `add` 路径。
//!
//! **落盘**：`~/.aide/browser/bookmarks.json`（Aide 自有数据树，与 sessions / observatory 同范式），
//! 原子写。文件损坏时**隔离不静默覆盖**：改名成 `bookmarks.json.corrupt-<ms>` 后按空库继续——
//! 旧数据留在磁盘上可人工恢复，功能也不会因为一个坏文件彻底挂掉。
//!
//! **去重键 = URL**（归一化后比较，`https://a.com` 与 `https://a.com/` 是同一条）。
//!
//! **目录**（schema v2）：`folders` 是从外到内的路径分段，空 = 根级散条。v1 老文件靠
//! `#[serde(default)]` 原样读成"根级、无目录"——**没有显式迁移代码**；那批条目由下次导入**认领**
//! 目录（见 [`BookmarkStore::import`]，去重键是 URL，所以认领就是"按 URL 找到那条、补上目录"）。

pub mod parse;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::browser::core::url_guard;
use crate::browser::favicons::{self, FaviconStore};
use crate::commands::our_config_dir;

/// id 里的进程内序号（与毫秒时间戳合成，跨进程也几乎不可能撞）。
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 读-改-写串行化：UI 点收藏与导入可能并发进来，防丢失更新（进程内足够——单桌面实例是唯一写者）。
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// 一条收藏。字段私有走访问器（M1 禁贫血：改动只经存储层，不散落改字段）。
/// serde derive 在**本模块内**生成，私有字段照样能序列化。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    id: String,
    title: String,
    url: String,
    /// 目录路径，从外到内（如 `["工作", "漳蒲"]`）；空 = 根级散条。
    /// `#[serde(default)]` 就是 v1→v2 的全部迁移：老文件没这个字段 → 读成空 = 根级。
    #[serde(default)]
    folders: Vec<String>,
    added_at: i64,
}

impl Bookmark {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    /// 目录路径（空 = 根级）。
    pub fn folders(&self) -> &[String] {
        &self.folders
    }
    pub fn added_at(&self) -> i64 {
        self.added_at
    }
}

/// 落盘形态。带版本号：v1 = 扁平（无 `folders`）、v2 = 带目录。v1 文件靠 `#[serde(default)]`
/// 直接读成 v2 形状，所以**没有单独的迁移代码**——版本号的意义是让磁盘上的文件自己说清是哪种。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BookmarkFile {
    version: u32,
    bookmarks: Vec<Bookmark>,
}

const FILE_VERSION: u32 = 2;

impl Default for BookmarkFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            bookmarks: Vec::new(),
        }
    }
}

/// 导入结果——**如实上报**：新增多少、补目录多少、跳过多少（重复 URL）、丢弃多少（没过 `url_guard`）、
/// 图标落盘多少。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportReport {
    pub added: usize,
    /// 同 URL 已存在、库里那条没目录而文件里有 → 原位补上了目录的条数（见 [`BookmarkStore::import`]）。
    pub adopted: usize,
    pub skipped: usize,
    pub invalid: usize,
    /// 真的写进图标缓存的条数。**这是"图标到底进来没有"的唯一可见信号**——2026-09-17 那次
    /// 「导入后全是地球图标」排查，卡就卡在这条数当时不存在：写入失败被静默吞掉，UI 上看不出
    /// 是"文件没带图标"还是"带了但没存进去"。
    pub icons: usize,
}

/// 一条候选并进书签表的结局（[`merge_candidate`] 的返回，由 [`ImportReport::count`] 记账）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Merge {
    Added,
    Adopted,
    Skipped,
}

impl ImportReport {
    /// 记一笔结局——**并条只管改表、计数只管数数**，两件事分开（`merge_candidate` 的返回值直接落位）。
    fn count(&mut self, outcome: Merge) {
        match outcome {
            Merge::Added => self.added += 1,
            Merge::Adopted => self.adopted += 1,
            Merge::Skipped => self.skipped += 1,
        }
    }
}

#[derive(Debug)]
pub enum StoreError {
    Io(String),
    UrlRejected(String),
    /// 锁中毒（别的线程 panic 在持锁期）：状态不可信。
    LockPoisoned,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(detail) => write!(f, "bookmarks storage error: {detail}"),
            StoreError::UrlRejected(detail) => write!(f, "url rejected: {detail}"),
            StoreError::LockPoisoned => write!(f, "bookmarks lock poisoned"),
        }
    }
}

impl std::error::Error for StoreError {}

/// 书签存储。默认位置：`~/.aide/browser/bookmarks.json`；图标缓存与之同级。
///
/// 图标缓存是**注入进来的**、不在 `import` 里现取：导入时要往里种图标，测试必须能把它指到临时
/// 目录——否则跑一次单测就往用户真实的 `~/.aide` 里写东西。
#[derive(Debug, Clone)]
pub struct BookmarkStore {
    path: PathBuf,
    favicons: FaviconStore,
}

impl BookmarkStore {
    pub fn at_default_location() -> Self {
        Self {
            path: our_config_dir().join("browser").join("bookmarks.json"),
            favicons: FaviconStore::at_default_location(),
        }
    }

    /// 指定路径。**只给测试用**：生产路径只有默认位置一条（否则"书签存哪"会有第二个答案）。
    /// 图标缓存跟着落在书签文件旁边（同样不碰真实 `~/.aide`）。
    #[cfg(test)]
    pub fn at(path: PathBuf) -> Self {
        let favicons = FaviconStore::at(
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join("favicons"),
        );
        Self { path, favicons }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[cfg(test)]
    pub fn favicons(&self) -> &FaviconStore {
        &self.favicons
    }

    /// 全部收藏（按写入顺序；文件不存在 = 空库）。
    pub fn list(&self) -> Result<Vec<Bookmark>, StoreError> {
        Ok(self.load()?.bookmarks)
    }

    /// 加一条。**过 `url_guard`**（书签文件里的 `javascript:` / `chrome://` 进不来）；
    /// 同 URL 已存在则原样返回既有那条（幂等，重复点 ★ 不会堆一堆）。
    pub fn add(&self, title: &str, url_raw: &str) -> Result<Bookmark, StoreError> {
        let _guard = FILE_LOCK.lock().map_err(|_| StoreError::LockPoisoned)?;
        let url = url_guard::guard(url_raw).map_err(|e| StoreError::UrlRejected(e.to_string()))?;
        let normalized = url.as_str().to_string();

        let mut file = self.load()?;
        if let Some(existing) = file.bookmarks.iter().find(|b| b.url == normalized) {
            return Ok(existing.clone());
        }

        let title = title.trim();
        let bookmark = Bookmark {
            id: new_id(),
            title: if title.is_empty() {
                normalized.clone()
            } else {
                title.to_string()
            },
            url: normalized,
            // ★ 收藏没有"选目录"这一步（UI 没这个入口）→ 落在根层，留着用户自己整理。
            folders: Vec::new(),
            added_at: now_ms(),
        };
        file.bookmarks.push(bookmark.clone());
        self.save(&file)?;
        Ok(bookmark)
    }

    /// 删一条。返回是否真的删到（未知 id → `false`，不报错——UI 的删除是幂等动作）。
    pub fn remove(&self, id: &str) -> Result<bool, StoreError> {
        let _guard = FILE_LOCK.lock().map_err(|_| StoreError::LockPoisoned)?;
        let mut file = self.load()?;
        let before = file.bookmarks.len();
        file.bookmarks.retain(|b| b.id != id);
        if file.bookmarks.len() == before {
            return Ok(false);
        }
        self.save(&file)?;
        Ok(true)
    }

    /// 导入：解析（两种通用格式，按内容嗅探）→ 过 `url_guard` → 按 URL 去重**合并**。
    ///
    /// 逐条三选一（**只增不删**：导入是"搬进来"，不是"替换"）：
    /// - 新 URL → 新增，带文件里的目录；
    /// - 同 URL 已存在、**库里那条没目录而文件里有** → 原位补目录（`adopted`）——这就是"不用删
    ///   数据、把同一份文件再导一次就自愈"，v1 扁平导进来的那批靠它升级；
    /// - 其余已存在 → 跳过，**什么都不改**（手动整理过的目录不会被文件冲掉）。
    pub fn import(&self, raw: &str) -> Result<ImportReport, StoreError> {
        let parsed = parse::parse_any(raw).map_err(|e| StoreError::Io(e.to_string()))?;
        let _guard = FILE_LOCK.lock().map_err(|_| StoreError::LockPoisoned)?;
        let mut file = self.load()?;

        let mut report = ImportReport::default();
        for candidate in parsed {
            let Ok(url) = url_guard::guard(&candidate.url) else {
                report.invalid += 1;
                continue;
            };
            let normalized = url.as_str().to_string();
            if seed_icon(&self.favicons, &normalized, candidate.icon.as_deref()) {
                report.icons += 1;
            }
            report.count(merge_candidate(&mut file.bookmarks, normalized, candidate));
        }

        // 认领也算写：否则刷新就回退成没目录。
        if report.added > 0 || report.adopted > 0 {
            self.save(&file)?;
        }
        Ok(report)
    }

    // ── 文件读写 ──

    fn load(&self) -> Result<BookmarkFile, StoreError> {
        if !self.path.exists() {
            return Ok(BookmarkFile::default());
        }
        let text = fs::read_to_string(&self.path)
            .map_err(|e| StoreError::Io(format!("{}: {e}", self.path.display())))?;
        match serde_json::from_str::<BookmarkFile>(&text) {
            Ok(file) => Ok(file),
            // 损坏 → 隔离后按空库继续（旧文件留在磁盘可人工恢复，功能不因坏文件挂掉）。
            Err(_) => {
                let quarantine = self
                    .path
                    .with_extension(format!("json.corrupt-{}", now_ms()));
                let _ = fs::rename(&self.path, &quarantine);
                Ok(BookmarkFile::default())
            }
        }
    }

    fn save(&self, file: &BookmarkFile) -> Result<(), StoreError> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| StoreError::Io(format!("{} has no parent", self.path.display())))?;
        fs::create_dir_all(dir).map_err(|e| StoreError::Io(format!("{}: {e}", dir.display())))?;
        let json = serde_json::to_string_pretty(file)
            .map_err(|e| StoreError::Io(format!("serialize: {e}")))?;
        write_atomic(&self.path, &json)
    }
}

/// 把导入文件里的 `ICON` 种进图标缓存（[`BookmarkStore::import`] 的逐条动作之一）。
/// 返回**是否真的落盘**，计数进 `ImportReport::icons`。
///
/// 两件是刻意的：**不合法就丢**（校验在 `favicons::decode_data_uri`，唯一守门处）、**写失败不回滚
/// 导入**（图标是装饰，下次导入会重来）。但失败**不再静默**——不计数，报告里那条就少，"图标进来
/// 没有"在 UI 上直接看得见（这正是上次排查缺的那条线索）。
fn seed_icon(store: &FaviconStore, url: &str, raw: Option<&str>) -> bool {
    let Some(icon) = raw.and_then(favicons::decode_data_uri) else {
        return false;
    };
    store.put(url, &icon).is_ok()
}

/// 把一条候选并进书签表（[`BookmarkStore::import`] 的逐条动作）。
///
/// **认领只认"库里那条没目录"**：已经有目录的不动——文件不该冲掉用户的选择（也冲不掉将来手动
/// 整理的结果）。三条分支各自只改该改的东西，返回值交给调用方记账。
fn merge_candidate(
    bookmarks: &mut Vec<Bookmark>,
    normalized: String,
    candidate: parse::ParsedBookmark,
) -> Merge {
    if let Some(existing) = bookmarks.iter_mut().find(|b| b.url == normalized) {
        if existing.folders.is_empty() && !candidate.folders.is_empty() {
            existing.folders = candidate.folders;
            return Merge::Adopted;
        }
        return Merge::Skipped;
    }

    bookmarks.push(Bookmark {
        id: new_id(),
        title: if candidate.title.trim().is_empty() {
            normalized.clone()
        } else {
            candidate.title.trim().to_string()
        },
        url: normalized,
        folders: candidate.folders,
        added_at: now_ms(),
    });
    Merge::Added
}

/// 原子写：临时文件 + rename。**同 knowledge/marketplace 已有写法**（四处重复，将来若收成
/// 公共 util 一起改）——中途崩不留半截 JSON。
fn write_atomic(path: &Path, content: &str) -> Result<(), StoreError> {
    let tmp = path.with_extension(format!(
        "json.tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, content).map_err(|e| StoreError::Io(format!("{}: {e}", tmp.display())))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        StoreError::Io(format!("{}: {e}", path.display()))
    })
}

fn new_id() -> String {
    format!("bm-{}-{}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod parse_test;

#[cfg(test)]
mod store_test;
