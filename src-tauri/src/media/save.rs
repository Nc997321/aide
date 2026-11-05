use std::{
    fs,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::Ordering,
        Arc,
    },
    time::SystemTime,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tempfile::{Builder, NamedTempFile, TempPath};
use tokio::{
    io::AsyncWriteExt,
    sync::{oneshot, SemaphorePermit, TryAcquireError},
    task,
};

use super::session::{ActiveFile, MediaSession};

const READ_CHUNK: usize = 512 * 1024;

pub(super) async fn to_local(app: &AppHandle, session: Arc<MediaSession>) -> Result<String, String> {
    session.check(app)?;
    let _permit = acquire_save(&session)?;
    let active = session.current().await;
    ensure_current(app, &session, &active).await?;
    prepare_download(app, &session, active).await
}

pub(super) async fn open_external(app: &AppHandle, session: Arc<MediaSession>) -> Result<String, String> {
    session.check(app)?;
    if is_ssh(&session) { return Err("SSH 主机上的媒体无法由本机程序打开；请先保存到本机后再打开。".into()); }
    let active = session.current().await;
    ensure_current(app, &session, &active).await?;
    let window = app.get_window(&session.owner).ok_or_else(|| "媒体标签所属窗口已关闭".to_string())?;
    let path = active.info.path.clone();
    task::spawn_blocking(move || crate::commands::filesystem::file_open(window, path))
        .await.map_err(|error| format!("启动系统程序失败：{error}"))??;
    Ok("已交由本机系统程序打开".into())
}

fn is_ssh(session: &MediaSession) -> bool {
    matches!(&session.host, crate::host_door::target::HostTarget::Remote {
        host: crate::remote_workspace::path::HostId::Ssh(_), ..
    })
}

fn acquire_save(session: &MediaSession) -> Result<SemaphorePermit<'_>, String> {
    session.saves.try_acquire().map_err(|error| match error {
        TryAcquireError::NoPermits => "正在保存，请稍后重试".to_string(),
        TryAcquireError::Closed => "媒体保存队列已关闭".to_string(),
    })
}

async fn prepare_download(
    app: &AppHandle,
    session: &Arc<MediaSession>,
    active: Arc<ActiveFile>,
) -> Result<String, String> {
    let target = choose_target(app, &active.info.path).await?;
    let Some(prepared) = prepare_destination(target).await? else { return Ok("已取消保存".into()); };
    ensure_current(app, session, &active).await?;
    let partial = write_source(app, session, &active, prepared.temporary).await?;
    ensure_current(app, session, &active).await?;
    let guard = CommitGuard { session: Arc::clone(session), active };
    persist_checked(partial, prepared.target, prepared.stamp, guard).await?;
    Ok("已保存到本机".into())
}

async fn choose_target(app: &AppHandle, source_path: &str) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().set_title("保存媒体到本机")
        .set_file_name(suggested_name(source_path))
        .save_file(move |selection| {
            if sender.send(selection).is_err() {
                tracing::debug!("media save dialog completed after its request was cancelled");
            }
        });
    let selection = receiver.await.map_err(|error| format!("保存位置选择器已关闭：{error}"))?;
    selection.map(|file| file.into_path()).transpose().map_err(|error| format!("无法读取所选保存位置：{error}"))
}

fn suggested_name(source_path: &str) -> String {
    let name = source_path.rsplit(['/', '\\']).next().unwrap_or_default();
    let safe: String = name.chars().map(|ch| {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { ch }
    }).collect();
    if safe.is_empty() || safe == "." || safe == ".." { "media".into() } else { safe }
}

struct PreparedTarget {
    target: PathBuf,
    stamp: TargetStamp,
    temporary: NamedTempFile,
}

async fn prepare_destination(target: Option<PathBuf>) -> Result<Option<PreparedTarget>, String> {
    let Some(target) = target else { return Ok(None); };
    let stamp = read_target_stamp(target.clone()).await?;
    let parent = parent_directory(&target)?;
    let temporary = create_partial(parent).await?;
    Ok(Some(PreparedTarget { target, stamp, temporary }))
}

