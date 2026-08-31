// git spawn 基建：串行锁（防 .git/index.lock 争用）+ 超时 kill + blocking 桥。
// 各域命令经 git_run / git_run_async / git_run_blocking 走子进程；常量与
// helper 均 `pub(super)` 供 git/ 模块树内共享（compare/tags 也从这里拿），
// 不重导出到 `crate::commands::git` 命名空间之外。

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
// ── Timeout + Mutex ──

pub(super) const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// fetch/pull/push 等网络操作走更长的超时——大仓库或慢网络下 15s 会误杀。
pub(super) const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Serialises all git invocations so concurrent calls never fight over
/// `.git/index.lock`.  A poisoned lock is treated as a fatal error and
/// immediately returned to the caller.
pub(super) static GIT_LOCK: Mutex<()> = Mutex::new(());

/// Spawn `git` with the given arguments inside `root`, blocking until it
/// finishes or `timeout` expires — on timeout the child is **killed** so no
/// zombie git process is left behind.  stdout/stderr are drained on helper
/// threads so a chatty child can't deadlock on a full pipe.
fn git_run_with_timeout(
    args: &[&str],
    root: &std::path::Path,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let _guard = GIT_LOCK
        .lock()
        .map_err(|e| format!("Git lock poisoned: {}", e))?;

    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn git: {}", e))?;

    let mut child_stdout = child.stdout.take().expect("stdout piped");
    let mut child_stderr = child.stderr.take().expect("stderr piped");
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut child_stdout, &mut buf).map(|_| buf)
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut child_stderr, &mut buf).map(|_| buf)
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(format!(
                        "Git command 'git {}' timed out after {}s",
                        args.join(" "),
                        timeout.as_secs(),
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to wait on git: {}", e)),
        }
    };

    let stdout = out_handle
        .join()
        .unwrap_or(Ok(Vec::new()))
        .unwrap_or_default();
    let stderr = err_handle
        .join()
        .unwrap_or(Ok(Vec::new()))
        .unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// Default-timeout variant used by all local (non-network) git invocations.
pub(super) fn git_run(
    args: &[&str],
    root: &std::path::Path,
) -> Result<std::process::Output, String> {
    git_run_with_timeout(args, root, GIT_TIMEOUT)
}

/// Run git inside `tokio::spawn_blocking` so the async handler never blocks
/// the tokio worker thread.
pub(super) async fn git_run_async_timeout(
    args: Vec<String>,
    root: std::path::PathBuf,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_run_with_timeout(&refs, &root, timeout)
    })
    .await
    .map_err(|e| format!("Git task panicked: {}", e))?
}

pub(super) async fn git_run_async(
    args: Vec<String>,
    root: std::path::PathBuf,
) -> Result<std::process::Output, String> {
    git_run_async_timeout(args, root, GIT_TIMEOUT).await
}

/// Like `git_run_async` but accepts an arbitrary closure that receives `root`
/// and can execute **multiple** git steps inside a single blocking task —
/// avoids repeated thread hops for compound operations (commit, show, …).
pub(super) async fn git_run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Git task panicked: {}", e))?
}
