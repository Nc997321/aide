use rand::Rng;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::settings::{SettingsError, SettingsScope, SettingsService};

/// 配对码状态：6 位数字，10 分钟有效，可轮换。
pub struct PairingState {
    code: String,
    expires_at: Instant,
}

impl PairingState {
    pub fn new() -> Self {
        Self {
            code: String::new(),
            expires_at: Instant::now(),
        }
    }

    /// 测试构造：指定码 + 过期时刻（集成测试无法快进时钟）。
    pub fn from_parts(code: String, expires_at: Instant) -> Self {
        Self { code, expires_at }
    }

    /// 生成新 6 位数字配对码（10 分钟有效）。
    pub fn refresh(&mut self) -> String {
        let mut rng = rand::thread_rng();
        let code: u32 = rng.gen_range(0..1_000_000);
        self.code = format!("{code:06}");
        self.expires_at = Instant::now() + Duration::from_secs(600);
        self.code.clone()
    }

    /// 当前有效配对码（过期/未生成返回 None）。
    pub fn current(&self) -> Option<String> {
        if self.code.is_empty() || Instant::now() > self.expires_at {
            None
        } else {
            Some(self.code.clone())
        }
    }

    /// 校验配对码（过期即无效）。
    pub fn validate(&self, code: &str) -> bool {
        self.current().as_deref() == Some(code)
    }

    /// 返回当前有效码；过期/为空则刷新。中继重连时调用，避免配对中途换码。
    pub fn ensure_valid(&mut self) -> String {
        match self.current() {
            Some(code) => code,
            None => self.refresh(),
        }
    }
}

/// long-lived token 与签发时刻在 secrets 中的 key。两者生命周期完全绑定：
/// 同签（issue）同销（revoke），不可只留其一。
const TOKEN_ISSUED_AT_KEY: &str = "remote/tokenIssuedAt";

/// 长期 token 存储：签发/校验/吊销 + 设备身份。secrets 访问内聚在本层。
/// 每个方法都是 secrets()/settings 的薄封装（1-3 行 IO），不写专门测试
/// （集成测试无法构造 SettingsService，见 tests/remote_auth.rs 注释）。
pub struct TokenStore {
    service: Arc<SettingsService>,
}

impl TokenStore {
    pub fn new(service: Arc<SettingsService>) -> Self {
        Self { service }
    }

    /// 签发长期 token 并持久化（覆盖旧 token = 吊销旧设备）。
    /// 同时记录签发时刻：设置面板「已配对设备」据此显示配对时间。
    pub fn issue(&self) -> Result<String, String> {
        let token = generate_token();
        self.service
            .secrets()
            .set("remote/token", &token)
            .map_err(|e| e.to_string())?;
        // 时间戳与 token 同生共死：不写会残留上一台的签发时间，写失败则宁可
        // 整体失败（revoke 走同一对 key，不会出现"有签发时间却没 token"的脏状态）
        self.service
            .secrets()
            .set(TOKEN_ISSUED_AT_KEY, &now_millis().to_string())
            .map_err(|e| e.to_string())?;
        Ok(token)
    }

    /// token 签发时刻（Unix 毫秒）。无 token / 记录缺失返回 None——老版本
    /// 签发的 token 没有时间戳，此处降级为「已配对，时间未知」，不报错。
    pub fn issued_at(&self) -> Option<i64> {
        self.service
            .secrets()
            .get(TOKEN_ISSUED_AT_KEY)
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok())
    }

    /// 校验 token（与 secrets 中存储的比对）。
    pub fn validate(&self, token: &str) -> bool {
        self.service
            .secrets()
            .get("remote/token")
            .ok()
            .flatten()
            .as_deref()
            == Some(token)
    }

    /// 吊销所有远程设备（清 token + 签发时刻）。
    pub fn revoke(&self) -> Result<(), String> {
        let secrets = self.service.secrets();
        // 两个 key 一起清：残留时间戳会让 UI 显示"配对于 X"却没有设备
        secrets
            .delete(TOKEN_ISSUED_AT_KEY)
            .map_err(|e| e.to_string())?;
        secrets.delete("remote/token").map_err(|e| e.to_string())
    }

    /// 读取/生成 device_id（持久化到 settings.remote.deviceId）。
    /// async：内部 spawn_blocking 读/写 settings（同步 IO 不能堵 tokio worker）。
    pub async fn device_id(&self) -> Result<String, String> {
        let service = self.service.clone();
        let existing = tokio::task::spawn_blocking(move || {
            let doc = service
                .effective_document_blocking(None)
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(
                doc.values
                    .get("settings")
                    .and_then(|s| s.get("remote"))
                    .and_then(|r| r.get("deviceId"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        if !existing.is_empty() {
            return Ok(existing);
        }
        let id = generate_device_id();
        let service = self.service.clone();
        let id2 = id.clone();
        tokio::task::spawn_blocking(move || {
            service
                .mutate_scope_blocking(SettingsScope::User, None, |document| {
                    let target = document
                        .values
                        .entry("settings".to_string())
                        .or_insert_with(|| serde_json::json!({}));
                    let target = target.as_object_mut().ok_or_else(|| {
                        SettingsError::Validation("settings must be an object".to_string())
                    })?;
                    let remote = target
                        .entry("remote".to_string())
                        .or_insert_with(|| serde_json::json!({}));
                    remote["deviceId"] = serde_json::json!(id2);
                    Ok(())
                })
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(id)
    }
}

/// 当前 Unix 毫秒时间戳（签发时刻记录用）。系统时钟异常时退化为 0，
/// 由调用方按「时间未知」展示，不让时钟问题阻断配对。
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 长期 token（32 字节 hex，64 字符）。
pub fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// device_id（16 字节 hex，32 字符）——路由键，非机密。
pub fn generate_device_id() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
