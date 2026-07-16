//! JDK 注册表：扫描本机已安装的 JDK，供运行配置按项目选 JDK 版本。
//!
//! 全程纯文件系统读取——读每个候选 JDK home 下的 `release` 文件取版本
//! （`JAVA_VERSION="21.0.2"`），**不 spawn 任何子进程**，因此天然规避
//! Windows `CREATE_NO_WINDOW` 坑。发现的 JDK 路径以 `read_dir` 原样返回
//! （非 verbatim），直接存进 RunConfig.env 后传给 `cmd` 也安全。
//!
//! 注册表本身持久化在 `AppSettings.jdkRegistry`，由前端 settings 管理；
//! 本模块只负责"扫描"与"校验解析"，不负责落盘。

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::user_home;

/// 一个已登记的 JDK。`version` 为主版本号字符串（"21" / "8"），便于展示与匹配。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JdkEntry {
    pub name: String,
    pub version: String,
    pub path: String,
}

/// 解析 `release` 文件里的 `JAVA_VERSION="..."`，返回主版本号。
/// `"21.0.2"` → `"21"`；`"1.8.0_301"` → `"8"`；`"21.0.2+13"` → `"21"`。
/// 无 `release` 文件或读不出版本 → `None`（视为非有效 JDK home）。
pub(crate) fn read_release_version(home: &Path) -> Option<String> {
    let release = home.join("release");
    let content = fs::read_to_string(&release).ok()?;
    parse_java_version_from_release(&content)
}

/// 从 `release` 文件内容里抽 `JAVA_VERSION="..."` 并归一成主版本号。
/// 纯函数（不读盘），便于单测。
pub(crate) fn parse_java_version_from_release(content: &str) -> Option<String> {
    let re = Regex::new(r#"JAVA_VERSION\s*=\s*"([^"]*)""#).ok()?;
    let caps = re.captures(content)?;
    let raw = caps.get(1)?.as_str();
    parse_java_major(raw)
}

/// 把原始版本串归一成主版本号：`1.8.x` → `8`，`21.x` → `21`。
fn parse_java_major(raw: &str) -> Option<String> {
    // 去掉 `+13` 这类 build 后缀
    let base = raw.split('+').next().unwrap_or(raw);
    let mut parts = base.split('.');
    let first = parts.next()?;
    if first == "1" {
        // 旧式 1.x 命名（1.8 / 1.7）→ 主版本在第二段
        let second = parts.next()?;
        Some(second.to_string())
    } else {
        Some(first.to_string())
    }
}

/// 列出 `parent` 下的直接子目录（非递归）。父目录不存在/无权限 → 空。
fn child_dirs(parent: &Path) -> Vec<PathBuf> {
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect()
}

/// 给定一批候选 JDK home 目录，读每个的 `release` 取版本，组装成 `JdkEntry`。
/// 无效（无 `release`/读不出版本）的跳过；按路径字符串去重。
/// 纯遍历逻辑（不读固定系统路径），便于用临时目录做单测。
pub(crate) fn collect_jdks<I>(homes: I) -> Vec<JdkEntry>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for home in homes {
        // 路径字符串去重（不走 canonicalize，避免 Windows `\\?\` verbatim 污染）
        let key = home.to_string_lossy().to_string();
        if !seen.insert(key.clone()) {
            continue;
        }
        let Some(version) = read_release_version(&home) else {
            continue;
        };
        let name = home
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("(unknown)")
            .to_string();
        out.push(JdkEntry { name, version, path: key });
    }
    out
}

/// 返回本平台常见的 JDK home 候选目录（已解析到 home 层，含 macOS 的
/// `…/Contents/Home`）。生产扫描入口 `scan_jdks` 调它后交给 `collect_jdks`。
fn candidate_jdk_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // /Library/Java/JavaVirtualMachines/<name>/Contents/Home
        let jvms = PathBuf::from("/Library/Java/JavaVirtualMachines");
        for e in child_dirs(&jvms) {
            let h = e.join("Contents/Home");
            if h.is_dir() {
                homes.push(h);
            }
        }
        if let Some(h) = user_home() {
            homes.extend(child_dirs(&h.join(".sdkman/candidates/java")));
            homes.extend(child_dirs(&h.join(".jdks")));
        }
    }

    #[cfg(windows)]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
        for parent in [
            format!("{pf}\\Java"),
            format!("{pf}\\Eclipse Adoptium"),
            format!("{pf}\\Zulu"),
            format!("{pf}\\Temurin"),
            format!("{pf86}\\Eclipse Adoptium"),
        ] {
            homes.extend(child_dirs(Path::new(&parent)));
        }
        // Microsoft JDK 装在 C:\Program Files\Microsoft\jdk-<ver>，按前缀过滤
        let ms = format!("{pf}\\Microsoft");
        for d in child_dirs(Path::new(&ms)) {
            if d.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("jdk-"))
                .unwrap_or(false)
            {
                homes.push(d);
            }
        }
        if let Some(h) = user_home() {
            homes.extend(child_dirs(&h.join(".jdks")));
        }
        if let Ok(lad) = std::env::var("LOCALAPPDATA") {
            homes.extend(child_dirs(Path::new(&format!("{lad}\\Programs\\Eclipse Adoptium"))));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for parent in ["/usr/lib/jvm", "/usr/java"] {
            homes.extend(child_dirs(Path::new(parent)));
        }
        if let Some(h) = user_home() {
            homes.extend(child_dirs(&h.join(".sdkman/candidates/java")));
            homes.extend(child_dirs(&h.join(".jdks")));
        }
    }

    homes
}

