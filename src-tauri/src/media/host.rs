use aide_core::Reply;
use serde_json::json;

use crate::host_door::target::HostTarget;
use super::types::FileInfo;

pub(crate) async fn open(target: &HostTarget, path: &str, revision: Option<&str>) -> Result<FileInfo, String> {
    match target.media_call("media_open", json!({ "path": path, "expectedRevision": revision })).await? {
        Reply::Json(value) => serde_json::from_value(value).map_err(|e| format!("媒体元数据格式不匹配：{e}")),
        Reply::Bytes(_) => Err("媒体元数据应为 JSON".into()),
    }
}

pub(crate) async fn read(target: &HostTarget, handle: &str, slice: (u64, usize)) -> Result<Vec<u8>, String> {
    match target.media_call("media_read", json!({ "handle": handle, "offset": slice.0, "length": slice.1 })).await? {
        Reply::Bytes(bytes) if bytes.len() <= slice.1 => Ok(bytes),
        Reply::Bytes(_) => Err("Host 返回的媒体块超过请求上限".into()),
        Reply::Json(_) => Err("媒体读取没有返回原始字节".into()),
    }
}

pub(crate) async fn close(target: &HostTarget, handle: &str) {
    if let Err(e) = target.media_call("media_close", json!({ "handle": handle })).await {
        tracing::debug!("media handle close deferred to Host expiry: {e}");
    }
}
