//! 内置 LSP 支持。设计见 docs/superpowers/specs/2026-08-04-lsp-builtin-design.md。
//! 子模块逐 task 填充。每个 task 创建对应子模块文件后，在此取消注释其 pub mod 行。

pub mod detector;
pub mod docs;
pub mod manager;
pub mod profiles;
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
    /// 失败详情（spawn/handshake 的可读错误，含 stderr 摘要）。ServerNotFound 不带。
    /// 用 skip_serializing_if 保证旧前端忽略新字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
    // 信任门（spec §5.3）：与 workspace_set_lsp_enabled 同一道门。即便
    // lsp_enabled 被设过，未信任工作区也拒拉 server——untrust 后老 server
    // 自然消亡，不再 respawn。
    if !crate::commands::workspace::is_path_trusted(&workspace_root) {
        return Ok(EnsureOutcome { ok: false, kind: Some("untrusted"), error: None });
    }
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(EnsureOutcome { ok: false, kind: Some("server_not_found"), error: None });
    };
    let settings = crate::commands::settings::public_settings(settings_service.inner())
        .map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    match mgr.ensure_server(&workspace_root, lang_id, &app, &settings).await {
        Ok(_) => Ok(EnsureOutcome { ok: true, kind: None, error: None }),
        Err(EnsureError::ServerNotFound) => Ok(EnsureOutcome { ok: false, kind: Some("server_not_found"), error: None }),
        Err(EnsureError::HandshakeFailed(e)) => Ok(EnsureOutcome { ok: false, kind: Some("handshake_failed"), error: Some(e) }),
        Err(EnsureError::SpawnFailed(e)) => Ok(EnsureOutcome { ok: false, kind: Some("spawn_failed"), error: Some(e) }),
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
    if crate::lsp::manager::is_excluded(&file_path, &h.exclude_globs) {
        return Ok(());
    }
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    // 去重：文档已在 jdtls 打开（导航回退时 cmLsp 不发 didClose，文档保持打开）→
    // 跳过重发 didOpen，否则 jdtls 报 "document already open"，且省去重新解析导入绑定
    // 的秒级延迟（回退后立刻跳转才拿得到定义）。
    let already_open = {
        let mut docs = h.docs.lock().await;
        if docs.contains(&uri) {
            true
        } else {
            docs.open(uri.clone(), text.clone());
            false
        }
    };
    if already_open {
        return Ok(());
    }
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
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    // 防御：前端漏发 did_open / 乱序时 OpenDocs::change 会 panic。未开 → 跳过，不崩。
    {
        let docs = h.docs.lock().await;
        if !docs.contains(&uri) {
            return Ok(()); // doc not open (no preceding did_open) — skip, don't panic
        }
    }
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
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
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
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
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
    Ok(crate::lsp::protocol::locations_to_query_results(&locs, &word, &workspace_root))
}

