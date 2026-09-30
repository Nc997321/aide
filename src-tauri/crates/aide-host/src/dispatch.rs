//! `invoke` 分派：Tauri 命令名 → aide-workspace 的同一份实现。
//!
//! 这张表就是远程工作区的**可审计暴露面**（同 remote/rpc.rs 的 REGISTRY 思路）：
//! 不在表里的命令，桌面的 IPC 拦截层会**大声拒绝**，绝不回落到本机执行
//! （回落 = 在桌面机上操作一个看似同名的路径，即「跑错机器」）。

use aide_workspace::transcripts::{self, LastEventInfo, LoadMessagesResult};
use aide_host::protocol::{InvokeParams, BYTES_KEY};
use aide_workspace::{detect_git_branch, fs_ops, search, FileEntry};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::git_dispatch;

pub fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    // 前端省略全部参数时 args 可能是 null：按空对象解析，让 Option 字段取 None。
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| format!("invalid args: {e}"))
}

pub fn to_value<T: Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// 阻塞实现搬到 blocking 线程池（同桌面包装的 spawn_blocking 口径）。
async fn blocking<T, F>(f: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Serialize + Send + 'static,
{
    to_value(
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| format!("task panicked: {e}"))?,
    )
}

pub async fn invoke(p: InvokeParams) -> Result<Value, String> {
    let InvokeParams { cmd, args, root } = p;
    if let Some(r) = invoke_fs(&cmd, args.clone()).await {
        return r;
    }
    let root = root.map(PathBuf::from);
    if cmd == "get_project_info" {
        let root = root.ok_or("get_project_info: missing root")?;
        return Ok(json!({
            "root": root.to_string_lossy(),
            "name": root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "branch": detect_git_branch(&root),
        }));
    }
    if let Some(r) = invoke_transcript(&cmd, args.clone()).await {
        return r;
    }
    if cmd.starts_with("git_") {
        let root = root.ok_or_else(|| format!("{cmd}: missing root"))?;
        if let Some(r) = git_dispatch::dispatch(&cmd, args, root).await {
            return r;
        }
    }
    Err(format!("aide-host: unsupported command `{cmd}`"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SrcDest {
    src: String,
    dest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParentName {
    parent_path: String,
    name: String,
}

async fn invoke_fs(cmd: &str, args: Value) -> Option<Result<Value, String>> {
    macro_rules! args {
        ($t:ty) => {
            match parse_args::<$t>(args) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    let r = match cmd {
        "list_directory" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                path: String,
                show_hidden: Option<bool>,
                include_ignored: Option<bool>,
            }
            let a = args!(A);
            blocking(move || {
                fs_ops::list_directory_blocking(
                    a.path,
                    a.show_hidden.unwrap_or(false),
                    a.include_ignored.unwrap_or(false),
                )
            })
            .await
        }
        "list_fs_roots" => to_value(Ok(fs_roots())),
        "read_file_content" => {
            let a = args!(PathArg);
            blocking(move || fs_ops::read_text_file_with_encoding(&a.path)).await
        }
        "read_file_base64" => {
            let a = args!(PathArg);
            blocking(move || fs_ops::read_file_base64(&a.path)).await
        }
        "read_file_binary" => {
            let a = args!(PathArg);
            blocking(move || {
                use base64::Engine;
                fs_ops::read_file_binary(&a.path).map(|bytes| {
                    json!({ BYTES_KEY: base64::engine::general_purpose::STANDARD.encode(bytes) })
                })
            })
            .await
        }
        "write_file_content" => {
            #[derive(Deserialize)]
            struct A {
                path: String,
                content: String,
            }
            let a = args!(A);
            blocking(move || fs_ops::write_file_content(&a.path, &a.content)).await
        }
        "delete_file" => {
            let a = args!(PathArg);
            blocking(move || fs_ops::delete_file(&a.path)).await
        }
        "create_file" => {
            let a = args!(ParentName);
            blocking(move || fs_ops::create_file(&a.parent_path, &a.name)).await
        }
        "create_dir" => {
            let a = args!(ParentName);
            blocking(move || fs_ops::create_dir(&a.parent_path, &a.name)).await
        }
        "copy_file" => {
            let a = args!(SrcDest);
            blocking(move || fs_ops::copy_file(&a.src, &a.dest)).await
        }
        "move_file" => {
            let a = args!(SrcDest);
            blocking(move || fs_ops::move_file(&a.src, &a.dest)).await
        }
        "grep_symbol" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                word: String,
                cwd: String,
                source_ext: Option<String>,
            }
            let a = args!(A);
            blocking(move || fs_ops::grep_symbol(a.word, a.cwd, a.source_ext)).await
        }
        "file_exists" => {
            let a = args!(PathArg);
            blocking(move || Ok(fs_ops::file_exists(&a.path))).await
        }
        "path_types" => {
            #[derive(Deserialize)]
            struct A {
                paths: Vec<String>,
            }
            let a = args!(A);
            blocking(move || Ok(fs_ops::path_types(&a.paths))).await
        }
        "find_files_by_name" => {
            #[derive(Deserialize)]
            struct A {
                query: String,
                cwd: String,
                limit: Option<usize>,
            }
            let a = args!(A);
            blocking(move || fs_ops::find_files_by_name(a.query, a.cwd, a.limit)).await
        }
        "search_in_files" => {
            #[derive(Deserialize)]
            struct A {
                query: String,
                cwd: String,
                options: search::SearchOptions,
            }
            let a = args!(A);
            blocking(move || search::search_in_files_blocking(&a.query, &a.cwd, &a.options)).await
        }
        "replace_in_files_preview" => {
            #[derive(Deserialize)]
            struct A {
                query: String,
                replacement: String,
                cwd: String,
                options: search::SearchOptions,
            }
            let a = args!(A);
            blocking(move || {
                search::replace_in_files_preview_blocking(
                    &a.query,
                    &a.replacement,
                    &a.cwd,
                    &a.options,
                )
            })
            .await
        }
        "apply_replacements" => {
            #[derive(Deserialize)]
            struct A {
                files: Vec<search::ReplaceFileInput>,
            }
            let a = args!(A);
            blocking(move || search::apply_replacements_blocking(a.files)).await
        }
        _ => return None,
    };
    Some(r)
}

/// 目标机的 claude home：与 `aide-host agent` 给 sidecar 的 CLAUDE_CONFIG_DIR 同一口径
/// （`$HOME/.aide/claude`，环境显式给了则用环境的）。读写两侧必须对称。
fn claude_home() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join(".aide")
        .join("claude")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionArg {
    session_id: String,
}

async fn invoke_transcript(cmd: &str, args: Value) -> Option<Result<Value, String>> {
    macro_rules! args {
        ($t:ty) => {
            match parse_args::<$t>(args) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            }
        };
    }
    let r = match cmd {
        "transcript_list" => {
            #[derive(Deserialize)]
            struct A {
                root: String,
            }
            let a = args!(A);
            blocking(move || {
                Ok(transcripts::list_transcripts(
                    &claude_home(),
                    &transcripts::path_to_key(&a.root),
                ))
            })
            .await
        }
        "transcript_load" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                session_id: String,
                offset_bytes: Option<u64>,
                limit: Option<u32>,
            }
            let a = args!(A);
            blocking(move || match transcripts::find_in_home(&claude_home(), &a.session_id) {
                Some(p) => transcripts::history::load_messages_at(&p, a.offset_bytes, a.limit),
                None => Ok(LoadMessagesResult {
                    messages: Vec::new(),
                    next_offset_bytes: 0,
                    end_offset_bytes: 0,
                }),
            })
            .await
        }
        "transcript_last_event" => {
            let a = args!(SessionArg);
            blocking(move || match transcripts::find_in_home(&claude_home(), &a.session_id) {
                Some(p) => transcripts::jsonl::last_event_at(&p),
                None => Ok(LastEventInfo::empty()),
            })
            .await
        }
        "transcript_size" => {
            let a = args!(SessionArg);
            blocking(move || match transcripts::find_in_home(&claude_home(), &a.session_id) {
                Some(p) => transcripts::jsonl::size_at(&p),
                None => Ok(0),
            })
            .await
        }
        "transcript_truncate" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                session_id: String,
                byte_pos: u64,
            }
            let a = args!(A);
            blocking(move || match transcripts::find_in_home(&claude_home(), &a.session_id) {
                Some(p) => transcripts::jsonl::truncate_at(&p, a.byte_pos),
                None => Ok(()),
            })
            .await
        }
        _ => return None,
    };
    Some(r)
}

