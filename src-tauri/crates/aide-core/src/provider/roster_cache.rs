//! 官方供应商的模型名册缓存：让「还没起会话」时的静态别名清单（opus/sonnet/haiku/fable）
//! 也看得出版本。
//!
//! 别名指向哪个版本由随包的 CLI 决定、随 CLI 升级而变，Aide 写死必然过期——所以不写死：
//! 会话一起来，CLI 报回完整清单（sidecar 的 `models_available.sdk_roster`），Host 记下最近
//! 一次的，下次开新会话就拿它给别名贴标签（`ProviderConfigView::model_labels`）。从没起过
//! 会话时没有缓存，标签为空，前端照旧显示别名。
//!
//! 只采纳「纯官方」会话的回报（`speaks_catalog_aliases`）：配了模型映射或自定义地址时，
//! 别名指向的已经不是 CLI 的默认模型，拿来贴标签就是错的。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::ProviderKind;

/// CLI 报回的一行：`value` 是 **SDK 自己的** 取值（别名或全 id），`display_name` 已带版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterRow {
    pub value: String,
    pub display_name: String,
}

/// 会让别名偏离 CLI 默认指向的 env 键：出现任意一个，这条会话的回报就不能当官方名册。
const ALIAS_OVERRIDE_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

/// 这条会话的别名是否就是 CLI 的默认指向（官方供应商、没配映射、没改地址）。
/// `env` 是 send 下发的供应商 env（选模型的 `ANTHROPIC_MODEL` 覆盖之前的那份）。
pub fn speaks_catalog_aliases(kind: ProviderKind, env: &HashMap<String, String>) -> bool {
    kind == ProviderKind::SystemDefault && !ALIAS_OVERRIDE_KEYS.iter().any(|k| env.contains_key(*k))
}

/// 给每个别名找标签：先认 `value` 就是该别名的那一行；没有再按显示名首词认（旧 CLI 的
/// fable 行 value 是全 id `claude-fable-5-1[1m]`、显示名 "Fable 5.1"）。默认槽不参与首词
/// 匹配（它的显示名是「Opus 5.5（默认）」，会冒充 opus）。找不到的别名不出现在结果里。
pub fn labels_for(aliases: &[String], rows: &[RosterRow]) -> BTreeMap<String, String> {
    let first_word = |row: &RosterRow| {
        row.display_name.split_whitespace().next().unwrap_or("").to_lowercase()
    };
    aliases
        .iter()
        .filter_map(|alias| {
            rows.iter()
                .find(|r| r.value == *alias)
                .or_else(|| rows.iter().find(|r| r.value != "default" && first_word(r) == *alias))
                .map(|r| (alias.clone(), r.display_name.clone()))
        })
        .collect()
}

/// 事件里的 `sdk_roster` → 行；形状不对的行丢弃（宿主不替 sidecar 兜形状，丢了只是没标签）。
pub fn rows_from_event(roster: &serde_json::Value) -> Vec<RosterRow> {
    serde_json::from_value::<Vec<RosterRow>>(roster.clone()).unwrap_or_default()
}

// ── 进程内缓存 + 落盘（~/.aide/model-roster.json）──

/// None = 还没读过盘。
static CACHE: Mutex<Option<Vec<RosterRow>>> = Mutex::new(None);

fn cache_path() -> PathBuf {
    crate::paths::our_config_dir().join("model-roster.json")
}

fn read_file(path: &Path) -> Vec<RosterRow> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn current() -> Vec<RosterRow> {
    let mut cache = CACHE.lock().unwrap();
    cache.get_or_insert_with(|| read_file(&cache_path())).clone()
}

/// 记下最新名册；与已有的相同返回 false（调用方据此决定要不要落盘）。空清单不采纳。
pub fn remember(rows: Vec<RosterRow>) -> bool {
    if rows.is_empty() || current() == rows {
        return false;
    }
    *CACHE.lock().unwrap() = Some(rows);
    true
}

