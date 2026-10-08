//! **参考客户端**（手机一侧的握手 + 加密传输）：测试与一致性向量用，同时是手机端移植时的对照实现——
//! 手机端按同一规约自己实现（Noise 库 + 本文件的流程），不依赖本 crate。

use serde_json::Value;

use crate::secure::{decode_bytes, encode_bytes, Initiator, Keypair, Mode, Transport, WireFrame};

/// 已发出 `sc_init`、等 Host 回 `sc_resp` 的客户端。
pub struct PendingClient {
    init: Initiator,
}

/// 握手完成、可以收发加密 Link 帧的客户端。
pub struct RefClient {
    transport: Transport,
    /// 正在接收的一个 Link 帧（逐块到达）。
    partial: bool,
}

impl RefClient {
    /// 造 `sc_init`。`psk` 仅 `pair` 模式（二维码里的一次性密钥）。
    pub fn begin(
        mode: Mode,
        phone: &Keypair,
        host_public: &[u8; 32],
        device_id: &str,
        psk: Option<&[u8; 32]>,
        versions: &[u32],
    ) -> Result<(WireFrame, PendingClient), String> {
        let (msg1, init) = Initiator::start(mode, phone, host_public, device_id, psk, None).map_err(|e| e.to_string())?;
        Ok((WireFrame::ScInit { versions: versions.to_vec(), mode, msg: encode_bytes(&msg1) }, PendingClient { init }))
    }

    pub fn seal_frame(&mut self, frame: &Value) -> Vec<WireFrame> {
        self.transport.seal(frame.to_string().as_bytes())
    }

    /// 收一块密文；凑齐一个 Link 帧时返回它（JSON）。
    pub fn open(&mut self, w: &WireFrame) -> Result<Option<Value>, String> {
        let WireFrame::Sc { c, last } = w else {
            return Err(format!("expected an `sc` frame, got {w:?}"));
        };
        self.partial = !*last;
        match self.transport.open(c, *last).map_err(|e| format!("{e:?}"))? {
            None => Ok(None),
            Some(plain) => serde_json::from_slice(&plain).map(Some).map_err(|e| e.to_string()),
        }
    }

    pub fn is_mid_frame(&self) -> bool {
        self.partial
    }
}

impl PendingClient {
    /// 收 Host 的 `sc_resp`：psk 不对 / 连错了 Host 在这里失败。
    pub fn complete(self, resp: &WireFrame) -> Result<RefClient, String> {
        let WireFrame::ScResp { msg, .. } = resp else {
            return Err(format!("expected sc_resp, got {resp:?}"));
        };
        let raw = decode_bytes(msg).ok_or("sc_resp.msg is not base64")?;
        let transport = self.init.finish(&raw).map_err(|e| e.to_string())?;
        Ok(RefClient { transport, partial: false })
    }
}
