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
        // 约定：lib.rs setup 里调用 catalog::set_resource_dir 注入一次（见 Step 6）。
        RESOURCE_DIR.with(|rd| {
            let dir = rd.borrow().as_ref()?;
            let p = dir.join("provider-catalog.json");
            if p.exists() { Some(p) } else { None }
        })
    }
}

#[cfg(not(debug_assertions))]
thread_local! {
    static RESOURCE_DIR: std::cell::RefCell<Option<std::path::PathBuf>> =
        std::cell::RefCell::new(None);
}

/// release 模式下由 app 启动时注入资源目录（lib.rs setup 调一次）。
#[cfg(not(debug_assertions))]
pub fn set_resource_dir(dir: std::path::PathBuf) {
    RESOURCE_DIR.with(|rd| *rd.borrow_mut() = Some(dir));
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

// Task 7-12 将按 kind 查 catalog 派生身份；暂时未调用，保留 API。
#[allow(dead_code)]
pub fn catalog_find(kind: ProviderKind) -> Option<&'static CatalogPreset> {
    catalog().iter().find(|p| p.kind == kind)
}

/// 派生预置 kind 的 (name, icon, base_url)。非预置 kind（Custom）返回 None。
// Task 7-12 将按 kind 派发；暂时未调用，保留 API。
#[allow(dead_code)]
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
}
