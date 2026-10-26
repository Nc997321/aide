//! Full Git clones into a new, explicitly selected directory.
use super::runtime::{git_run_blocking, git_run_blocking_options};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(600);

fn clone_environment() -> Vec<(String, String)> {
    vec![
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GCM_INTERACTIVE".into(), "never".into()),
        ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
    ]
}

/// Clone a repository into `parent_path/directory_name`, returning the Host-native path.
pub async fn git_clone(
    url: String,
    parent_path: String,
    directory_name: String,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("仓库地址不能为空".into());
    }
    let parent = PathBuf::from(parent_path);
    if !parent.is_absolute() {
        return Err("保存父目录必须是绝对路径".into());
    }
    validate_directory_name(&directory_name)?;

    git_run_blocking(move || clone_blocking(url, parent, directory_name)).await
}

fn clone_blocking(
    url: String,
    parent: PathBuf,
    directory_name: String,
) -> Result<String, String> {
    let metadata = std::fs::metadata(&parent)
        .map_err(|_| "保存父目录必须是已存在的目录".to_string())?;
    if !metadata.is_dir() {
        return Err("保存父目录必须是已存在的目录".into());
    }

    let target = parent.join(directory_name);
    std::fs::create_dir(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "目标目录已存在，未作任何更改".to_string()
        } else {
            format!("无法创建目标目录：{error}")
        }
    })?;

    let target_arg = target.to_string_lossy().into_owned();
    let args = ["clone", "--", url.as_str(), target_arg.as_str()];
    let environment = clone_environment();
    let environment_refs: Vec<(&str, &str)> = environment
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let result = git_run_blocking_options(
        &args,
        &parent,
        GIT_CLONE_TIMEOUT,
        &environment_refs,
        false,
    );

    match result {
        Ok(output) if output.status.success() => Ok(target.to_string_lossy().into_owned()),
        result => {
            let detail = match result {
                Err(error) if error.contains("timed out") => {
                    format!("克隆超时（{} 秒）", GIT_CLONE_TIMEOUT.as_secs())
                }
                Err(_) => "无法启动或等待 Git 克隆".to_string(),
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let diagnostic = sanitize_diagnostic(&stderr, &url);
                    if diagnostic.is_empty() {
                        format!(
                            "Git 克隆失败（退出码 {}）",
                            output
                                .status
                                .code()
                                .map_or("未知".into(), |code| code.to_string())
                        )
                    } else {
                        format!("Git 克隆失败：{diagnostic}")
                    }
                }
            };
            Err(cleanup_failed_target(&target, detail))
        }
    }
}

fn sanitize_diagnostic(stderr: &str, url: &str) -> String {
    let mut diagnostic = stderr.trim().to_string();
    if !url.is_empty() {
        diagnostic = diagnostic.replace(url, "[仓库地址]");
        if let Some(scheme_end) = url.find("://") {
            let authority = &url[scheme_end + 3..];
            let authority_end = authority.find('/').unwrap_or(authority.len());
            if let Some(userinfo_end) = authority[..authority_end].rfind('@') {
                let userinfo = &authority[..userinfo_end];
                if !userinfo.is_empty() {
                    diagnostic = diagnostic.replace(userinfo, "[凭据]");
                }
            }
        }
    }
    diagnostic
}

fn cleanup_failed_target(target: &Path, detail: String) -> String {
    match std::fs::remove_dir(target) {
        Ok(()) => detail,
        Err(error) => {
            if is_empty_directory(target) {
                format!(
                    "{detail}；空目录清理失败：{error}（路径：{}）",
                    target.display()
                )
            } else {
                format!("{detail}；保留克隆残留，请检查路径：{}", target.display())
            }
        }
    }
}

fn validate_directory_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    let invalid_character = name.chars().any(|character| {
        character.is_control()
            || matches!(character, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
    });
    let reserved_device_name = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(&[' ', '.'][..])
        .to_ascii_uppercase();
    let is_reserved = matches!(
        reserved_device_name.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        (1..=9).any(|number| reserved_device_name == format!("{prefix}{number}"))
    });

    if name.is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .last()
            .is_some_and(|character| matches!(character, ' ' | '.'))
        || invalid_character
        || is_reserved
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err("项目目录名必须是安全且受支持的单层目录名".into());
    }
    Ok(())
}

