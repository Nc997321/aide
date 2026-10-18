//! 手机读文件的闸门（Host 端）。
//!
//! 手机端的文件预览（图片 / 文档 / 文本）经 `read_file_*` 两条命令读 Host 上的文件。桌面前端
//! 调同一条命令、不设限；远程多这一道，两条规则：
//! - **只许读已注册工作区里的文件**：路径先 canonicalize（解掉 `..` 与符号链接），须落在某个
//!   注册工作区根之下；
//! - **大小上限** [`PHONE_FILE_MAX_BYTES`]：手机经中继传输，超大文件直接拒。
//!
//! 目录白名单管「能不能调」（[`crate::Catalog`]），这里管「能读哪儿」。由 [`crate::link::backend`]
//! 的 `call` 在转给命令表前执行。

use std::path::{Path, PathBuf};

use serde_json::Value;

/// 手机端单次读取的字节上限（base64 后约 11 MB，经中继传输的上限）。
pub const PHONE_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 受本闸门管的方法（手机端的文件读取）。
pub const READ_METHODS: &[&str] = &["read_file_content", "read_file_base64"];

pub fn is_read_method(method: &str) -> bool {
    READ_METHODS.contains(&method)
}

/// 当前已注册工作区根（每次现读 state，设置改了立即生效）。
pub fn registered_roots() -> Vec<PathBuf> {
    let config = crate::app_settings::load_state();
    crate::commands::workspace::registered_paths(&config).into_iter().map(PathBuf::from).collect()
}

/// 校验一次手机读文件请求。`roots` 任一覆盖即放行。
pub fn check_read(params: &Value, roots: &[PathBuf]) -> Result<(), String> {
    let raw = params.get("path").and_then(Value::as_str).ok_or("缺少 path 参数")?;
    check_path(Path::new(raw), roots)
}

fn check_path(raw: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let file = std::fs::canonicalize(raw).map_err(|e| format!("无法访问文件：{e}"))?;
    let inside = roots.iter().any(|root| std::fs::canonicalize(root).is_ok_and(|r| file.starts_with(&r)));
    if !inside {
        return Err("手机端只能读取已注册工作区里的文件".into());
    }
    let len = std::fs::metadata(&file).map_err(|e| format!("无法读取文件信息：{e}"))?.len();
    if len > PHONE_FILE_MAX_BYTES {
        return Err(format!("文件过大（{len} 字节），手机端上限 {PHONE_FILE_MAX_BYTES} 字节"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 测试用临时目录（系统临时目录下唯一子目录；不写死平台路径）。
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aide-files-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_inside_a_registered_root_is_allowed() {
        let root = scratch("inside");
        let file = root.join("a.png");
        std::fs::write(&file, b"png").unwrap();
        let params = json!({ "path": file.to_string_lossy() });
        assert!(check_read(&params, std::slice::from_ref(&root)).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_outside_every_root_is_refused() {
        let root = scratch("root");
        let other = scratch("other");
        let file = other.join("secret.txt");
        std::fs::write(&file, b"x").unwrap();
        let err = check_read(&json!({ "path": file.to_string_lossy() }), std::slice::from_ref(&root)).unwrap_err();
        assert!(err.contains("已注册工作区"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn dotdot_escape_is_refused() {
        let root = scratch("dotdot");
        let other = scratch("dotdot-out");
        let outside = other.join("out.txt");
        std::fs::write(&outside, b"x").unwrap();
        // root/../<other 的目录名>/out.txt 解析后落在 root 之外
        let sneaky = root.join("..").join(other.file_name().unwrap()).join("out.txt");
        assert!(check_read(&json!({ "path": sneaky.to_string_lossy() }), std::slice::from_ref(&root)).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_refused() {
        let root = scratch("link");
        let other = scratch("link-out");
        let target = other.join("secret.txt");
        std::fs::write(&target, b"x").unwrap();
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(check_read(&json!({ "path": link.to_string_lossy() }), std::slice::from_ref(&root)).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn oversized_file_is_refused() {
        let root = scratch("big");
        let file = root.join("big.bin");
        let f = std::fs::File::create(&file).unwrap();
        f.set_len(PHONE_FILE_MAX_BYTES + 1).unwrap();
        let err = check_read(&json!({ "path": file.to_string_lossy() }), std::slice::from_ref(&root)).unwrap_err();
        assert!(err.contains("过大"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_path_param_is_refused() {
        assert!(check_read(&json!({}), &[]).is_err());
    }
}
