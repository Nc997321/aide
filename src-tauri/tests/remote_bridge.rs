use aide::remote::bridge::{map_message, BridgeAction};
use aide::remote::protocol::PhoneToDesktop;

#[test]
fn map_send_message_requires_auth() {
    let msg = PhoneToDesktop::SendMessage { session_id: None, prompt: "hi".into() };
    let err = map_message(&msg, false).unwrap_err();
    assert!(err.contains("未认证"));
}

#[test]
fn map_send_message_generates_session_id_when_absent() {
    let msg = PhoneToDesktop::SendMessage { session_id: None, prompt: "hi".into() };
    match map_message(&msg, true).unwrap() {
        BridgeAction::SendMessage { session_id, prompt } => {
            assert!(session_id.starts_with("remote-"));
            assert_eq!(prompt, "hi");
        }
        _ => panic!("wrong action"),
    }
}

#[test]
fn map_send_message_keeps_existing_session_id() {
    let msg = PhoneToDesktop::SendMessage { session_id: Some("s1".into()), prompt: "hi".into() };
    match map_message(&msg, true).unwrap() {
        BridgeAction::SendMessage { session_id, .. } => {
            assert_eq!(session_id, "s1");
        }
        _ => panic!("wrong action"),
    }
}

#[test]
fn map_load_messages_and_list_require_auth() {
    let lm = PhoneToDesktop::LoadMessages { session_id: "s1".into() };
    assert!(map_message(&lm, false).is_err());
    let ls = PhoneToDesktop::ListSessions;
    assert!(map_message(&ls, false).is_err());
    assert!(map_message(&lm, true).is_ok());
    assert!(map_message(&ls, true).is_ok());
}

#[test]
fn map_pair_and_auth_never_require_auth() {
    let pair = PhoneToDesktop::Pair { code: "123456".into() };
    assert!(matches!(map_message(&pair, false).unwrap(), BridgeAction::Pair { code } if code == "123456"));
    let auth = PhoneToDesktop::Auth { token: "t".into() };
    assert!(matches!(map_message(&auth, false).unwrap(), BridgeAction::Auth { token } if token == "t"));
}
