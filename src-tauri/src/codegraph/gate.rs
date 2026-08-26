//! 命令级门控：受信任 + 总开关开启才放行。
//!
//! 统一「受信任工作区」与「代码索引总开关」两道门的判定逻辑，替代原先散落在
//! `codegraph_build_index` / `codegraph_reindex_file` / `codegraph_rescan`
//! 三个命令里复制粘贴的重复 trust 门控块（历史补丁：同一逻辑抄三遍、返回
//! 形状还不一致）。每个命令开头一行调用，skip 响应形状统一为
//! `skipped: "<reason>"`（untrusted / disabled）。
//!
//! `trusted` 由调用方传入（`is_path_trusted` 读全局 state.json，单测环境
//! 不可控，故不在此函数内调用）——门控的判定逻辑（顺序、原因、语义）收口
//! 在此，trust 检查本身仍是调用方的一个表达式。

use crate::settings::SettingsService;

/// 返回 skip 原因（None = 放行）。调用方在 spawn_blocking 或命令体里
/// （`codegraph_enabled` 读设置，轻量 IO）。
pub(crate) fn skip_reason(
    trusted: bool,
    settings_service: &SettingsService,
) -> Option<&'static str> {
    if !trusted {
        return Some("untrusted");
    }
    if !crate::commands::settings::codegraph_enabled(settings_service) {
        return Some("disabled");
    }
    None
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::settings::{MemorySecretStore, SettingsPaths, SettingsScope, SettingsService};

    fn test_service(tag: &str) -> SettingsService {
        let root = std::env::temp_dir().join(format!("aide-gate-{tag}-{}", std::process::id()));
        let service = SettingsService::new(
            SettingsPaths::for_test(root),
            Arc::new(MemorySecretStore::default()),
        );
        service.initialize_blocking().expect("init settings");
        service
    }

    /// 不信任 → untrusted（trust 门优先于开关门）。
    #[test]
    fn skip_reason_untrusted_wins_over_disabled() {
        let service = test_service("untrusted");
        assert_eq!(skip_reason(false, &service), Some("untrusted"));
    }

    /// 信任但总开关关闭 → disabled。
    #[test]
    fn skip_reason_disabled_when_switch_off() {
        let service = test_service("off");
        service
            .mutate_scope_blocking(SettingsScope::User, None, |doc| {
                doc.values
                    .entry("settings".to_string())
                    .or_insert_with(|| serde_json::json!({}))["codegraphEnabled"] =
                    serde_json::json!(false);
                Ok(())
            })
            .expect("set codegraphEnabled=false");
        assert_eq!(skip_reason(true, &service), Some("disabled"));
    }

    /// 信任 + 默认（未设置）→ 放行（开关默认开）。
    #[test]
    fn skip_reason_defaults_to_pass() {
        let service = test_service("default");
        assert_eq!(skip_reason(true, &service), None);
    }
}
