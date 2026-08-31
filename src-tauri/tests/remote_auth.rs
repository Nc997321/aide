use aide::remote::auth::{generate_device_id, generate_token, PairingState};
use std::time::{Duration, Instant};

#[test]
fn refresh_generates_six_digit_code() {
    let mut p = PairingState::new();
    let code = p.refresh();
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
}

#[test]
fn validate_accepts_current_code() {
    let mut p = PairingState::new();
    let code = p.refresh();
    assert!(p.validate(&code));
}

#[test]
fn validate_rejects_wrong_code() {
    let mut p = PairingState::new();
    p.refresh();
    assert!(!p.validate("000000"));
}

#[test]
fn validate_rejects_expired_code() {
    let p = PairingState::from_parts("123456".into(), Instant::now() - Duration::from_secs(1));
    assert!(!p.validate("123456"));
}

#[test]
fn ensure_valid_refreshes_when_expired() {
    let mut p = PairingState::from_parts("123456".into(), Instant::now() - Duration::from_secs(1));
    let code = p.ensure_valid();
    assert_ne!(code, "123456");
    assert_eq!(code.len(), 6);
}

#[test]
fn token_and_device_id_are_hex() {
    let t = generate_token();
    assert_eq!(t.len(), 64);
    assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    let d = generate_device_id();
    assert_eq!(d.len(), 32);
    assert!(d.chars().all(|c| c.is_ascii_hexdigit()));
}

// TokenStore 不写专门测试：它是 secrets()/settings 的 IO 薄层（每方法 1-3 行），
// 集成测试无法构造 SettingsService（MemorySecretStore 是 #[cfg(test)] 导出，
// 集成测试 crate 里不可见；真实 KeyringSecretStore 会碰用户 keychain）。
// 其行为由 Task 5 的 remote_get_status 手动验证覆盖。
