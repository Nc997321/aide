//! `invoke` 分派：查 [`aide_core`] 的命令表——与桌面本机 Host 同一张表、同一份实现。
//! 这台 Host 的全部能力面就是这张表；表外命令一律报错（大声拒绝，不猜）。

use aide_core::{Core, Reply};
use aide_host::protocol::{InvokeParams, BYTES_KEY};
use serde_json::{json, Value};
use std::sync::Arc;

pub async fn invoke(core: Arc<Core>, p: InvokeParams) -> Result<Value, String> {
    let InvokeParams { cmd, args } = p;
    let Some(run) = aide_core::lookup(&cmd) else {
        return Err(format!("aide-host: unsupported command `{cmd}`"));
    };
    match run(core, args).await? {
        Reply::Json(v) => Ok(v),
        Reply::Bytes(bytes) => {
            use base64::Engine;
            Ok(json!({ BYTES_KEY: base64::engine::general_purpose::STANDARD.encode(bytes) }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aide_core::NullSink;

    fn core() -> Arc<Core> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aide-host-test-core-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        Core::isolated(dir, Arc::new(NullSink))
    }

    fn call(cmd: &str, args: Value) -> InvokeParams {
        InvokeParams { cmd: cmd.into(), args }
    }

    #[tokio::test]
    async fn unknown_command_is_rejected_not_ignored() {
        let r = invoke(core(), call("no_such_command", json!({}))).await;
        assert!(r.unwrap_err().contains("unsupported"));
    }

    #[tokio::test]
    async fn core_commands_roundtrip_with_bytes_wrapped() {
        let dir = std::env::temp_dir().join(format!("aide-host-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("a.txt").to_string_lossy().to_string();
        invoke(core(), call("write_file_content", json!({"path": file, "content": "hi"})))
            .await
            .unwrap();
        let v = invoke(core(), call("read_file_content", json!({"path": file}))).await.unwrap();
        assert_eq!(v, json!("hi"));
        let b = invoke(core(), call("read_file_binary", json!({"path": file}))).await.unwrap();
        assert_eq!(b, json!({ BYTES_KEY: "aGk=" }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
