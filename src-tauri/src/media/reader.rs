//! 有界媒体读端口；授权闸在读前后各检查一次，取消最多留下一个在途小块。

use std::sync::Arc;

use crate::host_door::target::HostTarget;
use super::host;

pub(super) struct MediaReader {
    target: HostTarget,
    handle: String,
    gate: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
}

impl MediaReader {
    pub fn new(target: HostTarget, handle: String, gate: Arc<dyn Fn() -> Result<(), String> + Send + Sync>) -> Self {
        Self { target, handle, gate }
    }

    pub async fn read(&self, slice: (u64, usize)) -> Result<Vec<u8>, String> {
        (self.gate)()?;
        let bytes = host::read(&self.target, &self.handle, slice).await?;
        (self.gate)()?;
        if bytes.is_empty() { return Err("媒体文件在读取期间发生变化或提前结束".into()); }
        Ok(bytes)
    }
}