fn is_empty_directory(path: &Path) -> bool {
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::super::runtime::GIT_NETWORK_TIMEOUT;
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "aide-git-clone-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git(root: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0");
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let status = command.status().unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn source(root: &Path) -> PathBuf {
        let repo = root.join("源仓库 with spaces");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("one.txt"), "first\n").unwrap();
        git(&repo, &["add", "one.txt"]);
        git(&repo, &["commit", "-m", "first"]);
        std::fs::write(repo.join("one.txt"), "second\n").unwrap();
        git(&repo, &["commit", "-am", "second"]);
        repo
    }

    #[tokio::test]
    async fn clones_full_history_into_unicode_path() {
        let temp = TempDir::new("history");
        let repo = source(&temp.0);
        let parent = temp.0.join("保存位置 with spaces");
        std::fs::create_dir(&parent).unwrap();
        let cloned = git_clone(
            repo.to_string_lossy().into_owned(),
            parent.to_string_lossy().into_owned(),
            "项目 副本".into(),
        )
        .await
        .unwrap();
        let path = PathBuf::from(cloned);
        assert_eq!(
            std::fs::read_to_string(path.join("one.txt")).unwrap(),
            "second\n"
        );

        let mut command = Command::new("git");
        command
            .args(["rev-list", "--count", "HEAD"])
            .current_dir(path);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let history = command.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&history.stdout).trim(), "2");
    }

    #[tokio::test]
    async fn existing_target_is_untouched_and_unix_symlink_is_rejected() {
        let temp = TempDir::new("existing");
        let repo = source(&temp.0);
        let target = temp.0.join("occupied");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("marker"), "keep").unwrap();
        assert!(git_clone(
            repo.to_string_lossy().into_owned(),
            temp.0.to_string_lossy().into_owned(),
            "occupied".into()
        )
        .await
        .is_err());
        assert_eq!(std::fs::read_to_string(target.join("marker")).unwrap(), "keep");

        #[cfg(unix)]
        {
            let link = temp.0.join("link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(git_clone(
                repo.to_string_lossy().into_owned(),
                temp.0.to_string_lossy().into_owned(),
                "link".into()
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn rejects_invalid_name_and_parent_without_creating_target() {
        let temp = TempDir::new("invalid");
        for name in [
            "", ".", "..", "../escape", "a/b", "a\\b", "bad:name", "bad?name", "a<b", "CON",
            "CONIN$", "CONOUT$", "LPT9.ext", "nul.txt", "name.", "name ",
        ] {
            assert!(
                git_clone(
                    "unused".into(),
                    temp.0.to_string_lossy().into_owned(),
                    name.into()
                )
                .await
                .is_err(),
                "{name:?}"
            );
        }
        assert!(git_clone("unused".into(), "relative".into(), "valid".into())
            .await
            .is_err());
        assert!(!temp.0.join("valid").exists());
    }

    #[tokio::test]
    async fn failed_clone_cleans_only_empty_new_target() {
        let temp = TempDir::new("failure");
        let missing = temp.0.join("missing-repository");
        let result = git_clone(
            missing.to_string_lossy().into_owned(),
            temp.0.to_string_lossy().into_owned(),
            "failed".into(),
        )
        .await;
        let error = result.unwrap_err();
        assert!(!error.contains("missing-repository"));
        assert!(!temp.0.join("failed").exists());
    }

    #[test]
    fn failed_clone_retains_and_reports_nonempty_residue() {
        let temp = TempDir::new("residue");
        let target = temp.0.join("残留目录");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("partial"), "keep").unwrap();
        let error = cleanup_failed_target(&target, "Git 克隆失败".into());
        assert!(error.contains(&target.to_string_lossy().to_string()));
        assert_eq!(std::fs::read_to_string(target.join("partial")).unwrap(), "keep");
    }

    #[test]
    fn clone_diagnostics_redact_url_and_credentials() {
        let url = "https://user:secret@example.invalid/org/repo.git";
        let stderr = format!("fatal: unable to access '{url}': authentication failed");
        let safe = sanitize_diagnostic(&stderr, url);
        assert!(!safe.contains("user:secret"));
        assert!(!safe.contains(url));
        assert!(safe.contains("authentication failed"));
    }

    #[test]
    fn clone_timeout_and_noninteractive_environment_are_bounded() {
        assert_eq!(GIT_CLONE_TIMEOUT, Duration::from_secs(600));
        assert!(GIT_CLONE_TIMEOUT > GIT_NETWORK_TIMEOUT);
        let environment = clone_environment();
        assert!(environment.contains(&("GIT_TERMINAL_PROMPT".into(), "0".into())));
        assert!(environment.contains(&("GCM_INTERACTIVE".into(), "never".into())));
        assert!(environment.contains(&("SSH_ASKPASS_REQUIRE".into(), "never".into())));
        assert!(!environment.iter().any(|(key, _)| key == "GIT_SSH_COMMAND"));
    }
}
