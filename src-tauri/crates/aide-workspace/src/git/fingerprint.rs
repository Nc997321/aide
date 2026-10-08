// git 目录指纹域：refs/HEAD/index/FETCH_HEAD 的 mtime 组合指纹，供
// useGitWatcher 3s 轮询做轻量变更探测（只摸 mtime，不 spawn git）。
// 持续高频的同步命令，埋 trace_command 便于诊断报告点名。

use std::path::PathBuf;
/// 每 3s 轮询一次（useGitWatcher.ts），递归遍历 `.git/refs`——持续高频的同步
/// 命令，埋 trace_command 便于诊断报告点名（同批见 marketplace.rs 顶部注释）。
pub fn git_fingerprint(root: PathBuf) -> Result<String, String> {
    let git_dir = root.join(".git");
    if !git_dir.exists() {
        return Ok(String::new());
    }

    fn mtime_ms(path: &std::path::Path) -> u64 {
        path.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn dir_max_mtime(dir: &std::path::Path, depth: u8) -> u64 {
        let mut max = mtime_ms(dir);
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                let m = if p.is_dir() && depth < 3 {
                    dir_max_mtime(&p, depth + 1)
                } else {
                    mtime_ms(&p)
                };
                if m > max {
                    max = m;
                }
            }
        }
        max
    }

    let head = mtime_ms(&git_dir.join("HEAD"));
    let index = mtime_ms(&git_dir.join("index"));
    let fetch_head = mtime_ms(&git_dir.join("FETCH_HEAD"));
    let refs_heads = dir_max_mtime(&git_dir.join("refs").join("heads"), 0);
    let refs_remotes = dir_max_mtime(&git_dir.join("refs").join("remotes"), 0);
    let stash = mtime_ms(&git_dir.join("refs").join("stash"));

    Ok(format!(
        "{}-{}-{}-{}-{}-{}",
        head, index, fetch_head, refs_heads, refs_remotes, stash
    ))
}
