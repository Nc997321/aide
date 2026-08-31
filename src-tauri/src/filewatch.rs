//! 工作区文件系统监听：外部改动（资源管理器 / cmd / 其他编辑器 / agent 的
//! git 操作）自动刷新文件树。
//!
//! 结构（纯核心 + 薄外壳）：
//! - 纯核心 `EventAcc`：把 notify 事件归集成「受影响父目录集合 + full 标记」，
//!   纯数据进出，脱离环境即可单测。
//! - 薄外壳：`retarget`（换根/停表）+ 防抖线程（recv 轮询 → 归集 → emit）+
//!   `file_tree_watch` 命令。IO、时钟、线程全在外壳，外壳里没有业务判断。
//!
//! 事件协议：`file-tree-changed`，payload = 受影响父目录数组；**空数组 =
//! 全量刷新**（watcher 错误 / Rescan 缓冲区溢出 / 集合溢出时发出，防抖线程
//! 无法枚举具体目录，交由前端 refreshAllExpanded 兜底）。
//!
//! 降噪策略（三层，缺一即触发无谓刷新风暴）：
//! 1. 后端归集：一条事件只贡献父目录，rename 的 From/To 父目录相同天然去重；
//!    `.git` 分量直接丢弃（git 内部 churn 无用户可见意义，会话回合结束已有
//!    refreshAllExpanded 兜底）；集合超上限置 full（风暴时退化为一次全刷）。
//! 2. 冷却合并：距上次 emit 不足冷却时长时，把窗口内新到事件并入同批并在
//!    窗口结束时一并 emit，绝不丢弃（丢弃会让「唯一一批改动」永久丢失，
//!    树从此陈旧）。
//! 3. 前端相关性过滤（FileTree.vue）：改动目录若不在当前可见范围内（未展开
//!    的 node_modules churn 等）则完全跳过刷新。
//!
//! 线程生命周期：唯一的共享可变状态是 `FileWatchService(Mutex<..>)`（以
//! Arc 托管进 Tauri 状态，命令把 Arc clone 进 spawn_blocking）；防抖线程
//! 不持锁、只拥有自己的 receiver。retarget 时 drop 旧 watcher → 其内部
//! 闭包（持有 tx）一并释放 → 旧线程收到 Disconnected 退出；cancel 标志是
//! 轮询路径上的兜底。**事件线程必须是 std::thread**——阻塞式 recv_timeout
//! 丢进 tokio runtime 会饿死 worker（禁 tauri::async_runtime）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Error as NotifyError, Event, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

/// 单批归集的父目录数上限。超过说明是大规模重构/构建风暴，无法逐目录
/// 枚举，一次性退化为空 payload（= 前端全量刷新）。
const MAX_DIRS: usize = 4096;
/// 静默期：最后一条事件后安静满该时长才 emit（把一次文件的 Create+Modify
/// 连环事件归成一批）。
const QUIET_WINDOW: Duration = Duration::from_millis(300);
/// 冷却窗口：两次 emit 的最小间隔；期间新事件并入即将发出的一批而非丢弃。
const COOLDOWN: Duration = Duration::from_millis(2000);
/// 无事件时的轮询间隔（cancel 标志的最坏生效时延）。
const POLL: Duration = Duration::from_millis(200);
/// 发给前端的事件名（前端 FileTree.vue listen）。
const EVENT_NAME: &str = "file-tree-changed";

// ── 纯核心：事件归集 ────────────────────────────────────────────────────────

/// 一批事件的归集结果：受影响父目录集合 + 是否退化为全量刷新。
#[derive(Default)]
struct EventAcc {
    dirs: HashSet<String>,
    full: bool,
}

