use aide::remote::protocol::{PhoneToDesktop, DesktopToPhone};

#[test]
fn parses_send_message_with_session() {
    let msg: PhoneToDesktop = serde_json::from_str(
        r#"{"type":"send_message","session_id":"s1","prompt":"hi"}"#,
    ).unwrap();
    match msg {
        PhoneToDesktop::SendMessage { session_id, prompt } => {
            assert_eq!(session_id.as_deref(), Some("s1"));
            assert_eq!(prompt, "hi");
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn parses_send_message_without_session() {
    let msg: PhoneToDesktop = serde_json::from_str(
        r#"{"type":"send_message","prompt":"hi"}"#,
    ).unwrap();
    match msg {
        PhoneToDesktop::SendMessage { session_id, .. } => assert!(session_id.is_none()),
        _ => panic!("wrong variant"),
    }
}

#[test]
fn parses_pair_and_auth() {
    let pair: PhoneToDesktop = serde_json::from_str(r#"{"type":"pair","code":"123456"}"#).unwrap();
    assert!(matches!(pair, PhoneToDesktop::Pair { code } if code == "123456"));
    let auth: PhoneToDesktop = serde_json::from_str(r#"{"type":"auth","token":"abc"}"#).unwrap();
    assert!(matches!(auth, PhoneToDesktop::Auth { token } if token == "abc"));
}

#[test]
fn parses_load_messages_and_list_sessions() {
    let lm: PhoneToDesktop = serde_json::from_str(r#"{"type":"load_messages","session_id":"s1"}"#).unwrap();
    assert!(matches!(lm, PhoneToDesktop::LoadMessages { session_id } if session_id == "s1"));
    let ls: PhoneToDesktop = serde_json::from_str(r#"{"type":"list_sessions"}"#).unwrap();
    assert!(matches!(ls, PhoneToDesktop::ListSessions));
}

#[test]
fn serializes_pair_ok() {
    let reply = DesktopToPhone::PairOk { device_id: "d1".into(), token: "t1".into() };
    let s = serde_json::to_string(&reply).unwrap();
    assert!(s.contains("\"type\":\"pair_ok\""));
    assert!(s.contains("\"device_id\":\"d1\""));
}