/// 把内存里的名册写盘（阻塞 IO，调用方放 `spawn_blocking`）。失败只留痕：丢的只是
/// 下次启动时的版本标签。
pub fn persist() {
    let rows = current();
    let result = serde_json::to_vec_pretty(&rows)
        .map_err(|e| e.to_string())
        .and_then(|bytes| crate::apps::store::write_atomic(&cache_path(), &bytes));
    if let Err(e) = result {
        tracing::warn!(%e, "model roster cache: persist failed");
    }
}

/// 官方供应商静态别名清单的版本标签（别名 → "Opus 5.5"）。没缓存 = 空表。
pub fn system_default_labels() -> BTreeMap<String, String> {
    let aliases = super::catalog::catalog_find(ProviderKind::SystemDefault)
        .map(|p| p.models.clone())
        .unwrap_or_default();
    labels_for(&aliases, &current())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(value: &str, display_name: &str) -> RosterRow {
        RosterRow { value: value.into(), display_name: display_name.into() }
    }

    fn aliases() -> Vec<String> {
        ["opus", "sonnet", "haiku", "fable"].iter().map(|s| s.to_string()).collect()
    }

    fn env(keys: &[&str]) -> HashMap<String, String> {
        keys.iter().map(|k| (k.to_string(), "x".to_string())).collect()
    }

    /// CLI 0.3.292 的真实回报（2026-10-12 现取）：fable 行的 value 是全 id，只能按首词认。
    #[test]
    fn labels_cover_all_aliases_on_the_bundled_cli_shape() {
        let rows = vec![
            row("default", "Opus 5.5（默认）"),
            row("opus", "Opus 5.5"),
            row("claude-fable-5-1[1m]", "Fable 5.1"),
            row("sonnet", "Sonnet 5.5"),
            row("haiku", "Haiku 4.5"),
        ];
        let labels = labels_for(&aliases(), &rows);
        assert_eq!(labels["opus"], "Opus 5.5");
        assert_eq!(labels["sonnet"], "Sonnet 5.5");
        assert_eq!(labels["haiku"], "Haiku 4.5");
        assert_eq!(labels["fable"], "Fable 5.1");
    }

    /// 新版 CLI 还会列出旧型号（"Opus 5" / "Haiku 4.5"）：别名行优先，不能被首词同名的旧型号抢走。
    #[test]
    fn exact_alias_row_wins_over_same_family_older_models() {
        let rows = vec![
            row("claude-haiku-4-5-20251001", "Haiku 4.5"),
            row("claude-opus-5", "Opus 5"),
            row("opus", "Opus 5.5"),
            row("haiku", "Haiku 5.5"),
        ];
        let labels = labels_for(&aliases(), &rows);
        assert_eq!(labels["opus"], "Opus 5.5");
        assert_eq!(labels["haiku"], "Haiku 5.5");
    }

    #[test]
    fn default_slot_never_stands_in_for_an_alias_and_unknown_aliases_are_absent() {
        let labels = labels_for(&aliases(), &[row("default", "Opus 5.5（默认）")]);
        assert!(labels.is_empty(), "{labels:?}");
    }

    #[test]
    fn only_pure_official_sessions_speak_catalog_aliases() {
        assert!(speaks_catalog_aliases(ProviderKind::SystemDefault, &env(&["HTTPS_PROXY"])));
        // 配了映射 / 改了地址：别名已不指向 CLI 默认模型
        assert!(!speaks_catalog_aliases(ProviderKind::SystemDefault, &env(&["ANTHROPIC_DEFAULT_OPUS_MODEL"])));
        assert!(!speaks_catalog_aliases(ProviderKind::SystemDefault, &env(&["ANTHROPIC_BASE_URL"])));
        // 第三方供应商：opus 行报的是它家的模型
        assert!(!speaks_catalog_aliases(ProviderKind::Custom, &env(&[])));
    }

    #[test]
    fn malformed_roster_yields_no_rows() {
        assert!(rows_from_event(&serde_json::json!("nope")).is_empty());
        assert!(rows_from_event(&serde_json::json!([{ "value": "opus" }])).is_empty());
        let ok = rows_from_event(&serde_json::json!([{ "value": "opus", "displayName": "Opus 5.5" }]));
        assert_eq!(ok, vec![row("opus", "Opus 5.5")]);
    }
}
