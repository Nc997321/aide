//! 文件系统 / 搜索命令。实现都在 [`aide_workspace`]；这里只做参数形状与线程归位。
//!
//! 路径一律是 **Host 原生路径**（Host 在哪台机器，路径就是那台机器的形态）。

use std::path::PathBuf;
use std::sync::Arc;

use aide_workspace::search::{self, ReplaceFileInput, SearchOptions};
use aide_workspace::{detect_git_branch, fs_ops, FileEntry};
use serde::{Deserialize, Serialize};

use super::NoArgs;
use crate::registry::{blocking, Command};
use crate::paths::user_home;
use crate::{command, Core};

pub static COMMANDS: &[Command] = &[
    command!("get_project_info", get_project_info),
    command!("list_directory", list_directory),
    command!("list_fs_roots", list_fs_roots),
    command!("read_file_content", read_file_content),
    command!("read_file_base64", read_file_base64),
    command!(bytes "read_file_binary", read_file_binary),
    command!("write_file_content", write_file_content),
    command!("delete_file", delete_file),
    command!("create_file", create_file),
    command!("create_dir", create_dir),
    command!("copy_file", copy_file),
    command!("move_file", move_file),
    command!("grep_symbol", grep_symbol),
    command!("file_exists", file_exists),
    command!("path_types", path_types),
    command!("find_files_by_name", find_files_by_name),
    command!("search_in_files", search_in_files),
    command!("replace_in_files_preview", replace_in_files_preview),
    command!("apply_replacements", apply_replacements),
];

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub branch: String,
}

#[derive(Deserialize)]
pub struct CwdArg {
    #[serde(default)]
    cwd: Option<String>,
}

/// 项目信息（FileTree 根、CodeGraph 索引根）。显式 `cwd` 优先；否则活动工作区。
/// 都没有 = 显式空（root/name/branch 全 ""），**绝不回退家目录**（见 `active_root`）。
async fn get_project_info(core: Arc<Core>, a: CwdArg) -> Result<ProjectInfo, String> {
    let root = match a.cwd.filter(|c| !c.trim().is_empty()) {
        Some(c) => Some(PathBuf::from(c)),
        None => core.workspace.active_root(),
    };
    blocking(move || {
        Ok(match root {
            Some(root) => ProjectInfo {
                name: root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "unknown".into()),
                branch: detect_git_branch(&root),
                root: root.to_string_lossy().into_owned(),
            },
            None => ProjectInfo {
                root: String::new(),
                name: String::new(),
                branch: String::new(),
            },
        })
    })
    .await
}

/// 列目录。两个过滤维度刻意分开：`show_hidden`（点开头的条目，选目录时要看见 `.vscode`）
/// 与 `include_ignored`（node_modules / target 这类构建噪音，默认仍过滤）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirArgs {
    path: String,
    show_hidden: Option<bool>,
    include_ignored: Option<bool>,
}

async fn list_directory(_: Arc<Core>, a: ListDirArgs) -> Result<Vec<FileEntry>, String> {
    blocking(move || {
        fs_ops::list_directory_blocking(
            a.path,
            a.show_hidden.unwrap_or(false),
            a.include_ignored.unwrap_or(false),
        )
    })
    .await
}

/// 目录选择器的起点：家目录置顶；Windows 列盘符，其余平台列 `/`。
async fn list_fs_roots(_: Arc<Core>, _: NoArgs) -> Result<Vec<FileEntry>, String> {
    blocking(|| {
        let dir = |name: String, path: String| FileEntry {
            name,
            path,
            is_dir: true,
            children: None,
        };
        let mut roots = Vec::new();
        if let Some(home) = user_home().filter(|h| h.is_dir()) {
            roots.push(dir("Home".into(), home.to_string_lossy().into_owned()));
        }
        #[cfg(windows)]
        for b in b'A'..=b'Z' {
            let drive = format!("{}:\\", b as char);
            if std::path::Path::new(&drive).is_dir() {
                roots.push(dir(format!("{}:", b as char), drive));
            }
        }
        #[cfg(not(windows))]
        roots.push(dir("/".into(), "/".into()));
        Ok(roots)
    })
    .await
}

#[derive(Deserialize)]
pub struct PathArg {
    path: String,
}

async fn read_file_content(_: Arc<Core>, a: PathArg) -> Result<String, String> {
    blocking(move || fs_ops::read_text_file_with_encoding(&a.path)).await
}

async fn read_file_base64(_: Arc<Core>, a: PathArg) -> Result<String, String> {
    blocking(move || fs_ops::read_file_base64(&a.path)).await
}

/// 原始字节（图片预览）：前端 `new Blob(...)` + `URL.createObjectURL` 喂给 `<img>`。
async fn read_file_binary(_: Arc<Core>, a: PathArg) -> Result<Vec<u8>, String> {
    blocking(move || fs_ops::read_file_binary(&a.path)).await
}

#[derive(Deserialize)]
pub struct WriteArgs {
    path: String,
    content: String,
}

async fn write_file_content(_: Arc<Core>, a: WriteArgs) -> Result<(), String> {
    blocking(move || fs_ops::write_file_content(&a.path, &a.content)).await
}

