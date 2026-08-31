use aide::remote::protocol::{DesktopToPhone, PhoneToDesktop};
use serde_json::json;

// ── 协议 v2（通用 RPC）线形对账 ──

#[test]
fn parses_pair_and_auth() {
    let pair: PhoneToDesktop = serde_json::from_str(r#"{"type":"pair","code":"123456"}"#).unwrap();
    assert!(matches!(pair, PhoneToDesktop::Pair { code } if code == "123456"));
    let auth: PhoneToDesktop = serde_json::from_str(r#"{"type":"auth","token":"abc"}"#).unwrap();
    assert!(matches!(auth, PhoneToDesktop::Auth { token } if token == "abc"));
}

#[test]
fn parses_invoke_with_params() {
    let msg: PhoneToDesktop = serde_json::from_str(
        r#"{"type":"invoke","id":7,"command":"send_message","params":{"sessionId":"s1","prompt":"hi"}}"#,
    )
    .unwrap();
    match msg {
        PhoneToDesktop::Invoke {
            id,
            command,
            params,
        } => {
            assert_eq!(id, 7);
            assert_eq!(command, "send_message");
            assert_eq!(params["sessionId"], "s1");
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn parses_invoke_without_params_gives_null() {
    // 无参命令：params 字段缺省时 serde 收到的是缺失字段——协议要求调用方恒传
    // （无参传 {}）。这里验证缺省即解析失败，拒绝含糊协议形状。
    let r: Result<PhoneToDesktop, _> =
        serde_json::from_str(r#"{"type":"invoke","id":1,"command":"list_sessions"}"#);
    assert!(r.is_err());
}

#[test]
fn serializes_invoke_ok_and_err() {
    let ok = DesktopToPhone::InvokeOk {
        id: 3,
        payload: json!({"sessions": []}),
    };
    let s = serde_json::to_string(&ok).unwrap();
    assert!(s.contains("\"type\":\"invoke_ok\""));
    assert!(s.contains("\"id\":3"));
    assert!(s.contains("\"payload\""));

    let err = DesktopToPhone::InvokeErr {
        id: 3,
        error: "boom".into(),
    };
    let s = serde_json::to_string(&err).unwrap();
    assert!(s.contains("\"type\":\"invoke_err\""));
    assert!(s.contains("\"error\":\"boom\""));
}

#[test]
fn serializes_pair_ok() {
    let reply = DesktopToPhone::PairOk {
        device_id: "d1".into(),
        token: "t1".into(),
    };
    let s = serde_json::to_string(&reply).unwrap();
    assert!(s.contains("\"type\":\"pair_ok\""));
    assert!(s.contains("\"device_id\":\"d1\""));
}

#[test]
fn serializes_event_passthrough() {
    let ev = DesktopToPhone::Event {
        event: json!({"type":"text_delta","delta":"x"}),
    };
    let s = serde_json::to_string(&ev).unwrap();
    assert!(s.contains("\"type\":\"event\""));
    assert!(s.contains("\"text_delta\""));
}
