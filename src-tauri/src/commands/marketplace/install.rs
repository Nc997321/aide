use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Classify a git clone error and return a prefixed error string.
/// The prefix is a machine-readable code; the frontend maps it to
/// user-facing messages and actions.
pub(super) fn git_err(stderr: &str) -> String {
    let code = if stderr.contains("Could not connect")
        || stderr.contains("Failed to connect")
        || stderr.contains("Could not resolve")
    {
        "NETWORK_FAILURE"
    } else if stderr.contains("not found") || stderr.contains("remote: Repository") {
        "REPO_NOT_FOUND"
    } else if stderr.contains("timeout") || stderr.contains("timed out") {
        "TIMEOUT"
    } else {
        "UNKNOWN_ERROR"
    };
    format!("{}: {}", code, stderr.trim())
}

/// Run git clone with optional proxy and return output.
pub(super) fn git_clone(url: &str, target: &std::path::Path) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = Command::new("git");
    cmd.args(["clone", "--depth", "1"]);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }

    // Apply proxy if detected
    if let Some(ref proxy) = crate::commands::proxy::detect_proxy() {
        cmd.arg("-c");
        cmd.arg(format!("http.proxy={}", proxy));
        cmd.arg("-c");
        cmd.arg(format!("https.proxy={}", proxy));
    }

    cmd.arg(url).arg(target).output()
}

pub(super) fn get_remote_url(path: &std::path::Path) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["remote", "get-url", "origin"])
        .current_dir(path);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let output = cmd.output().ok()?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }
    None
}
