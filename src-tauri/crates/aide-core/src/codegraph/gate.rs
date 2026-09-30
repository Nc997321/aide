//! 命令级门控：受信任 + 该工作区索引开关开启才放行。
//!
//! 统一「受信任工作区」与「工作区索引开关」两道门的判定逻辑，替代原先散落在
//! `codegraph_build_index` / `codegraph_reindex_file` / `codegraph_rescan`
//! 三个命令里复制粘贴的重复门控块。每个命令开头一行调用，skip 响应形状统一为
//! `skipped: "<reason>"`（untrusted / disabled）。
//!
//! 纯核心形态：两个 bool 进、一个判定出，不碰 IO——trust 与开关的 state.json
//! 读取是政策归集，由调用方在 spawn_blocking / 命令体里作为表达式完成
//! （`is_path_trusted` / `is_codegraph_enabled_for_path`），使本函数脱离环境
//! 即可单测。
//!
//! 开关语义（工作区级下沉后）：**每工作区默认关**，仅当 state.json 的
//! `codegraph_workspaces[<trust_key>].enabled == true` 才放行。disabled =
//! 该工作区开关未开（含显式关与从未设置），untrusted 优先于 disabled。

/// 返回 skip 原因（None = 放行）。`trusted` / `enabled` 由调用方算好传入——
/// 判定逻辑（顺序、原因、语义）收口在此，政策读本身是调用方的表达式。
pub(crate) fn skip_reason(trusted: bool, enabled: bool) -> Option<&'static str> {
    if !trusted {
        return Some("untrusted");
    }
    if !enabled {
        return Some("disabled");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不信任 → untrusted（trust 门优先于开关门）。
    #[test]
    fn skip_reason_untrusted_wins_over_disabled() {
        assert_eq!(skip_reason(false, false), Some("untrusted"));
        assert_eq!(skip_reason(false, true), Some("untrusted"));
    }

    /// 信任但开关关 → disabled（显式关与从未设置的缺省关同一判定）。
    #[test]
    fn skip_reason_disabled_when_switch_off() {
        assert_eq!(skip_reason(true, false), Some("disabled"));
    }

    /// 信任 + 开关开 → 放行。
    #[test]
    fn skip_reason_passes_when_enabled() {
        assert_eq!(skip_reason(true, true), None);
    }
}
