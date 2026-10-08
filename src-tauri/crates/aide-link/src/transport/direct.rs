//! 直连：Host 自己监听一个 WebSocket 端口，手机连上即说安全通道（**不发**中继帧）。
//! 用途：局域网 / Tailscale 等自己够得着的网络、本地测试 Host。协议与经中继时完全相同。

use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;

use super::driver::drive;
use super::LinkHost;

/// 接受循环：每个连接一个任务。永不返回（取消 = 停服务）。
pub async fn serve(listener: TcpListener, host: LinkHost) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("link direct: accept: {e}");
                continue;
            }
        };
        let host = host.clone();
        tokio::spawn(async move {
            match accept_async(stream).await {
                Ok(ws) => {
                    let end = drive(ws, &host).await;
                    tracing::debug!("link direct: {peer} ended: {end:?}");
                }
                Err(e) => tracing::debug!("link direct: {peer} handshake failed: {e}"),
            }
        });
    }
}
