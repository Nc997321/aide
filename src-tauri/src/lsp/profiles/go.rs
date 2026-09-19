//! Go：gopls。PATH 发现；init 注入 directoryFilters（排除集按 gopls 语法转负号前缀）。

use crate::lsp::registry::{InitOptionsCtx, ServerProfile};
use serde_json::Value;

pub struct GoProfile;

impl ServerProfile for GoProfile {
    fn init_options(&self, ctx: &InitOptionsCtx) -> Value {
        serde_json::json!({
            "directoryFilters": ctx.exclude_globs
                .iter()
                .map(|g| g.replace("**/", "-").replace("/**", ""))
                .collect::<Vec<_>>()
        })
    }
}
