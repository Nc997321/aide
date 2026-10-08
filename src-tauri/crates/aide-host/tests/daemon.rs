//! 真二进制的守护进程集成测试：`aide-host serve`（桥）+ `aide-host daemon`，HOME 指向临时目录
//! （套接字 / 锁 / 数据都落在里面，绝不碰真实 `~/.aide` 与用户自己的守护进程）。
//!
//! 只在 Unix 上有意义（Host 本来就只在 Linux 目标机上跑）。

#![cfg(unix)]

use std::path::Path;
use std::time::{Duration, Instant};

mod common;
use common::{Bridge, TempHome};

use aide_host::protocol::{AttachInfo, HelloInfo, Resume};
use serde_json::{json, Value};

fn attach_of(h: &HelloInfo) -> AttachInfo {
    h.attach.clone().expect("hello after attach carries AttachInfo")
}

fn watch_event(f: &Value) -> bool {
    f["event"] == "file-tree-changed"
}

/// 桥被杀、守护进程活着：重连凭 `resume` 补回断线期间发生的事件，且守护进程身份不变。
#[test]
fn reconnect_resumes_and_replays_events_missed_while_away() {
    let home = TempHome::new("resume");
    let proj = home.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();

    let mut a = Bridge::start(&home, None);
    let hello = a.hello();
    let first = attach_of(&hello);
    assert!(!first.resumed, "a fresh attach has nothing to resume");
    assert!(!hello.daemon_id.is_empty() && hello.daemon_id == first.daemon_id);
    a.call("invoke", json!({ "cmd": "file_tree_watch", "args": { "root": proj } })).unwrap();
    // 在线时的一次改动：证明监听通了，也让 last_seq 往前走
    std::fs::write(proj.join("one.txt"), "1").unwrap();
    assert!(a.wait_event(Duration::from_secs(10), watch_event).is_some(), "live event");
    let last_seq = a.last_seq;
    a.kill();

    // 桥不在的时候发生的改动
    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(proj.join("two.txt"), "2").unwrap();
    std::thread::sleep(Duration::from_millis(1500)); // 监听防抖，确保事件已进环

    let mut b = Bridge::start(&home, Some(Resume { daemon_id: first.daemon_id.clone(), seq: last_seq }));
    let hello = b.hello();
    let info = attach_of(&hello);
    assert_eq!(hello.daemon_id, first.daemon_id, "same daemon: the Host survived the bridge");
    assert!(info.resumed && !info.gap, "{info:?}");
    assert!(info.replayed >= 1, "missed events replayed: {info:?}");
    let replayed = b.wait_event(Duration::from_secs(5), watch_event).expect("replayed file-tree-changed");
    assert!(replayed["seq"].as_u64().unwrap() > last_seq);

    // 收尾：让守护进程退出，并确认它清理了套接字
    b.call("shutdown", json!({ "force": true })).unwrap();
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    b.kill();
}

/// 守护进程重启过（身份变了）：不谎称 resumed——客户端据此知道会话已经没了。
#[test]
fn reconnect_after_the_daemon_restarted_is_not_resumed() {
    let home = TempHome::new("fresh");
    let mut a = Bridge::start(&home, None);
    let old = attach_of(&{
        a.hello()
    });
    a.call("shutdown", json!({ "force": true })).unwrap();
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    a.kill();

    let mut b = Bridge::start(&home, Some(Resume { daemon_id: old.daemon_id.clone(), seq: 5 }));
    let hello = b.hello();
    assert_ne!(hello.daemon_id, old.daemon_id, "a new daemon was started");
    assert!(!attach_of(&hello).resumed);
    b.call("shutdown", json!({ "force": true })).unwrap();
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    b.kill();
}

/// 两个客户端同时连着：都能 invoke；还有别人连着时，非强制的 shutdown 被拒绝。
#[test]
fn shutdown_refuses_while_other_clients_are_attached() {
    let home = TempHome::new("multi");
    let mut a = Bridge::start(&home, None);
    let mut b = Bridge::start(&home, None);
    let (ha, hb) = (a.hello(), b.hello());
    assert_eq!(ha.daemon_id, hb.daemon_id, "one daemon serves both");

    let err = a.call("shutdown", json!({})).unwrap_err();
    assert!(err.contains("客户端"), "{err}");
    assert!(a.call("invoke", json!({ "cmd": "no_such_command", "args": {} })).is_err());

    b.kill();
    std::thread::sleep(Duration::from_millis(300));
    a.call("shutdown", json!({})).expect("sole client may shut the daemon down");
    wait_gone(&home.path().join(".aide/host/daemon.sock"));
    a.kill();
}

fn wait_gone(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!path.exists(), "daemon should remove its socket on exit");
}
