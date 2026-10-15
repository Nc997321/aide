//! 运行 JVM 系语言服务器（jdtls 等）用的 Java 运行时：找本机已装、版本够的 JDK。
//!
//! 不下载 JDK：写 Java 的人本机都有，而且运行时与「项目用哪个 JDK 编译」是两回事——
//! 语言服务器跑在 21 上照样分析 Java 8 工程（按 pom / gradle 的编译级别，2026-10-15 po-api 实测）。
//!
//! 版本判定读 JDK 目录下的 `release` 文件（`JAVA_VERSION="21.0.11"`），不起进程；PATH 上的 `java`
//! 若是 shim（Windows 的 `Common Files\Oracle\Java\javapath`，旁边没有 `release`）才退回 `java -version`。
//! 同步实现：调用方在 `spawn_blocking` 里（安装）或启动 server 的路径上（本身就是 IO）。

use std::path::{Path, PathBuf};

/// 找一个版本 ≥ `min_major` 的 `java` 可执行文件。顺序：JAVA_HOME → PATH → 常见安装目录
///（Aide 的 JDK 注册表也落在这些目录里：`~/.jdks`、`Program Files\Java`、`/usr/lib/jvm`、macOS 的
/// `JavaVirtualMachines`）。同一档里取版本最高的。
pub fn find_java(min_major: u32) -> Option<(PathBuf, u32)> {
    if let Some(home) = std::env::var_os("JAVA_HOME").map(PathBuf::from) {
        if let Some(found) = in_home(&home).filter(|(_, v)| *v >= min_major) {
            return Some(found);
        }
    }
    if let Some(java) = crate::lsp::registry::which_native("java") {
        let home = java.parent().and_then(Path::parent).map(Path::to_path_buf);
        let version = home.as_deref().and_then(release_major).or_else(|| version_by_running(&java));
        if version.is_some_and(|v| v >= min_major) {
            return Some((java, version.unwrap_or(0)));
        }
    }
    candidate_homes()
        .into_iter()
        .filter_map(|h| in_home(&h))
        .filter(|(_, v)| *v >= min_major)
        .max_by_key(|(_, v)| *v)
}

/// JDK 目录 → (java 可执行文件, 主版本)。
fn in_home(home: &Path) -> Option<(PathBuf, u32)> {
    // macOS 的 JDK 包：<x>.jdk/Contents/Home
    let home = if home.join("Contents/Home/release").is_file() { home.join("Contents/Home") } else { home.to_path_buf() };
    let java = home.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
    if !java.is_file() {
        return None;
    }
    Some((java, release_major(&home)?))
}

fn release_major(home: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(home.join("release")).ok()?;
    let line = text.lines().find(|l| l.starts_with("JAVA_VERSION="))?;
    parse_major(line.trim_start_matches("JAVA_VERSION=").trim_matches('"'))
}

/// `21.0.11` → 21；`1.8.0_422` → 8；`17` → 17。
pub fn parse_major(version: &str) -> Option<u32> {
    let mut parts = version.split(|c: char| c == '.' || c == '_' || c == '+' || c == '-');
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 {
        parts.next()?.parse().ok()
    } else {
        Some(first)
    }
}

/// `java -version` 的第一行：`java version "21.0.11" 2026-04-21 LTS` / `openjdk version "1.8.0_422"`。
fn version_by_running(java: &Path) -> Option<u32> {
    let mut cmd = std::process::Command::new(java);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    let quoted = text.lines().next()?.split('"').nth(1)?;
    parse_major(quoted)
}

/// 常见的 JDK 安装目录下的每个子目录。
fn candidate_homes() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = crate::paths::user_home() {
        roots.push(home.join(".jdks")); // IntelliJ / Aide 注册表常见落点
        roots.push(home.join(".sdkman/candidates/java"));
    }
    roots.extend(platform_roots());
    roots
        .into_iter()
        .filter_map(|r| std::fs::read_dir(r).ok())
        .flat_map(|rd| rd.flatten().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect()
}

#[cfg(windows)]
fn platform_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432"] {
        if let Some(pf) = std::env::var_os(var).map(PathBuf::from) {
            for vendor in ["Java", "Eclipse Adoptium", "Microsoft", "Amazon Corretto", "Zulu"] {
                out.push(pf.join(vendor));
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn platform_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/Library/Java/JavaVirtualMachines")]
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn platform_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/usr/lib/jvm")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_old_and_new_version_strings() {
        assert_eq!(parse_major("21.0.11"), Some(21));
        assert_eq!(parse_major("1.8.0_422"), Some(8));
        assert_eq!(parse_major("17"), Some(17));
        assert_eq!(parse_major("25-ea"), Some(25));
        assert_eq!(parse_major("garbage"), None);
    }

    #[test]
    fn reads_jdk_home_by_release_file() {
        let home = std::env::temp_dir().join(format!("aide-jdk-{}", std::process::id()));
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" }), "").unwrap();
        std::fs::write(home.join("release"), "IMPLEMENTOR=\"x\"\nJAVA_VERSION=\"21.0.7\"\n").unwrap();
        let (java, v) = in_home(&home).unwrap();
        assert_eq!(v, 21);
        assert!(java.ends_with(if cfg!(windows) { "java.exe" } else { "java" }));
        let _ = std::fs::remove_dir_all(&home);
    }
}
