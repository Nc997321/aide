//! 工作区「配得上」哪些 LSP 语言（下发给 sidecar 的 agent LSP 工具闸门）。依赖 LSP 服务器
//! 解析（捆绑资源路径要 AppHandle），随 LSP manager 在 Host 模型 P0-4 迁入 aide-core。

/// 该工作区有哪几种语言**配得上语言服务器**——agent LSP 工具的挂载闸门数据源。
///
/// 「配得上」= detector 探到了该语言 + `registry::resolve` 能解析出 server 来源
/// （用户覆盖 > 捆绑 > PATH，三级优先级由 resolve 内部处理，不在这里重造）。
/// 两者缺一，工具挂了也只会返回 no_server——那就干脆别挂，省下每轮重发的工具 schema。
///
/// 与 `is_codegraph_enabled_for_path` 并列：都是「主进程算好、下发给 sidecar」的政策值
/// （见 automation/scheduler.rs 的 trusted/codegraph_enabled 同款处理）。
///
/// **签名带 `app`**：`registry::resolve` 需要它解析捆绑资源路径。无 app 就查不了
/// 捆绑 server，**不许**退化成「只查 PATH」——那会把一批用户误判成「没有 LSP」。
pub fn lsp_languages_for_path(app: &tauri::AppHandle, workspace_root: &str) -> Vec<String> {
    use tauri::Manager;
    let langs = lsp_language_ids_of(workspace_root);
    if langs.is_empty() {
        return vec![]; // 探不到语言：连 settings 都不必读
    }
    let Ok(settings) = app
        .try_state::<std::sync::Arc<crate::settings::SettingsService>>()
        .map(|s| crate::commands::settings::public_settings(s.inner()))
        .unwrap_or(Ok(Default::default()))
    else {
        return vec![];
    };
    langs
        .into_iter()
        .filter(|lang| crate::lsp::registry::resolve(*lang, &settings, app).is_some())
        .map(|lang| lang.id_str().to_string())
        .collect()
}


/// 纯路径判定部分：该根探测到哪些语言。与 app 无关，故可单测。
fn lsp_language_ids_of(workspace_root: &str) -> Vec<crate::lsp::detector::LanguageId> {
    crate::lsp::detector::detect_languages(std::path::Path::new(workspace_root))
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 不存在的路径不该 panic，也不该假装有语言。这条离开 AppHandle 也能验，
    /// 故把纯路径部分拆成 `lsp_language_ids_of`。
    #[test]
    fn lsp_language_ids_unknown_path_is_empty() {
        assert!(lsp_language_ids_of("C:/definitely/not/here").is_empty());
    }

    /// 本仓库根目录应至少探到 Rust 与 TypeScript（有 src-tauri/Cargo.toml 与 src/*.ts）。
    /// 用真实仓库当夹具：若 detector 的探测规则被改坏，这条会红。
    #[test]
    fn lsp_language_ids_of_a_real_tree_is_not_empty() {
        let here = env!("CARGO_MANIFEST_DIR");
        assert!(!lsp_language_ids_of(here).is_empty(), "仓库根应探测到语言: {here}");
    }
}
