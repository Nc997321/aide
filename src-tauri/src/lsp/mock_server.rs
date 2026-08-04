//! 测试夹具：in-process 极小 LSP responder。
//! 走 tokio duplex 管道，说 Content-Length 帧 LSP 协议子集：
//! initialize → capabilities；initialized → 无应；textDocument/definition → 固定 Location；
//! shutdown → null；启动后主动推一条 publishDiagnostics。
//! 让 transport+rpc+manager 的端到端测试在 cargo test 里跑，无需外部二进制。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use crate::lsp::transport::{Framer, format_frame};

pub struct MockLsp {
    /// transport 的 stdin 写端（manager 往这写）→ mock 的读端
    pub transport_stdin: Box<dyn AsyncWrite + Send + Unpin>,
    /// transport 的 stdout 读端（manager 从这读）← mock 的写端
    pub transport_stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub join: tokio::task::JoinHandle<()>,
}

pub fn spawn_mock_lsp() -> MockLsp {
    // duplex A：manager 写 → mock 读（mock 的 stdin）
    let (a_write, a_read) = tokio::io::duplex(8 * 1024);
    // duplex B：mock 写 → manager 读（mock 的 stdout）
    let (b_write, b_read) = tokio::io::duplex(8 * 1024);

    let join = tokio::spawn(async move {
        mock_responder(a_read, b_write).await;
    });

    MockLsp {
        transport_stdin: Box::new(a_write),
        transport_stdout: Box::new(b_read),
        join,
    }
}

async fn mock_responder<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(mut reader: R, mut writer: W) {
    let mut framer = Framer::new();
    let mut buf = [0u8; 4096];

    // 启动即推一条 publishDiagnostics
    let diag = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/publishDiagnostics",
        "params":{"uri":"file:///mock/main.rs","diagnostics":[
            {"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":3}},
             "severity":1,"message":"mock diagnostic"}
        ]}
    });
    let _ = writer.write_all(&format_frame(&diag)).await;

    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break, // transport 关闭
            Ok(n) => n,
            Err(_) => break,
        };
        for msg in framer.feed(&buf[..n]) {
            let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
            let id = msg.get("id").cloned();
            let resp = match method {
                "initialize" => Some(serde_json::json!({
                    "jsonrpc":"2.0","id":id,
                    "result":{"capabilities":{"definitionProvider":true,"completionProvider":{},"hoverProvider":true,"textDocumentSync":1}}
                })),
                "initialized" => None, // notification，无应
                "textDocument/definition" => Some(serde_json::json!({
                    "jsonrpc":"2.0","id":id,
                    "result":[{"uri":"file:///mock/def.rs","range":{"start":{"line":2,"character":4},"end":{"line":2,"character":8}}}]
                })),
                "shutdown" => Some(serde_json::json!({"jsonrpc":"2.0","id":id,"result":null})),
                _ => id.map(|i| serde_json::json!({"jsonrpc":"2.0","id":i,"result":null})),
            };
            if let Some(r) = resp {
                let _ = writer.write_all(&format_frame(&r)).await;
            }
            if method == "shutdown" {
                break; // 模拟 shutdown 后退出
            }
        }
    }
}
