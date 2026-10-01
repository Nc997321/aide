//! 真 Host 的 Aide Link 端到端：真守护进程（真 Core、真命令表）+ 真中继（进程内）+ 手机一侧的参考客户端。
//!
//! 走完整条路：Host 设置里配中继 → 生成配对二维码（`link_create_offer`，桥上 invoke，就是 Host 窗口里
//! 设置面板发的那条命令）→ 手机扫码配对 → 经中继调真实的 Host 命令 → Host 上撤销，手机被踢。

#![cfg(unix)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use aide_link::client::RefClient;
use aide_link::secure::{generate_keypair, Mode, PairingOffer, WireFrame};
use common::{Bridge, TempHome};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Phone {
    ws: Ws,
    client: RefClient,
}

async fn next_wire(ws: &mut Ws) -> WireFrame {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("timed out").expect("closed").expect("ws error");
        if let Message::Text(t) = m {
            return serde_json::from_str(&t).expect("wire frame");
        }
    }
}

impl Phone {
    async fn connect(offer: &PairingOffer, mode: Mode, keys: &aide_link::secure::Keypair) -> Result<Phone, String> {
        let url = aide_link::transport::relay::ws_url(offer.endpoint.url());
        let (mut ws, _) = connect_async(url.as_str()).await.map_err(|e| e.to_string())?;
        ws.send(Message::Text(json!({"type":"connect","device_id":offer.device_id}).to_string())).await.unwrap();
        let psk = (mode == Mode::Pair).then_some(&offer.psk);
        let (init, pending) = RefClient::begin(mode, keys, &offer.host_public, &offer.device_id, psk, &[1])?;
        ws.send(Message::Text(serde_json::to_string(&init).unwrap())).await.unwrap();
        let resp = next_wire(&mut ws).await;
        match &resp {
            WireFrame::ScResp { .. } => Ok(Phone { ws, client: pending.complete(&resp)? }),
            WireFrame::ScErr { code, message } => Err(format!("sc_err {code:?}: {message}")),
            other => Err(format!("unexpected {other:?}")),
        }
    }

    async fn send(&mut self, frame: Value) {
        for w in self.client.seal_frame(&frame) {
            self.ws.send(Message::Text(serde_json::to_string(&w).unwrap())).await.unwrap();
        }
    }

    async fn recv(&mut self) -> Value {
        loop {
            let w = next_wire(&mut self.ws).await;
            if let Some(v) = self.client.open(&w).expect("decrypt") {
                return v;
            }
        }
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({"type":"call","id":id,"method":method,"params":params})).await;
        loop {
            let v = self.recv().await;
            if v["id"] == id {
                return v;
            }
        }
    }
}

async fn start_relay() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(std::sync::Mutex::new(aide_relay::state::RelayState::default()));
    tokio::spawn(async move { aide_relay::run(listener, state).await });
    format!("ws://{addr}")
}

