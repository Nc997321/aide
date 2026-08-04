//! 内置 LSP 支持。设计见 docs/superpowers/specs/2026-08-04-lsp-builtin-design.md。
//! 子模块逐 task 填充。每个 task 创建对应子模块文件后，在此取消注释其 pub mod 行。

pub mod detector;
pub mod docs;
pub mod manager;
pub mod protocol;
pub mod registry;
pub mod rpc;
pub mod transport;

#[cfg(test)] mod mock_server;

use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use serde::Serialize;

pub use crate::lsp::manager::{LspManager, EnsureError};
pub use crate::lsp::protocol::CmCompletion;

#[derive(Debug, Serialize)]
pub struct EnsureOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
}

pub struct LspState(pub Arc<TokioMutex<LspManager>>);
impl LspState {
    pub fn new() -> Self { Self(Arc::new(TokioMutex::new(LspManager::new()))) }
}

fn lang_from_id_str(s: &str) -> Option<crate::lsp::detector::LanguageId> {
    crate::lsp::detector::lang_from_id_str(s)
}

#[tauri::command]
pub async fn lsp_detect_languages(workspace_root: String) -> Result<Vec<String>, String> {
    let langs = crate::lsp::detector::detect_languages(std::path::Path::new(&workspace_root));
    Ok(langs.iter().map(|l| l.id_str().to_string()).collect())
}

#[tauri::command]
pub async fn lsp_ensure_server(
    workspace_root: String, lang: String,
    state: tauri::State<'_, Arc<LspState>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
    app: tauri::AppHandle,
) -> Result<EnsureOutcome, String> {
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(EnsureOutcome { ok: false, kind: Some("server_not_found") });
    };
    let settings = crate::commands::settings::public_settings(settings_service.inner())
        .map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    match mgr.ensure_server(&workspace_root, lang_id, &app, &settings).await {
        Ok(_) => Ok(EnsureOutcome { ok: true, kind: None }),
        Err(EnsureError::ServerNotFound) => Ok(EnsureOutcome { ok: false, kind: Some("server_not_found") }),
        Err(EnsureError::HandshakeFailed(_e)) => Ok(EnsureOutcome { ok: false, kind: Some("handshake_failed") }),
        Err(EnsureError::SpawnFailed(e)) => Err(format!("spawn failed: {e}")),
    }
}

