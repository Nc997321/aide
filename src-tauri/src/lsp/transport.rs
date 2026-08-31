use std::collections::HashMap;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

// ── Framer：Content-Length 帧解析器（带缓冲状态机）──

pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 喂一段字节，返回缓冲区里已完整的所有 JSON 消息。
    /// 跨 read 的 partial header/body 在内部缓冲拼接；损坏 header/JSON 跳帧不崩。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<serde_json::Value> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(header_end) = find_header_end(&self.buf) else {
                break;
            };
            let header = &self.buf[..header_end];
            let Some(len) = parse_content_length(header) else {
                // 无 Content-Length 的损坏 header 块：跳过这组 \r\n\r\n，继续找下一条。
                self.buf.drain(..header_end + 4);
                continue;
            };
            let body_start = header_end + 4;
            if self.buf.len() < body_start + len {
                break; // body 未到齐，等下一段
            }
            let body_bytes = self.buf[body_start..body_start + len].to_vec();
            self.buf.drain(..body_start + len);
            match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(v) => out.push(v),
                Err(_) => continue, // 损坏 JSON body 跳帧
            }
        }
        out
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(header: &[u8]) -> Option<usize> {
    for line in header.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(rest) = line.strip_prefix(b"Content-Length:") {
            let n: usize = std::str::from_utf8(rest).ok()?.trim().parse().ok()?;
            return Some(n);
        }
    }
    None
}

/// 把一条 JSON-RPC 消息编成 `Content-Length: N\r\n\r\n{body}` 字节（纯函数，单测）。
pub fn format_frame(value: &serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).expect("JSON-RPC payload serializable");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&body);
    out
}

/// 写一帧到异步 sink（生产用 ChildStdin，测试用 duplex 写端）。
pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    w.write_all(&format_frame(value)).await?;
    w.flush().await?;
    Ok(())
}

// ── 请求/响应 oneshot 表（照 runtime/mod.rs 已移除的 image_probe_waiters 范式）──

pub struct RequestTable {
    waiters: HashMap<u64, oneshot::Sender<serde_json::Value>>,
}

impl RequestTable {
    pub fn new() -> Self {
        Self {
            waiters: HashMap::new(),
        }
    }
    pub fn insert(&mut self, id: u64, tx: oneshot::Sender<serde_json::Value>) {
        self.waiters.insert(id, tx);
    }
    pub fn take(&mut self, id: u64) -> Option<oneshot::Sender<serde_json::Value>> {
        self.waiters.remove(&id)
    }
    /// server EOF / 进程退出：丢弃所有 sender，所有 await 的 receiver 收到 RecvError。
    pub fn reject_all(&mut self) {
        self.waiters.clear();
    }
}

use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// 持有一个 server 的 stdin 写端 + stdout 读源 + 请求/响应关联表。
/// stdout reader 任务由 manager 在 spawn 后启动（需 app handle 做 emit），
/// reader 把 Framer 出来的消息交 rpc::Router::handle_incoming 路由。
pub struct LspTransport {
    stdin: Arc<TokioMutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pub table: Arc<TokioMutex<RequestTable>>,
    reader_source: tokio::sync::Mutex<Option<Box<dyn AsyncRead + Send + Unpin>>>,
}

impl LspTransport {
    /// 构造：传 stdin（写端）+ stdout（读端）。stdout 通过 take_reader_source 取出供 reader 任务。
    pub fn with_reader_source(
        stdin: Box<dyn AsyncWrite + Send + Unpin>,
        stdout: Box<dyn AsyncRead + Send + Unpin>,
    ) -> Self {
        Self {
            stdin: Arc::new(TokioMutex::new(stdin)),
            table: Arc::new(TokioMutex::new(RequestTable::new())),
            reader_source: tokio::sync::Mutex::new(Some(stdout)),
        }
    }

    /// 取出 stdout 读源（仅一次，供 start_reader 消费）。
    pub async fn take_reader_source(&self) -> Box<dyn AsyncRead + Send + Unpin> {
        self.reader_source
            .lock()
            .await
            .take()
            .expect("reader taken once")
    }