#[tauri::command]
pub async fn lsp_completion(
    workspace_root: String, file_path: String, line: usize, column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<CmCompletion>, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
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
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
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
pub async fn lsp_implementation(
    workspace_root: String, file_path: String, line: usize, column: usize, word: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<crate::codegraph::types::QueryResult>, String> {
    // 与 lsp_definition 同构，仅 method 换为 textDocument/implementation（父→子）。
    // 返回 Location[] → 归一为 QueryResult[]；前端据此挂向下箭头，并反推向上箭头。
    let lang = lang_from_ext_of(&file_path);
    let Some(lang_id) = lang else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/implementation", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    let locs = parse_locations(&result);
    Ok(crate::lsp::protocol::locations_to_query_results(&locs, &word, &workspace_root))
}

#[tauri::command]
pub async fn lsp_document_symbol(
    workspace_root: String, file_path: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<crate::lsp::protocol::DocumentSymbolItem>, String> {
    // 枚举文档声明符号（Class/Interface/Method/Function...），供前端筛可视区声明查 implementation。
    // 客户端已声明 hierarchicalSupport → server 多返 DocumentSymbol[]（带 children）；
    // 解析器兼容 SymbolInformation[]（扁平，有 location）兜底。
    let Some(lang_id) = lang_from_ext_of(&file_path) else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::resolve_file_uri(&workspace_root, &file_path);
    let params = serde_json::json!({ "textDocument":{"uri":uri} });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/documentSymbol", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    Ok(parse_document_symbols(&result))
}

#[tauri::command]
pub async fn lsp_capabilities(
    workspace_root: String, lang: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<crate::lsp::protocol::LspCapabilities, String> {
    // 按语言查 server 的可选能力开关。server 未启动 → 默认全 false（前端据 isLspOn + caps
    // 决定是否启用 gutter 标记；server 后续就绪时 watch 会 reconfigure）。
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(Default::default()); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(Default::default()); };
    let caps = h.capabilities.lock().await;
    Ok(crate::lsp::protocol::LspCapabilities::from_caps(caps.as_ref()))
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

/// 打开随包分发的 LSP 安装向导 HTML（resource_dir/lsp-install-guide.html），系统默认浏览器。
/// 同步命令（spawn start/xdg-open/open 是轻子进程），照 show_in_explorer 模式埋 trace_command。
#[tauri::command]
pub fn open_lsp_install_guide(app: tauri::AppHandle) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("open_lsp_install_guide");
    use tauri::Manager;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let html = res_dir.join("lsp-install-guide.html");
    let html = if html.exists() {
        html
    } else {
        // dev：bundle resources 不拷进 resource_dir（打包才生效），回落源码目录
        let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/lsp-install-guide.html");
        if dev.exists() {
            dev
        } else {
            return Err(format!("lsp-install-guide.html not found (release: {:?}, dev: {:?})", html, dev));
        }
    };
    // Windows 上 resource_dir 是 \\?\ verbatim 路径，传给外部进程前必须 dunce 剥前缀（CLAUDE.md 红线）
    let html = dunce::simplified(&html);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        // start 的第一个引号参数是窗口标题（空串），路径带空格也没问题
        cmd.arg("/C").arg("start").arg("").arg(&html);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：不弹控制台
        cmd.spawn().map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&html)
            .spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&html)
            .spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
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

/// documentSymbol 结果 → 扁平 DocumentSymbolItem[]。兼容两种形态：
/// - DocumentSymbol（有 selectionRange，可能带 children）→ 用 selectionRange.start，递归 children
/// - SymbolInformation（有 location）→ 用 location.range.start
/// 不依赖 lsp_types::DocumentSymbol（其 SymbolKind newtype 内部私有，as u32 不便），
/// 直接按 JSON 字段取，规避类型摩擦。
fn parse_document_symbols(result: &serde_json::Value) -> Vec<crate::lsp::protocol::DocumentSymbolItem> {
    let Some(arr) = result.as_array() else { return vec![]; };
    let mut out = Vec::new();
    for item in arr {
        flatten_symbol(item, &mut out);
    }
    out
}

fn flatten_symbol(item: &serde_json::Value, out: &mut Vec<crate::lsp::protocol::DocumentSymbolItem>) {
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let kind = item.get("kind").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    // DocumentSymbol 用 selectionRange.start；SymbolInformation 用 location.range.start
    let start = item
        .get("selectionRange")
        .and_then(|sr| sr.get("start"))
        .or_else(|| item.get("location").and_then(|l| l.get("range")).and_then(|r| r.get("start")));
    if let Some(start) = start {
        let line = start.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let column = start.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        out.push(crate::lsp::protocol::DocumentSymbolItem {
            name,
            kind,
            line: line + 1,   // LSP 0-based → 1-based
            column: column + 1,
        });
    }
    if let Some(children) = item.get("children").and_then(|v| v.as_array()) {
        for child in children {
            flatten_symbol(child, out);
        }
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
        let r = crate::lsp::protocol::locations_to_query_results(&locs, "foo", "C:/p");
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

    #[test]
    fn parse_document_symbols_handles_hierarchical_and_flat() {
        // DocumentSymbol[]（带 selectionRange + children）→ 扁平化，0-based → 1-based
        let ds = serde_json::json!([
            {"name":"Foo","kind":5,
             "range":{"start":{"line":0,"character":0},"end":{"line":10,"character":0}},
             "selectionRange":{"start":{"line":0,"character":6},"end":{"line":0,"character":9}},
             "children":[{"name":"bar","kind":6,
                          "range":{"start":{"line":2,"character":2},"end":{"line":3,"character":2}},
                          "selectionRange":{"start":{"line":2,"character":2},"end":{"line":2,"character":5}}}]}
        ]);
        let items = parse_document_symbols(&ds);
        assert_eq!(items.len(), 2); // Foo + bar（children 扁平化）
        assert_eq!(items[0].name, "Foo");
        assert_eq!(items[0].kind, 5);
        assert_eq!(items[0].line, 1);    // line 0 → 1-based 1
        assert_eq!(items[0].column, 7);  // character 6 → 7
        assert_eq!(items[1].name, "bar");
        assert_eq!(items[1].kind, 6);
        assert_eq!(items[1].line, 3);    // line 2 → 3

        // SymbolInformation[]（扁平，有 location）→ 用 location.range.start
        let si = serde_json::json!([
            {"name":"baz","kind":11,
             "location":{"uri":"file:///x","range":{"start":{"line":5,"character":0},"end":{"line":5,"character":3}}},
             "containerName":"Foo"}
        ]);
        let items2 = parse_document_symbols(&si);
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].name, "baz");
        assert_eq!(items2[0].kind, 11);
        assert_eq!(items2[0].line, 6);   // line 5 → 6

        // null / 空数组 → 空
        assert!(parse_document_symbols(&serde_json::json!(null)).is_empty());
        assert!(parse_document_symbols(&serde_json::json!([])).is_empty());
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
        let qr = crate::lsp::protocol::locations_to_query_results(&locs, "sym", "/mock");
        assert_eq!(qr[0].symbol.file, "def.rs"); // 相对 mock workspace root
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
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => { return Err(()); }
            }
        }
    }
}
