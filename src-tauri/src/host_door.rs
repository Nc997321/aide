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
pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: &str, payload: Value) {
        if let Err(e) = self.0.emit(event, payload) {
            tracing::warn!(event, "core event emit failed: {e}");
        }
    }
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