    /// 写一帧（request 或 notification）。调方负责编好消息体。
    pub async fn send(&self, value: &serde_json::Value) -> std::io::Result<()> {
        let mut w = self.stdin.lock().await;
        write_frame(&mut *w, value).await
    }

    /// 给 reader 任务用的 table 句柄（reject_all / take 在 router 侧）。
    pub fn table_handle(&self) -> Arc<TokioMutex<RequestTable>> {
        Arc::clone(&self.table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn framer_single_message() {
        let mut f = Framer::new();
        let msgs = f.feed(&frame(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["id"], 1);
    }

    #[test]
    fn framer_split_across_chunks() {
        let mut f = Framer::new();
        let full = frame(r#"{"jsonrpc":"2.0","id":2,"result":42}"#);
        let at = full.len() / 2;
        let mut msgs = f.feed(&full[..at]);
        assert!(msgs.is_empty(), "half a frame should yield nothing");
        msgs.extend(f.feed(&full[at..]));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["result"], 42);
    }

    #[test]
    fn framer_multiple_in_one_buffer() {
        let mut f = Framer::new();
        let mut buf = frame(r#"{"id":1}"#);
        buf.extend_from_slice(&frame(r#"{"id":2}"#));
        let msgs = f.feed(&buf);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["id"], 1);
        assert_eq!(msgs[1]["id"], 2);
    }

    #[test]
    fn framer_partial_header() {
        let mut f = Framer::new();
        // 只给了部分 header（无 \r\n\r\n）
        assert!(f.feed(b"Content-Length: 18\r\n").is_empty());
        // 补齐 header + body
        let msgs = f.feed(b"\r\n{\"id\":1,\"ok\":true}");
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn framer_empty_body() {
        let mut f = Framer::new();
        // Content-Length: 0 → body 空 → from_slice(b"") Err → 跳帧，不崩、不出消息
        let msgs = f.feed(b"Content-Length: 0\r\n\r\n");
        assert!(msgs.is_empty());
    }

    #[test]
    fn framer_garbage_header_skipped() {
        let mut f = Framer::new();
        let mut buf = b"server stderr stray line\r\n\r\n".to_vec();
        // 损坏 header 块（无 Content-Length）跳过后，正常消息应仍能解析
        buf.extend_from_slice(&frame(r#"{"id":7,"result":{}}"#));
        let msgs = f.feed(&buf);
        assert_eq!(
            msgs.len(),
            1,
            "garbage header should be skipped, got {msgs:?}"
        );
        assert_eq!(msgs[0]["id"], 7);
    }

    #[test]
    fn format_frame_produces_valid_header() {
        let bytes = format_frame(&json!({"x": 1}));
        let expected = b"Content-Length: 7\r\n\r\n{\"x\":1}".to_vec();
        assert_eq!(bytes, expected);
    }

    #[tokio::test]
    async fn write_frame_writes_to_async_sink() {
        // duplex：写一端，读另一端，验字节 = format_frame 输出
        let (mut tx, mut rx) = tokio::io::duplex(1024);
        let payload = json!({"jsonrpc":"2.0","method":"foo"});
        write_frame(&mut tx, &payload).await.unwrap();
        let mut got = Vec::new();
        tx.flush().await.unwrap();
        // 读回所有字节（帧 + 可能的后续）
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 1024];
        let n = rx.read(&mut buf).await.unwrap();
        got.extend_from_slice(&buf[..n]);
        assert_eq!(got, format_frame(&payload));
    }

    #[tokio::test]
    async fn request_table_reject_all_awaits_get_error() {
        let mut table = RequestTable::new();
        let (tx, rx) = oneshot::channel();
        table.insert(42, tx);
        table.reject_all();
        assert!(
            rx.await.is_err(),
            "receiver must get error after reject_all"
        );
    }

    #[test]
    fn request_table_take_removes() {
        let mut table = RequestTable::new();
        let (tx, _rx) = oneshot::channel();
        table.insert(1, tx);
        assert!(table.take(1).is_some());
        assert!(table.take(1).is_none(), "second take must be None");
    }
}