fn parent_directory(target: &Path) -> Result<PathBuf, String> {
    target.parent().filter(|parent| !parent.as_os_str().is_empty()).map(Path::to_path_buf)
        .ok_or_else(|| "请选择一个有效的本机文件路径".to_string())
}

async fn create_partial(parent: PathBuf) -> Result<NamedTempFile, String> {
    task::spawn_blocking(move || Builder::new().prefix(".aide-media-").suffix(".partial").tempfile_in(parent))
        .await.map_err(|error| format!("创建临时文件任务失败：{error}"))?
        .map_err(|error| format!("无法在目标目录创建临时文件：{error}"))
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TargetStamp {
    Missing,
    Existing { length: u64, modified: Option<SystemTime>, created: Option<SystemTime>, readonly: bool },
}

fn inspect_target_stamp(path: &Path) -> Result<TargetStamp, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(TargetStamp::Missing),
        Err(error) => return Err(format!("无法检查本机目标文件：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("所选保存目标不是普通文件，不能安全替换".into());
    }
    Ok(TargetStamp::Existing {
        length: metadata.len(), modified: metadata.modified().ok(), created: metadata.created().ok(),
        readonly: metadata.permissions().readonly(),
    })
}

async fn read_target_stamp(path: PathBuf) -> Result<TargetStamp, String> {
    task::spawn_blocking(move || inspect_target_stamp(&path)).await
        .map_err(|error| format!("检查目标文件任务失败：{error}"))?
}

async fn write_source(
    app: &AppHandle,
    session: &Arc<MediaSession>,
    active: &Arc<ActiveFile>,
    temporary: NamedTempFile,
) -> Result<TempPath, String> {
    let (file, partial) = temporary.into_parts();
    let mut output = tokio::fs::File::from_std(file);
    copy_source(app, session, active, &mut output).await?;
    output.flush().await.map_err(|error| format!("刷新本机临时文件失败：{error}"))?;
    output.sync_all().await.map_err(|error| format!("同步本机临时文件失败：{error}"))?;
    drop(output);
    ensure_current(app, session, active).await?;
    Ok(partial)
}

async fn copy_source(
    app: &AppHandle,
    session: &Arc<MediaSession>,
    active: &Arc<ActiveFile>,
    output: &mut tokio::fs::File,
) -> Result<(), String> {
    let mut offset = 0_u64;
    while offset < active.info.size {
        ensure_current(app, session, active).await?;
        let length = (active.info.size - offset).min(READ_CHUNK as u64) as usize;
        let bytes = super::host::read(&session.host, &active.info.handle, (offset, length)).await?;
        ensure_current(app, session, active).await?;
        if bytes.len() != length { return Err("源媒体在保存期间发生变化或提前结束".into()); }
        output.write_all(&bytes).await.map_err(|error| format!("写入本机临时文件失败：{error}"))?;
        offset += length as u64;
    }
    ensure_current(app, session, active).await?;
    let eof = super::host::read(&session.host, &active.info.handle, (active.info.size, 1)).await?;
    ensure_current(app, session, active).await?;
    if !eof.is_empty() { return Err("源媒体在保存期间增长，保存已取消".into()); }
    Ok(())
}

async fn ensure_current(app: &AppHandle, session: &MediaSession, active: &ActiveFile) -> Result<(), String> {
    session.check(app)?;
    if session.closed.load(Ordering::Acquire) || active.revoked.load(Ordering::Acquire) {
        return Err("媒体标签或源文件已关闭，保存已取消".into());
    }
    let current = session.current().await;
    if current.index != active.index || current.info.revision != active.info.revision || current.info.handle != active.info.handle {
        return Err("源媒体版本已变化，保存已取消；请重新打开媒体后再试".into());
    }
    Ok(())
}

struct CommitGuard {
    session: Arc<MediaSession>,
    active: Arc<ActiveFile>,
}

impl CommitGuard {
    fn check(&self) -> Result<(), String> {
        if self.session.closed.load(Ordering::Acquire) || self.active.revoked.load(Ordering::Acquire) {
            return Err("媒体标签或源文件已关闭，保存已取消".into());
        }
        Ok(())
    }
}

async fn persist_checked(
    partial: TempPath,
    target: PathBuf,
    before: TargetStamp,
    guard: CommitGuard,
) -> Result<(), String> {
    task::spawn_blocking(move || commit_partial(partial, target, before, || guard.check()))
        .await.map_err(|error| format!("提交保存任务失败：{error}"))?
}

fn commit_partial<F>(partial: TempPath, target: PathBuf, before: TargetStamp, check: F) -> Result<(), String>
where
    F: Fn() -> Result<(), String>,
{
    check()?;
    if inspect_target_stamp(&target)? != before {
        return Err("目标文件在保存期间发生变化，未覆盖；请重新选择目标后再试".into());
    }
    check()?;
    persist_partial(partial, target, matches!(&before, TargetStamp::Existing { .. }))
}

fn persist_partial(partial: TempPath, target: PathBuf, replace_existing: bool) -> Result<(), String> {
    let persisted = if replace_existing { partial.persist(&target) } else { partial.persist_noclobber(&target) };
    persisted.map_err(|error| format!("无法原子保存媒体文件：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn partial_in(directory: &Path, bytes: &[u8]) -> TempPath {
        let mut temporary = Builder::new().prefix(".test-").suffix(".partial").tempfile_in(directory).expect("create partial");
        use io::Write;
        temporary.write_all(bytes).expect("write partial");
        temporary.into_temp_path()
    }

    #[test]
    fn suggested_name_uses_only_a_safe_basename() {
        assert_eq!(suggested_name("/home/user/video.mp4"), "video.mp4");
        assert_eq!(suggested_name("C:\\clips\\video?.mp4"), "video_.mp4");
        assert_eq!(suggested_name("/"), "media");
    }

    #[test]
    fn missing_target_is_atomically_created() {
        let directory = tempfile::tempdir().expect("tempdir");
        let target = directory.path().join("new.mp4");
        let stamp = inspect_target_stamp(&target).expect("target stamp");
        commit_partial(partial_in(directory.path(), b"media"), target.clone(), stamp, || Ok(())).expect("commit new file");
        assert_eq!(fs::read(target).expect("saved media"), b"media");
    }

    #[test]
    fn existing_target_is_atomically_replaced_after_confirmation() {
        let directory = tempfile::tempdir().expect("tempdir");
        let target = directory.path().join("old.mp4");
        fs::write(&target, b"old").expect("existing target");
        let stamp = inspect_target_stamp(&target).expect("target stamp");
        commit_partial(partial_in(directory.path(), b"new media"), target.clone(), stamp, || Ok(())).expect("replace file");
        assert_eq!(fs::read(target).expect("saved media"), b"new media");
    }

    #[test]
    fn changed_target_is_not_overwritten_and_partial_is_removed() {
        let directory = tempfile::tempdir().expect("tempdir");
        let target = directory.path().join("old.mp4");
        fs::write(&target, b"old").expect("existing target");
        let stamp = inspect_target_stamp(&target).expect("initial stamp");
        let partial = partial_in(directory.path(), b"new media");
        let partial_path = partial.to_path_buf();
        fs::write(&target, b"changed while downloading").expect("concurrent update");
        assert!(commit_partial(partial, target.clone(), stamp, || Ok(())).is_err());
        assert_eq!(fs::read(target).expect("unchanged target"), b"changed while downloading");
        assert!(!partial_path.exists(), "failed commit removes the partial file");
    }

    #[test]
    fn missing_target_commit_never_clobbers_a_late_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let target = directory.path().join("late.mp4");
        fs::write(&target, b"other writer").expect("late target");
        let partial = partial_in(directory.path(), b"our media");
        let partial_path = partial.to_path_buf();
        assert!(persist_partial(partial, target.clone(), false).is_err());
        assert_eq!(fs::read(target).expect("late target preserved"), b"other writer");
        assert!(!partial_path.exists(), "failed no-clobber commit removes the partial file");
    }

    #[tokio::test]
    async fn cancelled_selection_creates_no_partial_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        assert!(prepare_destination(None).await.expect("cancelled selection").is_none());
        assert_eq!(fs::read_dir(directory.path()).expect("directory").count(), 0);
    }
}
