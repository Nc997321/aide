//! 本地测试 Host：手机端开发时直接连它，不用先搭中继、也不用一台真 Host。
//!
//! ```text
//! cargo run -p aide-link --features transport --example test_host -- --listen 0.0.0.0:8787 --public ws://192.168.1.20:8787/ --demo
//! ```
//!
//! - 直连 WebSocket（`--listen`），说完整的 Aide Link v1（安全通道 + Link 帧）；
//! - **身份与密钥固定**（`crates/aide-link/src/testkit.rs` 里的常量）——二维码每次启动都一样，可以硬编码进手机端调试；
//!   一次性密钥被用掉后立刻重新开放，所以能反复配对 / 顶替；
//! - 后端是脚本化的假 Host（`list_sessions` → `["s1","s2"]`，`send_message` / `get_settings` 回显参数，
//!   `set_model` 失败，`load_messages` 慢 150 ms……见一致性向量 README）；`--demo` 每 2 s 往会话 `demo`
//!   发一个 `chat-event`，用来试订阅 / 续传；
//! - `--relay <中继地址>`：改为出站注册到真中继（`<relay>/ws`），二维码里写中继地址，用来联调中继路径。
//!
//! 它**不是**真 Host：不会执行任何真实命令，也不碰你的文件。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aide_link::identity::{keypair_from_private, Identity, MemoryVault, OFFER_TTL};
use aide_link::secure::{Endpoint, PairingOffer};
use aide_link::testkit::{FakeBackend, DEVICE_ID, HOST_SECRET, OFFER_PSK};
use aide_link::transport::relay::RelayStatus;
use aide_link::transport::{direct, relay, LinkHost};
use qrcode::render::unicode::Dense1x2;
use qrcode::QrCode;
use serde_json::json;

struct Args {
    listen: String,
    public: Option<String>,
    relay: Option<String>,
    demo: bool,
}

fn parse_args() -> Args {
    let mut a = Args { listen: "127.0.0.1:8787".into(), public: None, relay: None, demo: false };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        match k.as_str() {
            "--listen" => a.listen = it.next().expect("--listen needs an address"),
            "--public" => a.public = it.next(),
            "--relay" => a.relay = it.next(),
            "--demo" => a.demo = true,
            "-h" | "--help" => {
                eprintln!("usage: test_host [--listen ADDR] [--public WS_URL] [--relay RELAY_URL] [--demo]");
                std::process::exit(0);
            }
            other => panic!("unknown argument `{other}`"),
        }
    }
    a
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let identity = Arc::new(Identity::from_parts(Arc::new(MemoryVault::default()), DEVICE_ID.into(), HOST_SECRET));
    identity.seed_for_test(None, Some(OFFER_PSK));
    let backend = Arc::new(FakeBackend::default());
    let host = LinkHost::new(backend.clone(), identity.clone());

    let endpoint = match (&args.relay, &args.public) {
        (Some(r), _) => Endpoint::Relay(r.clone()),
        (None, Some(p)) => Endpoint::Direct(p.clone()),
        (None, None) => Endpoint::Direct(format!("ws://{}/", args.listen)),
    };
    let offer = PairingOffer {
        endpoint,
        device_id: DEVICE_ID.into(),
        host_public: keypair_from_private(HOST_SECRET).public,
        psk: OFFER_PSK,
        name: "Aide Link test host".into(),
        expires_at_unix: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) + OFFER_TTL.as_secs(),
    };
    let uri = offer.to_uri();
    println!("Aide Link test host — fixed identity, scripted backend (NOT a real Host)\n");
    println!("pairing URI (valid while this process runs; the one-time secret is re-opened after each pairing):\n\n  {uri}\n");
    if let Ok(code) = QrCode::new(uri.as_bytes()) {
        println!("{}\n", code.render::<Dense1x2>().quiet_zone(true).build());
    }

    // 一次性密钥被用掉后立刻重新开放，方便反复配对
    {
        let identity = identity.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if !identity.offer_active() {
                    identity.seed_for_test(None, Some(OFFER_PSK));
                    println!("(pairing offer re-opened)");
                }
            }
        });
    }
    if args.demo {
        let backend = backend.clone();
        tokio::spawn(async move {
            let mut n = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                n += 1;
                backend.bus.emit("chat-event", json!({"type":"text_delta","session_id":"demo","text":format!("tick {n}")}));
            }
        });
    }

    match args.relay {
        Some(relay_url) => {
            println!("registering with relay {} as {DEVICE_ID} …", relay::ws_url(&relay_url));
            relay::run(host, relay_url, Arc::new(RelayStatus::default())).await;
        }
        None => {
            let listener = tokio::net::TcpListener::bind(&args.listen).await.expect("bind");
            println!("listening on ws://{} (direct, no relay)", listener.local_addr().expect("addr"));
            direct::serve(listener, host).await;
        }
    }
}
