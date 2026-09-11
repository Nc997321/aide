pub mod handler;
pub mod protocol;
pub mod state;

use state::SharedState;
use tokio::net::TcpListener;

/// 接受循环：每个连接一个任务。
pub async fn run(listener: TcpListener, state: SharedState) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handler::handle_conn(stream, state).await {
                eprintln!("relay conn error: {e}");
            }
        });
    }
}
