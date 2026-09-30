//! 本机 Host 的前门：前端 invoke → [`aide_core`] 命令表，**进程内直调**。
//!
//! Host 模型（docs/host-model.md）：命令只有一张表（aide-core），本机与远程 Host 查同一张。
//! 已迁进 core 的命令不再各自写 `#[tauri::command]`，也不进 `generate_handler!`——这里按名
//! 查表分派；表外命令原样交还 Tauri 命令表。本机零额外跳数：与 Tauri 命令同样是一次
//! JSON 反序列化 + 一次序列化。

use std::sync::Arc;

use aide_core::{Core, EventSink, Reply};
use serde_json::Value;
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Core 的事件出口 → Tauri 全窗口广播（与既有 `app.emit` 同一语义）。
///
/// 例外：`system-notification`（`Core::notify`）不进 WebView，由本前门就地弹系统通知——
/// Host 不弹窗，弹窗是 GUI 的事。
pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: &str, payload: Value) {
        if event == "system-notification" {
            show_system_notification(&payload);
            return;
        }
        if let Err(e) = self.0.emit(event, payload) {
            tracing::warn!(event, "core event emit failed: {e}");
        }
    }
}

fn show_system_notification(payload: &Value) {
    let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut n = notify_rust::Notification::new();
    n.app_id("com.aide.app");
    n.auto_icon();
    n.summary(&text("title"));
    n.body(&text("body"));
    tauri::async_runtime::spawn(async move {
        let _ = n.show();
    });
}

/// Core 的资源端口 → 本机：release 读 Tauri 打包资源目录，dev 读源码树 / cargo target。
pub struct DesktopResources(pub AppHandle);

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

impl aide_core::resources::HostResources for DesktopResources {
    /// dev = cargo target/debug（需先 `pnpm build:codegraph`），release = 打包资源目录
    /// `codegraph/` 子目录（与 agent-runtime 同模式）。
    fn codegraph_runner(&self) -> Result<std::path::PathBuf, String> {
        #[cfg(debug_assertions)]
        {
            let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("debug")
                .join(exe("aide-codegraph"));
            if path.exists() {
                return Ok(dunce::simplified(&path).to_path_buf());
            }
            Err(format!(
                "codegraph runner 未构建（{:?}）——先运行 pnpm build:codegraph",
                path
            ))
        }
        #[cfg(not(debug_assertions))]
        {
            let resource_dir = self.0.path().resource_dir().map_err(|e| e.to_string())?;
            let path = resource_dir.join("codegraph").join(exe("aide-codegraph"));
            if path.exists() {
                return Ok(dunce::simplified(&path).to_path_buf());
            }
            Err(format!("codegraph runner exe missing: {path:?}"))
        }
    }

    /// release：打包资源目录（runner 内本地 ONNX 模型解析）；dev 不设——runner 走
    /// CARGO_MANIFEST_DIR 源码树回退。
    fn codegraph_model_dir(&self) -> Option<std::path::PathBuf> {
        #[cfg(debug_assertions)]
        {
            None
        }
        #[cfg(not(debug_assertions))]
        {
            let res_dir = self.0.path().resource_dir().ok()?;
            Some(dunce::simplified(&res_dir).to_path_buf())
        }
    }

    /// dev：node 跑 esbuild bundle（`agent-sidecar/dist/runtime.js`，`AIDE_NODE_PATH` 可换 node）；
    /// release：打包资源目录 `agent-runtime/` 下的独立可执行文件（旧路径 `agent-sidecar/` 兜底）。
    fn agent_runtime(&self) -> Result<(String, std::path::PathBuf), String> {
        #[cfg(debug_assertions)]
        {
            let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("agent-sidecar")
                .join("dist")
                .join("runtime.js");
            if !path.exists() {
                return Err(format!(
                    "Runtime not found at {:?}. Run: cd agent-sidecar && pnpm build",
                    path
                ));
            }
            let node = std::env::var("AIDE_NODE_PATH").unwrap_or_else(|_| "node".to_string());
            Ok((node, dunce::simplified(&path).to_path_buf()))
        }
        #[cfg(not(debug_assertions))]
        {
            let resource_dir = self.0.path().resource_dir().map_err(|e| e.to_string())?;
            let bin_name = exe("aide-agent");
            let path = resource_dir.join("agent-runtime").join(&bin_name);
            if path.exists() {
                return Ok((dunce::simplified(&path).to_string_lossy().to_string(), Default::default()));
            }
            let fallback = resource_dir.join("agent-sidecar").join(&bin_name);
            if fallback.exists() {
                return Ok((dunce::simplified(&fallback).to_string_lossy().to_string(), Default::default()));
            }
            Err(format!("Runtime exe missing: {:?}", path))
        }
    }

    /// release：随 app 分发的原生 CLI（`agent-runtime/claude[.exe]`）。dev：agent-sidecar 的
    /// node_modules 里 SDK 平台包带的 claude（CARGO_MANIFEST_DIR 是 src-tauri/，向上一层到项目根）。
    fn claude_exe(&self) -> Option<std::path::PathBuf> {
        #[cfg(not(debug_assertions))]
        {
            let res_dir = self.0.path().resource_dir().ok()?;
            let claude = res_dir.join("agent-runtime").join(exe("claude"));
            claude.exists().then(|| dunce::simplified(&claude).to_path_buf())
        }
        #[cfg(debug_assertions)]
        {
            let pkg = if cfg!(target_os = "windows") {
                "@anthropic-ai/claude-agent-sdk-win32-x64"
            } else if cfg!(target_os = "macos") {
                "@anthropic-ai/claude-agent-sdk-darwin-arm64"
            } else {
                "@anthropic-ai/claude-agent-sdk-linux-x64"
            };
            let candidate = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("agent-sidecar")
                .join("node_modules")
                .join(pkg)
                .join(exe("claude"));
            candidate.exists().then(|| dunce::simplified(&candidate).to_path_buf())
        }
    }

    /// `<resource_dir>/lsp`（dev 与 release 同一口径：捆绑 server 与 lombok.jar 只在打包后存在）。
    fn lsp_dir(&self) -> Option<std::path::PathBuf> {
        let res_dir = self.0.path().resource_dir().ok()?;
        Some(res_dir.join("lsp"))
    }
}

/// 返回 `Some(invoke)` = 不是 core 命令，交给 Tauri 命令表；`None` = 已接管并应答。
pub fn dispatch(invoke: Invoke<Wry>) -> Option<Invoke<Wry>> {
    let Some(run) = aide_core::lookup(invoke.message.command()) else {
        return Some(invoke);
    };
    let args = match invoke.message.payload() {
        InvokeBody::Json(v) => v.clone(),
        InvokeBody::Raw(_) => {
            invoke
                .resolver
                .reject(format!("{}：不接受原始字节参数", invoke.message.command()));
            return None;
        }
    };
    let core = invoke
        .message
        .webview()
        .app_handle()
        .state::<Arc<Core>>()
        .inner()
        .clone();
    invoke.resolver.respond_async_serialized(async move {
        match run(core, args).await {
            Ok(Reply::Json(v)) => serde_json::to_string(&v)
                .map(InvokeResponseBody::Json)
                .map_err(|e| InvokeError::from(Value::String(e.to_string()))),
            Ok(Reply::Bytes(b)) => Ok(InvokeResponseBody::Raw(b)),
            Err(e) => Err(InvokeError::from(Value::String(e))),
        }
    });
    None
}
