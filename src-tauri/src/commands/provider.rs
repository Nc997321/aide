use serde_json::Value;
use std::time::Duration;

use super::proxy::detect_proxy;
use super::settings::{load_config, with_config_mut};
use crate::runtime::provider::{
    load_system_default_mappings, migrate_provider_model, ProviderConfig,
    ProviderModelMappings,
};

#[tauri::command]
pub fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let _trace = crate::diagnostics::trace_command("get_providers");
    let config = load_config();
    if let Some(arr) = config.get("providers").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for item in arr {
            if let Ok(mut p) = serde_json::from_value::<ProviderConfig>(item.clone()) {
                migrate_provider_model(&mut p);
                out.push(p);
            }
        }
        Ok(out)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn set_providers(providers: Vec<ProviderConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_providers");
    with_config_mut(move |config| {
        config["providers"] =
            serde_json::to_value(&providers).map_err(|e| format!("Serialize error: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_active_provider_id() -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("get_active_provider_id");
    let config = load_config();
    let id = config
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("__system_default__")
        .to_string();
    Ok(id)
}

#[tauri::command]
pub fn set_active_provider_id(provider_id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_active_provider_id");
    with_config_mut(move |config| {
        config["active_provider"] = Value::String(provider_id);
        Ok(())
    })
}

#[tauri::command]
pub fn get_system_default_model_mappings() -> Result<ProviderModelMappings, String> {
    let _trace = crate::diagnostics::trace_command("get_system_default_model_mappings");
    Ok(load_system_default_mappings())
}

#[tauri::command]
pub fn set_system_default_model_mappings(mappings: ProviderModelMappings) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_system_default_model_mappings");
    let mappings_val =
        serde_json::to_value(&mappings).map_err(|e| format!("Serialize error: {}", e))?;
    with_config_mut(move |config| {
        config["system_default_model_mappings"] = mappings_val;
        Ok(())
    })
}

// ── 启动时拉最新模型覆盖"系统默认" ──
//
// 模型会持续迭代（opus 4.8 → 4.9 → …），硬编码默认会随版本老化。启动时（和点
// "手动刷新"时）调 Anthropic `GET /v1/models` 拉真实可用列表，按省钱档映射覆盖
// "系统默认"的 5 字段。模型变量本就该自动维护、不该让用户手改（手改易出 opus4.8
// 这种 404 错名）——前端 ProviderSettings 系统默认下 5 字段改只读 + 刷新按钮。
//
// 认证走系统 env 兜底（与 chat.rs spawn 合并点 None 分支同源）。无认证时静默返回
// 旧 mappings（系统默认允许无认证），网络/解析失败返回 Err 让前端 toast 提示。
//
// async + spawn_blocking：CLAUDE.md 规矩——重 IO 命令一律 async + spawn_blocking，
// 同步 ureq 调用放 blocking 闭包不阻塞 tokio worker。**不埋 trace_command**——
// async 命令的 guard 在 dispatch 后立刻 drop，埋了也抓不到（CLAUDE.md 红线）。

/// 启动时（和点"手动刷新"时）调 Anthropic `GET /v1/models` 拉最新模型列表，
/// 按省钱档映射覆盖"系统默认"的 5 个模型变量字段，写回 config 并返回新 mappings。
#[tauri::command]
pub async fn refresh_system_default_models() -> Result<ProviderModelMappings, String> {
    tokio::task::spawn_blocking(|| {
        // 1. 认证 env（镜像 chat.rs:52-71 系统默认 env 读取）
        let api_key = std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        let auth_token = std::env::var("ANTHROPIC_AUTH_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());

        // 无认证：静默保留旧值（系统默认本来就允许无认证）
        let (auth_header_name, auth_header_val): (&str, String) = match (api_key, auth_token) {
            (Some(key), _) => ("x-api-key", key),
            (_, Some(token)) => ("Authorization", format!("Bearer {}", token)),
            (None, None) => return Ok(load_system_default_mappings()),
        };

        // 2. ureq agent + 代理 + 10s 超时
        let mut agent_builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
        if let Some(proxy_url) = detect_proxy() {
            if let Ok(proxy) = ureq::Proxy::new(&proxy_url) {
                agent_builder = agent_builder.proxy(proxy);
            }
        }
        let agent = agent_builder.build();

        // 3. GET {base_url}/v1/models
        let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
        let response = agent
            .get(&url)
            .set(auth_header_name, &auth_header_val)
            .call()
            .map_err(|e| format!("API 请求失败: {}", e))?;

        let body: serde_json::Value = response
            .into_json()
            .map_err(|e| format!("解析响应失败: {}", e))?;

        // 4. 映射省钱档
        let mappings = parse_models_response(&body)?;

        // 5. 持久化（走临界区，与 set_providers/set_settings 串行，避免陈旧快照覆盖）
        let mappings_val =
            serde_json::to_value(&mappings).map_err(|e| format!("Serialize error: {}", e))?;
        with_config_mut(move |config| {
            config["system_default_model_mappings"] = mappings_val;
            Ok(())
        })?;

        Ok(mappings)
    })
    .await
    .map_err(|e| format!("任务调度失败: {}", e))?
}

/// 解析 `GET /v1/models` 响应 `{data: [{id, display_name, ...}]}`，按省钱档映射
/// 到 5 字段：主模型/sonnet 别名 = 最新 Sonnet，opus 别名 = 最新 Opus，haiku 别名/
/// 子代理 = 最新 Haiku。
///
/// family 识别用 id 前缀（`claude-opus-`/`claude-sonnet-`/`claude-haiku-`），**排除**
/// `claude-fable-`/`claude-mythos-`（用户踩过 Fable 5 烧 5 小时窗口的坑）。"最新"
/// 判定按版本号数值比较（`parse_version`），不靠字符串排序——防未来 `4-10` vs
/// `4-9` 字符串反序（`'1' < '9'` 会把 4-10 排到 4-9 后面）。某 family 无模型 →
/// 对应字段留空（不报错）。`data` 缺失 → `Err`；`data` 空数组 → 全空 mappings。
fn parse_models_response(body: &serde_json::Value) -> Result<ProviderModelMappings, String> {
    let data = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "响应缺少 data 数组".to_string())?;

    let mut opus: Vec<&str> = Vec::new();
    let mut sonnet: Vec<&str> = Vec::new();
    let mut haiku: Vec<&str> = Vec::new();

    for item in data {
        let id = match item.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };
        if id.starts_with("claude-opus-") {
            opus.push(id);
        } else if id.starts_with("claude-sonnet-") {
            sonnet.push(id);
        } else if id.starts_with("claude-haiku-") {
            haiku.push(id);
        }
        // fable/mythos/未知 family —— 跳过
    }

    // 取版本号最大的（数值比较，非字符串排序）
    let latest = |models: &Vec<&str>| -> String {
        models
            .iter()
            .max_by(|a, b| parse_version(a).cmp(&parse_version(b)))
            .map(|s| s.to_string())
            .unwrap_or_default()
    };

    let latest_opus = latest(&opus);
    let latest_sonnet = latest(&sonnet);
    let latest_haiku = latest(&haiku);

    Ok(ProviderModelMappings {
        anthropic_model: latest_sonnet.clone(),
        default_opus_model: latest_opus,
        default_sonnet_model: latest_sonnet,
        default_haiku_model: latest_haiku.clone(),
        subagent: latest_haiku,
    })
}

/// 从模型 id 解析版本号元组用于数值比较。如 `claude-opus-4-8` → `[4, 8]`，
/// `claude-sonnet-4-20250514` → `[4, 20250514]`，`claude-sonnet-5` → `[5]`。
/// 非数字段跳过。逐位数值比较避免字符串排序的 `4-10 < 4-9` 反序 bug。
fn parse_version(id: &str) -> Vec<u64> {
    id.split('-')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

#[tauri::command]
pub fn get_provider_catalog() -> Result<Vec<crate::runtime::provider::catalog::CatalogPreset>, String> {
    Ok(crate::runtime::provider::catalog::catalog().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── refresh_system_default_models 的映射逻辑单测 ──

    #[test]
    fn parse_version_extracts_numeric_segments() {
        assert_eq!(parse_version("claude-opus-4-8"), vec![4, 8]);
        assert_eq!(parse_version("claude-sonnet-5"), vec![5]);
        assert_eq!(
            parse_version("claude-sonnet-4-20250514"),
            vec![4, 20250514]
        );
        assert_eq!(parse_version("claude-haiku-4-10"), vec![4, 10]);
        assert_eq!(parse_version("claude-opus-4-9"), vec![4, 9]);
    }

    #[test]
    fn parse_version_numeric_compare_not_string_sort() {
        // 字符串排序会把 '4-9' 排到 '4-10' 后（'9' > '1'）——版本号数值比较必须反过来
        assert!(parse_version("claude-opus-4-10") > parse_version("claude-opus-4-9"));
        assert!(parse_version("claude-sonnet-5") > parse_version("claude-sonnet-4-8"));
    }

    #[test]
    fn parse_models_response_selects_latest_per_family() {
        let body = serde_json::json!({
            "data": [
                {"id": "claude-sonnet-4-20250514"},
                {"id": "claude-sonnet-4-20250402"},
                {"id": "claude-opus-4-8"},
                {"id": "claude-opus-4-7"},
                {"id": "claude-haiku-4-5"},
                {"id": "claude-haiku-4-20250514"},
            ]
        });
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.anthropic_model, "claude-sonnet-4-20250514");
        assert_eq!(m.default_opus_model, "claude-opus-4-8");
        assert_eq!(m.default_sonnet_model, "claude-sonnet-4-20250514");
        assert_eq!(m.default_haiku_model, "claude-haiku-4-20250514");
        assert_eq!(m.subagent, "claude-haiku-4-20250514");
    }

    #[test]
    fn parse_models_response_excludes_fable_and_mythos() {
        let body = serde_json::json!({
            "data": [
                {"id": "claude-fable-5"},
                {"id": "claude-mythos-5"},
                {"id": "claude-sonnet-5"},
            ]
        });
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.anthropic_model, "claude-sonnet-5");
        // 没有 opus/haiku —— 对应字段留空
        assert_eq!(m.default_opus_model, "");
        assert_eq!(m.default_haiku_model, "");
        assert_eq!(m.subagent, "");
    }

    #[test]
    fn parse_models_response_skips_unknown_families() {
        let body = serde_json::json!({
            "data": [
                {"id": "some-unknown-model"},
                {"id": "claude-opus-4-8"},
            ]
        });
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.default_opus_model, "claude-opus-4-8");
        assert_eq!(m.anthropic_model, ""); // 无 sonnet
    }

    #[test]
    fn parse_models_response_empty_data_yields_all_empty() {
        let body = serde_json::json!({"data": []});
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.anthropic_model, "");
        assert_eq!(m.default_opus_model, "");
        assert_eq!(m.default_sonnet_model, "");
        assert_eq!(m.default_haiku_model, "");
        assert_eq!(m.subagent, "");
    }

    #[test]
    fn parse_models_response_missing_data_field_is_err() {
        let body = serde_json::json!({});
        assert!(parse_models_response(&body).is_err());
    }
}