/// 扫描本机已安装的 JDK。async + spawn_blocking（目录遍历是 IO，不占 Tauri 主线程）。
#[tauri::command]
pub async fn scan_jdks() -> Result<Vec<JdkEntry>, String> {
    tokio::task::spawn_blocking(|| Ok(collect_jdks(candidate_jdk_homes())))
        .await
        .map_err(|e| format!("scan_jdks task panicked: {e}"))?
}

/// 校验用户手动输入的路径是否为有效 JDK home 并自动取版本。
/// 有效 → 返回 JdkEntry；无效（无 `release`/读不出版本）→ None。
#[tauri::command]
pub async fn resolve_jdk(path: String) -> Result<Option<JdkEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let home = PathBuf::from(&path);
        if let Some(version) = read_release_version(&home) {
            let name = home
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("(manual)")
                .to_string();
            Ok(Some(JdkEntry { name, version, path }))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|e| format!("resolve_jdk task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_java_version_modern() {
        assert_eq!(parse_java_major("21.0.2"), Some("21".into()));
        assert_eq!(parse_java_major("21"), Some("21".into()));
        assert_eq!(parse_java_major("17.0.8+7"), Some("17".into()));
    }

    #[test]
    fn parse_java_version_legacy_1x() {
        // 旧式 1.x 命名：主版本在第二段
        assert_eq!(parse_java_major("1.8.0_301"), Some("8".into()));
        assert_eq!(parse_java_major("1.7.0_80"), Some("7".into()));
    }

    #[test]
    fn parse_java_version_from_release_string() {
        let content = r#"IMPLEMENTOR="Eclipse Adoptium"
JAVA_VERSION="21.0.2+13"
OS_NAME="Linux"
"#;
        assert_eq!(parse_java_version_from_release(content), Some("21".into()));
    }

    #[test]
    fn parse_java_version_from_release_legacy() {
        let content = "JAVA_VERSION=\"1.8.0_301\"";
        assert_eq!(parse_java_version_from_release(content), Some("8".into()));
    }

    #[test]
    fn parse_release_returns_none_without_version_line() {
        assert_eq!(parse_java_version_from_release("OS_NAME=Linux"), None);
        assert_eq!(parse_java_version_from_release(""), None);
    }

    /// 造临时目录模拟 JDK 安装根：放 jdk-21/release、jdk-8/release 和一个无 release
    /// 的目录（非 JDK）。`collect_jdks` 应只返回两个有效的，跳过无效项。
    #[test]
    fn collect_jdks_finds_valid_and_skips_invalid() {
        let root = std::env::temp_dir().join("aide_jdk_scan_test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let j21 = root.join("jdk-21");
        let j8 = root.join("jdk-8");
        let not = root.join("not-a-jdk");
        fs::create_dir_all(&j21).unwrap();
        fs::create_dir_all(&j8).unwrap();
        fs::create_dir_all(&not).unwrap();
        fs::write(j21.join("release"), b"JAVA_VERSION=\"21.0.2+13\"").unwrap();
        fs::write(j8.join("release"), b"JAVA_VERSION=\"1.8.0_301\"").unwrap();
        // not-a-jdk 没有 release 文件

        let homes = child_dirs(&root);
        let entries = collect_jdks(homes);
        assert_eq!(entries.len(), 2, "must skip the dir without release");

        let by_name: std::collections::BTreeMap<&str, &JdkEntry> =
            entries.iter().map(|e| (e.name.as_str(), e)).collect();
        let j21e = by_name.get("jdk-21").expect("jdk-21 present");
        let j8e = by_name.get("jdk-8").expect("jdk-8 present");
        assert_eq!(j21e.version, "21");
        assert_eq!(j21e.path, j21.to_string_lossy().to_string());
        assert_eq!(j8e.version, "8");
        assert_eq!(j8e.path, j8.to_string_lossy().to_string());

        let _ = fs::remove_dir_all(&root);
    }

    /// `read_release_version` 对无 release 的目录返回 None。
    #[test]
    fn read_release_version_none_for_non_jdk_dir() {
        let root = std::env::temp_dir().join("aide_jdk_norelease_test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(read_release_version(&root).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    /// `JdkEntry` 序列化为 camelCase（前端按 camelCase 读）。
    #[test]
    fn jdk_entry_serializes_camel_case() {
        let e = JdkEntry { name: "jdk-21".into(), version: "21".into(), path: "/p".into() };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("\"name\""), "{s}");
        assert!(s.contains("\"version\""), "{s}");
        assert!(s.contains("\"path\""), "{s}");
        let back: JdkEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back.path, "/p");
    }
}