#[tauri::command]
pub async fn lsp_did_open(
    workspace_root: String, file_path: String, lang: String, text: String,
    state: tauri::State<'_, Arc<LspState>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(()); };
    let settings = crate::commands::settings::public_settings(settings_service.inner()).map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    let h = match mgr.ensure_server(&workspace_root, lang_id, &app, &settings).await {
        Ok(h) => h, Err(_) => return Ok(()),
    };
    // §5.4 排除集跳过
    if crate::lsp::manager::is_excluded(&file_path, &h.exclude_globs) { return Ok(()); }
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    h.docs.lock().await.open(uri.clone(), text.clone());
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":uri,"languageId":lang,"version":1,"text":text}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_did_change(
    workspace_root: String, file_path: String, lang: String, text: String, version: Option<i64>,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(()); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(()); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let v = h.docs.lock().await.change(&uri, text.clone());
    let _ = version; // Full 同步：用 docs 内部 version
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":v},
                  "contentChanges":[{"text":text}]}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_did_close(
    workspace_root: String, file_path: String, lang: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(()); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(()); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    h.docs.lock().await.close(&uri);
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didClose",
        "params":{"textDocument":{"uri":uri}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_definition(
    workspace_root: String, file_path: String, line: usize, column: usize, word: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<crate::codegraph::types::QueryResult>, String> {
    let lang = lang_from_ext_of(&file_path);
    let Some(lang_id) = lang else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/definition", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    // result 是 null / Location / Location[]
    let locs = parse_locations(&result);
    Ok(crate::lsp::protocol::locations_to_query_results(&locs, &word))
}

#[tauri::command]
pub async fn lsp_completion(
    workspace_root: String, file_path: String, line: usize, column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<CmCompletion>, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/completion", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    let items = parse_completion_items(&result);
    Ok(crate::lsp::protocol::completion_items_to_cm(&items))
}

#[tauri::command]
pub async fn lsp_hover(
    workspace_root: String, file_path: String, line: usize, column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<serde_json::Value, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else { return Ok(serde_json::json!({"content":null})); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(serde_json::json!({"content":null})); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/hover", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    let content = parse_hover_content(&result);
    Ok(serde_json::json!({"content":content}))
}

#[tauri::command]
pub async fn lsp_shutdown_workspace(
    workspace_root: String,
    state: tauri::State<'_, Arc<LspState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.0.lock().await.kill_workspace(&workspace_root).await;
    let _ = tauri::Emitter::emit(&app, "lsp-diagnostics", serde_json::json!({"workspaceRoot":workspace_root,"clear":true}));
    Ok(())
}

// ── helpers ──

fn lang_from_ext_of(file_path: &str) -> Option<crate::lsp::detector::LanguageId> {
    let ext = file_path.rsplit('.').next().map(|e| e.to_lowercase())?;
    crate::lsp::detector::LanguageId::from_ext(&ext)
}

fn parse_locations(result: &serde_json::Value) -> Vec<lsp_types::Location> {
    use lsp_types::Location;
    if result.is_null() { return vec![]; }
    if let Some(arr) = result.as_array() {
        arr.iter().filter_map(|v| serde_json::from_value::<Location>(v.clone()).ok()).collect()
    } else {
        serde_json::from_value::<Location>(result.clone()).ok().into_iter().collect()
    }
}

fn parse_completion_items(result: &serde_json::Value) -> Vec<lsp_types::CompletionItem> {
    if let Some(arr) = result.get("items").and_then(|v| v.as_array()) {
        arr.iter().filter_map(|v| serde_json::from_value::<lsp_types::CompletionItem>(v.clone()).ok()).collect()
    } else if let Some(arr) = result.as_array() {
        arr.iter().filter_map(|v| serde_json::from_value::<lsp_types::CompletionItem>(v.clone()).ok()).collect()
    } else { vec![] }
}

fn parse_hover_content(result: &serde_json::Value) -> Option<String> {
    let contents = result.get("contents")?;
    match contents {
        serde_json::Value::String(s) => Some(s.clone()),
        obj if obj.is_object() => obj.get("value").and_then(|v| v.as_str()).map(String::from),
        _ => None,
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::manager::{build_exclude_globs, is_excluded};

    #[test]
    fn lsp_location_to_query_result_via_protocol() {
        let locs = vec![serde_json::from_value::<lsp_types::Location>(serde_json::json!({
            "uri": "file:///C:/p/x.rs",
            "range": {
                "start": { "line": 3, "character": 5 },
                "end":   { "line": 3, "character": 8 },
            }
        })).unwrap()];
        let r = crate::lsp::protocol::locations_to_query_results(&locs, "foo");
        assert_eq!(r[0].symbol.name, "foo");
        assert_eq!(r[0].symbol.line, 4);
        assert_eq!(r[0].symbol.column, 6);
    }

    #[test]
    fn did_open_skips_excluded_paths() {
        let globs = build_exclude_globs(&vec!["generated".into()]);
        assert!(is_excluded("C:/p/generated/x.rs", &globs));
        assert!(!is_excluded("C:/p/src/main.rs", &globs));
    }

    #[tokio::test]
    async fn mock_end_to_end_definition() {
        let mock = crate::lsp::mock_server::spawn_mock_lsp();
        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            mock.transport_stdin, mock.transport_stdout,
        );
        let router = crate::lsp::rpc::Router::new();
        let table = transport.table_handle();
        let mut reader = tokio::io::BufReader::new(transport.take_reader_source().await);
        let table_r = table.clone();
        let mut framer = crate::lsp::transport::Framer::new();
        // initialize
        let (msg, id, tx, rx) = router.next_request("initialize", serde_json::json!({
            "rootUri":"file:///mock","capabilities":{},"workspaceFolders":[{"uri":"file:///mock","name":"mock"}]
        }));
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let init = pump_until(&mut reader, &mut framer, &table_r, rx).await.unwrap();
        let _ = init;
        // definition
        let (msg, id, tx, rx) = router.next_request("textDocument/definition", serde_json::json!({
            "textDocument":{"uri":"file:///mock/main.rs"},"position":{"line":0,"character":0}
        }));
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = pump_until(&mut reader, &mut framer, &table_r, rx).await.unwrap();
        let locs = parse_locations(&result);
        assert_eq!(locs.len(), 1);
        let qr = crate::lsp::protocol::locations_to_query_results(&locs, "sym");
        assert_eq!(qr[0].symbol.file, "/mock/def.rs");
    }

    async fn pump_until(
        reader: &mut tokio::io::BufReader<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
        framer: &mut crate::lsp::transport::Framer,
        table: &std::sync::Arc<tokio::sync::Mutex<crate::lsp::transport::RequestTable>>,
        mut rx: tokio::sync::oneshot::Receiver<serde_json::Value>,
    ) -> Result<serde_json::Value, ()> {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                r = &mut rx => { return r.map_err(|_| ()); }
                n = reader.read(&mut buf) => {
                    let n = n.map_err(|_| ())?;
                    if n == 0 { tokio::task::yield_now().await; continue; }
                    for msg in framer.feed(&buf[..n]) {
                        if let crate::lsp::rpc::Action::ResolveWaiter { id, result } = crate::lsp::rpc::dispatch(&msg) {
                            if let Some(tx) = table.lock().await.take(id) { let _ = tx.send(result); }
                        }
                    }
                }
            }
        }
    }
}
