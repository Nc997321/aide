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
