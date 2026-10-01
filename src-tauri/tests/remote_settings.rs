use aide::commands::settings::{AppSettings, RemoteSettings};

#[test]
fn remote_settings_serde_roundtrip() {
    let s = RemoteSettings {
        permission_mode: "manual".into(),
    };
    let json = serde_json::to_string(&s).unwrap();
    let back: RemoteSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.permission_mode, "manual");
    // camelCase 序列化；中继地址是产品内置的，不再是设置
    assert!(json.contains("\"permissionMode\""));
    assert!(!json.contains("relayUrl"));
}

#[test]
fn app_settings_remote_defaults() {
    // 缺省时 remote 字段用默认值（permissionMode="auto"）
    let s: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
    assert_eq!(s.remote.permission_mode, "auto");
}

#[test]
fn a_legacy_saved_relay_url_is_ignored_not_an_error() {
    // 旧版本落盘的 remote.relayUrl：升级后读得进来（不炸），但不再有任何效果
    let s: AppSettings = serde_json::from_str(r#"{"remote":{"relayUrl":"wss://old.example","permissionMode":"manual"}}"#).unwrap();
    assert_eq!(s.remote.permission_mode, "manual");
}
