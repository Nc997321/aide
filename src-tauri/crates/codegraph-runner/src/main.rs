//! aide-codegraph.exe 入口 —— CodeGraph 独立索引/查询进程（优化项二）。
//!
//! 进程模型（照抄 agent-sidecar 的形状）：
//! - **stdin**：主进程写入的 JSON-RPC 请求，一行一条；
//! - **stdout**：本进程写出的响应/通知，一行一条（因此 tracing 全部落
//!   **stderr**，stdout 上一个字节的非协议输出都会污染通道）；
//! - **生命周期**：主进程惰性拉起；stdin EOF（主进程死亡）⇒ 本进程自行退出
//!   ——天然的看门狗，不需要心跳。`shutdown` 方法：应答写出后主动退出。
//!
//! 并发模型：每条请求一个 `spawn_blocking`（沿用迁移前 Tauri command 的
//! std 锁 + 阻塞池语义）——分钟级的 build_index 长请求在跑时，goto /
//! agent_query 照常并发进入。输出统一经 mpsc 汇到单写者线程序列化，避免
//! 多线程交错撕碎 JSON 行。
//!
//! 日志桥：tracing 的 WARN/ERROR 除了落 stderr，还经 `log` 通知回传主进程
//! （主进程记入自己的日志文件——runner 崩溃诊断不用翻两个文件）。

use std::io::Write;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};

use codegraph_core::protocol::{
    methods as rpc_methods, notifications, LogPayload, RpcNotification, RpcRequest, RpcResponse,
};
use codegraph_runner::codegraph::embed::set_model_resource_dir;
use codegraph_runner::codegraph::methods;
use codegraph_runner::codegraph::CodeGraphState;

/// 单写者线程的输出消息。
enum OutMsg {
    Response(RpcResponse),
    Notification(RpcNotification),
    /// shutdown 应答 + 写出回执（应答 flush 到 stdout 后 ack，main 收到才
    /// exit——保证主进程一定能读到 shutdown 的响应）。
    Shutdown(RpcResponse, Sender<()>),
}

fn main() {
    // release：主进程把自己的 resource_dir 经 env 注入（dev 不设，走
    // resolve_model_dir 的源码树回退分支）。
    if let Ok(dir) = std::env::var("AIDE_CODEGRAPH_MODEL_DIR") {
        if !dir.is_empty() {
            set_model_resource_dir(std::path::PathBuf::from(dir));
        }
    }

    // ── 单写者线程：唯一持有 stdout 的地方 ─────────────────────────────
    let (tx, rx) = std::sync::mpsc::channel::<OutMsg>();
    let _writer = std::thread::Builder::new()
        .name("rpc-writer".into())
        .spawn(move || {
            let stdout = std::io::stdout();
            loop {
                let msg = match rx.recv() {
                    Ok(m) => m,
                    Err(_) => break, // 所有 sender 都走了
                };
                let line = match &msg {
                    OutMsg::Response(r) => serde_json::to_string(r),
                    OutMsg::Notification(n) => serde_json::to_string(n),
                    OutMsg::Shutdown(r, _) => serde_json::to_string(r),
                };
                {
                    let mut out = stdout.lock();
                    if let Ok(l) = line {
                        let _ = out.write_all(l.as_bytes());
                        let _ = out.write_all(b"\n");
                    }
                    let _ = out.flush();
                }
                if let OutMsg::Shutdown(_, ack) = msg {
                    let _ = ack.send(());
                    break;
                }
            }
        })
        .expect("spawn rpc-writer");

    // ── tracing：stderr fmt + WARN/ERROR 经 log 通知回传主进程 ─────────
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(NotifyLayer { tx: tx.clone() })
        .init();
    tracing::info!("aide-codegraph runner started (pid={})", std::process::id());

    // ── tokio runtime：stdin 读循环 + 进度通知任务 + 每请求分发任务 ────
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(run(tx.clone()));
    // 走到这说明 stdin EOF（主进程死亡）——看门狗退出。可能有 build 还挂在
    // spawn_blocking 线程里，等它们只会拖尸，直接退。
    tracing::info!("stdin EOF (host gone) — exiting");
    flush_coverage();
    std::process::exit(0);
}

/// 覆盖实测（llvm-cov）钩子：`std::process::exit` 在 Windows 上走 `ExitProcess`，
/// 不执行 atexit——插桩 profile 数据不会落盘。覆盖构建（cargo-llvm-cov 注入
/// `--cfg=coverage`）里在 exit 前手动 flush；普通构建为空函数，产物零影响。
#[cfg(coverage)]
fn flush_coverage() {
    extern "C" {
        fn __llvm_profile_write_file() -> i32;
    }
    // 写失败也没处可报（马上要退出），结果丢弃。
    unsafe { __llvm_profile_write_file() };
}