fn invoke(b: &mut Bridge, cmd: &str, args: Value) -> Result<Value, String> {
    b.call("invoke", json!({ "cmd": cmd, "args": args }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_real_host_pairs_a_phone_through_a_real_relay() {
    let relay_url = start_relay().await;
    let home = TempHome::new("link");
    let mut host = Bridge::start(&home, None);
    host.hello();

    // 配置中继 → 生成配对二维码（Host 设置面板发的就是这两条命令）
    invoke(&mut host, "set_settings", json!({ "settings": { "remote": { "relayUrl": relay_url } } })).unwrap();
    let before = invoke(&mut host, "link_status", json!({})).unwrap();
    assert_eq!(before["enabled"], false);
    assert_eq!(before["relayConfigured"], true);

    let offer_view = invoke(&mut host, "link_create_offer", json!({})).unwrap();
    assert!(offer_view["qrSvg"].as_str().unwrap().contains("<svg"));
    let offer = PairingOffer::parse(offer_view["uri"].as_str().unwrap()).expect("a valid pairing URI");

    // 等 Host 在中继上注册上
    let mut registered = false;
    for _ in 0..60 {
        if invoke(&mut host, "link_status", json!({})).unwrap()["connected"] == true {
            registered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(registered, "the Host never registered with the relay");
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 手机扫码配对
    let phone_keys = generate_keypair();
    let mut phone = Phone::connect(&offer, Mode::Pair, &phone_keys).await.expect("pair handshake");
    phone.send(json!({"type":"hello"})).await;
    let hello_ok = phone.recv().await;
    assert_eq!(hello_ok["type"], "hello_ok", "{hello_ok}");
    assert_eq!(hello_ok["host"]["id"], offer.device_id.as_str());
    assert_eq!(hello_ok["host"]["os"], "linux");

    // 真实的 Host 命令：来自真 Core 的命令表
    let ws = phone.call(1, "get_active_workspace", json!({})).await;
    assert_eq!(ws["type"], "result", "{ws}");
    let sessions = phone.call(2, "list_sessions", json!({})).await;
    assert_eq!(sessions["type"], "result", "{sessions}");
    assert!(sessions["value"].is_array());
    // 目录之外的命令：Host 窗口能用、手机不能
    let denied = phone.call(3, "git_status", json!({"cwd": "/"})).await;
    assert_eq!((denied["type"].as_str(), denied["code"].as_str()), (Some("error"), Some("unknown_method")));
    let catalog = phone.call(4, "link.describe", json!({})).await;
    assert!(catalog["value"]["groups"].as_array().unwrap().len() >= 5);

    // Host 的视角：已配对、二维码已用掉
    let after = invoke(&mut host, "link_status", json!({})).unwrap();
    assert_eq!((after["paired"].as_bool(), after["offerActive"].as_bool()), (Some(true), Some(false)));

    // 订阅：Host 上发生的对话事件会推给手机（用 Host 自己的 notify 造一个系统通知事件）
    phone.send(json!({"type":"subscribe","sessions":null})).await;
    assert_eq!(phone.recv().await["type"], "subscribed");

    // 手机离开后用 resume 回来：不再需要二维码
    phone.ws.close(None).await.ok();
    drop(phone);
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mut back = Phone::connect(&offer, Mode::Resume, &phone_keys).await.expect("resume handshake");
    back.send(json!({"type":"hello"})).await;
    assert_eq!(back.recv().await["type"], "hello_ok");

    // Host 上撤销：手机被踢（bye revoked），之后 resume 被拒
    invoke(&mut host, "link_revoke", json!({})).unwrap();
    let mut got_bye = false;
    for _ in 0..10 {
        let v = tokio::time::timeout(Duration::from_secs(3), back.recv()).await.expect("bye should arrive");
        if v["type"] == "bye" {
            assert_eq!(v["code"], "revoked");
            got_bye = true;
            break;
        }
    }
    assert!(got_bye);
    back.ws.close(None).await.ok();
    drop(back);
    tokio::time::sleep(Duration::from_millis(400)).await;
    let err = Phone::connect(&offer, Mode::Resume, &phone_keys).await.err().expect("revoked phone cannot resume");
    assert!(err.contains("Unauthorized"), "{err}");

    // 收尾：关掉 Link，让守护进程退出
    invoke(&mut host, "link_set_enabled", json!({"enabled": false})).unwrap();
    host.call("shutdown", json!({ "force": true })).unwrap();
    host.kill();
}

/// 启用了手机网关的 Host 不会因为「没有客户端」而空闲退出（手机随时会来）；没启用的会照常退。
#[test]
fn an_enabled_link_keeps_the_daemon_alive_while_idle() {
    const FAST_IDLE: &[(&str, &str)] = &[("AIDE_HOST_IDLE_SECS", "1"), ("AIDE_HOST_IDLE_CHECK_SECS", "1")];
    let gone = |home: &TempHome| {
        let sock = home.path().join(".aide/host/daemon.sock");
        for _ in 0..80 {
            if !sock.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    };

    // 对照：没启用 Link，客户端全走了 → 守护进程按空闲规则退出
    let plain = TempHome::new("idle-plain");
    let mut b = Bridge::start_with_env(&plain, None, FAST_IDLE);
    b.hello();
    b.kill();
    assert!(gone(&plain), "control: without Link the idle daemon exits (otherwise this test proves nothing)");

    // 启用了 Link：同样的空闲条件，守护进程必须还在
    let home = TempHome::new("idle-link");
    let mut host = Bridge::start_with_env(&home, None, FAST_IDLE);
    host.hello();
    invoke(&mut host, "set_settings", json!({ "settings": { "remote": { "relayUrl": "ws://127.0.0.1:9" } } })).unwrap();
    invoke(&mut host, "link_set_enabled", json!({"enabled": true})).unwrap();
    host.kill(); // 客户端全走了
    std::thread::sleep(Duration::from_secs(5)); // 远超空闲宽限 + 检查间隔
    assert!(home.path().join(".aide/host/daemon.sock").exists(), "an enabled Link gateway must keep the daemon alive");

    // 收尾
    let mut again = Bridge::start(&home, None);
    again.hello();
    invoke(&mut again, "link_set_enabled", json!({"enabled": false})).unwrap();
    again.call("shutdown", json!({ "force": true })).unwrap();
    again.kill();
}
