//! Provider 预置 catalog——**编译进二进制**的只读静态清单（`provider-catalog.json`），预置
//! kind 身份的唯一来源。编译期嵌入：本机 Host 与远程 Host（aide-host）带同一份，不依赖
//! 任何资源目录。首次访问时解析一次。

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::provider::ProviderKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    ApiKey,
    AuthToken,
}

/// 预置供应商的表单默认值（模型档位映射 + 上下文窗口）。
/// 仅前端建草稿时预填用——不参与运行时 env 组装；用户保存草稿后这些值落进
/// provider 的 modelMappings / maxContextTokens，由既有注入链路生效。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct CatalogDefaults {
    #[serde(default)]
    pub anthropic_model: String,
    #[serde(default)]
    pub default_opus_model: String,
    #[serde(default)]
    pub default_sonnet_model: String,
    #[serde(default)]
    pub default_haiku_model: String,
    #[serde(default)]
    pub subagent: String,
    #[serde(default)]
    pub max_context_tokens: String,
    #[serde(default)]
    pub effort_level: String,
    #[serde(default)]
    pub auto_compact_window: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CatalogPreset {
    pub kind: ProviderKind,
    pub name: String,
    pub icon: String,
    pub base_url: String,
    pub auth_mode: AuthMode,
    pub actions: Vec<String>,
    /// 预填表单的默认模型值；无默认值的预置（如 Anthropic 官方）不写此字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<CatalogDefaults>,
    /// 该预置的模型选项集（前端下拉/兜底列表的唯一来源）。
    /// 系统默认用 4 个 Anthropic 别名；第三方预置（如有）也走这里；不写 = 空列表。
    #[serde(default)]
    pub models: Vec<String>,
}

static CATALOG: OnceLock<Vec<CatalogPreset>> = OnceLock::new();

const CATALOG_JSON: &str = include_str!("provider-catalog.json");

fn load() -> Vec<CatalogPreset> {
    match serde_json::from_str::<Vec<CatalogPreset>>(CATALOG_JSON) {
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
    fn qwen_defaults_parsed_from_catalog() {
        let p = catalog_find(ProviderKind::Qwen).unwrap();
        let d = p.defaults.as_ref().expect("qwen must carry defaults");
        assert_eq!(d.anthropic_model, "qwen3.8-max");
        assert_eq!(d.default_haiku_model, "qwen3.6-flash");
        assert_eq!(d.subagent, "qwen3.7-max");
        assert_eq!(d.max_context_tokens, "983616");
    }

    #[test]
    fn deepseek_defaults_parsed_from_catalog() {
        let p = catalog_find(ProviderKind::DeepSeek).unwrap();
        let d = p.defaults.as_ref().expect("deepseek must carry defaults");
        assert_eq!(d.anthropic_model, "deepseek-v4-pro[1m]");
        assert_eq!(d.default_opus_model, "deepseek-v4-pro[1m]");
        assert_eq!(d.default_sonnet_model, "deepseek-v4-pro[1m]");
        assert_eq!(d.default_haiku_model, "deepseek-v4-flash");
        assert_eq!(d.subagent, "deepseek-v4-flash");
        assert_eq!(d.effort_level, "max");
        assert_eq!(d.auto_compact_window, "786432");
    }

    #[test]
    fn kimi_defaults_parsed_from_catalog() {
        let p = catalog_find(ProviderKind::Kimi).unwrap();
        let d = p.defaults.as_ref().expect("kimi must carry defaults");
        assert_eq!(d.anthropic_model, "k3[1m]");
        assert_eq!(d.default_opus_model, "k3[1m]");
        assert_eq!(d.default_sonnet_model, "k3[1m]");
        assert_eq!(d.default_haiku_model, "k3[1m]");
        assert_eq!(d.subagent, "k3[1m]");
        assert_eq!(d.effort_level, "high");
        assert_eq!(d.auto_compact_window, "1048576");
        assert_eq!(d.max_context_tokens, "1048576");
    }

    #[test]
    fn zhipu_defaults_parsed_from_catalog() {
        let p = catalog_find(ProviderKind::Zhipu).unwrap();
        let d = p.defaults.as_ref().expect("zhipu must carry defaults");
        assert_eq!(d.anthropic_model, "glm-5.3-flash");
        assert_eq!(d.default_opus_model, "glm-5.3");
        assert_eq!(d.default_sonnet_model, "glm-5.3-flash");
        assert_eq!(d.default_haiku_model, "glm-5.3-flash");
        assert_eq!(d.subagent, "glm-5.3-flash");
        assert_eq!(d.max_context_tokens, "1048576");
        // 未提供 effort / auto_compact_window → 空（serde default，不预填）
        assert_eq!(d.effort_level, "");
        assert_eq!(d.auto_compact_window, "");
        // 无 defaults 的预置（如 Ollama）仍为 None——向后兼容
        assert!(catalog_find(ProviderKind::Ollama)
            .unwrap()
            .defaults
            .is_none());
    }

    #[test]
    fn catalog_loads_five_presets() {
        let c = catalog();
        assert!(c.len() >= 5, "catalog must have 5 presets, got {}", c.len());
        assert!(catalog_find(ProviderKind::CpaGpt).is_some());
        assert!(
            catalog_find(ProviderKind::Custom).is_none(),
            "Custom not in catalog"
        );
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

    /// catalog.system_default.models 决定前端「系统默认供应商」的 known_models。
    /// 不再依赖 default-models.json——单一真源就是 catalog 预设。
    /// 改 catalog.json → 改 view() 输出 → 改前端下拉/兜底列表。
    #[test]
    fn system_default_models_parsed_from_catalog() {
        let p = catalog_find(ProviderKind::SystemDefault).unwrap();
        assert_eq!(
            p.models,
            vec!["opus", "sonnet", "haiku", "fable"],
            "system_default must carry the 4 Anthropic aliases as its model set"
        );
    }

    #[test]
    fn resolve_preset_identity_none_for_custom() {
        assert!(resolve_preset_identity(ProviderKind::Custom).is_none());
    }

    #[test]
    fn embedded_catalog_parses() {
        assert!(!catalog().is_empty(), "embedded provider-catalog.json must parse");
    }
}
