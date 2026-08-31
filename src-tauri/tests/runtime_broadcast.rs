use aide::runtime::AgentRuntimeManager;
use serde_json::json;

#[tokio::test]
async fn subscribe_receives_events_from_channel() {
    let mgr = AgentRuntimeManager::new();
    let mut rx = mgr.subscribe_chat_events();
    let tx = mgr.chat_events_sender();
    tx.send(json!({"type": "text_delta", "delta": "hi"}))
        .unwrap();
    let ev = rx.recv().await.unwrap();
    assert_eq!(ev["type"], "text_delta");
    assert_eq!(ev["delta"], "hi");
}

#[tokio::test]
async fn multiple_subscribers_each_get_events() {
    let mgr = AgentRuntimeManager::new();
    let mut rx1 = mgr.subscribe_chat_events();
    let mut rx2 = mgr.subscribe_chat_events();
    let tx = mgr.chat_events_sender();
    tx.send(json!({"type": "message_stop"})).unwrap();
    assert_eq!(rx1.recv().await.unwrap()["type"], "message_stop");
    assert_eq!(rx2.recv().await.unwrap()["type"], "message_stop");
}
