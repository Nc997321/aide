//! 安全通道的**逐字节**向量：固定密钥 + 固定临时密钥 → 握手消息与密文都是确定的。手机端实现用它验证
//! 自己的 Noise 实现（`tests/fixtures/noise_vectors.json`）：给同样的输入，必须得到同样的字节。
//!
//! 文件由本测试生成并校验：`UPDATE_VECTORS=1 cargo test -p aide-link --test noise_vectors` 重写它。
//! 改了握手 / 帧格式导致它变化 = 协议不兼容变更，须升版本号（见 `docs/aide-link-protocol.md` §10）。

use aide_link::identity::keypair_from_private;
use aide_link::secure::{b64, encode_bytes, prologue, Initiator, Mode, Responder, WireFrame};
use serde_json::{json, Value};

const DEVICE_ID: &str = "00112233445566778899aabbccddeeff";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn vector(mode: Mode, name: &str) -> Value {
    let host = keypair_from_private([0x42; 32]);
    let phone = keypair_from_private([0xA1; 32]);
    let psk = [0x5A; 32];
    let (e_init, e_resp) = ([0x11; 32], [0x22; 32]);
    let psk_opt = (mode == Mode::Pair).then_some(&psk);

    let (msg1, init) = Initiator::start(mode, &phone, &host.public, DEVICE_ID, psk_opt, Some(&e_init)).unwrap();
    let resp = Responder::read_first(mode, &host.private, DEVICE_ID, psk_opt, &msg1, Some(&e_resp)).unwrap();
    assert_eq!(resp.remote_static, phone.public);
    let (msg2, mut host_t) = resp.finish().unwrap();
    let mut phone_t = init.finish(&msg2).unwrap();

    // 传输态：phone → host 第一帧、host → phone 第一帧（nonce 都是 0）
    let hello = br#"{"type":"hello"}"#;
    let reply = br#"{"type":"hello_ok","version":1}"#;
    let c_phone = phone_t.seal(hello);
    let c_host = host_t.seal(reply);
    let WireFrame::Sc { c: c1, last: l1 } = &c_phone[0] else { panic!() };
    let WireFrame::Sc { c: c2, last: l2 } = &c_host[0] else { panic!() };
    assert!(*l1 && *l2);

    json!({
        "name": name,
        "pattern": match mode { Mode::Pair => "Noise_IKpsk2_25519_ChaChaPoly_SHA256", Mode::Resume => "Noise_IK_25519_ChaChaPoly_SHA256" },
        "inputs": {
            "host_private_hex": hex(&host.private),
            "host_public_hex": hex(&host.public),
            "phone_private_hex": hex(&phone.private),
            "phone_public_hex": hex(&phone.public),
            "device_id": DEVICE_ID,
            "prologue_utf8": String::from_utf8(prologue(DEVICE_ID)).unwrap(),
            "psk_hex": if mode == Mode::Pair { Value::String(hex(&psk)) } else { Value::Null },
            "initiator_ephemeral_private_hex": hex(&e_init),
            "responder_ephemeral_private_hex": hex(&e_resp),
        },
        "handshake": {
            "msg1_hex": hex(&msg1),
            "msg2_hex": hex(&msg2),
            "sc_init": { "type": "sc_init", "versions": [1], "mode": match mode { Mode::Pair => "pair", Mode::Resume => "resume" }, "msg": encode_bytes(&msg1) },
            "sc_resp": { "type": "sc_resp", "version": 1, "msg": encode_bytes(&msg2) },
        },
        "transport": {
            "phone_to_host": { "plaintext_utf8": String::from_utf8_lossy(hello), "sc": { "type": "sc", "c": c1, "last": true } },
            "host_to_phone": { "plaintext_utf8": String::from_utf8_lossy(reply), "sc": { "type": "sc", "c": c2, "last": true } },
        },
        "pairing_uri_psk_b64url": b64(&psk),
    })
}

fn build() -> Value {
    json!({
        "about": "Aide Link secure-channel byte-exact vectors. Reproduce `handshake` and `transport` from `inputs` with your Noise implementation (see docs/aide-link-protocol.md §3).",
        "vectors": [
            vector(Mode::Resume, "resume: Noise_IK"),
            vector(Mode::Pair, "pair: Noise_IKpsk2"),
        ],
    })
}

#[test]
fn the_noise_vectors_file_matches_what_the_implementation_produces() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/noise_vectors.json");
    let built = build();
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&built).unwrap() + "\n").unwrap();
    }
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("run with UPDATE_VECTORS=1 to create"))
        .expect("valid json");
    assert_eq!(built, on_disk, "noise vectors drifted: a wire-incompatible change needs a protocol version bump");
}

/// 握手消息长度是协议的一部分（手机端实现可以据此自检）：msg1 = e(32) + 加密的 s(48) + 空 payload 的 tag(16)；
/// msg2 = e(32) + 空 payload 的 tag(16)。
#[test]
fn handshake_message_lengths_are_as_documented() {
    for v in build()["vectors"].as_array().unwrap() {
        let mode = if v["pattern"].as_str().unwrap().contains("psk") { Mode::Pair } else { Mode::Resume };
        let hs = &v["handshake"];
        let _ = mode;
        assert_eq!(hs["msg1_hex"].as_str().unwrap().len(), 96 * 2);
        assert_eq!(hs["msg2_hex"].as_str().unwrap().len(), 48 * 2);
    }
}
