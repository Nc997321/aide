use aide::commands::settings::{AppSettings, RemoteSettings};

#[test]
fn remote_settings_serde_roundtrip() {
    let s = RemoteSettings {
        enabled: true,
        relay_url: "wss://relay.example.com".into(),
        device_id: "abc".into(),
        permission_mode: "auto".into(),
    };
    let json = serde_json::to_string(&s).unwrap();
    let back: RemoteSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.enabled, true);
    assert_eq!(back.relay_url, "wss://relay.example.com");
    assert_eq!(back.permission_mode, "auto");
    // camelCase 序列化
    assert!(json.contains("\"relayUrl\""));
}

#[test]
fn app_settings_remote_defaults() {
    // 缺省时 remote 字段用默认值（enabled=false / permissionMode="auto"）
    let s: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
    assert_eq!(s.remote.enabled, false);
    assert_eq!(s.remote.permission_mode, "auto");
    assert_eq!(s.remote.relay_url, "");
}
