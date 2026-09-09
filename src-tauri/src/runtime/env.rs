//! Runtime spawn env 组装。从 commands/chat.rs 迁入并改纯函数：
//! 调用方负责取 active provider / proxy 传入，
//! 本函数不做 config I/O，runtime 层不依赖 commands。

use std::collections::HashMap;

use crate::runtime::provider::ProviderConfig;

/// 组 spawn env：active provider 直映；
/// 再补公共 fallback（CLAUDE_CONFIG_DIR + 代理），最后 proxy 覆盖。
/// 纯函数——无 I/O，可单测。
pub fn build_runtime_env_vars(active: &ProviderConfig, proxy: &str) -> HashMap<String, String> {
    use crate::runtime::provider::strategy::strategy_for;
    let strat = strategy_for(active.kind);
    let mut env_vars = strat.env_vars(active);

    for var in strat.fallback_env_keys() {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }

    if !proxy.is_empty() {
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env_vars.insert(k.to_string(), proxy.to_string());
        }
    }
    env_vars
}

/// 剥掉 cargo 注入的 target 段。`cargo run` 会把当前构建的 profile 目录
/// （target\debug、target\release）、deps、build-script out 目录前置进 PATH——
/// 它们只服务于被构建进程自身的动态库解析，对子进程链（runtime → claude.exe
/// → where.exe）是纯毒：claude.exe 解析裸命令名时 spawn where.exe（5s 硬超时），
/// where.exe 逐文件扫描 target\debug\deps（本项目上万文件 × 杀软逐文件加税）
/// 必然超时，导致 LSP 服务器、auto 分类器等一切裸命令解析失败
///（2026-09-09 LSP "rust-analyzer not found or is in an unsafe location" 根因，
/// release 链由 explorer 启动无此注入故不受影响）。
/// 大小写不敏感、兼容正斜杠；带边界校验——`\target\debugger-tools` 不算。
/// 纯字符串处理，平台语义由调用方（Windows cfg 块）负责。
pub fn strip_cargo_target_segments(path: &str) -> String {
    path.split(';')
        .filter(|seg| !is_cargo_target_segment(seg))
        .collect::<Vec<_>>()
        .join(";")
}

fn is_cargo_target_segment(seg: &str) -> bool {
    let s = seg.replace('/', "\\").to_ascii_lowercase();
    for marker in ["\\target\\debug", "\\target\\release"] {
        if let Some(pos) = s.find(marker) {
            let rest = &s[pos + marker.len()..];
            if rest.is_empty() || rest.starts_with('\\') {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderKind, ProviderModelMappings};

    #[test]
    fn strip_removes_cargo_injected_segments() {
        // cargo run 注入的三种形态：profile 本体、deps、build-script out
        let path = "C:\\Program Files\\Git\\usr\\bin;\
C:\\proj\\src-tauri\\target\\debug;\
C:\\proj\\src-tauri\\target\\debug\\deps;\
C:\\proj\\src-tauri\\target\\debug\\build\\ring-abc123\\out;\
C:\\Users\\yangx\\.cargo\\bin";
        let out = strip_cargo_target_segments(path);
        assert!(!out.contains("target\\debug"));
        assert!(out.contains("Git\\usr\\bin"));
        assert!(out.contains(".cargo\\bin"));
    }

    #[test]
    fn strip_is_case_insensitive_and_slash_tolerant() {
        let out = strip_cargo_target_segments(
            "C:/proj/target/DEBUG/deps;C:/proj/TARGET/release;C:\\Windows",
        );
        assert_eq!(out, "C:\\Windows");
    }

    #[test]
    fn strip_does_not_touch_non_target_lookalikes() {
        // 边界：目录名以 debug/release 开头但不是 target 段的，必须保留
        let path = "C:\\tools\\target\\debugger-tools;C:\\proj\\target\\debug\\deps;C:\\Windows";
        let out = strip_cargo_target_segments(path);
        assert!(out.contains("debugger-tools"));
        assert!(!out.contains("deps"));
        assert!(out.contains("C:\\Windows"));
    }

    #[test]
    fn strip_preserves_empty_segments_and_plain_path() {
        assert_eq!(strip_cargo_target_segments("C:\\a;C:\\b"), "C:\\a;C:\\b");
        assert_eq!(strip_cargo_target_segments(""), "");
        // 空段（";;"）原样保留，不做多余规范化
        assert_eq!(strip_cargo_target_segments("C:\\a;;C:\\b"), "C:\\a;;C:\\b");
    }

    #[test]
    fn system_default_kind_uses_large_fallback_set() {
        // SystemDefault kind 必须仍走大 fallback 集（含 ANTHROPIC_*），保住系统 env 认证兜底。
        // 本测试验证该路径不 panic；具体 env 变量取决于进程环境，不在单元中断言。
        let p = ProviderConfig {
            id: "__system_default__".into(),
            kind: ProviderKind::SystemDefault,
            name: "".into(),
            icon: "".into(),
            base_url: "".into(),
            api_key: "".into(),
            auth_token: "".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        };
        let _ = build_runtime_env_vars(&p, "");
    }

    #[test]
    fn active_provider_path_does_not_fallback_anthropic_env() {
        // active provider 存在 → fallback 集 不含 ANTHROPIC_*，env 里只该有 provider 直映的
        let p = ProviderConfig {
            id: "x".into(),
            kind: ProviderKind::Custom,
            name: "".into(),
            icon: "".into(),
            base_url: "https://b.example".into(),
            api_key: "k".into(),
            auth_token: "".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        };
        let env = build_runtime_env_vars(&p, "");
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL"),
            Some(&"https://b.example".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
        // active 分支不读 ANTHROPIC_AUTH_TOKEN 进程 env（没设也不会插空）——不在此断言进程 env
    }
}