async fn delete_file(_: Arc<Core>, a: PathArg) -> Result<(), String> {
    blocking(move || fs_ops::delete_file(&a.path)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentName {
    parent_path: String,
    name: String,
}

async fn create_file(_: Arc<Core>, a: ParentName) -> Result<(), String> {
    blocking(move || fs_ops::create_file(&a.parent_path, &a.name)).await
}

async fn create_dir(_: Arc<Core>, a: ParentName) -> Result<(), String> {
    blocking(move || fs_ops::create_dir(&a.parent_path, &a.name)).await
}

#[derive(Deserialize)]
pub struct SrcDest {
    src: String,
    dest: String,
}

async fn copy_file(_: Arc<Core>, a: SrcDest) -> Result<(), String> {
    blocking(move || fs_ops::copy_file(&a.src, &a.dest)).await
}

async fn move_file(_: Arc<Core>, a: SrcDest) -> Result<(), String> {
    blocking(move || fs_ops::move_file(&a.src, &a.dest)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepArgs {
    word: String,
    cwd: String,
    source_ext: Option<String>,
}

async fn grep_symbol(_: Arc<Core>, a: GrepArgs) -> Result<Vec<aide_workspace::GrepMatch>, String> {
    blocking(move || fs_ops::grep_symbol(a.word, a.cwd, a.source_ext)).await
}

async fn file_exists(_: Arc<Core>, a: PathArg) -> Result<bool, String> {
    blocking(move || Ok(fs_ops::file_exists(&a.path))).await
}

#[derive(Deserialize)]
pub struct PathsArg {
    paths: Vec<String>,
}

/// 批量探测路径类型，逐项返回 `"file"` / `"dir"` / `"none"`（输入框 `@path` 芯片用）。
async fn path_types(_: Arc<Core>, a: PathsArg) -> Result<Vec<String>, String> {
    blocking(move || Ok(fs_ops::path_types(&a.paths))).await
}

#[derive(Deserialize)]
pub struct FindArgs {
    query: String,
    cwd: String,
    limit: Option<usize>,
}

async fn find_files_by_name(_: Arc<Core>, a: FindArgs) -> Result<Vec<String>, String> {
    blocking(move || fs_ops::find_files_by_name(a.query, a.cwd, a.limit)).await
}

#[derive(Deserialize)]
pub struct SearchArgs {
    query: String,
    cwd: String,
    options: SearchOptions,
}

async fn search_in_files(_: Arc<Core>, a: SearchArgs) -> Result<search::SearchResponse, String> {
    blocking(move || search::search_in_files_blocking(&a.query, &a.cwd, &a.options)).await
}

#[derive(Deserialize)]
pub struct ReplacePreviewArgs {
    query: String,
    replacement: String,
    cwd: String,
    options: SearchOptions,
}

async fn replace_in_files_preview(
    _: Arc<Core>,
    a: ReplacePreviewArgs,
) -> Result<search::ReplacePreviewResponse, String> {
    blocking(move || {
        search::replace_in_files_preview_blocking(&a.query, &a.replacement, &a.cwd, &a.options)
    })
    .await
}

#[derive(Deserialize)]
pub struct ApplyArgs {
    files: Vec<ReplaceFileInput>,
}

async fn apply_replacements(_: Arc<Core>, a: ApplyArgs) -> Result<search::ApplyResult, String> {
    blocking(move || search::apply_replacements_blocking(a.files)).await
}

#[cfg(test)]
mod tests {
    use crate::registry::{lookup, Reply};
    use crate::{Core, NullSink};
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn core() -> Arc<Core> {
        crate::test_core(Arc::new(NullSink))
    }

    async fn call(cmd: &str, args: Value) -> Result<Reply, String> {
        lookup(cmd).unwrap_or_else(|| panic!("{cmd} not registered"))(core(), args).await
    }

    fn json_of(r: Reply) -> Value {
        match r {
            Reply::Json(v) => v,
            Reply::Bytes(_) => panic!("expected json"),
        }
    }

    #[tokio::test]
    async fn fs_roundtrip_through_the_table() {
        let dir = std::env::temp_dir().join(format!("aide-core-fs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt").to_string_lossy().into_owned();
        call("write_file_content", json!({ "path": file, "content": "hi" })).await.unwrap();
        assert_eq!(json_of(call("read_file_content", json!({ "path": file })).await.unwrap()), json!("hi"));
        let Reply::Bytes(b) = call("read_file_binary", json!({ "path": file })).await.unwrap() else {
            panic!("read_file_binary must reply bytes");
        };
        assert_eq!(b, b"hi");
        let list = json_of(call("list_directory", json!({ "path": dir })).await.unwrap());
        assert_eq!(list[0]["name"], json!("a.txt"));
        call("create_dir", json!({ "parentPath": dir, "name": "sub" })).await.unwrap();
        assert_eq!(
            json_of(call("path_types", json!({ "paths": [file, dir.join("sub"), dir.join("zz")] })).await.unwrap()),
            json!(["file", "dir", "none"])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn project_info_is_empty_without_a_workspace() {
        let v = json_of(call("get_project_info", Value::Null).await.unwrap());
        assert_eq!(v, json!({ "root": "", "name": "", "branch": "" }));
    }

    #[tokio::test]
    async fn bad_args_are_reported() {
        let e = call("read_file_content", json!({})).await.err().unwrap();
        assert!(e.contains("invalid args"), "{e}");
    }
}
