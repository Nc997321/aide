//! `fs.*`：应用读写**面板所在工作区**里的文件。路径一律是工作区内的相对路径，
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

/// 工作区里的一个目录：`cwd` 省略或空 = 工作区根。返回真实路径和相对写法（`process.run` 的 cwd 用）。
pub fn dir(workspace: Option<&Path>, cwd: Option<&str>) -> Result<(PathBuf, String), String> {
    let root = root(workspace)?;
    let (real, rel) = match cwd {
        None | Some("") | Some(".") => (root.clone(), String::new()),
        Some(path) => {
            safe_rel(path)?;
            (inside(&root, &root.join(path))?, path.to_string())
        }
    };
    if !real.is_dir() {
        return Err("cwd 不是目录".into());
    }
    Ok((real, rel))
}

pub fn stat(workspace: Option<&Path>, params: &Value) -> Result<Value, String> {
    let root = root(workspace)?;
    let meta = fs::metadata(inside(&root, &root.join(rel(params)?))?).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
    Ok(json!({ "isDir": meta.is_dir(), "size": meta.len(), "mtime": mtime }))
}

fn limit(params: &Value, default: usize, max: usize) -> usize {
    params.get("limit").and_then(Value::as_u64).map_or(default, |n| (n as usize).clamp(1, max))
}

/// 按文件名找（文件树里点文件链接用的那一套：名字相等的在前，其次名字包含）。遵守 `.gitignore`、
/// 跳过隐藏文件。结果是相对工作区根的路径。
pub fn find(workspace: Option<&Path>, params: &Value) -> Result<Value, String> {
    let root = root(workspace)?;
    let name = params.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if name.is_empty() || name.len() > 256 || name.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("fs.find 需要 name（文件名，或带目录段的路径片段）".into());
    }
    let found = aide_workspace::fs_ops::find_files_by_name(
        name.to_string(),
        root.to_string_lossy().into_owned(),
        Some(limit(params, 50, 500)),
    )?;
    let files: Vec<String> = found
        .iter()
        .filter_map(|full| Path::new(full).strip_prefix(&root).ok())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .collect();
    Ok(json!({ "files": files }))
}

/// 按内容搜（搜索面板用的那一套）。`mask` 是文件名掩码（`*.ts`），不是路径 glob。
pub fn search(workspace: Option<&Path>, params: &Value) -> Result<Value, String> {
    let root = root(workspace)?;
    let query = params.get("query").and_then(Value::as_str).unwrap_or("");
    if query.trim().is_empty() || query.len() > 1000 {
        return Err("fs.search 需要 query".into());
    }
    let flag = |name: &str| params.get(name).and_then(Value::as_bool).unwrap_or(false);
    let options = aide_workspace::search::SearchOptions {
        use_regex: flag("regex"),
        case_sensitive: flag("caseSensitive"),
        whole_word: flag("wholeWord"),
        file_mask: params.get("mask").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string),
        limit: Some(limit(params, 200, 2000)),
    };
    let found = aide_workspace::search::search_in_files_blocking(query, &root.to_string_lossy(), &options)?;
    serde_json::to_value(found).map_err(|e| e.to_string())
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
    fn finds_searches_and_stats_with_paths_relative_to_the_workspace() {
        let (_, ws) = workspace();
        fs::create_dir_all(ws.join("mod/deep")).unwrap();
        fs::write(ws.join("mod/deep/a.txt"), "hello again\nTODO fix").unwrap();
        let mut files: Vec<String> =
            serde_json::from_value(find(Some(&ws), &json!({ "name": "a.txt" })).unwrap()["files"].clone()).unwrap();
        files.sort();
        assert_eq!(files, ["mod/deep/a.txt", "src/a.txt"]);

        let hits = search(Some(&ws), &json!({ "query": "TODO", "mask": "*.txt" })).unwrap();
        assert_eq!(hits["total"], 1);
        assert_eq!(hits["files"][0]["file"], "mod/deep/a.txt");
        assert_eq!(hits["files"][0]["matches"][0]["line"], 2);

        let st = stat(Some(&ws), &json!({ "path": "src/a.txt" })).unwrap();
        assert_eq!((st["isDir"].clone(), st["size"].clone()), (json!(false), json!(5)));
        assert_eq!(stat(Some(&ws), &json!({ "path": "src" })).unwrap()["isDir"], true);
        assert!(stat(Some(&ws), &json!({ "path": "../outside.txt" })).is_err());
        assert!(find(Some(&ws), &json!({ "name": "../outside.txt" })).is_err());
    }

    #[test]
    fn a_process_cwd_must_be_a_directory_inside_the_workspace() {
        let (_, ws) = workspace();
        assert_eq!(dir(Some(&ws), None).unwrap().1, "");
        assert_eq!(dir(Some(&ws), Some("src")).unwrap(), (ws.canonicalize().unwrap().join("src"), "src".to_string()));
        for bad in ["..", "/tmp", "src/a.txt", "nope"] {
            assert!(dir(Some(&ws), Some(bad)).is_err(), "{bad}");
        }
        assert!(dir(None, None).is_err());
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
