//! `fs.*`：应用读写**当前工作区**里的文件。路径一律是工作区内的相对路径，
//! 解析符号链接后必须仍在工作区内。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::manifest::safe_rel;
use super::store::write_atomic;

const MAX_FILE: u64 = 5 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
/// 应用不许写进去的目录：`.git`（钩子即代码执行）、`.aide`（Aide 自己的配置、hooks、别的应用）。
const WRITE_DENY: &[&str] = &[".git", ".aide"];

fn root(workspace: Option<&Path>) -> Result<PathBuf, String> {
    workspace
        .ok_or("没有打开的工作区".to_string())?
        .canonicalize()
        .map_err(|e| format!("工作区不可用：{e}"))
}

fn rel(params: &Value) -> Result<&str, String> {
    let path = params.get("path").and_then(Value::as_str).ok_or("需要 path")?;
    safe_rel(path)?;
    Ok(path)
}

/// 解析成工作区内的真实路径；越界（含经符号链接越界）即拒绝。
fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let real = path.canonicalize().map_err(|_| "文件不存在".to_string())?;
    if !real.starts_with(root) {
        return Err("路径在工作区之外".into());
    }
    Ok(real)
}

pub fn read(workspace: Option<&Path>, params: &Value) -> Result<Value, String> {
    let root = root(workspace)?;
    let file = inside(&root, &root.join(rel(params)?))?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    if meta.len() > MAX_FILE {
        return Err(format!("文件超过 {} MB 上限", MAX_FILE / 1024 / 1024));
    }
    let text = String::from_utf8(fs::read(&file).map_err(|e| e.to_string())?).map_err(|_| "不是文本文件".to_string())?;
    Ok(json!({ "text": text }))
}

/// 列一层目录。`path` 省略 = 工作区根。
pub fn list(workspace: Option<&Path>, params: &Value) -> Result<Value, String> {
    let root = root(workspace)?;
    let dir = match params.get("path").and_then(Value::as_str) {
        None | Some("") | Some(".") => root.clone(),
        Some(_) => inside(&root, &root.join(rel(params)?))?,
    };
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().take(MAX_ENTRIES) {
        let Ok(meta) = entry.metadata() else { continue };
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "isDir": meta.is_dir(),
            "size": meta.len(),
        }));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({ "entries": entries }))
}

pub fn write(workspace: Option<&Path>, params: &Value) -> Result<Value, String> {
    let root = root(workspace)?;
    let path = rel(params)?;
    if let Some(denied) = path.split('/').find(|seg| WRITE_DENY.iter().any(|d| seg.eq_ignore_ascii_case(d))) {
        return Err(format!("应用不能写进 {denied} 目录"));
    }
    let text = params.get("text").and_then(Value::as_str).ok_or("需要 text")?;
    if text.len() as u64 > MAX_FILE {
        return Err(format!("内容超过 {} MB 上限", MAX_FILE / 1024 / 1024));
    }
    let target = root.join(path);
    // 父目录必须已存在且在工作区内（不替应用建目录树：越界判断只对真实存在的目录可靠）
    let parent = inside(&root, target.parent().ok_or("路径不合法")?).map_err(|_| "父目录不存在或在工作区之外".to_string())?;
    let file = parent.join(target.file_name().ok_or("路径不合法")?);
    // 目标若是指到工作区外的符号链接，写它就是写外面
    if file.is_symlink() {
        return Err("目标是符号链接，拒绝写入".into());
    }
    write_atomic(&file, text.as_bytes())?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn workspace() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("aide_wsfs_{}_{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&base);
        let ws = base.join("ws");
        fs::create_dir_all(ws.join("src")).unwrap();
        fs::write(ws.join("src/a.txt"), "hello").unwrap();
        fs::write(base.join("outside.txt"), "secret").unwrap();
        (base, ws)
    }

    #[test]
    fn reads_lists_and_writes_inside_the_workspace() {
        let (_, ws) = workspace();
        assert_eq!(read(Some(&ws), &json!({ "path": "src/a.txt" })).unwrap()["text"], "hello");
        write(Some(&ws), &json!({ "path": "src/b.txt", "text": "new" })).unwrap();
        let names: Vec<String> = list(Some(&ws), &json!({ "path": "src" })).unwrap()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["a.txt", "b.txt"]);
        assert_eq!(list(Some(&ws), &json!({})).unwrap()["entries"][0]["isDir"], true);
    }

    #[test]
    fn nothing_works_without_a_workspace() {
        assert!(read(None, &json!({ "path": "a" })).unwrap_err().contains("没有打开的工作区"));
    }

    #[test]
    fn paths_cannot_leave_the_workspace() {
        let (_, ws) = workspace();
        for path in ["../outside.txt", "/etc/passwd", "src/../../outside.txt", "C:/x"] {
            assert!(read(Some(&ws), &json!({ "path": path })).is_err(), "read {path}");
            assert!(write(Some(&ws), &json!({ "path": path, "text": "x" })).is_err(), "write {path}");
        }
    }

    #[test]
    fn writes_into_git_and_aide_are_refused() {
        let (_, ws) = workspace();
        fs::create_dir_all(ws.join(".git/hooks")).unwrap();
        fs::create_dir_all(ws.join(".aide/claude")).unwrap();
        for path in [".git/hooks/pre-commit", ".aide/claude/settings.json", ".GIT/config"] {
            assert!(write(Some(&ws), &json!({ "path": path, "text": "x" })).unwrap_err().contains("不能写进"), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_workspace_are_refused() {
        let (base, ws) = workspace();
        std::os::unix::fs::symlink(base.join("outside.txt"), ws.join("leak.txt")).unwrap();
        std::os::unix::fs::symlink(&base, ws.join("up")).unwrap();
        assert!(read(Some(&ws), &json!({ "path": "leak.txt" })).unwrap_err().contains("之外"));
        assert!(write(Some(&ws), &json!({ "path": "leak.txt", "text": "x" })).is_err());
        assert!(write(Some(&ws), &json!({ "path": "up/planted.txt", "text": "x" })).is_err());
        assert_eq!(fs::read_to_string(base.join("outside.txt")).unwrap(), "secret");
    }
}
