//! `invoke` 分派：主体查 [`aide_core`] 的命令表（与桌面本机 Host 同一张表、同一份实现），
//! 外加两组还没迁进 core 的 host 专属命令（会话转录原料、LSP 探测）。
//!
//! 不在表里的命令一律报错——桌面的 IPC 拦截层会**大声拒绝**，绝不回落到本机执行
//! （回落 = 在桌面机上操作一个看似同名的路径，即「跑错机器」）。

use aide_core::{Core, Reply};
use aide_host::protocol::{InvokeParams, BYTES_KEY};
use aide_workspace::transcripts::{self, LastEventInfo, LoadMessagesResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

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

pub async fn invoke(core: Arc<Core>, p: InvokeParams) -> Result<Value, String> {
    let InvokeParams { cmd, mut args, root } = p;
    if let Some(run) = aide_core::lookup(&cmd) {
        // 桌面解析好的工作区根（git 系 / get_project_info）= core 命令的显式 `cwd`。
        if let Some(root) = root {
            if args.is_null() {
                args = json!({});
            }
            if let Some(o) = args.as_object_mut() {
                o.insert("cwd".into(), Value::String(root));
            }
        }
        return match run(core, args).await? {
            Reply::Json(v) => Ok(v),
            Reply::Bytes(bytes) => {
                use base64::Engine;
                Ok(json!({ BYTES_KEY: base64::engine::general_purpose::STANDARD.encode(bytes) }))
            }
        };
    }
    if let Some(r) = invoke_transcript(&cmd, args.clone()).await {
        return r;
    }
    if let Some(r) = invoke_lsp(&cmd, args).await {
        return r;
    }
    Err(format!("aide-host: unsupported command `{cmd}`"))
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

/// LSP 探测（`protocol::LSP_COMMANDS`）：远程工作区的语言探测与代表文件在**目标机**上算
/// （同一份 `aide_workspace::detect`），桌面 LSP 层据此决定起哪些服务器、递哪个文件。
async fn invoke_lsp(cmd: &str, args: Value) -> Option<Result<Value, String>> {
    use aide_workspace::detect::languages::{detect_languages, lang_from_id_str, representative_sources};
    match cmd {
        // 探到的语言 + 其中哪些在目标机登录 PATH 上真有服务器（= 桌面 `lsp_languages_for_path`
        // 的「配得上」判据：没有服务器的语言不挂 agent 工具，免得诱导它调一个注定 no_server 的工具）。
        "lsp_detect" => {
            #[derive(Deserialize)]
            struct A {
                root: String,
            }
            let a = match parse_args::<A>(args) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            };
            let root = PathBuf::from(&a.root);
            let langs = match tokio::task::spawn_blocking(move || detect_languages(&root)).await {
                Ok(l) => l,
                Err(e) => return Some(Err(format!("task panicked: {e}"))),
            };
            let login = crate::login::cached_login_env().await;
            let available: Vec<&str> = langs
                .iter()
                .filter(|l| l.server_binary().is_some_and(|b| crate::login::which(b, login).is_some()))
                .map(|l| l.id_str())
                .collect();
            let languages: Vec<&str> = langs.iter().map(|l| l.id_str()).collect();
            Some(Ok(json!({ "languages": languages, "available": available })))
        }
        "lsp_representatives" => {
            #[derive(Deserialize)]
            struct A {
                root: String,
                lang: String,
                max: usize,
            }
            let a = match parse_args::<A>(args) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            };
            let Some(lang) = lang_from_id_str(&a.lang) else {
                return Some(Err(format!("unknown language `{}`", a.lang)));
            };
            Some(
                blocking(move || {
                    Ok(representative_sources(std::path::Path::new(&a.root), lang, a.max)
                        .into_iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect::<Vec<_>>())
                })
                .await,
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aide_core::NullSink;
    use aide_host::commands::TRANSCRIPT_COMMANDS;

    fn core() -> Arc<Core> {
        {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aide-host-test-core-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        Core::isolated(dir, Arc::new(NullSink))
    }
    }

    fn call(cmd: &str, args: Value, root: Option<String>) -> InvokeParams {
        InvokeParams { cmd: cmd.into(), args, root }
    }

    #[tokio::test]
    async fn every_listed_transcript_command_dispatches() {
        for cmd in TRANSCRIPT_COMMANDS {
            assert!(invoke_transcript(cmd, json!({})).await.is_some(), "{cmd} listed but not dispatched");
        }
    }

    #[tokio::test]
    async fn every_listed_lsp_command_dispatches() {
        for cmd in aide_host::protocol::LSP_COMMANDS {
            assert!(invoke_lsp(cmd, json!({})).await.is_some(), "{cmd} listed but not dispatched");
        }
    }

    #[tokio::test]
    async fn lsp_detect_and_representatives_run_on_this_machine() {
        let dir = std::env::temp_dir().join(format!("aide-host-lsp-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn f() {}\n").unwrap();
        let root = dir.to_string_lossy().to_string();
        let v = invoke_lsp("lsp_detect", json!({ "root": root })).await.unwrap().unwrap();
        assert!(v["languages"].as_array().unwrap().contains(&json!("rust")), "{v}");
        assert!(v["available"].is_array());
        let reps = invoke_lsp("lsp_representatives", json!({ "root": root, "lang": "rust", "max": 1 }))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reps.as_array().unwrap().len(), 1, "{reps}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unknown_command_is_rejected_not_ignored() {
        let r = invoke(core(), call("pty_spawn_shell", json!({}), None)).await;
        assert!(r.unwrap_err().contains("unsupported"));
    }

    #[tokio::test]
    async fn core_commands_roundtrip_with_bytes_wrapped() {
        let dir = std::env::temp_dir().join(format!("aide-host-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("a.txt").to_string_lossy().to_string();
        invoke(core(), call("write_file_content", json!({"path": file, "content": "hi"}), None))
            .await
            .unwrap();
        let v = invoke(core(), call("read_file_content", json!({"path": file}), None)).await.unwrap();
        assert_eq!(v, json!("hi"));
        let b = invoke(core(), call("read_file_binary", json!({"path": file}), None)).await.unwrap();
        assert_eq!(b, json!({ BYTES_KEY: "aGk=" }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn desktop_root_becomes_core_cwd() {
        let dir = std::env::temp_dir().join(format!("aide-host-root-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let v = invoke(core(), call("get_project_info", Value::Null, Some(root.clone()))).await.unwrap();
        assert_eq!(v["root"], json!(root));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
