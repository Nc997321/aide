use std::collections::HashSet;

use tokio::sync::oneshot;

use super::registry::{token, MediaRegistry, PendingFeedback};
use super::types::FeedbackOutcome;

fn pending(owner: &str) -> (PendingFeedback, oneshot::Receiver<Result<(), String>>) {
    let (sender, receiver) = oneshot::channel();
    (PendingFeedback { owner: owner.into(), sender }, receiver)
}

#[test]
fn window_scoped_browser_events_reach_the_rust_cleanup_consumer() {
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use tauri::{Emitter, Listener, EventTarget};
    let app = tauri::test::mock_app();
    let received = Arc::new(AtomicBool::new(false));
    let capture = Arc::clone(&received);
    app.listen_any("media-test-close", move |_| { capture.store(true, Ordering::Release); });
    app.emit_to(EventTarget::webview_window("owner"), "media-test-close", serde_json::json!({ "kind": "closed" })).unwrap();
    assert!(received.load(Ordering::Acquire));
}

#[test]
fn capabilities_are_unique_opaque_and_not_paths() {
    let values: HashSet<_> = (0..256).map(|_| token()).collect();
    assert_eq!(values.len(), 256);
    assert!(values.iter().all(|value| value.len() == 48 && value.bytes().all(|byte| byte.is_ascii_hexdigit())));
}

#[test]
fn window_rebinding_has_a_monotonic_independent_epoch() {
    let registry = MediaRegistry::default();
    let before = registry.epoch("window-one");
    registry.release_window("window-one");
    assert_eq!(registry.epoch("window-one"), before + 1);
    assert_eq!(registry.epoch("window-two"), 0);
    registry.release_window("window-one");
    assert_eq!(registry.epoch("window-one"), before + 2);
}

#[tokio::test]
async fn foreign_window_cannot_consume_the_feedback_ack() {
    let registry = MediaRegistry::default();
    let (request, receiver) = pending("owner");
    registry.begin_feedback(("request".into(), request)).unwrap();
    assert!(registry.finish_feedback("other", "request", FeedbackOutcome { error: None }).is_err());
    registry.finish_feedback("owner", "request", FeedbackOutcome { error: None }).unwrap();
    assert!(receiver.await.unwrap().is_ok());
    assert!(registry.finish_feedback("owner", "request", FeedbackOutcome { error: None }).is_err());
}

#[tokio::test]
async fn closing_a_window_rejects_its_feedback_but_not_other_windows() {
    let registry = MediaRegistry::default();
    let (one, one_rx) = pending("one");
    let (two, two_rx) = pending("two");
    registry.begin_feedback(("one-request".into(), one)).unwrap();
    registry.begin_feedback(("two-request".into(), two)).unwrap();
    registry.release_window("one");
    assert!(one_rx.await.unwrap().unwrap_err().contains("关闭"));
    registry.finish_feedback("two", "two-request", FeedbackOutcome { error: None }).unwrap();
    assert!(two_rx.await.unwrap().is_ok());
}

#[tokio::test]
async fn a_closed_draft_error_reaches_the_waiting_page() {
    let registry = MediaRegistry::default();
    let (request, receiver) = pending("owner");
    registry.begin_feedback(("request".into(), request)).unwrap();
    registry.finish_feedback("owner", "request", FeedbackOutcome { error: Some("原会话已关闭".into()) }).unwrap();
    assert_eq!(receiver.await.unwrap(), Err("原会话已关闭".into()));
}

#[test]
fn pending_feedback_is_bounded_and_expired_waits_are_removed() {
    let registry = MediaRegistry::default();
    let mut receivers = Vec::new();
    for index in 0..32 {
        let (request, receiver) = pending("owner");
        receivers.push(receiver);
        registry.begin_feedback((index.to_string(), request)).unwrap();
    }
    assert!(registry.begin_feedback(("overflow".into(), pending("owner").0)).is_err());
    registry.cancel_feedback("0");
    assert!(registry.begin_feedback(("replacement".into(), pending("owner").0)).is_ok());
    assert!(registry.finish_feedback("owner", "0", FeedbackOutcome { error: None }).is_err());
}