impl EventAcc {
    /// 归集一条 notify 结果。刻意不按 EventKind 变体分支：Create/Remove/
    /// Rename(ModifyKind::Name) 对父目录集合同等贡献；真正的分界只有三条——
    /// 错误、Rescan（递归缓冲区溢出，Windows 上以 EventKind::Other 且 paths
    /// 为空送达）、`.git` 分量。Modify(Data) 的父目录也会入集，不可见目录的
    /// 噪音由前端相关性过滤兜住——后端保持单一事实源（受影响目录集合），
    /// 不在此处做树可见性判断。
    fn ingest(&mut self, result: &Result<Event, NotifyError>) {
        match result {
            Err(_) => self.full = true,
            Ok(event) => {
                if matches!(event.kind, EventKind::Other) {
                    self.full = true;
                    return;
                }
                for path in &event.paths {
                    let is_git = path
                        .components()
                        .any(|c| c.as_os_str() == std::ffi::OsStr::new(".git"));
                    if is_git {
                        continue;
                    }
                    if self.dirs.len() >= MAX_DIRS {
                        self.dirs.clear();
                        self.full = true;
                        return;
                    }
                    if let Some(parent) = path.parent() {
                        self.dirs.insert(parent.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    /// emit payload：full / 溢出 → 空数组（前端语义 = 全量刷新）。非 full
    /// 且空集合的实况只有一种——盘根事件（路径 "/"，parent()=None）落不进
    /// 任何目录，同样以空数组全量刷新兜底，语义自洽。
    /// `&self`（clone 出去）以便测试里先断言标志再断言 payload。
    fn payload(&self) -> Vec<String> {
        if self.full {
            return vec![];
        }
        self.dirs.iter().cloned().collect()
    }
}

/// 在 `window` 时窗内继续排空事件并入 acc：收到事件就重新计时，静默满时窗
/// 即结束。返回 `false` 表示通道已断开（该批是最后一批，emit 后应退出）。
fn settle(rx: &Receiver<Result<Event, NotifyError>>, acc: &mut EventAcc, window: Duration) -> bool {
    let deadline = Instant::now() + window;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return true;
        };
        match rx.recv_timeout(remaining) {
            Ok(result) => acc.ingest(&result),
            Err(RecvTimeoutError::Timeout) => return true,
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
}

// ── 外壳：监听服务 ─────────────────────────────────────────────────────────

/// 当前活跃的 watch。watcher 持有事件闭包（闭包持有 tx），drop 它 = 取消
/// OS watch + 断开 tx，防抖线程随 Disconnected 退出——生命周期由所有权链
/// 保证，cancel 标志只是轮询路径上的兜底。
struct ActiveWatch {
    root: PathBuf,
    /// 保活字段：从不读取，但 retarget 替换 ActiveWatch 时触发它的 Drop =
    /// 取消 OS watch + 断开 tx。用 expect 而非 allow——若未来真的读了它，
    /// 该标记会自己报警失效。
    #[expect(dead_code, reason = "保活以触发 Drop（取消 OS watch）")]
    watcher: notify::RecommendedWatcher,
    cancel: Arc<AtomicBool>,
}

/// 同一时刻只跟一个工作区根。retarget 由前端 loadRoot 驱动（文件树是唯一
/// 消费方），切工作区 / 无工作区时跟随。
#[derive(Default)]
pub struct FileWatchService {
    active: Mutex<Option<ActiveWatch>>,
}

impl FileWatchService {
    /// 重定监听目标（`&self` + 内部 Mutex，命令经 State 取引用）。同 root
    /// 短路：loadRoot 会在挂载 / 隐藏文件切换 / 工作区切换时反复调用，不
    /// 短路会在 Linux 上反复全树重建 inotify。
    pub fn retarget(&self, root: Option<&Path>, app: &AppHandle) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "文件监听状态损坏，请重启应用".to_string())?;
        let wanted = root.map(|p| p.to_path_buf());
        let current = active.as_ref().map(|w| w.root.clone());
        if wanted == current {
            return Ok(());
        }
        // 拆掉旧的：置线程终止标志 + drop watcher（OS watch 取消 + tx 断开）。
        if let Some(old) = active.take() {
            old.cancel.store(true, Ordering::Relaxed);
        }
        let Some(root_path) = root.map(Path::to_path_buf) else {
            return Ok(()); // 仅停止监听
        };

        let (tx, rx) = std::sync::mpsc::channel::<Result<Event, NotifyError>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| format!("创建文件监听失败: {e}"))?;
        watcher
            .watch(&root_path, RecursiveMode::Recursive)
            .map_err(|e| format!("监听目录失败: {e}"))?;

        let cancel = Arc::new(AtomicBool::new(false));
        let thread_cancel = Arc::clone(&cancel);
        let handle = app.clone();
        std::thread::Builder::new()
            .name("filewatch".into())
            .spawn(move || debounce_loop(rx, thread_cancel, handle))
            .map_err(|e| format!("启动监听线程失败: {e}"))?;
        *active = Some(ActiveWatch {
            root: root_path,
            watcher,
            cancel,
        });
        Ok(())
    }
}

/// 防抖主循环（外壳，只编排）：等首事件 → 静默期归集 → 冷却并入 → emit。
fn debounce_loop(
    rx: Receiver<Result<Event, NotifyError>>,
    cancel: Arc<AtomicBool>,
    app: AppHandle,
) {
    let mut last_emit: Option<Instant> = None;
    loop {
        let first = match rx.recv_timeout(POLL) {
            Ok(item) => item,
            Err(RecvTimeoutError::Timeout) => {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut acc = EventAcc::default();
        acc.ingest(&first);
        // 静默期 + 冷却窗口内的后续事件并入同批（settle 返回 false = 通道
        // 已断开，这批是最后一批）。
        let mut alive = settle(&rx, &mut acc, QUIET_WINDOW);
        if alive {
            if let Some(rest) = last_emit.and_then(|last| COOLDOWN.checked_sub(last.elapsed())) {
                alive = settle(&rx, &mut acc, rest);
            }
        }
        // emit 失败无恢复路径（前端不在线即丢弃），但要留痕可诊断
        if let Err(e) = app.emit(EVENT_NAME, acc.payload()) {
            tracing::warn!("[filewatch] file-tree-changed 事件发送失败: {e}");
        }
        last_emit = Some(Instant::now());
        if !alive {
            return;
        }
    }
}

// ── Tauri 命令 ─────────────────────────────────────────────────────────────

/// 前端 FileTree 在 loadRoot 成功后调用：把监控指向当前工作区根（或空串停表）。
///
/// async + spawn_blocking：watch 的重活在 Linux 侧（Recursive = 全树逐目录
/// inotify_add_watch + 遍历，node_modules 规模属重 IO）且在 retarget 的
/// Mutex 内；Windows（RDCW 单 syscall）顺带受益。注意 State 不能跨
/// spawn_blocking（CLAUDE.md 红线）——先 Arc clone 成 owned 值再 move。
#[tauri::command]
pub async fn file_tree_watch(
    root: String,
    app: AppHandle,
    svc: State<'_, std::sync::Arc<FileWatchService>>,
) -> Result<(), String> {
    let svc = svc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if root.is_empty() {
            return svc.retarget(None, &app);
        }
        svc.retarget(Some(Path::new(&root)), &app)
    })
    .await
    .map_err(|e| format!("文件监听任务中断: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::CreateKind;

    fn create_event(path: &str) -> Result<Event, NotifyError> {
        Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from(path)))
    }

    #[test]
    fn ingest_dedups_parent_dirs() {
        let mut acc = EventAcc::default();
        acc.ingest(&create_event("C:\\w\\src\\a.rs"));
        acc.ingest(&create_event("C:\\w\\src\\b.rs"));
        acc.ingest(&create_event("C:\\w\\src\\a.rs"));
        assert_eq!(acc.payload(), vec!["C:\\w\\src"]);
    }

    #[test]
    fn error_maps_to_full_refresh() {
        let mut acc = EventAcc::default();
        acc.ingest(&create_event("C:\\w\\a.rs"));
        acc.ingest(&Err(notify::Error::io(std::io::Error::other("boom"))));
        assert!(acc.payload().is_empty());
    }

    #[test]
    fn rescan_other_kind_maps_to_full_refresh() {
        let mut acc = EventAcc::default();
        acc.ingest(&Ok(Event::new(EventKind::Other)));
        assert!(acc.payload().is_empty());
    }

    #[test]
    fn overflow_degrades_to_full_refresh() {
        // 触发条件是「不同父目录数」超限（树级重命名/大构建风暴），
        // 同一目录内的海量单文件事件不设 full。
        let mut acc = EventAcc::default();
        for i in 0..(MAX_DIRS + 10) {
            acc.ingest(&create_event(&format!("C:\\w\\d{i}\\f.txt")));
        }
        assert!(acc.full);
        assert!(acc.payload().is_empty());
    }

    #[test]
    fn git_components_filtered() {
        let mut acc = EventAcc::default();
        acc.ingest(&create_event("C:\\w\\.git\\HEAD"));
        acc.ingest(&create_event("C:\\w\\.git\\objects\\ab\\cd"));
        acc.ingest(&create_event("C:\\w\\notgit\\a.rs"));
        assert_eq!(acc.payload(), vec!["C:\\w\\notgit"]);
    }

    #[test]
    fn settle_drains_queued_events_until_quiet() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut acc = EventAcc::default();
        tx.send(create_event("C:\\w\\a.rs")).unwrap();
        tx.send(create_event("C:\\w\\b.rs")).unwrap();
        // 队列排空后静默满时窗 → 存活（true），同父目录已去重
        let alive = settle(&rx, &mut acc, Duration::from_millis(10));
        assert!(alive);
        assert_eq!(acc.payload(), vec!["C:\\w"]);
    }

    #[test]
    fn settle_disconnect_returns_false_but_last_batch_kept() {
        // retarget 断开 tx 后：已入队的最后一批先进 acc 再收到 Disconnected，
        // 语义 = 这批照常 emit 后退出（不丢最终改动）
        let (tx, rx) = std::sync::mpsc::channel::<Result<Event, NotifyError>>();
        tx.send(create_event("C:\\w\\last.rs")).unwrap();
        drop(tx);
        let mut acc = EventAcc::default();
        let alive = settle(&rx, &mut acc, Duration::from_millis(50));
        assert!(!alive);
        assert_eq!(acc.payload(), vec!["C:\\w"]);
    }

    #[test]
    fn settle_zero_window_returns_without_waiting() {
        // 零窗口不等待。Windows QPC 上两次 Instant::now() 同 tick 时走
        // Some(0)→recv_timeout(0)→Timeout 路径，时钟推进过才走
        // checked_duration_since None 臂——两臂行为等价（同样无等待返回
        // true），功能语义一致。
        let (_tx, rx) = std::sync::mpsc::channel::<Result<Event, NotifyError>>();
        let mut acc = EventAcc::default();
        assert!(settle(&rx, &mut acc, Duration::ZERO));
        assert!(acc.payload().is_empty());
    }

    #[test]
    fn root_path_with_no_parent_arm_is_skipped() {
        // 盘根事件（watch 根 = 盘根本身，路径 "/"）的 parent() = None——
        // 不产生目录条目，也不算 full（改动无从定位就忽略）
        let mut acc = EventAcc::default();
        acc.ingest(&create_event("/"));
        assert!(acc.payload().is_empty());
        assert!(!acc.full);
    }
}