#[cfg(not(coverage))]
fn flush_coverage() {}

async fn run(tx: Sender<OutMsg>) {
    let state = Arc::new(CodeGraphState::new());

    // 进度通知任务：build 激活期间每 250ms 推一次快照；true→false 翻转时
    // 补推最后一条（让主进程侧 atomics 收敛到终态，前端轮询看到 done）。
    tokio::spawn(progress_task(tx.clone(), state.clone()));

    // stdin 行循环。
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => return, // EOF：主进程死亡
            Err(e) => {
                tracing::warn!("stdin read error: {e}");
                return;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: RpcRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                // 解析失败的行没有可靠 id 可回——落日志后丢弃（主进程侧同
                // 一行也会按协议错误处理）。
                tracing::warn!("malformed rpc line ({e}): {line}");
                continue;
            }
        };

        // shutdown：应答 flush 后退出（不等在途请求——shutdown 语义就是
        // “现在就走”，在途响应随进程消亡，主进程按重启处理）。
        if req.method == rpc_methods::SHUTDOWN {
            let (ack_tx, ack_rx) = std::sync::mpsc::channel::<()>();
            let _ = tx.send(OutMsg::Shutdown(
                RpcResponse::ok(req.id, serde_json::Value::Null),
                ack_tx,
            ));
            let _ = ack_rx.recv_timeout(Duration::from_secs(2));
            tracing::info!("shutdown requested — exiting");
            flush_coverage();
            std::process::exit(0);
        }

        // 普通请求：spawn_blocking 分发（方法体内是 std 锁 + 重计算）。
        let tx2 = tx.clone();
        let st = state.clone();
        tokio::spawn(async move {
            let st2 = st.clone();
            let id = req.id;
            let method = req.method.clone();
            let params = req.params.clone();
            let resp =
                tokio::task::spawn_blocking(move || methods::dispatch(&st2, id, &method, &params))
                    .await
                    .unwrap_or_else(|e| {
                        RpcResponse::err(id, format!("runner method task panicked: {e}"))
                    });
            let _ = tx2.send(OutMsg::Response(resp));
        });
    }
}

/// 250ms 进度通知任务。只在有意义时发（激活期间 + 结束翻转 + 首帧），
/// 空闲时不刷屏。
async fn progress_task(tx: Sender<OutMsg>, st: Arc<CodeGraphState>) {
    let mut last_active: Option<bool> = None;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let snap = methods::progress_snapshot(&st);
        let send = match last_active {
            None => true,                      // 首帧（主进程刚拉起就能看到 index_ready 等状态）
            Some(prev) => snap.active || prev, // 激活期持续发 + 结束翻转帧（active 刚变 false）
        };
        if send {
            if let Ok(payload) = serde_json::to_value(&snap) {
                let _ = tx.send(OutMsg::Notification(RpcNotification {
                    notification: notifications::PROGRESS.to_string(),
                    payload,
                }));
            }
        }
        last_active = Some(snap.active);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 日志桥：tracing WARN/ERROR → `log` 通知 → 主进程日志。
// info 级不回传（build 期间每文件一条 info 会把管道刷成日志通道）。
// ─────────────────────────────────────────────────────────────────────────────

struct NotifyLayer {
    tx: Sender<OutMsg>,
}

impl<S> tracing_subscriber::Layer<S> for NotifyLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let level = *event.metadata().level();
        if !matches!(level, tracing::Level::WARN | tracing::Level::ERROR) {
            return;
        }
        let mut visitor = MsgVisitor { msg: String::new() };
        event.record(&mut visitor);
        if visitor.msg.is_empty() {
            return;
        }
        let payload = LogPayload {
            level: level.to_string(),
            message: visitor.msg,
        };
        if let Ok(value) = serde_json::to_value(&payload) {
            let _ = self.tx.send(OutMsg::Notification(RpcNotification {
                notification: notifications::LOG.to_string(),
                payload: value,
            }));
        }
    }
}

struct MsgVisitor {
    msg: String,
}

impl tracing::field::Visit for MsgVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.msg = value.to_string();
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            // Debug 格式化会给字符串加引号，剥掉保持与 record_str 一致。
            let s = format!("{value:?}");
            self.msg = s.trim_matches('"').to_string();
        }
    }
}
