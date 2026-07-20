//! Provider 预置 catalog——编译进 resources 的只读静态清单，预置 kind 身份的唯一来源。
//! 加载时机：Lazy 首次访问。dev 从 CARGO_MANIFEST_DIR/resources 读，
//! release 从 resource_dir/agent-runtime 读（与 default-models.json 同级）。

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::runtime::provider::ProviderKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    ApiKey,
    AuthToken,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CatalogPreset {
    pub kind: ProviderKind,
    pub name: String,
    pub icon: String,
    pub base_url: String,
    pub auth_mode: AuthMode,
    pub actions: Vec<String>,
}

static CATALOG: OnceLock<Vec<CatalogPreset>> = OnceLock::new();

fn resolve_path() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let p = manifest.join("resources").join("provider-catalog.json");
        if p.exists() { return Some(p); }
        None
    }
    #[cfg(not(debug_assertions))]
    {
        // release: 由 tauri.conf.json resources 打包；运行时从 exe 同级或资源目录找。
        // 简化：读 cwd/resources 或 exe 目录 resources。Tauri 资源目录由调用方注入更稳，
        // 但 catalog 要在 runtime 层无 AppHandle 也能读——用 exe 目录回退。
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let p = dir.join("resources").join("provider-catalog.json");
        if p.exists() { return Some(p); }
        // Tauri 把 resources 解到 resource_dir，但 runtime 层拿不到 AppHandle。
        // 由 lib.rs setup 调 set_resource_dir 注入一次（进程全局 OnceLock，worker 线程可见）。
        if let Some(rd) = RESOURCE_DIR.get() {
            let p = rd.join("provider-catalog.json");
            if p.exists() { return Some(p); }
        }
        None
    }
}

#[cfg(any(not(debug_assertions), test))]
static RESOURCE_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// release 模式下由 app 启动时注入资源目录（lib.rs setup 调一次）。
/// 进程全局 OnceLock——任何线程（含 Tauri worker 线程）都能读到，且重复设置不 panic。
#[cfg(any(not(debug_assertions), test))]
pub fn set_resource_dir(dir: std::path::PathBuf) {
    let _ = RESOURCE_DIR.set(dir); // idempotent: 忽略“已设”（setup 只调一次）
}

fn load() -> Vec<CatalogPreset> {
    let path = match resolve_path() {
        Some(p) => p,
        None => {
            tracing::error!("provider-catalog.json not found; presets will have empty identity");
            return Vec::new();
        }
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("read catalog failed: {e}");
            return Vec::new();
        }
    };
    match serde_json::from_str::<Vec<CatalogPreset>>(&content) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("parse catalog failed: {e}");
            Vec::new()
        }
    }
}

pub fn catalog() -> &'static [CatalogPreset] {
    CATALOG.get_or_init(load)
}

pub fn catalog_find(kind: ProviderKind) -> Option<&'static CatalogPreset> {
    catalog().iter().find(|p| p.kind == kind)
}

/// 派生预置 kind 的 (name, icon, base_url)。非预置 kind（Custom）返回 None。
pub fn resolve_preset_identity(kind: ProviderKind) -> Option<(String, String, String)> {
    let p = catalog_find(kind)?;
    Some((p.name.clone(), p.icon.clone(), p.base_url.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_five_presets() {
        let c = catalog();
        assert!(c.len() >= 5, "catalog must have 5 presets, got {}", c.len());
        assert!(catalog_find(ProviderKind::CpaGpt).is_some());
        assert!(catalog_find(ProviderKind::Custom).is_none(), "Custom not in catalog");
    }

    #[test]
    fn cpa_gpt_base_url_is_locked_to_8317() {
        let p = catalog_find(ProviderKind::CpaGpt).unwrap();
        assert_eq!(p.base_url, "http://127.0.0.1:8317");
        assert_eq!(p.auth_mode, AuthMode::AuthToken);
    }

    #[test]
    fn system_default_has_empty_base_url() {
        let p = catalog_find(ProviderKind::SystemDefault).unwrap();
        assert_eq!(p.base_url, "");
    }

    #[test]
    fn resolve_preset_identity_none_for_custom() {
        assert!(resolve_preset_identity(ProviderKind::Custom).is_none());
    }

    #[test]
    fn set_resource_dir_is_process_global_and_idempotent() {
        // 进程全局 OnceLock：set 不 panic，重复 set 静默忽略（setup 只调一次）。
        // 注意：dev 模式 resolve_path 走 CARGO_MANIFEST_DIR 分支，不读 RESOURCE_DIR，
        // 所以这个测试只验证 set 机制本身，不验证 resolve_path release 分支。
        use std::path::PathBuf;
        set_resource_dir(PathBuf::from("/nonexistent-test-dir"));
        // 第二次 set 应静默忽略（OnceLock::set 返回 Err，我们丢弃）——不 panic。
        set_resource_dir(PathBuf::from("/another-test-dir"));
        // catalog() 仍能加载（dev 模式从 CARGO_MANIFEST_DIR 读，不受影响）。
        assert!(!catalog().is_empty(), "catalog must not be empty in dev mode");
    }
}
