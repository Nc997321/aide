//! 工作区「配得上」哪些 LSP 语言（下发给 sidecar 的 agent LSP 工具闸门）。依赖 LSP 服务器
//! 解析（捆绑资源路径经 [`crate::resources::HostResources`]）。

/// 该工作区有哪几种语言**配得上语言服务器**——agent LSP 工具的挂载闸门数据源。
///
/// 「配得上」= detector 探到了该语言 + `registry::resolve` 能解析出 server 来源
/// （用户覆盖 > 捆绑 > PATH，三级优先级由 resolve 内部处理，不在这里重造）。
/// 两者缺一，工具挂了也只会返回 no_server——那就干脆别挂，省下每轮重发的工具 schema。
///
/// 与 `trusted` 并列：都是「主进程算好、下发给 sidecar」的政策值。
///
/// **签名带 `core`**：`registry::resolve` 要它的资源端口解析捆绑资源路径。没有它就查不了
/// 捆绑 server，**不许**退化成「只查 PATH」——那会把一批用户误判成「没有 LSP」。
pub fn lsp_languages_for_path(core: &crate::Core, workspace_root: &str) -> Vec<String> {
    let langs = lsp_language_ids_of(workspace_root);
    if langs.is_empty() {
        return vec![]; // 探不到语言：连 settings 都不必读
    }
    let Ok(settings) = crate::app_settings::public_settings(&core.settings) else {
        return vec![];
    };
    langs
        .into_iter()
        .filter(|lang| crate::lsp::registry::resolve(*lang, &settings, core.resources.as_ref()).is_some())
        .map(|lang| lang.id_str().to_string())
        .collect()
}


/// 会话前询问的判定结果（`lsp_session_preflight`）。判定全在代码里，模型不参与。
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LspPreflight {
    /// 未信任：不问（信任门在前，开关开了也不会起 server）。
    Untrusted,
    /// 用户选过（或存量已开）：照做，不问。
    Decided { enabled: bool },
    /// 探到的语言里没有一个装着、也没有一个能装：问了也没用。
    Nothing,
    /// 该问：列出可开的语言。
    Ask { langs: Vec<PreflightLang> },
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreflightLang {
    pub lang: String,
    /// 语言服务器已可解析（用户覆盖 / 语言包 / 捆绑 / PATH 任一）。
    pub installed: bool,
    /// 未安装但语言包目录里有：可「安装并开启」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_id: Option<&'static str>,
}

/// 纯判定（IO 由调用方做完传进来，便于单测）。
pub fn decide_preflight(trusted: bool, decided: bool, enabled: bool, langs: Vec<PreflightLang>) -> LspPreflight {
    if !trusted {
        return LspPreflight::Untrusted;
    }
    if decided {
        return LspPreflight::Decided { enabled };
    }
    let langs: Vec<_> = langs.into_iter().filter(|l| l.installed || l.pack_id.is_some()).collect();
    if langs.is_empty() {
        LspPreflight::Nothing
    } else {
        LspPreflight::Ask { langs }
    }
}

/// 某语言在询问提示上的一项：装没装、能不能装。
pub fn preflight_lang(
    core: &crate::Core,
    settings: &crate::app_settings::AppSettings,
    lang: crate::lsp::detector::LanguageId,
) -> PreflightLang {
    let installed = crate::lsp::registry::resolve(lang, settings, core.resources.as_ref()).is_some();
    let pack_id = if installed {
        None
    } else {
        crate::lsp::packs::catalog::CATALOG.iter().find(|p| p.langs.contains(&lang)).map(|p| p.id)
    };
    PreflightLang {
        lang: lang.id_str().to_string(),
        installed,
        pack_id,
    }
}

/// 纯路径判定部分：该根广义发现到哪些语言。与 core 无关，故可单测。
fn lsp_language_ids_of(workspace_root: &str) -> Vec<crate::lsp::detector::LanguageId> {
    crate::lsp::detector::detect_workspace_languages(std::path::Path::new(workspace_root))
        .query_languages()
}


#[cfg(test)]
mod tests {
    use super::*;

    fn pl(lang: &str, installed: bool, pack: Option<&'static str>) -> PreflightLang {
        PreflightLang { lang: lang.into(), installed, pack_id: pack }
    }

    #[test]
    fn preflight_untrusted_and_decided_never_ask() {
        assert_eq!(decide_preflight(false, false, false, vec![pl("java", true, None)]), LspPreflight::Untrusted);
        assert_eq!(
            decide_preflight(true, true, false, vec![pl("java", true, None)]),
            LspPreflight::Decided { enabled: false }
        );
    }

    #[test]
    fn preflight_asks_only_for_usable_languages() {
        // 没装也没语言包的语言（如 Java 目前不在语言包目录）不进卡片
        let got = decide_preflight(
            true,
            false,
            false,
            vec![pl("java", false, None), pl("rust", false, Some("rust")), pl("typescript", true, None)],
        );
        assert_eq!(
            got,
            LspPreflight::Ask { langs: vec![pl("rust", false, Some("rust")), pl("typescript", true, None)] }
        );
        assert_eq!(decide_preflight(true, false, false, vec![pl("java", false, None)]), LspPreflight::Nothing);
        assert_eq!(decide_preflight(true, false, false, vec![]), LspPreflight::Nothing);
    }

    /// 不存在的路径不该 panic，也不该假装有语言。这条离开 Core 也能验，
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

    #[test]
    fn language_tool_mount_uses_project_and_source_union() {
        let root =
            std::env::temp_dir().join(format!("aide_lsp_tool_languages_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts/helper.py"), "").unwrap();

        let report = crate::lsp::detector::detect_workspace_languages(&root);
        assert!(report.project_languages.is_empty());
        assert!(report
            .source_languages
            .contains(&crate::lsp::detector::LanguageId::Python));
        assert!(lsp_language_ids_of(&root.to_string_lossy())
            .contains(&crate::lsp::detector::LanguageId::Python));
        std::fs::remove_dir_all(root).unwrap();
    }
}
