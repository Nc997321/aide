//! Rust：rust-analyzer。捆绑 + PATH 发现；init 注入 excludeGlobs。

use crate::lsp::registry::ServerProfile;
use serde_json::Value;

pub struct RustProfile;

impl ServerProfile for RustProfile {
    fn bundled(&self) -> Option<(&'static str, &'static str)> {
        Some(("rust", "rust-analyzer"))
    }

    fn init_options(&self, exclude_globs: &[String]) -> Value {
        serde_json::json!({ "excludeGlobs": exclude_globs })
    }
}