/// 目录选择器的起点：`/` 与家目录（目标机没有盘符）。
fn fs_roots() -> Vec<FileEntry> {
    let mut roots = vec![FileEntry {
        name: "/".into(),
        path: "/".into(),
        is_dir: true,
        children: None,
    }];
    if let Ok(home) = std::env::var("HOME") {
        roots.insert(
            0,
            FileEntry {
                name: "Home".into(),
                path: home,
                is_dir: true,
                children: None,
            },
        );
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use aide_host::commands::{FS_COMMANDS, GIT_COMMANDS, TRANSCRIPT_COMMANDS};

    #[tokio::test]
    async fn every_listed_fs_command_dispatches() {
        // 表里登记了但 match 没接住 = 桌面会转发一个 host 不认识的命令。
        for cmd in FS_COMMANDS {
            let r = invoke_fs(cmd, json!({})).await;
            assert!(r.is_some(), "{cmd} listed but not dispatched");
        }
    }

    #[tokio::test]
    async fn every_listed_git_command_dispatches() {
        let tmp = std::env::temp_dir();
        for cmd in GIT_COMMANDS {
            let r = git_dispatch::dispatch(cmd, json!({}), tmp.clone()).await;
            assert!(r.is_some(), "{cmd} listed but not dispatched");
        }
    }

    #[tokio::test]
    async fn every_listed_transcript_command_dispatches() {
        for cmd in TRANSCRIPT_COMMANDS {
            assert!(invoke_transcript(cmd, json!({})).await.is_some(), "{cmd} listed but not dispatched");
        }
    }

    #[tokio::test]
    async fn unknown_command_is_rejected_not_ignored() {
        let r = invoke(InvokeParams {
            cmd: "pty_spawn_shell".into(),
            args: json!({}),
            root: None,
        })
        .await;
        assert!(r.unwrap_err().contains("unsupported"));
    }

    #[tokio::test]
    async fn fs_roundtrip_via_dispatch() {
        let dir = std::env::temp_dir().join(format!("aide-host-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let d = dir.to_string_lossy().to_string();
        let file = dir.join("a.txt").to_string_lossy().to_string();
        invoke_fs("write_file_content", json!({"path": file, "content": "hi"}))
            .await
            .unwrap()
            .unwrap();
        let v = invoke_fs("read_file_content", json!({"path": file})).await.unwrap().unwrap();
        assert_eq!(v, json!("hi"));
        let list = invoke_fs("list_directory", json!({"path": d})).await.unwrap().unwrap();
        assert_eq!(list[0]["name"], json!("a.txt"));
        assert_eq!(list[0]["is_dir"], json!(false));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
